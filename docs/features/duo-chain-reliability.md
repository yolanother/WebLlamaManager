# Duo chain reliability

The `duo` model is not a model — it is a three-step chain: a planner writes the steps, a
worker carries them out, and the planner reviews the result and returns the final answer.
The intermediate plan and work are attached to every response under `duo` so you can see
what each step actually produced.

This page records what the chain does and does not guarantee, measured on real repo
source rather than toy prompts.

## The short version

- **At small payloads (~10k tokens) the chain is reliable.** Measured 2/2 correct, strict
  JSON, on a corpus containing a planted defect.
- **At large payloads it is not.** The review step intermittently discards the worker's
  answer and returns an empty one instead.
- **When an answer looks wrong, read `duo.work` before believing `duo`'s final answer.**
  The signal is usually there and correct; the last step is what loses it.
- **To review a large corpus, chunk it.** Several small reviews beat one large one, and
  the small regime is the one with evidence behind it.

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

Every prose run named the planted defect correctly, in 179-274 tokens. One of them:

> The single most serious defect is in the `_acquire` method... The JSDoc and inline
> comments explicitly state that "equal priority never preempts." However, the
> implementation uses `if (!lowest || priority < lowest.priority) return null;`... This
> logic allows preemption when the new claim's priority is equal to the lowest occupant's
> priority (since `5 < 5` is false, the code proceeds to preempt).

So the model is NOT losing its grip on a long prompt in general — it reads the corpus fine
and reasons about it correctly. What fails is producing a *structured* answer at that
size: it emits the minimal instance of the schema instead. Free-form output over the same
input is unaffected.

That matters because structured extraction over large inputs is exactly the podcast
pipeline's use case, and exactly where this bug was first seen.

So this is model behaviour at large prompts. The chain cannot prevent it.

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
- **If you need structured output over a large input, bound the prompt or ask for prose
  and parse it yourself.** Prose survived 5 of 5 at a prompt size where the JSON schema
  failed 17 of 21. Asking for JSON is what breaks, not asking the model to read a lot.
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
