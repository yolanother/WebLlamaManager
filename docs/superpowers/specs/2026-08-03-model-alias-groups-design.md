# Model Alias Groups — Design

**Date:** 2026-08-03
**Orch task:** [0DfIVlZNejtccWwVzOKYg](https://orchestrator.doubtech.ai/tasks/0DfIVlZNejtccWwVzOKYg)
**Supersedes:** [2026-06-22-default-model-aliases-design.md](2026-06-22-default-model-aliases-design.md)
**Status:** **SHIPPED** 2026-08-03 (local `main` @ `c5a7e60`), deployed and verified
on the live dev server. This document has been **reconciled with what shipped** —
sections carrying a "**Shipped:**" or "**Amended**" callout differ from the design as
originally written, and the callout is the authoritative record of the difference.
Operator-facing documentation: [`docs/features/model-alias-groups.md`](../../features/model-alias-groups.md).
Module contract, as amended: [`2026-08-03-model-alias-contract.md`](2026-08-03-model-alias-contract.md).

## Problem

Three overlapping mechanisms answered "which real model serves this request?", and none of
them could express "this name means any of these several models, wherever they live".
**All three are now retired** — the table below is the pre-alias state this design
replaced:

| Retired mechanism | Where it lived | Scope | Limitation |
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
list at resolve time. Globs reuse the translation the retired `resolveModelMapping()` used:
`*` → `.*`, `?` → `.`, anchored at both ends.

**Local target kinds.** A `local` target's `model` may name a llama preset id, a ds4
preset id, or a bare model name. Disambiguation follows the engine's existing rule:
if `config.presets[model]` exists it is a preset (ds4 or llama per `isDs4Preset()`),
otherwise it is a model name. This lifts the restriction the retired
`validateDefaultModelTarget()` imposed, which rejected llama preset ids — that
restriction had no strong justification and blocked pinning an alias to a tuned launch
config (context size, flags).

**Order is authored intent.** Target order is preserved and used as the final tiebreak
when ranking produces a tie.

**An alias shadows a real model of the same name.** Alias resolution runs at request
entry, before model lookup — the same position the retired `resolveDefaultModel()` held —
so naming an alias after an existing model makes the alias win. `validateAlias()` rejects
the two router-classifier names (`auto`, `default-router`, from
`AUTO_MODEL_ALIASES` in `api/chat-router.js:8`) outright, and warns on a name that
collides with a known local model or preset id.

> **Amended (`[1C]`) — where the "known local model" list comes from.** As written,
> this clause never said, and `validateAlias` — unlike `resolveAliasCandidates` — took
> no inventory parameter. Both pair-1 workers independently defaulted to reading
> `config.localModels`, so they agreed and the suite was green, but **`config.localModels`
> does not exist on the real persisted config**: local models are produced at runtime by
> `scanLocalModels()`. Called as `validateAlias(config, name, targets)` against a real
> loaded config the known-local set is always empty, and the shadowing warning could
> never fire — dead code guarding the exact footgun that
> [migration step 4](#migration) exists for.
>
> The signature is therefore **`validateAlias(config, name, targets, localModels = [])`**,
> reading the argument and falling back to `config.localModels`. This mirrors the
> convention already set for `migrateModelMappings(config, localModels = [])`, for the
> same reason: the caller owns the local model list, and it may not exist at load time.
> **Shipped:** `api/server.js` passes `localModelNames()` (a 30s-cached
> `scanLocalModels()` projection) at both call sites — `setDefaultAliasTarget()` and
> `PUT /api/aliases/:name`. `[3I]` had shipped both with only three arguments; `[3C]`
> caught and fixed it. Omitting the argument silently disables the warning.

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
   the requested model unchanged, exactly as the retired `resolveDefaultModel()` no-opped).
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

> **Shipped (`[3C]`) — the gate is real, and it is SOFT.** Verified live: with a 32B
> resident, both local slots full at `modelsMax: 2`, and the alias's local member cold,
> three consecutive `conversational-model` requests were all served from the remote and
> **nothing was evicted**:
> ```
> [routing] alias warm-gate: 'conversational-model' has no warm local target; serving
> from a warm remote member rather than loading "google_gemma-4-12B-it-qat-q4_0-gguf"
> ```
> The migrated production alias shows the same gate firing on the operator's own live
> traffic (`'Qwen_Qwen3-8B-GGUF' has no warm local target…`).
>
> **But the gate is conditioned on `hasViableRemote`, which requires a remote member
> with QUEUE CAPACITY.** Every backend on this deployment is
> `maxConcurrentRequests: 1`. Under sustained remote saturation the gate cannot fire,
> the alias falls back to its cold local member exactly as this section's last-resort
> rule specifies, and that load **can evict a resident model** — observed at 13:17–13:18
> with both remotes momentarily queue-full, evicting `google_gemma-4-E2B` (the reroute
> machinery pulled the request back out mid-flight once capacity reappeared, but the
> local load had already started).
>
> **An alias is therefore not a residency guarantee.** Hard pinning is
> `config.modelResidency.desiredModels` (a separate mechanism, currently empty). The
> gate is deliberately additive — it only ever sets `shouldOffload` — so an explicitly
> desired resident model still outranks it.
>
> One implementation detail worth recording: the `available` flag the contract's
> `Inventory` carries is wired to the **circuit breaker**. A backend whose circuit is
> open is not reachable now, so its candidates land in the COLD tier and stop counting
> as a warm alternative that could hold a cold local load back.

### Consequence: mixed models behind one alias

`gemma4:*` on a host holding `gemma4:12b` and `gemma4:27b` yields two candidates that are
genuinely different models, so consecutive requests to one alias can land on different
sizes — as can a local vs. remote member of the same alias. This is deliberate. The
operator authoring an alias group is assumed to have accepted that trade-off; it is the
price of "use whatever is warm."

## Code structure

### New: `api/model-aliases.js`

Pure module, no I/O, mirroring the retired `api/default-models.js` and the surviving
`api/resource-guard.js`.

| Export | Purpose |
|---|---|
| `RESERVED_ALIAS_NAMES`, `BIG_ALIAS`, `SMALL_ALIAS` | shared constants |
| `expandGlob(pattern, names)` | exported for direct testing; an exact pattern returns `[pattern]` unconditionally |
| `resolveAliasCandidates(name, config, inventory)` | alias → ordered concrete candidates |
| `partitionByWarmth(candidates, inventory)` | `{warm, cold}` for the tier gate |
| `validateAlias(config, name, targets, localModels = [])` | name and target validation for the API — see the `[1C]` amendment above |
| `aliasListEntries(config, nowSeconds)` | `/v1/models` rows, `status: 'alias'` (replaces `defaultModelListEntries`) |

**Shipped: the migration + shim functions live in a separate module,
`api/alias-migration.js`**, not in `api/model-aliases.js` as tabled here:

| Export (`api/alias-migration.js`) | Purpose |
|---|---|
| `migrateModelMappings(config, localModels = [])` | one-time fold; idempotent on `config.aliases` |
| `synthesizeModelMapping(config, backendId)` | back-compat view for `GET /api/backends` |
| `foldModelMapping(config, backendId, mapping)` | back-compat write for `PUT /api/backends/:id` |

The split is deliberate: this code is one-time and legacy-facing, while
`api/model-aliases.js` sits on the hot request path. Both are pure — no I/O, no
imports from `server.js`.

### Deleted

- `resolveModelMapping()` in `api/server.js:672` — 8 call sites rerouted (848, 996, 1036,
  1108, 1149, 8873, 9955, 11124).
- `api/default-models.js` and `api/default-models.test.js` — 9 call sites in `server.js`
  rerouted; `api/chat-router.js:210-212,287-297` repointed at the new resolver.

> **Shipped (`[3C]`).** Both modules and their call sites are gone; the retired
> `resolveModelMapping()` is replaced by two functions that split its two jobs cleanly —
> `remoteTargetModel()` (alias candidates for an alias request, `acceptsAny` for a direct
> one) and `resolveRequestModel()` / `resolveAliasRouting()`. Three **prose** mentions of
> the retired names survive deliberately, in the knowledge-base-ingested headers and
> doc-comments of `api/model-aliases.js` and `api/model-aliases.test.js`, as historical
> context ("supersedes `api/default-models.js`"). There are zero live references,
> imports, or call sites.

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
   set. A collision with a group already built in step 1 appends and warns — it never
   overwrites.
4. **Preserve local serving** (added during convergence — see the amendment below).
5. **Delete both top-level keys**, then save. The alias table is the single source of
   truth; `/api/settings` synthesizes the two fields on read and writes through to the
   aliases on write, and every internal reader goes through the alias resolver.

Idempotent — keyed on the presence of `config.aliases`, so a second run is a no-op.
Surviving glob *keys* (none exist in the live config) migrate to a literal alias name and
log a warning, since alias names no longer glob.

> **Amended (`[2C]`) — step 4, preserve local serving.** Found while verifying the
> migration against the operator's **real** `config.json`. Two backends (borethrax,
> dahaka) both map the key `Qwen_Qwen3-8B-GGUF`; migration correctly folds them into one
> alias with two remote targets. But `Qwen_Qwen3-8B-GGUF` is **also a real local model** —
> it was the configured `defaultSmallModel`. Because an alias shadows a real model of the
> same name, the folded alias would have resolved to the two remote targets **only**, and
> the model would have become unservable locally. The old `modelMapping` semantics were
> "local is primary; translate the name only IF we offload", so this is a silent
> regression, not a redesign.
>
> **Step 4 UNSHIFTS `{host: 'local', model: <aliasName>}` as the FIRST target of any
> group built in step 1 whose name matches a known local reference**, unless a `local`
> target is already present, warning per alias seeded. The known-local set is
> `Object.keys(config.presets)`, plus the `localModels` argument, plus the
> **pre-deletion** values of `defaultBigModel` / `defaultSmallModel` — read before step 5
> removes them, which is why the legacy defaults alone rescue this case even when
> `loadConfig()` runs before the local model list exists. Only groups folded in step 1
> are eligible; the groups seeded in step 3 are not. The signature is therefore
> **`migrateModelMappings(config, localModels = [])`**.
>
> Under the warm gate this reproduces the old behavior exactly (resident local wins,
> remote absorbs when local is cold) and is strictly better, since previously a cold
> local model had no remote fallback outside the offload policy.
>
> **Shipped and verified on the real config** (against a copy; the live file was never
> opened for writing): `Qwen_Qwen3-8B-GGUF` → `[local/Qwen_Qwen3-8B-GGUF,
> borethrax/qwen3-vl:8b, dahaka/qwen3:8b]`; `gemini-4-12b` correctly stays remote-only;
> ember's `{"*": "qwen3-8b-jetson:latest"}` becomes `acceptsAny` with **no alias
> created**; both legacy default keys deleted; run 2 reports `migrated: false`.

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

> **Shipped (`[4C]`).** The pure state transforms live in `ui/src/pages/alias-editor.js`
> (`aliasesToRows`, `rowsToAliases`, `diffAliases`, `validateRows`) with `Settings.jsx`
> owning every fetch and all component state; a save issues one `PUT` per changed alias
> and one `DELETE` per removed one. Two additions beyond the design: target rows can be
> **reordered** in place (order is authored intent, so it must be editable), and
> `/v1/models` rows with `status: 'alias'` are filtered out of the model suggestion lists
> so an alias cannot be pointed at itself.
>
> **Contract disagreement, resolved against the implementation:** `rowsToAliases` must
> drop a row unless `aliasName`, `host`, **AND** `model` are all non-blank after
> trimming, omitting any group left with no valid rows. The first implementation dropped
> only on a blank `aliasName`. That is a real user-facing bug, not a unit-test detail: a
> blank `host` would have been serialized into `config.aliases` and `PUT` to
> `/api/aliases`, where the server's `validateAlias()` rejects it — the user would have
> seen a confusing save failure instead of the incomplete row simply being filtered out
> client-side. The tests were right and were left untouched.
>
> Verified live against the migrated data: all five migrated aliases listed
> (`default-big`/`default-small` appearing as ordinary rows); a group built from scratch
> through the UI with a local target and a free-text `gemma4:*` glob the datalist does
> **not** offer, round-tripping through a reload; the reserved-name error disabling
> **Save Aliases**; the shadowing warning **not** blocking a save; the General tab's
> Default Big/Small dropdowns correctly rendering values that exist nowhere but the alias
> table; and the Remote Hosts preview showing an entry for an alias absent from the
> backend's stored mapping — proving it is synthesized live, not read from the legacy
> field. Not verified live: the General-tab **write** direction (dropdown → alias), which
> the permission classifier blocked as a live-config mutation; it is wired through
> `setDefaultAliasTarget()` and covered by the api suite.

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
`buildRemoteRouting()` were inline in the 11,624-line `api/server.js` with **zero**
unit tests — the pre-alias glob, `*`-fallback, and empty-string-target semantics were
entirely unverified. Extracting resolution into a pure module makes the replacement
testable in a way the original never was.

Integration coverage: `/v1/models` advertises every alias; a `conversational-model` alias
can be created end-to-end from the Settings UI and routes a request.

> **Shipped — as-built test surface.** `api/model-aliases.test.js` 48 tests,
> `api/alias-migration.test.js` 38, `ui/src/pages/alias-editor.test.js` 25, plus a
> server smoke suite at `tests/aliases/run-tests.sh` (55 checks) that boots a real
> server against a disposable `CONFIG_PATH` on a dynamic port with `autoStart: false`.
> Full gates: **`node --test api/*.test.js`** (601), `cd ui && npm test` (86),
> `cd ui && npm run build`.
>
> Two process notes worth keeping. (1) **`node --test api/` is forbidden** — the bare
> directory argument spawns `node api`, which resolves to `api/server.js` and boots a
> real server, hanging forever; recorded in [`docs/GOTCHAS.md`](../../GOTCHAS.md).
> (2) **`./scripts/dev-build.sh check` does not exist** in this repo — it is an
> orchestrator-template convention that appeared in the task boilerplate. The real gates
> are the commands above.
>
> The pairs converged unusually cleanly: pair 1 and pair 2 each had **zero** behavioural
> disagreements on first run (pair 1's green was checked against an 8-mutation harness,
> all 8 caught), pair 4 had exactly one, and pair 3's 30 baseline failures went to 0.
> The one defect the pair pattern could **not** catch by construction was the
> `validateAlias` local-model source, because both halves made the same wrong assumption
> and therefore agreed — see the `[1C]` amendment above.

## Out of scope

- Changing the `resolveBackend()` ranking weights.
- Making `acceptsAny` hosts eligible as alias fallbacks (explicitly rejected above).
- Changes to the `auto`/`default-router` classifier in `api/chat-router.js` beyond
  repointing its `default-small`/`default-big` fallbacks.
- Removing the deprecated `modelMapping` request/response field — a later pass.
