# Model Alias Groups — Design

**Date:** 2026-08-03
**Orch task:** [0DfIVlZNejtccWwVzOKYg](https://orchestrator.doubtech.ai/tasks/0DfIVlZNejtccWwVzOKYg)
**Supersedes:** [2026-06-22-default-model-aliases-design.md](2026-06-22-default-model-aliases-design.md)

## Problem

Three overlapping mechanisms answer "which real model serves this request?", and none of
them can express "this name means any of these several models, wherever they live":

| Mechanism | Where | Scope | Limitation |
|---|---|---|---|
| `backend.modelMapping` | per remote backend, `api/server.js:672` | remote only | cannot name a local model; one target per host; duplicated across hosts |
| `backend.modelMapping["*"]` | per remote backend | remote only | not an alias at all — it is "this host accepts anything", wedged into the alias map |
| `defaultBigModel` / `defaultSmallModel` | global, `api/default-models.js` | local or ds4 | exactly two hardcoded names, exactly one target each |

The driving use case is a `conversational-model` alias that resolves to whichever suitable
model is already warm — a local llama preset, a local ds4 preset, or a model on any remote
host — instead of pinning one. That is inexpressible today.

## Solution

One global `config.aliases` table. An alias name maps to an **ordered list of targets**;
each target names a host (`local` or a backend id) and a model. Resolution expands the
alias into concrete candidates and hands them to the routing ranking that already exists.

### Data model

```js
config.aliases = {
  "conversational-model": {
    targets: [
      { host: "local",                     model: "gemma4-12b-chat" }, // llama preset
      { host: "local",                     model: "Qwen_Qwen3-8B-GGUF" }, // model name
      { host: "borethrax-ollama-mnfmirep", model: "gemma4:*" }         // glob
    ]
  },
  "default-big":   { targets: [{ host: "local", model: "ds4-flash" }] },
  "default-small": { targets: [{ host: "local", model: "Qwen_Qwen3-8B-GGUF" }] }
}
```

**Alias names are exact.** No glob matching on the name — an alias is a literal string a
client sends. This keeps resolution unambiguous (two globs could both match one request)
and lets every alias be advertised as a concrete entry in `/v1/models`.

**Target models may be globs.** Variants are a real thing on remote hosts, so
`{host: "borethrax", model: "gemma4:*"}` is valid and expands against that host's model
list at resolve time. Globs use the existing translation from `resolveModelMapping()`:
`*` → `.*`, `?` → `.`, anchored at both ends.

**Local target kinds.** A `local` target's `model` may name a llama preset id, a ds4
preset id, or a bare model name. Disambiguation follows the engine's existing rule:
if `config.presets[model]` exists it is a preset (ds4 or llama per `isDs4Preset()`),
otherwise it is a model name. This lifts the current restriction in
`validateDefaultModelTarget()`, which rejects llama preset ids — that restriction has no
strong justification and blocks pinning an alias to a tuned launch config (context size,
flags).

**Order is authored intent.** Target order is preserved and used as the final tiebreak
when ranking produces a tie.

**An alias shadows a real model of the same name.** Alias resolution runs at request
entry, before model lookup — the same position `resolveDefaultModel()` occupies today —
so naming an alias after an existing model makes the alias win. `validateAlias()` rejects
the two router-classifier names (`auto`, `default-router`, from
`AUTO_MODEL_ALIASES` in `api/chat-router.js:8`) outright, and warns on a name that
collides with a known local model or preset id.

### Host policy moves out of the alias map

`backend.modelMapping["*"]` becomes `backend.acceptsAny` — a string (the model name to
rewrite to) or null. It was never an alias; it is the host-level statement "send me
anything you can't place, rewritten to this model."

**`acceptsAny` hosts are NOT eligible as alias fallbacks.** If every target of
`conversational-model` is down, the request fails over per normal routing — it does not
silently land on an unrelated model on a catch-all host. An alias is an explicit
contract; `acceptsAny` remains a fallback for *direct* model requests only.

### Resolution

```
resolveAliasCandidates(name, config, inventory) -> Candidate[]
```

1. Exact lookup of `name` in `config.aliases`. Miss → return `[]` (caller proceeds with
   the requested model unchanged, exactly as `resolveDefaultModel()` no-ops today).
2. For each target in order, expand to concrete candidates:
   - `host: "local"` — exact: one candidate, classified preset/ds4/model. Glob: expand
     against the local model list.
   - `host: <backendId>` — backend must exist and be `enabled && tested`. Exact: one
     candidate. Glob: expand against that backend's cached `remoteModels`.
   - A target naming an unknown host or matching nothing contributes zero candidates.
3. Return the flattened, de-duplicated candidate list in authored order.

`inventory` is the injected view of what exists — local models/presets, per-backend
`remoteModels`, and local residency. Injecting it keeps the module pure and testable.

### Ranking: the warm gate

Candidates feed the existing `resolveBackend()` ranking (priority → tok/s EMA →
`sharedResourceWeight` → queue depth, under the thermal/memory guards). One new gate sits
in front:

```
tier 1  warm — local candidate already resident (loadedModelsSnapshot),
               OR remote candidate on an enabled + tested backend that is
               up, circuit-closed, and under capacity
tier 2  cold — local candidate that would require a load (and therefore
               possibly an eviction)
```

Rank within tier 1. Fall to tier 2 **only when tier 1 is empty**.

This is the point of the design: `conversational-model` must not evict the resident
gpt-oss-120b just because a local member ranks well on paper. It is also consistent with
the existing restart-thrash and memory-pressure governors — a cold local load is the
expensive action, and remote hosts exist to absorb exactly this.

Remote candidates count as warm because the manager does not control remote residency;
an Ollama host that loads on demand is its own concern.

### Consequence: mixed models behind one alias

`gemma4:*` on a host holding `gemma4:12b` and `gemma4:27b` yields two candidates that are
genuinely different models, so consecutive requests to one alias can land on different
sizes — as can a local vs. remote member of the same alias. This is deliberate. The
operator authoring an alias group is assumed to have accepted that trade-off; it is the
price of "use whatever is warm."

## Code structure

### New: `api/model-aliases.js`

Pure module, no I/O, mirroring `api/default-models.js` and `api/resource-guard.js`.

| Export | Purpose |
|---|---|
| `resolveAliasCandidates(name, config, inventory)` | alias → ordered concrete candidates |
| `partitionByWarmth(candidates, inventory)` | `{warm, cold}` for the tier gate |
| `validateAlias(config, name, targets)` | name and target validation for the API |
| `aliasListEntries(config, nowSeconds)` | `/v1/models` rows, `status: 'alias'` (replaces `defaultModelListEntries`) |
| `migrateModelMappings(config)` | one-time fold; idempotent |
| `synthesizeModelMapping(config, backendId)` | back-compat view for `GET /api/backends` |
| `foldModelMapping(config, backendId, mapping)` | back-compat write for `PUT /api/backends/:id` |

### Deleted

- `resolveModelMapping()` in `api/server.js:672` — 8 call sites rerouted (848, 996, 1036,
  1108, 1149, 8873, 9955, 11124).
- `api/default-models.js` and `api/default-models.test.js` — 9 call sites in `server.js`
  rerouted; `api/chat-router.js:210-212,287-297` repointed at the new resolver.

### API

New CRUD at `/api/aliases`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/aliases` | all aliases with resolved candidate previews |
| `PUT` | `/api/aliases/:name` | create/replace an alias's targets |
| `DELETE` | `/api/aliases/:name` | remove an alias |

`GET|POST /api/settings` keeps `defaultBigModel`/`defaultSmallModel` as read/write views
onto the seeded `default-big`/`default-small` aliases (single-target form), so the General
tab needs no change.

**Back-compat.** `PUT /api/backends/:id` still accepts `modelMapping`: each key becomes or
joins an alias with that backend as a target, `*` is diverted to `acceptsAny`, and a
deprecation warning is logged. `GET /api/backends` synthesizes `modelMapping` from the
alias table so existing clients keep working. Removal is a later pass.

### Migration

Runs once inside `loadConfig()` when `config.aliases` is absent:

1. For each backend, fold every `modelMapping` entry into `config.aliases`, appending
   `{host: backend.id, model: <target>}` to the alias named by the key.
2. Divert `"*"` to `backend.acceptsAny`; delete `backend.modelMapping`.
3. Seed `default-big` / `default-small` from `defaultBigModel` / `defaultSmallModel` when
   set, then **delete both top-level keys**. The alias table is the single source of
   truth; `/api/settings` synthesizes the two fields on read and writes through to the
   aliases on write, and every internal reader goes through the alias resolver.
4. Save.

Idempotent — keyed on the presence of `config.aliases`, so a second run is a no-op.
Surviving glob *keys* (none exist in the live config) migrate to a literal alias name and
log a warning, since alias names no longer glob.

### UI

`ui/src/pages/Settings.jsx`: the **Model Mapping** tab (`ModelMappingSection`, lines
638-816) becomes **Aliases**. Flat `{rowId, backendId, localKey, remoteValue}` rows are
replaced by alias groups, each expanding to target rows:

- host `<select>` — `Local` plus every configured backend
- model combobox — `<datalist>` from that host's `/v1/models` (local list, or the
  backend's cached `remoteModels`), free text permitted so a glob can be typed
- add/remove target, add/remove/rename alias

The dead mapping helpers in `BackendFormFields` (lines 1293-1309) go with it. The
read-only per-host mapping preview in `BackendsSection` (1197-1206) shows the synthesized
view and gains a link to the Aliases tab.

## Testing

TDD per project convention: tests first, in `api/model-aliases.test.js`.

- **Resolution** — exact name hit/miss, authored order preserved, unknown host dropped,
  disabled/untested backend dropped.
- **Glob expansion** — remote glob against `remoteModels`, local glob, no-match yields
  zero candidates, `?` single-char.
- **Local target kinds** — llama preset, ds4 preset, bare model name, preset-shadows-model.
- **Warm gate** — resident local wins over remote; remote wins over cold local; cold local
  used only when nothing is warm; empty candidate set.
- **Validation** — duplicate targets, unknown host, blank name, the reserved
  `auto`/`default-router` names, and the warn-on-collision-with-a-real-model case.
- **Migration** — fold from a realistic pre-alias `config.json`, `*` → `acceptsAny`,
  default big/small seeding, idempotency (run twice, deep-equal).
- **Back-compat** — `synthesizeModelMapping()` round-trips a folded mapping;
  `foldModelMapping()` merges rather than clobbers.

This closes a real gap. `resolveModelMapping()`, `resolveBackend()`, and
`buildRemoteRouting()` are inline in the 11,624-line `api/server.js` and have **zero**
unit tests — the current glob, `*`-fallback, and empty-string-target semantics are
entirely unverified. Extracting resolution into a pure module makes the replacement
testable in a way the original never was.

Integration coverage: `/v1/models` advertises every alias; a `conversational-model` alias
can be created end-to-end from the Settings UI and routes a request.

## Out of scope

- Changing the `resolveBackend()` ranking weights.
- Making `acceptsAny` hosts eligible as alias fallbacks (explicitly rejected above).
- Changes to the `auto`/`default-router` classifier in `api/chat-router.js` beyond
  repointing its `default-small`/`default-big` fallbacks.
- Removing the deprecated `modelMapping` request/response field — a later pass.
