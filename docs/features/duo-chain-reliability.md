# Duo chain reliability

The `duo` model is not a model — it is a three-step chain: a planner writes the steps, a
worker carries them out, and the planner reviews the result and returns the final answer.
The intermediate plan and work are attached to every response under `duo` so you can see
what each step actually produced.

This page records what the chain does and does not guarantee, measured on real repo
source rather than toy prompts.

> **Note on repeated runs and the prompt cache (2026-09-10).** Repeating an identical
> prompt hits the engine prompt cache (`usage.prompt_tokens_details.cached_tokens` goes
> from 0 to the full prompt length, and `prompt_ms` drops from ~380,000 to ~200). That is a
> COMPUTE optimisation only — the cached prefix KV is what recomputation would have
> produced, and generation still samples fresh — so warm repeats ARE independent samples
> and the counts on this page are legitimate.
>
> Verified rather than assumed: warm repeats of a byte-identical prompt returned 4 distinct
> completion lengths in one arm (942/945/317/464) and, in another, differed in OUTCOME —
> 762, **12**, 762, 765, a collapse sitting among clean runs at identical prompt and cache
> state. Only where the distribution is heavily peaked do repeats look identical (one arm
> returned exactly 12 tokens five times).
>
> An earlier revision of this page claimed the opposite — that warm repeats were dependent
> and the rates inflated. That was wrong and is retracted.

## The short version

- **At small payloads (~10k tokens) the chain is reliable *for the defect it was measured
  on*.** 2/2 correct and strict JSON on a corpus containing one planted defect — but a
  SECOND plant at the same size went 0/3, so this is not a general recall claim. See
  "One plant is not a measurement of recall".
- **At large payloads it is not.** The review step intermittently discards the worker's
  answer and returns an empty one instead.
- **When an answer looks wrong, read `duo.work` before believing `duo`'s final answer.**
  The signal is usually there and correct; the last step is what loses it.
- **To review a large corpus, chunk it.** Several small reviews beat one large one, and
  the small regime is the one with evidence behind it.

## How large a request can duo actually take?

Measured end to end on real repository source with a planted defect, `default-big`,
`temperature: 0.2`, `enable_thinking: false`:

| request | prompt tok | total | result |
|---|---|---|---|
| 197k chars | 52,454 | 17 min | strict JSON, defect found |
| 360k chars | 93,651 | 20 min | strict JSON, defect MISSED (see recall below) |
| 480k chars | 125,652 | 32 min | strict JSON, defect found |
| 620k chars | 163,596 | 43-99 min | strict JSON, defect found |
| 800k chars | 212,600 | 60 min | strict JSON, defect found |
| **907k chars** | **247,281** | **73 min** | **strict JSON, defect found** |
| 961k chars | 262,532 | **0s — HTTP 400** | exceeds context size |

Every row above used a handful of files. A later controlled test showed **file count
matters more than size** — six files at 41k chars failed where two files at 205k and three
files at 153k succeeded — so read this table as "large requests work when the corpus is a
few files", not as a licence to pass many. See "Split by FILE COUNT" under practical
guidance.

**The practical ceiling is ~260,000 request tokens, and it is architectural.** Two of the
three steps carry the request plus prior output:

- plan prompt = instructions + request
- **execute prompt = request + plan output** ← the binding constraint
- review prompt = bounded request + plan + work

At a 262,144-token request the execute step needs 263,760 and the engine refuses with
`exceed_context_size_error`. So **the last ~6% of the model's window is unreachable by
duo's design**, regardless of engine speed. A caller sizing to `n_ctx` will fail on step
two even though step one fits.

### Where the time goes

Cost is prompt processing, and it is legitimate work. From per-step `promptMs` /
`unaccountedMs` (recorded since 8a90315):

| prompt size | prefill rate (cumulative) |
|---|---|
| 6k | 181 tok/s |
| 54k | 144 tok/s |
| 170k | 104 tok/s |
| 213k | 84 tok/s |
| 247k | 86 tok/s — decay has flattened |

**Those are CUMULATIVE averages — the engine's running mean over the whole prefill — and
they understate what another token costs.** Differencing consecutive samples from one
continuous 200k-token prefill gives the marginal rate:

| n_tokens | cumulative tok/s | marginal tok/s |
|---|---|---|
| 16,384 | 153.7 | — |
| 32,768 | 140.5 | 130.9 |
| 49,152 | 131.5 | 120.5 |
| 65,536 | 109.4 | 104.5 |
| 98,304 | 105.4 | 95.0 |
| 131,072 | 100.1 | 82.8 |
| 163,840 | 94.7 | 73.9 |
| 190,464 | 90.7 | **65.0** |

At 190k the cumulative rate is 90.7 and the marginal rate is 65.0 — 30% worse. Adding 50k
tokens to a 190k prompt costs ~770s, not the ~550s the cumulative figure implies, and the
error grows with context. The marginal decay is roughly linear in `n` (about -0.31 tok/s
per 1,000 tokens between 65k and 190k), which puts it near 47 tok/s at 247k. **Size a
request from the marginal column, not the cumulative one.**

### The execute step is faster because it is a different MODEL, not a cache hit

An earlier version of this page said the execute step runs 3x faster "because its prompt
shares the request prefix with the plan step and hits the prompt cache". That is wrong.
The two steps run on **different child processes with separate KV caches** — `ps` on
drakemore shows Flash-Next and Qwen3.6-35B-A3B as two `llama-server` children, and the
engine log shows the plan on slot 0 of one process and the execute on slot 1 of another.
A prefix cannot be shared between them.

The difference is the model. Cold measurements, where neither step had seen the payload
before:

| run | plan prompt | plan tok/s | execute prompt | execute tok/s | ratio |
|---|---|---|---|---|---|
| enum41_1 | 10,638 | 168 | 12,359 | 850 | 5.1x |
| p2_1 | 10,566 | 175 | 11,862 | 891 | 5.1x |
| p3f_1 | 10,317 | 141 | 11,122 | 829 | 5.9x |
| p150k_1 | 40,607 | 128 | 44,750 | 666 | 5.2x |

`p150k_1` is the decisive one: it was the FIRST run of that payload, so the execute step
had never seen its prompt either, and it was still 5.2x faster. Flash-Next is a
`UD-IQ3_XXS` quant of a much larger hybrid-attention model; Qwen3.6-35B-A3B is a
`Q4_K_XL` MoE with ~3B active parameters per token.

**So the Flash-Next steps dominate the chain's cost at large context.** On the 200k run the
plan step's prefill alone was 2,210s against the execute step's 540s. If large-request duo
is ever optimised, the plan step is where the time is.

### The prompt cache is real, but it is across RUNS of the same payload

Re-sending an identical payload makes the plan step's prefill effectively free:

| run of the same 153k payload | plan promptTokens | plan promptMs |
|---|---|---|
| first (cold) | 40,607 | 317,456 |
| second | 40,607 | **195** |
| third | 40,607 | **200** |

A 1,600x difference. This matters when reading any batch timing on this page: **run 1 of a
batch is cold and runs 2-3 are warm**, so their wall times are not independent samples of
cost. It does not affect any conclusion drawn from output CONTENT, only from timing.

Healthy `unaccountedMs` is **182ms to 15s** per step, but it has been measured as high as
**56.9 minutes** on a 7,469-token review prompt.

**`unaccountedMs` IS engine contention. Reproduced on demand at 253,000x.** The identical
7,589-token request, sent three times straight to the Flash-Next child engine:

| condition | wall | prompt_ms | gen_ms | **unaccounted** |
|---|---|---|---|---|
| engine idle | 57,601 ms | 56,241 | 1,342 | **18 ms** |
| **155k request in flight** | **4,620,191 ms** | 58,770 | 1,371 | **4,560,049 ms (76 min)** |
| engine idle again | 2,670 ms | 184 | 1,237 | **1,249 ms** |

Prefill and generation barely move; only the waiting changes. **The engine runs
`--parallel 1` — one slot, no interleaving — so a small request blocks for the entire
duration of any large request already running.**

duo's chain is plan (Flash-Next) -> execute (Qwen3.6-35B) -> review (Flash-Next). The review
step is small and lands last on Flash-Next, so it waits for anything else using that model —
including the production podcast pipeline, which uses exactly that model. A competitor
longer than 60 minutes pushes the waiting step past the 3600s proxy read timeout and the
chain fails with `proxy error: Failed to read connection`.

**Fixes, in order of directness:**

1. Raise `--parallel` on the duo models so small steps interleave instead of blocking. Note
   the context splits across slots, so size it against the ~250k architectural request
   ceiling above.
2. Raise the 3600s per-step ceiling — independently justified, since a 247k plan step needs
   46-55 minutes of legitimate prefill against that cut.
3. Do not run duo and the podcast pipeline on one engine concurrently, or accept that each
   will intermittently stall the other.

**Before trusting any duo timing, check who else is on the engine.** `queue.pending` is not
enough: it does not count work issued directly to a child engine, which is how duo's own
steps run. Read `/api/queue` to see the active request.

The one path that IS explained is prefill: a 247k plan step needs 46-55 minutes of genuine
prompt processing against a hard 3600s per-step cut, leaving ~5 minutes of margin.

**The marginal rate predicts that boundary; the cumulative rate does not.** A clean
measurement on an idle drakemore — 2 files, 200,467 prompt tokens, `unaccountedMs` 0 on
every step:

| step | wall | prefill | rate | completion |
|---|---|---|---|---|
| plan | 2,340s | 2,257s | 89 tok/s | 446 |
| execute | 711s | 647s | 310 tok/s | 1,475 |
| review | 88s | 43s | 171 tok/s | 681 |

Extrapolating the plan step to 247k with the marginal rate (declining from ~63 tok/s at
200k toward ~47 at 247k, so ~55 average over that stretch), the extra 46,533 tokens cost
~846s:

```
plan prefill at 247k ≈ 2,257 + 846 ≈ 3,103s
plus generation                    ≈   100s
                                     3,203s   against a 3,600s ceiling
```

~400s of headroom — which any contention consumes. So the 247k runs that failed with
`proxy error: Failed to read connection` at exactly 3600xxx ms were not stalls: they were
legitimate prefill plus a little contention crossing a hard limit. Note this run had a
completely idle box; the 32.8-to-60+ minute variance recorded on an identical payload
elsewhere on this page is what happens when it is not.

That also means the 3600s cut and the contention problem are the same failure at large
sizes, not two independent ones: below ~200k there is enough margin to absorb contention,
above it there is not.

**Sizing a payload:** do not use `chars/4`. Measured density varies by file type — 3.77
chars/token for `api/` + `ui/src`, 3.66 once tests and shell scripts are included. That 3%
difference is what pushed one attempt 388 tokens over the window.

## How it was measured

One unambiguous defect was planted in `api/gpu-reservations.js`:

```js
// real
if (!lowest || priority <= lowest.priority) return null;
// planted — makes EQUAL priority preempt, contradicting the comment two lines above
if (!lowest || priority <  lowest.priority) return null;
```

The same plant, always the first file in the corpus, was submitted at several corpus
sizes with identical prompt wording, model `default-big`, `temperature: 0.2`,
`chat_template_kwargs: {"enable_thinking": false}`.

| corpus | files | review prompt tok | review completion tok | outcome |
|---|---|---|---|---|
| 41,235 ch | 3 | 12,624 | 776 | plant reported, strict JSON |
| 41,235 ch | 3 | 11,274 | 137 | plant reported, strict JSON |
| 68,826 ch | 6 | 56,506 | 1,513 | plant recovered but **answer was prose + a ```json fence, not strict JSON** |
| 101,295 ch | 7 | 28,545 | **12** | `{"verdict":"pass","concerns":[]}` |
| 197,242 ch | 12 | 54,542 | **12** | `{"verdict":"pass","concerns":[]}` — **worker had found the plant** |
| 197,242 ch | 12 | 54,467 | 357 | plant reported, strict JSON |

Three of six runs delivered a usable answer.

### One plant is not a measurement of recall

Everything in the table above uses that ONE defect, always as the first file in the
corpus. A second plant, run 2026-09-12, was missed 3 times out of 3:

```js
// api/queue-admission.js, real
if (pending <  maxQueueDepth) { return { action: 'accept', reason: 'under-cap' }; }
// planted — accepts AT the cap, contradicting the very next comment,
// "Overflow zone (pending >= soft cap)"
if (pending <= maxQueueDepth) { ... }
```

41,027 chars, 6 files, the recommended findings-only schema with a severity enum,
plant at offset 3,825. Two of the three runs collapsed into the repetition loop
described under failure mode 4 and produced nothing to judge. **The third generated
healthy text and still missed it, for a different reason worth knowing about:**

> "The code provided for `api/queue-admission.js` does NOT contain `pending`,
> `maxQueueDepth`, `hasViableRemote`, `offload`, `active`, `msSinceLastCompletion`,
> `stallMs`. **CRITICAL REALIZATION:** The code snippet provided for
> `api/queue-admission.js` is **EMPTY** of the logic described in the plan. It only
> contains `poolPinPlan` which is about pinning models."
> — `duo.work`, run 3

`poolPinPlan` is in `api/alias-gpu.js`. The admission logic was present, in the
region the chain demonstrably read — the plan quoted that file's own comments back.
It attributed one file's contents to another and concluded the target file was
empty, then reported a fabricated `severity: "high"` defect in its place: that stall
detection "fails to reject when `active === 0`", which the real code deliberately
accepts as `deep-draining` because a deep queue with nothing active is DRAINING, not
stuck — exactly what that file's documentation says. The model invented a contract
and reported compliance with the real one as a violation.

The same confusion produced run 1's four `severity: "high"` findings asserting that
files "not provided in the source code snippet" could not be reviewed, for files
that were in the request throughout.

**So read every recall figure on this page as "for a defect of that kind, in a
corpus of that shape".** They are not a general claim that duo finds planted
defects.

### The corpus was the variable, not the defect

The 0/3 above confounded two changes: a new defect AND six files instead of three.
A control isolated it — same plant, same offset 3,825, same settings, but the
known-healthy three-file corpus with `gpu-drain.js` swapped out for the planted
`queue-admission.js` (39,534 chars, within 4% of the six-file payload):

| corpus | files | chars | loops | plant found |
|---|---|---|---|---|
| plant in `gpu-reservations.js` | 3 | 41,011 | 0/3 | 3/3 |
| plant in `queue-admission.js` | 3 | 39,534 | 1/3 | **2/2 healthy runs** |
| same plant, more files | 6 | 41,027 | 2/3 | 0/1 healthy run |

Both healthy three-file runs named it correctly and cited the right contradiction:

> "Boundary condition mismatch for soft cap. The documentation states 'At/over the
> soft cap... offload', implying that if `pending == maxQueueDepth`, the request
> should be offloaded or stall-checked. However, the code uses
> `if (pending <= maxQueueDepth)` to accept..."

So this defect class is not invisible to duo, and the caveat the recall figures need
is about corpus shape rather than defect kind. Three things follow:

1. **File count drives the loop rate and the attribution errors.** Three files looped
   once in nine runs across all three-file corpora; six files looped two in three. The
   "file not provided" and "this file is EMPTY of the logic" findings appeared ONLY in
   the six-file batch. A later size step confirmed file count and not size is the
   variable — see "Split by FILE COUNT" under practical guidance.
2. **Reducing file count is not a fix.** One three-file run hit the identical
   36,768-token ceiling as the six-file loops. The loop is a baseline hazard at this
   size and `loopingTextReason` is what makes it visible; fewer files only improves
   the odds.
3. **Split a review by FILE COUNT, not only by token count.** At essentially constant
   size, three files to six took this from found-in-218s to 0/3.

### Recall and precision, measured on the healthy runs

Six healthy runs across all three corpora examined the planted file. **Four named the
plant correctly (67%)**, e.g.:

> "The code uses `pending <= maxQueueDepth` to accept requests, but the documentation
> and comments define the 'Overflow zone' as `pending >= soft cap`."

Precision is the weaker half, and the 153k run is the clearest illustration because
two of its three findings were in files it had never been pointed at before:

| finding | verdict |
|---|---|
| the plant | **true positive** |
| `api-spec.js`: `TIMING_EVIDENCE_SCHEMA` uses `context_cache_contract` (snake_case) while the context-prepare response schema uses `contextCacheContract` (camelCase) | **real** — a genuine cross-schema inconsistency, accurately described, found unprompted in an 83KB file |
| `engines.js`: "`resolveDs4Config` references an undefined variable `ds4Config`", `severity: "high"` | **false** — line 193 is `engineDescriptor(type, { ds4Config, llamaPort } = {})`; it is a destructured parameter, in scope where it is used |

So it finds real defects in unfamiliar code, and files confident high-severity
nonsense beside them. Both halves are load-bearing when deciding how to consume the
output: the array is worth reading, and no individual entry is worth acting on
unverified.

### False positives cluster on a code shape

Both batches produced the same fabricated finding, at `severity: "high"`, on the same
symbol — that stall detection "fails to reject wedged models when active count is zero
but queue is deep and stalled". The code deliberately does the opposite and says so two
lines apart:

```js
// …if something is actively being served but nothing has completed within stallMs,
// the model is wedged/stuck — reject as a last resort.
if (active > 0 && msSinceLastCompletion >= stallMs) { /* reject 'stalled' */ }
// Deep but draining (or nothing active yet) — let the queue grow; requests wait,
// they don't fail.
return { action: 'accept', reason: 'deep-draining' };
```

It invents a requirement the file's own comments contradict, then reports compliance
with the real requirement as a violation. **Three of the six healthy runs that read
this file did it** — at severity high, high and medium, across three payloads (6
files/41k, 3 files/39.5k, 3 files/153k).

So false positives are not random noise. They attach to a specific code shape — a
guard whose condition deliberately excludes a case — and reproduce across corpora,
sizes and file counts. On this file the chain runs at roughly 67% recall on the real
defect with a ~50% chance of this one fabricated defect filed beside it. An enum
constrains the vocabulary of `severity`; nothing constrains its accuracy.


## Failure mode 1 — the reviewer collapses to a minimal answer

The reviewer returns exactly the minimal instance of the shape it was asked for, e.g.
`{"verdict":"pass","concerns":[]}` at 12 completion tokens, discarding everything the
worker produced. At the 197,242-char run above, `duo.work` contained the planted defect
as concern #1 with the correct fix, and the caller received a clean pass.

It is **not** any of the failures the output guards look for:

- not truncation — `finish_reason: stop`
- not reasoning exhaustion — no reasoning content, zero reasoning tokens
- not context overflow — the reviewer model serves at `--ctx-size 262144` against a
  93,310-token prompt-plus-budget total
- not `MODEL_SAMPLING_DEFAULTS` — it never applies to duo at all (the duo branch
  returns before the injection, and duo's step requests bypass Express for the engine
  port), and temperature was explicit on every run besides

It reproduces calling the reviewer model directly, with no duo code in the path:

| direct call | prompt tok | runs | collapsed |
|---|---|---|---|
| instructions only | 2,158 | 10 | **0 of 10** |
| full corpus in the request | 54,542 | **21** | **17 of 21 = 81%** |

The 21 full-corpus runs pool five arms that varied `max_tokens` (4,000 vs 38,768) and
`reasoning_effort` (none, `low`, `medium`, `high`). They are pooled because every one of
them renders the SAME prompt — see the gotcha below — so none of those knobs changed
anything. Collapse at this prompt size is ~81% regardless of sampling settings.

**It only happens when structured output is requested.** The same corpus, model and
settings, changing ONLY the requested output shape:

| requested shape | prompt tok | runs | collapsed |
|---|---|---|---|
| strict JSON schema | 54,542 | 21 | **17 (81%)** |
| free prose | 54,511 | 5 | **0** |

Every prose run named the planted defect correctly, in 179-274 tokens.

**But size alone does NOT determine it — three factors interact.** A controlled 2x2 at
constant ~21k prompt size, varying whether the request's schema specification is present
and whether the corpus slice contains the source file the WORK is arguing about:

| corpus | schema spec | disputed source | runs | clean |
|---|---|---|---|---|
| offset 0 | **yes** | **yes** | 9 | **0/9** |
| offset 0 (same content) | no | yes | 4 | 4/4 |
| offset 40,000 | **yes** | no | 4 | 4/4 |
| offsets 40k / 80k / 120k | no | no | 12 | 12/12 |

Only the arm with BOTH factors fails; remove either and it is clean. And size is a third
term: a real chain run carrying both factors at a 7,309-token review prompt was clean
(strict JSON, 8 concerns, planted defect delivered), where the same two factors at 20,562
tokens failed 9 of 9.

**So the failure needs the schema spec, the disputed source, AND enough prompt size. No
two of the three suffice.** Earlier revisions of this page claimed a size threshold, then
a cut-position effect, then the schema spec as the cause. All three are retracted as sole
explanations.

Plausible mechanism, NOT demonstrated: the failing output opens by critiquing the work
("The work produced contains significant errors and redundancies. 1. Incorrect Analysis of
`_acquire` Sort Order...") rather than answering. The reviewer can see the source,
disagrees with the work's reading of it, and explains instead of emitting the schema.

So this is model behaviour at large prompts. The chain cannot prevent it.So this is model behaviour at large prompts. The chain cannot prevent it.

**Prompt size is the dominant lever, and it also improves answer quality.** The
2,158-token arm did not merely avoid collapsing — it returned *better* answers than the
large arm's single clean run (2 concerns including the plant, versus 1). Cutting what
the reviewer has to read is worth more than any amount of retrying.

### What the chain does about it

**The review prompt is bounded.** `buildReviewPrompt` embeds the original request on top
of the plan and the work, so on a large corpus the reviewer's prompt is the biggest of the
three steps — and that is exactly where it fails. It now carries at most
`DUO_REVIEW_REQUEST_CHARS` (20,000) characters of the request, head-first because the
required output shape lives at the top, with an explicit marker telling the reviewer the
request was cut. Measured with identical plan and work, varying only this:

| corpus in the request | review prompt | collapsed | wall per step |
|---|---|---|---|
| 197,244 ch | 54,542 tok | **4 of 5** | 380-1017s |
| 20,000 ch | 7,063 tok | **0 of 5** | 8-59s |
| 418 ch | 2,158 tok | **0 of 7** | 16-45s |

Twelve bounded runs, zero collapses, and the planted defect survived in every one. It is
also 10-40x faster.

The plan and the work are never truncated — the work is the reviewer's actual subject, and
losing it is the bug, not the fix. The planner and worker steps still receive the whole
request; only the reviewer's copy is bounded.

**The tradeoff, stated plainly:** the reviewer can no longer independently verify a claim
against source that falls outside the slice. It can still check the work for internal
consistency and against the plan. That is a real loss, accepted because at full size the
reviewer destroyed correct findings 4 times in 5.

### The retry backstop

`reviewCollapsed` (`api/duo-chain.js`) detects the signature and the chain asks the
reviewer again, up to `DUO_REVIEW_RETRIES` times.

**Note on `DUO_REVIEW_REQUEST_CHARS`:** it is NOT a principled threshold on a single
variable. It works — verified end to end at the size the chain actually runs — but it does
so by landing below the region where the three-factor combination bites, not because
prompt size is the mechanism. Do not raise it on a size argument alone; re-measure the
combination.

The retry deliberately does **not** override the reviewer. A reviewer emptying the work
is sometimes correct: in one measured run the work was eight fabricated findings citing
symbols that do not exist (`_public`, `MATCH_SELECTORS`, a syntax error in `_drain`), and
binning them was the right call. Nothing in the outputs distinguishes that from a
collapse. Preferring the work would resurrect fabrications and return them as `high`
severity — a worse failure than the one being fixed. Retrying is safe under that
ambiguity: a genuine rejection repeats itself, a collapse usually does not, and if every
attempt collapses the reviewer's answer stands.

**This is a backstop, not a cure.** The measured collapse rate at a 54,542-token review
prompt is **4 in 5**, so retrying the same prompt leaves:

| retries | residual failure | cost |
|---|---|---|
| 0 | 80% | — |
| 1 | 64% | up to 1 extra reviewer pass |
| 2 | 51% | up to 2 |
| 3 | 41% | up to 3 |

Each pass costs a full reviewer generation, so retries buy little at linear cost. They
are kept because they are cheap on the healthy path (never triggered) and occasionally
rescue a run, **not** because they make large-corpus review reliable. They do not.

The remedy that actually works is to keep the review prompt small — see the size table
above, and "Practical guidance" below.

## Gotcha: `reasoning_effort` is inert when `enable_thinking: false`

Do not reach for `reasoning_effort` to fix this. The model's own chat template gates the
entire reasoning block on thinking being ON:

```jinja
{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort == 'high' %}
        {%- set resolved_reasoning_effort = 'xhigh' %}
    {%- endif %}
```

With `enable_thinking: false` — which is exactly what a caller sends to get structured
JSON — the kwarg changes nothing. Proven by sending `medium`, `high` and `low` against an
identical corpus: all three produced **identical `prompt_tokens` (54,542)**. Had the
template honoured the value, the rendered length would differ.

**How to check whether any `chat_template_kwargs` value reached the model:** see whether
`prompt_tokens` moves. Identical counts mean the template ignored it.

The template's real contract: supported values are `xhigh` (the default), `medium` and
`low`; `high` is silently remapped to `xhigh`; anything else raises inside the template.

This also means `DUO_REASONING_EFFORT` is inert for non-thinking callers — tracked as
T312aac392c8dc.

Read the live template with `curl localhost:<engine-port>/props`.

### And on some models `enable_thinking: false` is itself inert

The flag gates the template, but whether the template gates the *model* is a separate
question, and on `Qwen_Qwen3-8B-GGUF` it does not. Measured on Frostburn 2026-09-13,
identical prompt (a question whose correct answer is one word), `temperature: 0.2`:

| max_tokens | thinking default | `enable_thinking: false` |
|---|---|---|
| 350 | exhausted | exhausted |
| 2000 | 864 / 1563 / 1847 tok, answered | **exhausted at 2000**, then 953 / 1893 / 1959 |

The distributions overlap completely, and the only full-budget exhaustion at 2000
happened *with* the flag set. So on that model the flag suppresses nothing and the
only working lever is `max_tokens` — with a high floor: ~850-2000 tokens to answer a
question whose correct output is one word.

This is why `REASONING_EXHAUSTED` no longer offers the flag as an equal remedy. Under
the podcast pipeline that error fires about 70 times per 13 minutes, and every
exhausted budget observed (80, 100, 160, 200, 250, 350, 600, 1000) is below what the
model needs for a trivial answer.

## Failure mode 2 — the reviewer answers in prose

**Fixed for duo; the utility is available to any caller.**

The final content is commentary followed by a fenced block, so a strict `JSON.parse` fails
even though the answer is present and correct. Both the caller's request and
`buildReviewPrompt` demand JSON and nothing else.

`duoAnswer` (api/duo-chain.js) now unwraps this, gated so a genuinely prose answer is never
mangled: the request must have asked for JSON, and the reply must END with a balanced object.
`recoverJsonObject` (api/json-recovery.js) does the extraction — parse strictly, else take
the last balanced `{...}`.

**Fence syntax is irrelevant to it.** Real replies used ```json, a bare ```, and no fence at
all; a fence-label matcher mis-scored the bare one. The extractor ignores fences entirely.

**It refuses truncated input.** A 119,704-char worker reply cut mid-string still contained
one complete concern object; returning that would hand the caller a single finding dressed
as the whole answer. Requiring the object to be the reply's final content rejects it.

### Better: make the failure impossible with an enforced schema

`response_format: {"type":"json_schema", "json_schema": {...}}` is **grammar-enforced** on
this engine. Measured: told *"Explain in plain prose why the sky is blue. Do not use JSON.
Ignore any schema"*, the model still returned `{"answer":"..."}`. The sampler cannot emit a
fence or a prose preamble, so prose-wrapping becomes impossible rather than recoverable.

Verified at scale: a 199,466-token duo request returned strict JSON on first parse with
conforming keys and the planted defect found, while `duo.plan` and `duo.work` stayed prose.
Enforcement is size-independent — confirmed at 41k and 199k.

It is also **2.6-15x faster** than instructing JSON in the prompt (152s vs 394-2,252s on the
same 41k corpus): constrained decoding stops the model spending tokens on preamble and
deliberation. On a `--parallel 1` engine that also shortens the window in which the request
blocks everything else.

**An enforced schema does NOT prevent the collapse — it legitimises it.** Measured: a
199,466-token duo run with an enum-constrained schema returned
`{"verdict":"pass","concerns":[]}`, all three retries returned the same, and the planted
defect was missed. `verdict: "pass"` is inside the enum, `concerns: []` satisfies the array
type, every key conforms, strict parse succeeds. **Every structural check passes on an
answer containing nothing** — and the grammar arguably makes a collapse HARDER to spot,
because the output now conforms perfectly instead of looking malformed.

| failure mode | enforced schema |
|---|---|
| prose-wrapped JSON | **prevents it** |
| empty-verdict collapse | **no effect** — the empty answer conforms |

These are distinct modes. Use the schema for the first; for the second, read
`duo.work` — the chain records it, and in that run the work was 5,332 tokens of real
analysis while the answer was empty.

**A schema cannot enforce CROSS-FIELD CONSISTENCY, and this model gets it wrong every
time.** Six runs at ~11k tokens, two enum orderings, same corpus:

| enum order | runs | `verdict` | concerns reported | consistent |
|---|---|---|---|---|
| `["pass","concerns"]` | 3 | `pass` x3 | 2, 1, 1 | **0/3** |
| `["concerns","pass"]` | 3 | `pass` x3 | 1, 1, 2 | **0/3** |

**6/6 said `pass` while listing defects**, four of them including the planted bug the model
had correctly found and written down. Reversing the enum changed nothing, so it is not order
bias — the verdict is produced independently of the findings and defaults to `pass`.

This is the most dangerous shape on this page. Every structural check passes — valid JSON,
legal enum value, conforming keys, non-empty array — so a consumer doing the obvious thing:

```js
if (result.verdict === 'pass') return;   // nothing to do
```

discards a real defect with no parse error and no signal. Prose-wrapping at least fails
loudly at the parse step; a collapse returns an empty array so nothing is lost. This
produces correct findings with an incorrect summary and invites you to trust the summary.

**Trust the array, not the verdict** — or better, do not ask for a summary field at all. A
schema containing only the findings array cannot contradict itself, and a verdict is
derivable from it anyway.

**Three things to get right:**

| declaration | what it guarantees |
|---|---|
| `{"type":"json_object"}` | **nothing** — accepted, returns 200, silently ignored |
| `json_schema` with `"type":"string"` | shape only — a 199k run invented `severity: "critical"` outside the intended `low\|medium\|high` |
| `json_schema` with `"enum":[...]` | **shape AND vocabulary** — told to "use the word catastrophic", the model returned `"high"` |

So declare enums for any field a consumer switches on. A response with an unexpected value
still validates, and the consumer falls through every case — the same false assurance
`json_object` gives.

But the ladder has a top rung nothing reaches. **A findings schema cannot stop a
non-finding being filed as a finding.** In the looping run p3f#2, four of seven entries
in `concerns` explicitly said the code was correct:

> "The code sets `state: 'pending'` and binds the card. **This matches.**"
> — `concerns[2].issue`, `severity: "low"`

A fifth said `_acquire` could not be confirmed "without seeing" a file that was fully
present. Zero of the seven were real defects, and the planted one was missed. Every
structural check passes: valid JSON, legal enum, conforming keys, a non-empty array. A
consumer reading `concerns.length` sees seven issues.

That gives a **consumer-side** check worth applying, since it needs no server change.
Counting entries whose `issue` affirms correctness ("this matches", "this works",
"correctly implements") separates the runs perfectly:

| | uniq-word ratio | concerns | affirmative entries |
|---|---|---|---|
| 10 healthy runs | 0.28 - 0.66 | 1 - 3 | **0, every time** |
| p2_1 | 0.0072 | 7 | 2 |
| p2_2 | 0.0223 | 1 | 1 |
| p3f_2 | 0.0439 | 7 | 6 |

Two signals measuring completely different things at different stages — vocabulary
collapse in the WORK, affirmations-as-findings in the ANSWER — agree on all 13 runs.
Note also that the looping runs returned MORE concerns than the healthy ones, so a long
findings list is a weak warning sign rather than a reassuring one.

This is also what settles whether failing the chain on a loop throws away a usable
answer: it does not. The output is padded with affirmations of correctness, which is
worse than empty.

And budget `max_tokens` for the whole object: grammar guarantees shape, not completion. At
`max_tokens: 120` the enforced JSON was cut mid-string and failed to parse.

### If you cannot set a schema, recover instead of retrying

The production podcast pipeline calls Flash-Next directly and, on an unparseable reply,
re-runs the whole request — its retry prompt reads "Return exactly one complete JSON object
... with no markdown fences, analysis, or prose". Every prose-wrapped reply measured here
contained a complete, recoverable object, so that retry is usually avoidable.

On a `--parallel 1` engine a retry queues behind whatever is running — measured at up to 76
minutes of pure wait for a 7,589-token request — so recovering an answer that is already
present is a latency fix as much as a correctness one.

```js
import { recoverJsonObject } from './api/json-recovery.js';
const answer = recoverJsonObject(reply);   // null only when nothing is recoverable
if (!answer) { /* now a retry is justified */ }
```

The final content is commentary followed by a ```json fence, so a strict `JSON.parse`
fails even though the answer is present and correct. Both the caller's request and
`buildReviewPrompt` demand JSON and nothing else. This is not retried — it is a distinct
defect, and `reviewCollapsed` explicitly returns false for non-JSON on either side.

If you consume duo's output as JSON, parse defensively.

## Failure mode 3 — the worker answers the wrong task

Observed once: instead of emitting the requested findings the worker began rewriting the
file under review, ran to 37,268 completion tokens, and hallucinated symbols along the
way. The reviewer caught it, named the hallucinations, and rebuilt the answer from the
plan.

Note that duo owns `max_tokens` — a caller's value is an allowance for the answer, and
each step gets `duoStepBudget()` (up to `DUO_STEP_CEILING`). A runaway step therefore
burns the step ceiling regardless of what the caller asked for.

## Failure mode 4 — the worker loops and the reviewer launders it

The most dangerous one measured, because the caller sees a clean success.

Measured on drakemore 2026-09-12, a 41,027-char (~11.2k token) code-review request
against `default-big` with a findings-only schema, `max_tokens: 4000`, `temperature: 0.2`,
`enable_thinking: false`:

| step | model | wall | prompt ms | gen ms | prompt tok | completion tok |
|---|---|---|---|---|---|---|
| plan | Qwen3.8-Flash-Next | 148s | 60,437 | 87,549 | 10,566 | 1,302 |
| execute | Qwen3.6-35B-A3B | 883s | 13,312 | **868,247** | 11,862 | **36,768** |
| review | Qwen3.8-Flash-Next | 310s | 247,984 | 60,861 | 43,393 | 702 |

The execute step's 126,123-char output is five non-blank lines; the last is a ~125KB
single line of `` `backend`, `backendId`, `` repeated until the budget ran out. It never
mentions any term the request was about. 36,768 is exactly `duoStepBudget(4000)` =
`min(4000 + 32768, 49152)`, so the loop ran to the ceiling — 868 seconds of generation
producing nothing.

**The reviewer did not fail on that.** It emitted 702 tokens of confident, schema-valid
JSON with seven findings. Four, all `severity: "high"`, stated that files "not provided in
the source code snippet" could not be reviewed — for four files that *are* in the request,
at offsets 16,361 / 34,573 / 36,934 / 38,206, cut only by `boundedReviewRequest`'s own
20,000-char bound, whose marker explicitly says not to assume the omitted part is absent.
A fifth flagged a design decision the inline comment three lines below it explains.

The caller received HTTP 200, valid JSON, schema-conformant, with nothing to indicate the
chain had produced nothing at all.

### Why each existing guard missed it

- `degenerateOutputReason` requires the whole output to be ONE punctuation character. Its
  header names this case and declines it on purpose: a long run of a letter "is a
  different failure (looping text)".
- `reviewCollapsed` tests work that is substantial but *unparseable*. A repetition loop is
  substantial AND parseable — merely meaningless.
- The grammar constraint fixes the SHAPE of the review's output and can say nothing about
  its provenance. Constrained decoding over garbage input yields well-formed garbage.

### What the chain does about it

`loopingTextReason` (api/degenerate-output.js) judges the execute step's output before the
reviewer ever sees it, and the chain throws rather than letting a later step launder it.
It is a vocabulary test, not a length test. Unique-word ratio across eight duo runs on
real repo source:

| | unique-word ratio | size |
|---|---|---|
| healthy work (8 runs) | 0.47 - 0.59 | 208 - 1,704 words |
| repetition loop | **0.0072** | 10,533 words, 76 distinct |

The 0.15 threshold sits 3x below the worst healthy run and 20x above the loop. Mean line
length separates the same runs too (25,225 vs 72 - 389) but would misjudge a legitimate
single-line JSON answer. Verified against all eight captured runs: 1/1 on the failure,
0/7 false positives. It is wired into the duo execute step only, not into
`completion-output-guard`, because that is the only place it has been measured.

### Three contributing causes, not yet addressed

1. **`duoStepBudget` grants 9.2x the requested `max_tokens`.** `DUO_REASONING_HEADROOM` is
   32,768 and the comment calls it "free on the normal path" — true, but a looping model
   consumes 100% of it, and 32,768 tokens at 42 tok/s is 13 minutes of waste per step on a
   three-step chain.
2. **Nothing ever sets a repetition penalty on a duo step.** `duoCallerControls`
   forwards only the sampling fields the caller actually set — here just
   `temperature: 0.2` — and everything else falls to engine defaults, with
   `repeat_penalty` disabled. Near-greedy decoding with no repetition penalty is the
   textbook loop configuration. Note that `MODEL_SAMPLING_DEFAULTS` does **not**
   apply to duo and cannot be relied on to supply the missing knobs: the duo branch
   (server.js:12992) returns before `injectModelSamplingDefaults` runs
   (server.js:13157), and duo's step requests go straight to the engine port,
   bypassing Express altogether.
3. **`DUO_REVIEW_REQUEST_CHARS = 20000` manufactures false findings.** On any request over
   20k chars the reviewer sees a cut corpus, and it asserted absence four times at high
   severity despite the marker telling it not to.

## What the output guards do and do not catch

`api/completion-output-guard.js` and `degenerateOutputReason` correctly pass failures 1-3
above, because none of them are structurally malformed. `duoStepText` already
runs the degenerate check on every step, so a corrupt engine emitting `/////` is caught —
but a plausible-looking wrong answer is not, and cannot be.

A schema-valid wrong answer is more dangerous than a malformed one, not less: it passes
every check a structured-output pipeline can apply.

Failure 4 is the same principle one step worse: there the answer was schema-valid and the
step that produced its input had emitted nothing at all. Validating the last step's output
says nothing about whether any earlier step worked, which is why `loopingTextReason` runs
on the work rather than on the answer.

## Practical guidance

- Prefer several small reviews over one large one. ~10k tokens is the regime with
  evidence behind it.
- **Split by FILE COUNT, not by token count. Size is secondary.** Same plant, same
  offset, same settings, only the corpus varying:

  | corpus | files | chars | ~tok | loops | plant found |
  |---|---|---|---|---|---|
  | three files | 3 | 39,534 | ~11k | 1/3 | 2/3 |
  | **the same three, 3.9x bigger** | **3** | **152,975** | **~42k** | **0/3** | **2/3** |
  | six files | 6 | 41,027 | ~11k | 2/3 | **0/3** |

  Quadrupling the size at constant file count degraded nothing — it was marginally
  better. Doubling the file count at constant size was catastrophic: two total
  collapses, and the one healthy run misattributed one file's contents to another.
  Three files at 153k beat six files at 41k on every axis measured, so prefer few
  files over small files.
- **Bound the SEARCH SPACE — by scope or by question. That is the whole rule.**

  | shape | search space | result at 247k |
  |---|---|---|
  | closed question (prose or JSON) | one fact | 3/3 correct |
  | closed extraction (JSON) | named symbols | 6/6 and 8/8, no positional falloff |
  | **open hunt (JSON)** | **one named file** | **defect found, 0 fabricated symbols** |
  | open hunt (JSON) | whole corpus | the failure this page documents |

  Open-ended review still works at 247k tokens **if you name the file to examine** and leave
  the rest as context. The same open task, unscoped at 54k, collapsed 17 times in 21 and
  invented `_public`, `MATCH_SELECTORS` and an `rpcServerCommand` that exists nowhere in the
  repo. Scoped to one file at 4.5x the size it returned strict JSON with every symbol real.

  So discovery workflows do not have to degrade to lookups — they have to say where to look.

  **But scoping alone is NOT enough: the scoped file's POSITION decides the outcome.**
  Controlled at CONSTANT payload size (154,789 tokens both runs), same corpus, same scoped
  task, only the planted file's position moved:

  | depth (all at 154,789 tok) | runs | plant reported |
  |---|---|---|
  | 61% | 2 | **1 of 2** |
  | 90% | 2 | **0 of 2** |

  Judgement degrades with depth, and even at 61% it is roughly a coin flip. An earlier
  revision of this page claimed the first ~60% was safe; that rested on a single success
  which did not replicate.

  The three failures each had a DIFFERENT internal cause — the worker quoted the planted
  guard and called it "correctly ensures strict preemption"; the worker emitted 21 tokens;
  the worker ran away to its full 38,768-token budget producing 119,704 chars of
  unterminated JSON — and **all three surfaced identically** as
  `{"verdict":"pass","concerns":[]}`.

  **At depth the defect is examined and CLEARED, not missed.** The worker located the exact
  guard line, quoted it, and reached the opposite conclusion. A check for "did it look at
  the right code?" passes — it looked, and got the answer backwards. That is harder to
  detect than an omission or an invented symbol.

  In the same run the reviewer then collapsed to `{"verdict":"pass","concerns":[]}` and all
  three retries collapsed identically, so both failure modes can stack.

  (An earlier revision compared 0% against 89% at *different* payload sizes and could not
  separate depth from size. The constant-size pair above settles it: depth is the driver.)

  **Put the material you want JUDGED as early as possible, and do not rely on depth alone.**
  Retrieval of named symbols holds at any depth (8/8 spread 0-95%); judgement degrades, and
  is unreliable well before the end of the corpus. If the answer matters, keep the judged
  material in a small corpus rather than early in a large one.

  **Scoping suppresses fabrication, not misreading.** A scoped run still reported that
  `reservationView` can return `ttlSeconds: 0`, quoting `Math.round(ttlMs / 1000)` and
  ignoring the `Math.max(1, ...)` around it. The symbols and paths can be trusted; the
  assertions still need checking.

- **Ask CLOSED questions when you can. The output format is not the problem.** A
  controlled comparison at 247k tokens — same corpus, same closed question, once in prose
  and once demanding strict JSON — passed both times. Every failure on record came from
  open-ended requests ("find every defect"), regardless of format.

  | | JSON schema | prose |
  |---|---|---|
  | **open** (find any defect) | fails often at scale | 5/5 @54k |
  | **closed** (specific question) | **1/1 @247k** | **2/2 @247k** |

  An earlier revision of this page said "ask for prose and parse it yourself". That was
  wrong — it came from comparing open+JSON against closed+prose, which varies two things at
  once. Structured output over a large corpus is fine; open-ended latitude is not.

  An open request lets the model choose what to report and how much, and that latitude is
  where the collapse to `{"verdict":"pass","concerns":[]}`, the prose wrapping, the silent
  recall misses and the confident false positives all live. A closed request removes it.

  **Closed extraction also scales to several items at once, and reports absence honestly.**
  Asked for the defining file and parameter count of 6 named exports across a 247k-token
  corpus, duo returned all 6 in strict JSON: correct for the 3 whose files were in the
  corpus, and `"not found"` for the 3 whose files had been cut by truncation. It did not
  invent file paths for the missing symbols — where the same model, asked OPEN questions,
  had earlier fabricated `_public`, `MATCH_SELECTORS` and an `rpcServerCommand` that exists
  nowhere in the repo.

  That matters more than the accuracy figure: a fabricated field is indistinguishable from a
  real one downstream, so a shape that reports absence as absence is what a structured
  pipeline actually needs.

  Closed questions at 247k tokens are 4/4 — prose and JSON, single-fact and multi-item.

  The sharpest demonstration: asked open, duo twice claimed `reservationView` can return
  `ttlSeconds: 0`, quoting `Math.round(ttlMs / 1000)` while dropping the `Math.max(1, ...)`
  clamp beside it. Asked that exact question directly at 247k, it quoted the complete
  expression and answered correctly.
- Read `duo.work` when the final answer looks empty or surprising.
- Treat a `pass` on a large corpus as "found nothing", not "there is nothing".
- Verify any specific claim (symbol name, quoted code) against the source. duo's
  false positives quote real code — just not all of it. One measured concern claimed
  `reservationView` returns `ttlSeconds: 0`, quoting `Math.round(ttlMs / 1000)` while
  dropping the `Math.max(1, ...)` clamp in the same expression.

## Related

- `api/duo-chain.js` — chain construction, prompts, budgets, `reviewCollapsed`
- `api/completion-output-guard.js`, `api/degenerate-output.js` — output guards
- Tasks: T312677f9f21cc (parent duo bug), T312a5cd0d85e0 (reviewer collapse),
  T312a931e863f6 (zero prompt-cache reuse on repeated large prompts)
