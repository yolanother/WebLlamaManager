<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Operator guide to smart aliases: the `type: 'smart'` alias group that asks a
System 1 decision model (Laya or Jev) to classify each request and routes it to
the best-sized/best-domain candidate instead of always trying targets in a fixed
order. Documents the `PUT /api/aliases/:name` shape, how a candidate is chosen
(size inference, the difficulty-to-index formula, the domain filter, the resident
rule), the no-block fallback to `targets[0]` and Laya's lazy warm-up, the
Laya/Jev/Jev→Laya provider setting and its privacy note, the
`x-llama-smart-choice`/`x-llama-smart-reason` response headers, which endpoints
route through it, and its known limits. Read this before authoring a smart alias
or debugging why it picked the candidate it did.
-->

# Smart Aliases

A **smart alias** is a `config.aliases` entry with `type: 'smart'`. Like an
ordinary (failover) alias, it is a named group of candidate models that clients
request by name. Unlike a failover alias, it does not always prefer the same
order: for every request it asks a System 1 decision model — local **Laya** or
hosted **Jev** — to score the prompt's difficulty and guess its domain, then
picks the candidate that best fits. Simple prompts go to the smallest candidate;
harder prompts go to larger ones; a confident domain match (e.g. `code`) narrows
the pick to candidates tagged with it. Laya and Jev are classifiers only — they
never generate the reply — so a smart alias always hands the request to a real
candidate LLM, the same way a failover alias does.

See [`model-alias-groups.md`](model-alias-groups.md) for the alias table itself
(host/model targets, globbing, the warm gate); this doc covers only what is
specific to the `smart` type.

## Configuring one

In **Settings ▸ Aliases**, set an alias's type toggle to **Smart**. This adds,
per alias:

- a System 1 override select (**inherit**, **Laya**, **Jev**, **Jev → Laya**);
- per-candidate reordering — first position gets a **fallback** badge;
- a per-candidate **Domain** dropdown (blank, or one of the six domains below);
- a per-candidate **Size (B)** field. When left blank it shows the size the
  server inferred (e.g. `≈8B inferred`), or `unknown — set size` when nothing
  could be inferred.

Over the API, `PUT /api/aliases/:name` takes the same body as a failover alias
plus `type` and the per-target `domain`/`sizeB`:

```bash
curl -sS -X PUT http://127.0.0.1:5250/api/aliases/smart \
  -H 'content-type: application/json' \
  -d '{
    "type": "smart",
    "system1": "jev",
    "targets": [
      { "host": "local", "model": "qwen3-8b" },
      { "host": "local", "model": "gpt-oss-120b", "domain": "code" },
      { "host": "drakemore", "model": "mystery-model", "sizeB": 30 }
    ]
  }'
```

- `targets[0]` is both the lowest-priority tiebreak and the **fallback**
  candidate — see below.
- `domain` is one of `code`, `math_or_logic`, `writing`, `factual_lookup`,
  `data_analysis`, `chitchat`.
- `sizeB` is billions of parameters (total, for MoE models); it overrides
  inference for that one target.
- `system1` is optional and overrides the global provider (`config.decision`)
  for this alias only.
- `GET /api/aliases` echoes each smart target with an added `inferredSizeB` —
  what the server would infer for that target ignoring any authored `sizeB` —
  which is display-only and never round-trips into a save.

## How a candidate is chosen

1. **Size**, in this order: the target's authored `sizeB`; else a size parsed
   from the model name (the largest `<n>b` match not followed by a letter, so
   `30B-A3B` reads 30); else, for a local model, its file size on disk divided
   by ≈0.6 GB per billion params (a quantization-agnostic heuristic); else
   unknown. An unknown size ranks **largest**, so it is never picked over a
   known-smaller candidate by mistake.
2. **Domain filter.** When System 1's domain answer has confidence ≥ 0.5 *and*
   at least one candidate is tagged with that domain, the pool is narrowed to
   just those candidates. Otherwise every candidate is in the pool.
3. **Difficulty → index.** The pool is sorted by size, ascending (ties break on
   authored order). System 1's difficulty score (0–3) maps onto that sorted
   list: `idx = round(clamp(score, 0, 3) / 3 × (poolSize − 1))` — 0 picks the
   smallest, 3 picks the largest.
4. **The resident rule.** If the candidate at `idx` is not currently resident
   (loaded locally, or a reachable warm remote), the search moves forward
   through the rest of the sorted pool for the first resident one. If none of
   them is resident, the original `idx` pick is used anyway (accepting a cold
   load) rather than falling back to something smaller and warm.

## Fallback

A smart alias never blocks a request on System 1. Every leg — a cold local
engine, a missing Jev key, a timeout, a non-2xx response, or a bad answer shape —
is treated the same way: serve **`targets[0]`** (the alias's first/fallback
candidate) and fire a **background** warm-up of Laya (not awaited, and skipped
for a Jev-only provider or under low free memory). System 1 gets a **1 second**
budget per request; `jev-then-laya` gives *each* leg its own full second, so the
worst case for that provider is 2 seconds before falling back.

A cold Laya container therefore never delays the answer: the first request or
two after Laya has been idle falls back while it warms up, and once it is warm
subsequent requests get a real classification.

## System 1 providers

Three providers, set globally (`config.decision.provider`, the Dashboard
**Decision** card) or per-alias (`system1`, overriding the global setting for
just that alias):

- **`laya`** — the local, self-hosted classifier. See
  [`laya-decision-engine.md`](laya-decision-engine.md) and
  [`../research/System 1/laya.md`](../research/System%201/laya.md).
- **`jev`** — TypeSafe's hosted API (`api.typesafe.ai`). Requires a Jev API key
  (see [`jev.md`](../research/System%201/jev.md)); a missing key is treated as
  a fallback cause (`no_jev_key`), not an error response.
- **`jev-then-laya`** — try Jev first, fall back to Laya on any failure.

The Jev API key and model name are set on the Dashboard **Decision** card. The
key is write-only: the field is always blank, shows `key set — type to replace`
once one exists, and is never echoed back by any read. **The key input, and the
provider controls in general, are loopback-only** — `POST /api/decision/config`
only accepts changes from a request originating on this machine, so they cannot
be set from a browser on another host. When the provider is anything but
`laya`, the UI shows the privacy note:

> Jev sends the start of each prompt to TypeSafe (api.typesafe.ai).

## Headers

Every response routed through a smart alias carries two headers:

```
x-llama-smart-choice: local/gpt-oss-120b
x-llama-smart-reason: laya:d=2.1,domain=code
```

`x-llama-smart-choice` is `<host>/<model>` of the chosen candidate.
`x-llama-smart-reason` is either:

- `<provider>:d=<difficulty>,domain=<choice>` — a real System 1 answer, e.g.
  `laya:d=2.1,domain=code` or `jev:d=0.0,domain=chitchat`;
- `fallback:<cause>` — System 1 was not consulted or its answer was rejected,
  e.g. `fallback:no_decision_host` (no Laya peer or local engine could serve),
  `fallback:no_text` (the request carried no extractable prompt text), or
  `fallback:jev_429` (Jev rate-limited the call).

## Endpoints

Smart-alias routing runs on `/v1/chat/completions`, `/v1/completions`,
`/v1/responses`, and `/v1/messages` (Anthropic-shaped). It reads the request's
last user-authored text from whichever of those four body shapes applies.

**Embeddings requests against a smart alias return 400**:

```json
{ "error": { "message": "smart aliases route text generation only; name a model for embeddings",
             "type": "invalid_request_error", "code": "smart_alias_not_supported" } }
```

A smart alias's candidates are also listed as remote/duo-transparent to the
existing backend resolution — GPU pools, queueing, and the warm gate all apply
to the single candidate System 1 picked, unchanged.

## Limits

- **Laya reads only the start of the prompt** — about 320 tokens on the
  `english` checkpoint, about 768 on others (`laya-typed-decisions`, the one
  llama-manager actually loads, is in that second group). A long prompt whose
  distinguishing content is further in is classified on an incomplete read.
- **Accuracy:** Laya's own benchmarks report domain routing accuracy around
  0.66 (`laya-typed-decisions`: 0.659). **No accuracy figure is published for
  the difficulty score** — treat it as a rough size hint, not a calibrated
  measurement.
- **Name-based size parsing takes the largest `<n>b` match**, which is right
  for a MoE name like `30B-A3B` (30) but wrong for a Mixtral-style name like
  `8x7B`, where the intended total is 56B, not the 7 the regex would find as
  its largest bare match (`8` has no unit suffix, so `7` wins). Set `sizeB`
  explicitly for any candidate whose name reads wrong.

## Links

- Design: [`../superpowers/specs/2026-09-23-smart-alias-design.md`](../superpowers/specs/2026-09-23-smart-alias-design.md)
- Research: [`../research/System 1/laya.md`](../research/System%201/laya.md) ·
  [`../research/System 1/jev.md`](../research/System%201/jev.md)
- Related: [`model-alias-groups.md`](model-alias-groups.md) ·
  [`laya-decision-engine.md`](laya-decision-engine.md)
