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
offload, DS4, and backfill. Rejected output is recorded as an error rather than a
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
