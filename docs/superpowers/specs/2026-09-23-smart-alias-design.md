# Smart Alias — Design

**Date:** 2026-09-23 · **Status:** approved in conversation, pending written review
**Research:** [Laya](../../research/System%201/laya.md) · [Jev](../../research/System%201/jev.md) · Deployment: [Laya decision engine plan](../../plans/2026-09-22-laya-decision-engine.md)

## Goal

A new alias type, the **smart alias**. Like `default-big` and `default-small`, it is a named entry in `config.aliases` that clients request by name. It can hold any set of candidate models. For each request, a System 1 decision model (local **Laya** or hosted **Jev**) classifies the prompt, and the alias routes it to the best-suited candidate:

- simple prompts go to the smallest candidate;
- harder prompts go to larger ones;
- domain-tagged candidates win when the prompt's domain matches.

Laya and Jev are classifiers. They cannot generate text (see [laya.md](../../research/System%201/laya.md) under "Relevance to routing"), so the smart alias always answers through a candidate LLM. The "answer it itself" case is covered by routing trivial prompts to the smallest candidate.

## Decisions (from the design interview)

| # | Question | Decision |
|---|---|---|
| Q1 | Simple cases | Route to the **smallest candidate**. |
| Q2 | How candidates are chosen | **Automatic by size**: difficulty maps onto the size-sorted list. Optional **domain tags** override. |
| Q3 | Endpoints | Chat completions, `/v1/completions`, `/v1/responses`, `/v1/messages`. **Embeddings return 400.** |
| Q4 | System 1 unavailable | Never block a request on System 1. The first target in the list is the **priority/fallback** candidate. Fire a background lazy start of Laya. |
| Q5 | Provider choice | **Global provider + optional per-alias override**: `laya` \| `jev` \| `jev-then-laya`. |
| Q6 | Candidate size | **Inferred** (GGUF params → file size → name parse), with a **manual `sizeB`** override. Unknown size ranks largest. |
| Q7 | Chosen candidate is cold | Use the **smallest loaded candidate at the same position or larger**. Otherwise load the pick. |

## Data model

A smart alias is an ordinary `config.aliases` entry with `type: 'smart'`. When `type` is absent, the alias is today's failover alias and behaves exactly as before.

```js
config.aliases['smart'] = {
  type: 'smart',
  targets: [                                   // authored order = priority; targets[0] = fallback
    { host: 'local', model: 'qwen3-8b' },
    { host: 'local', model: 'gpt-oss-120b', domain: 'code' },
    { host: 'drakemore', model: 'mystery-model', sizeB: 30 }
  ],
  system1: 'jev',                              // optional; overrides config.decision.provider
  gpu, gpuPriority                             // unchanged semantics
}
```

- `domain` is one of `SMART_DOMAINS = ['code','math_or_logic','writing','factual_lookup','data_analysis','chitchat']`. These are the six domains of `laya.router_questions()`. The constant is exported from `api/smart-alias.js` and is the only source of truth for the question and the UI.
- `sizeB` is a positive number: billions of parameters, total parameters for MoE models.
- `system1` is one of `laya | jev | jev-then-laya`.
- Target globs still expand, and every expanded concrete model inherits the target's `domain`, `sizeB` and priority order.
- Add `type`, `system1` to `ALIAS_GROUP_KEYS`. Add `domain` and `sizeB` to the per-target shape. `validateAlias` rejects unknown values. A smart alias needs at least one target.

Global provider settings go in `config.decision`:

- `provider`: `laya` by default.
- `jevModel`: `jev-latest` by default.
- `jevApiKey`: a secret, masked on every read path. `GET` returns only `jevApiKeySet: true|false`.

## Components

### `api/smart-alias.js` (new, pure, dependencies injected)

- **`SMART_DOMAINS`, `SMART_QUESTIONS`.** `SMART_QUESTIONS` is the router question set: `difficulty` is a 4-level score (trivial, easy, moderate, hard) and `domain` is a 6-way choice.
- **`candidateSize(candidate, inventory) → number|null`**, resolved in this order:
  1. `sizeB`;
  2. the local GGUF parameter count;
  3. the local file size (bytes ÷ quantization-agnostic 0.6e9 ≈ B params; a heuristic, marked `ponytail:`);
  4. the size parsed from the name, via the regex `(\d+(?:\.\d+)?)\s*[bB](?![a-z])` with the largest match winning, so `30B-A3B` gives 30;
  5. `null`.

  DS4 and preset candidates use their underlying model.
- **`extractPromptText(endpoint, body) → string`.** Returns the last user text from any of the four body shapes: chat `messages`, completions `prompt`, responses `input`, and Anthropic `messages` with content blocks.
- **`pickSmartCandidate(candidates, verdict, {sizeOf, isResident}) → {candidate, reason}`**:
  1. If `verdict.domain.confidence ≥ 0.5` and some candidates are tagged with `verdict.domain.choice`, the pool is only those tagged candidates. Otherwise it is all candidates.
  2. Sort the pool by size, ascending. `null` counts as +∞, and ties break on the authored `order`.
  3. `idx = round(clamp(score, 0, 3) / 3 × (n − 1))`.
  4. If `pool[idx]` is not resident, use the first resident entry of `pool[idx..]`. If none is resident, keep `pool[idx]`.
- **`routeSmartAlias({name, endpoint, body}, deps) → {candidate, reason, verdict?}`**:
  - Resolves candidates with the existing `resolveAliasCandidates`.
  - Calls `deps.askSystem1(SMART_QUESTIONS, {request: text}, {provider, timeoutMs: 1000})`.
  - On any throw or timeout, returns the candidate with `order` 0 and `reason: 'fallback:<cause>'`, and calls `deps.warmSystem1()` without awaiting it.

### `askSystem1` in `api/decision.js`

`askSystem1(questions, state, {provider, timeoutMs}) → {answers, provider, model}` throws on failure.

- `laya` follows the existing route plan: peers, then the local container (via `supervisor.ensureStarted`), otherwise throw `no_decision_host`. For the smart alias, the "local" leg must not wait for a cold start. It throws `cold` and relies on `warmSystem1`.
- `jev` sends `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <jevApiKey>` and `model: jevModel`. It throws on a missing key, a non-2xx response, or a timeout. There are no retries.
- `jev-then-laya` tries `jev`, and on any throw tries `laya`.

The existing `/v1/systemone` proxy follows the global provider:

| Provider | `laya` / `laya-*` / omitted | `jev-*` |
|---|---|---|
| `jev` | answered by Jev, using `jevModel` | forwarded unchanged to TypeSafe |
| `jev-then-laya` | tries Jev, falls back to Laya | tries Jev, falls back to Laya |
| `laya` | unchanged (today's behavior) | unchanged (today's behavior) |

### Server wiring (`api/server.js`)

- The chat, completions, responses and messages handlers call `routeSmartAlias` when `config.aliases[model]?.type === 'smart'`. They do this before `resolveRequestModel`, and chat does it before the duo check.
- The chosen candidate goes into the existing `resolveBackend` path as a single-candidate alias routing. Remote, DS4, duo, GPU-pool and queue handling are therefore unchanged.
- Response headers: `x-llama-smart-choice: <host>/<model>` and `x-llama-smart-reason: <provider>:d=<score>,domain=<choice>` or `fallback:<cause>`.
- Embeddings with a smart alias return 400 `{error:'smart_alias_not_supported'}`.
- `/v1/models` lists smart aliases with `owned_by: 'smart-alias'`.

## UI

- **Settings → Aliases** (`AliasesSection`, `alias-editor.js`):
  - a type toggle, Failover or Smart;
  - for smart aliases: reordering by priority, with a "fallback" badge on the first candidate;
  - a per-candidate domain dropdown (none plus `SMART_DOMAINS`);
  - the inferred size, with a `sizeB` input shown when it is unknown;
  - a System 1 override: inherit, Laya, Jev, or Jev → Laya.

  The pure helpers round-trip the new fields and validate them.
- **Dashboard Decision card**:
  - a provider selector;
  - a Jev API key input (write-only, shows set or unset) and the Jev model;
  - the privacy note: "Jev sends the start of each prompt to TypeSafe (api.typesafe.ai)".

## Error handling

| Situation | Result |
|---|---|
| System 1 down, cold, slow (> 1 s), 4xx/5xx, or missing Jev key | `targets[0]`, `x-llama-smart-reason: fallback:<cause>`. Laya warm-up is fired. |
| Smart alias resolves to zero candidates | Same as an empty alias today: 404 or model-not-found. |
| Chosen candidate fails downstream | Existing backend behavior. The smart alias does not retry a different candidate. |

## Testing (TDD, red first)

- **`api/smart-alias.test.js`**:
  - size inference order;
  - name parsing (`8B`, `120b`, `30B-A3B`, `qwen3.6-35b`);
  - difficulty mapping for n = 1…5;
  - domain filter, above and below 0.5 confidence;
  - the resident-candidate rule;
  - fallback on throw and timeout, with `warmSystem1` called;
  - `extractPromptText` for all four body shapes.
- **`api/decision.test.js`**:
  - `askSystem1` for each provider with a stubbed fetch;
  - the Jev bearer header and model;
  - 401, 429, 529 and missing key cause a throw, and `jev-then-laya` then falls to Laya;
  - the `/v1/systemone` proxy's behavior under each provider.
- **`api/model-aliases.test.js`**: validation of `type`, `system1`, `domain` and `sizeB`. Failover aliases are unchanged.
- **`ui/src/pages/alias-editor.test.js`** and **`decision-card.test.js`**: round-tripping of the new fields. The key is never echoed.
- **`tests/aliases/run-tests.sh`** (black-box):
  - a smart alias with System 1 stubbed down returns `targets[0]` and the fallback header, on both chat and `/v1/messages`;
  - embeddings return 400.

## Docs

- A new `docs/features/smart-aliases.md`, linked from `docs/features/model-alias-groups.md`.
- Update the "How llama-manager uses it" sections in `laya.md` and `jev.md`.
- Run `orch docs sync`.

## Out of scope

- Changes to the existing `auto` / `default-router` classifier.
- Custom question sets per alias.
- Jev retries and backoff.
- Retrying a different candidate after a downstream failure.
- The `needs_tools` and `is_sensitive` signals. These can be added later, when a routing rule needs them.
