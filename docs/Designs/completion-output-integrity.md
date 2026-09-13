# Completion output integrity guard

## Purpose

Llama Manager treats two shapes of generated text as corrupted inference output.

**Question-mark-only output.** Non-empty assistant text made entirely of ASCII
question marks and whitespace. Observed when an AMD ROCm llama.cpp regression
returned one literal `?` per generated token for Qwen3-8B while reporting an
otherwise successful completion.

**Degenerate repeated-character output.** A run of one identical character,
accumulated across streamed deltas, passing `STREAM_REPEAT_LIMIT` (256). Observed
when a loaded llama.cpp child entered a persistent corrupt state and emitted a
single character forever for every request it received.

**Phrase-level looping.** One line repeated `STREAM_LINE_REPEAT_LIMIT` (30) times
consecutively. Blank lines do not break the run. Punctuation-only and very short
lines are excluded, because real code legitimately stacks closing braces and
brackets. Observed when a reviewer request looped `- **Input Format:**` 1677 times.

## Contract

- Normal text passes through unchanged, including mixed text such as `What???`.
- Empty content and tool-call-only responses remain valid.
- Hidden reasoning does not make question-mark-only visible assistant content valid.
- Visible content is judged first and alone, so valid reasoning never excuses
  corrupt visible output. Hidden reasoning is judged for degeneracy only when there
  was no visible content at all — which is how the corrupt child presented.
- Non-streaming chat completions return an OpenAI-compatible error with semantic
  status 502, type `upstream_output_error`, and code `QUESTION_MARK_ONLY_OUTPUT` or
  `DEGENERATE_OUTPUT` according to which shape was detected.
- A degenerate run terminates the stream as soon as it passes the threshold, aborts
  the upstream fetch, and evicts the model so its next request loads a fresh child.
  Detection without that eviction would only make the next request fail faster.
- The degenerate check sits outside the question-mark guard's `safe` latch, so a
  stream that begins with a real answer and degenerates afterwards is still caught.
- Streaming chat completions withhold a leading question-mark-only candidate. If
  later visible text proves the response valid, every buffered SSE byte is released
  unchanged. If the stream ends while still corrupt, the candidate content is
  discarded and replaced by one structured error event followed by `[DONE]`.

The streaming route sends heartbeat bytes before inference completes, so its HTTP
headers may already carry status 200. Streaming clients must therefore honor the
structured SSE error envelope. The built-in Chat client converts that envelope into
a visible error and preserves the server's error type and code.

## Coverage and accounting

The guard applies to all OpenAI chat-completion exits: local llama.cpp, remote
offload, DS4, and backfill.

The **Responses transport** (`/v1/responses`) is guarded separately by
`api/responses-output-guard.js`, because its events carry generated text as
`response.output_text.delta` / `response.reasoning_text.delta` rather than
`choices[].delta` — the chat extractor sees nothing there. Detection is shared
(`createRepetitionMonitor`, `degenerateOutputReason`), so "corrupt" means the same
thing on both transports.

Two differences are deliberate. Corruption is reported as a real
`response.failed` event carrying `event.response`, because
`executeBackgroundResponse` records a final response only from a terminal
status-bearing event — a bare `{error}` would leave a `background: true` job
holding `null` with status 200, a silently empty result instead of a failure. And
there is no withhold-and-release buffering: that exists in the chat guard for the
question-mark case, whereas here the detector needs a long run before it fires, so
bytes are forwarded unchanged and only a trip stops the stream.

`background: true` jobs are covered because `executeBackgroundResponse` re-enters
`/api/v1/responses` rather than calling the engine directly. A test pins that, so
turning it into a direct engine call cannot silently drop the guard.

`response.function_call_arguments.delta` is deliberately NOT guarded: tool
arguments are structured JSON where repetition is plausible, and falsely aborting
a valid tool call is worse than the failure being guarded against. Rejected output is recorded as an error rather than a
successful request and is excluded from successful throughput accounting.

## Runtime incident and rollback

On 2026-08-22, llama.cpp build 10586 (`b21e4de74`) produced question-mark-only
Qwen3-8B output on the local AMD GPU path while the same GGUF generated coherent
text on CPU. The live service was restored to the ROCm toolbox's pre-update build
9820 (`3fc4e1052`), which passed a forced-local Qwen3-8B response probe. The source
pin remains at `8be759e6f70d629638a7eb70db3824cbdcea370b` until a newer runtime passes
both Qwen3-8B and Qwen3.8 validation.



## Runtime incident: corrupt forward pass, 2026-09-08

On Drakemore, a loaded `unsloth_Qwen3.6-35B-A3B-GGUF` child served HTTP 200 while
emitting 12288 `/` (code 47) tokens for every request. Two peer requests burned
304.7s and 328.4s producing nothing else, with `retries: 0`.

Isolation performed on the live degraded child, before recycling it:

- Reproduced straight to the child on its loopback port with llama-manager out of
  the path — not proxying, not streaming, not the caller's harness.
- Failed identically on plain, `json_object`, `temperature 0.35`, and
  `json_object` + `temperature` requests — not request-shape dependent.
- Failed with `cache_prompt: false` and `cached_tokens: 0`, a completely fresh
  prefill — KV-cache and slot-restore poisoning refuted. The `promptTokens = 4`
  visible in `/api/llm-logs` is `timings.prompt_n` after a prefix hit, not the real
  prompt size, and misleads here.
- Failed on raw `/completion` with no chat template and no reasoning — the
  corruption is in the forward pass, not in template or reasoning handling.
- The sibling `unsloth_Qwen3.8-Flash-Next-GGUF` child answered correctly on the
  same GPU at the same moment — the GPU was not globally wedged; the degradation
  is per-child.

Recovery is `POST /api/models/unload` for that model alone, then reload on demand;
this was verified healthy afterwards on `json_object` + `temperature 0.35`
(`finish_reason: stop`, valid JSON). The guard now performs that eviction
automatically.

The cause of the corruption itself is **not** established — only the signature,
that it is per-child and persistent, and that targeted eviction recovers it. A
recurrence should be reported rather than worked around, since the recovery is
cheap and the recurrence data is what is missing.

`/v1/completions` and the DS4 and remote-backend pumps are not covered by the
degenerate check today.


## Runtime incident: phrase-level loop, 2026-09-08

A Qwen3.6-35B-A3B reviewer request ran 265.6s at HTTP 200, produced 12000
completion tokens entirely inside the reasoning block, and returned no content.
The reasoning was a loop: 1694 non-empty lines, **12 distinct**, with
`- **Input Format:**` repeated **1677** times. Degeneration began at the fourth
line (`Check all constraints, constraints, check all constraints.`).

Temperature was 1.0, so this does **not** require greedy decoding. The children
report `repeat_penalty = 1.0` (disabled), and the manager's sampling injection
sets no repetition penalty — nothing pushed the model out of the loop.

The character-run detector missed it entirely: the longest single-character run
in that output was zero. Replaying the captured 39,809-byte payload through the
line detector trips after 2,190 bytes — 5.5% of the output, roughly 15s rather
than 265s.

Note that a `response_format` schema would **not** have prevented this. The
engine's grammar for this model constrains the content *after* the thinking
block — `optional("<think>" ... "</think>")` followed by schema-constrained
content — so it permits unbounded reasoning by design, and a loop inside the
thinking block is untouched by it.

Separately, and worth knowing: on this engine a bare
`response_format: {"type":"json_object"}` with no `schema` key applies **no
grammar at all** for templates routed to the `qwen3_coder` handler (which
Qwen3.6 is, by its `<tool_call>` / `<function=` / `<parameter=` markers). The
handler gates on a non-empty schema object, and a bare `json_object` yields an
empty one. Supply a real schema — either `{"type":"json_object","schema":{...}}`
or `{"type":"json_schema","json_schema":{"schema":{...}}}` — to get a grammar.

## Runtime incident: in-line phrase loop, 2026-09-12

A third loop shape, and the first one that no existing detector saw.

A duo execute step (Qwen3.6-35B-A3B, drakemore, reviewing 41,027 chars of real
repo source) ran 883s and consumed **36,768** completion tokens — exactly
`duoStepBudget(4000)` = `min(4000 + 32768, 49152)`, so it ran to the ceiling. The
126,123-char output is five non-blank lines; the last is a single ~125KB line of
`` `backend`, `backendId`, `` repeated. 10,533 words, **76 distinct** (0.0072).

Replayed through every detector in this module:

| detector | shape it looks for | result |
|---|---|---|
| `degenerateOutputReason` | the whole output is ONE punctuation character | missed |
| `createRepetitionMonitor` character run | a run of one character in the stream | missed |
| `createRepetitionMonitor` line repeat | the same LINE repeated `STREAM_LINE_REPEAT_LIMIT` times | missed |
| `loopingTextReason` (new) | vocabulary collapse over the whole output | **caught** |

The line detector missed it for the same structural reason the character detector
missed the 2026-09-08 loop: the repetition is one level below what it measures.
There the phrase repeated across lines; here it repeats *within* a single line, so
there are only five lines and none repeats. The three detectors are complementary,
not redundant — one per level: character, line, phrase.

`loopingTextReason` is therefore a vocabulary test rather than a structural one:
unique words over total words, judged only above 500 words because a loop always
runs to its full budget and is never short. Measured across eight duo runs on real
repo source, healthy work sits at 0.47 - 0.59 and this run at 0.0072, so the 0.15
threshold sits 3x below the worst healthy run and 20x above the loop. Verified
against all eight captured runs: 1/1 on the failure, 0/7 false positives.

Mean line length separates the same runs too (25,225 vs 72 - 389) and was rejected
as the signal: it would misjudge a legitimate single-line JSON answer, which
vocabulary variety does not.

Sampling matched the 2026-09-08 incident's finding that no repetition penalty is
ever set. The caller sent only `temperature: 0.2`; `duoCallerControls` forwarded
that and nothing else, so every other knob fell to the ENGINE's defaults, including
`repeat_penalty` disabled. Near-greedy decoding with no repetition penalty is the
textbook loop configuration.

Worth recording because it is easy to assume otherwise: **`MODEL_SAMPLING_DEFAULTS`
never applies to a duo request at all**, by two independent routes. The duo branch
(`isDuoChainRequest`, server.js:12992) returns before `injectModelSamplingDefaults`
runs at server.js:13157; and duo's own step requests are posted by
`duoChainStepRequest` straight to `http://localhost:${LLAMA_PORT}/v1/chat/completions`,
the engine, bypassing Express entirely. So a duo step gets exactly the sampling the
caller set, plus engine defaults — never the model-card recipe, and never the
temperature 1.0 that recipe carries.

### Why this one mattered more than a malformed response

It was laundered. The duo reviewer, handed 126KB of that, did not fail: it emitted
702 tokens of confident, schema-valid JSON with seven findings, four of them
`severity: "high"` asserting that files "not provided in the source code snippet"
could not be reviewed — for four files that were in the request all along, cut only
by the review step's own 20,000-char request bound. The caller received HTTP 200,
valid JSON, schema-conformant, with nothing to indicate the chain had produced
nothing.

Constrained decoding fixes the SHAPE of an output and can say nothing about its
provenance. Validating the last step's output says nothing about whether any
earlier step worked, which is why `loopingTextReason` runs on the duo execute
step's work rather than on the answer. It is deliberately NOT wired into
`completion-output-guard`: judging every completion on this basis has not been
measured, and a false positive rejects a real answer.

## Runtime incident: eviction loop on a caller-side failure, 2026-09-12

Not an output-integrity failure — a recovery-action failure, found while watching
for engine restart loops on Frostburn under production podcast load.

Nine model evictions in 6.5 minutes, eight of them `REASONING_EXHAUSTED`. In a
194-request window only 33% succeeded (502: 39%, 503 "Rerouted ... Retry.": 31%),
and 62 of the 72 exhaustion errors were `max_tokens: 100` sent to a
thinking-enabled Qwen3-8B — a request that cannot be satisfied as sent, arriving
about nine times a minute.

Every one of those evicted the model. Eviction exists to replace a child stuck
producing garbage for every subsequent request; a healthy model that ran out of
budget produces exactly the same result after a reload, so each eviction paid a
full model reload to change nothing and the next request evicted again.

`corruptionIsChildFault(code)` now gates it: `DEGENERATE_OUTPUT` and
`QUESTION_MARK_ONLY_OUTPUT` evict, everything else does not, and unknown codes must
opt in deliberately. The guard sits inside `recycleCorruptModel` so all four call
sites are covered once. One genuine `DEGENERATE_OUTPUT` occurred in the same
window and still evicts, as it should — it was 1 request in 194, previously buried
in the exhaustion noise.

The contract line above ("evicts the model so its next request loads a fresh
child") applies to the degenerate and question-mark codes only.
