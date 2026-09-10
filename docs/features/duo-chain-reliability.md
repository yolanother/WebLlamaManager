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
| instructions only | 2,158 | 3 | 0 |
| full corpus in the request | 54,542 | 2 | 1 |

So this is model behaviour at large prompts. The chain cannot prevent it.

### What the chain does about it

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

**This reduces the failure rate; it does not eliminate it.** At a measured ~1-in-2
collapse rate, one retry leaves roughly 1 in 4.

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
