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

- **At small payloads (~10k tokens) the chain is reliable.** Measured 2/2 correct, strict
  JSON, on a corpus containing a planted defect.
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

| prompt size | prefill rate |
|---|---|
| 6k | 181 tok/s |
| 54k | 144 tok/s |
| 170k | 104 tok/s |
| 213k | 84 tok/s |
| 247k | 86 tok/s — decay has flattened |

The execute step runs 3x faster (266 tok/s at 247k) because its prompt shares the request
prefix with the plan step and hits the prompt cache. Only the first big step pays full
price.

Healthy `unaccountedMs` is **182ms to 15s** per step. One run showed 56.6 minutes there and
has never reproduced; anything approaching the engine's 3600s per-step read timeout is a
fault, not the expected cost of a large request.

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
- not `MODEL_SAMPLING_DEFAULTS` — temperature was explicit on every run

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

## Failure mode 2 — the reviewer answers in prose

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

## What the output guards do and do not catch

`api/completion-output-guard.js` and `degenerateOutputReason` correctly pass all three
failures above, because none of them are structurally malformed. `duoStepText` already
runs the degenerate check on every step, so a corrupt engine emitting `/////` is caught —
but a plausible-looking wrong answer is not, and cannot be.

A schema-valid wrong answer is more dangerous than a malformed one, not less: it passes
every check a structured-output pipeline can apply.

## Practical guidance

- Prefer several small reviews over one large one. ~10k tokens is the regime with
  evidence behind it.
- **Ask CLOSED questions, not open ones. The output format is not the problem.** A
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
