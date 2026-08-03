# Shared module contract — Model Alias Groups

**Status: SHIPPED 2026-08-03** (local `main` @ `c5a7e60`). This document has been
**reconciled with what shipped** — every amendment the four convergence tasks
recorded is folded in below and marked as such. It now describes the code as
built, not only as designed.

**This contract was authoritative and frozen** during implementation. Both the
test worker and the implementation worker in each pair coded against it
independently, without talking to each other. If you believe the contract is
wrong, DO NOT silently deviate — post an `orch tasks progress` comment on your
task naming the problem, and comment on your pair partner's task too.

Spec: `docs/superpowers/specs/2026-08-03-model-alias-groups-design.md`
Operator guide: `docs/features/model-alias-groups.md`

---

## `api/model-aliases.js`

```js
/** Names owned by the chat-router classifier; never valid alias names. */
export const RESERVED_ALIAS_NAMES = ['auto', 'default-router'];
export const BIG_ALIAS = 'default-big';
export const SMALL_ALIAS = 'default-small';
```

### Types

```js
/**
 * @typedef {{ host: string, model: string }} AliasTarget
 *   host  — 'local' or a backend id
 *   model — exact name, or a glob using * (any run) and ? (one char)
 *
 * @typedef {{ targets: AliasTarget[] }} AliasGroup
 *
 * @typedef {{
 *   localModels:    string[],                  // bare local model names
 *   presets:        Object<string, object>,    // config.presets
 *   residentModels: string[],                  // currently loaded local models
 *   backends: Array<{
 *     id: string, enabled: boolean, tested: boolean,
 *     remoteModels: string[], available?: boolean   // available defaults true
 *   }>
 * }} Inventory
 *
 * @typedef {{
 *   host:      'local' | string,   // backend id when remote
 *   model:     string,             // concrete name; glob already expanded
 *   kind:      'model' | 'preset' | 'ds4',   // remote is always 'model'
 *   backendId: string | null,      // null when host === 'local'
 *   order:     number              // authored target index, ascending
 * }} Candidate
 */
```

### `expandGlob(pattern, names) -> string[]`

Exported for direct testing. When `pattern` contains no `*` or `?`, returns
`[pattern]` **unconditionally** — an exact target is never filtered against the
inventory (a model may be valid but not yet listed). When it does contain a
wildcard, returns every entry of `names` that matches, in `names` order.
Translation matches the now-retired `resolveModelMapping()`: `*` → `.*`, `?` → `.`,
anchored `^...$`. Regex metacharacters in the rest of the pattern are escaped.

### `resolveAliasCandidates(name, config, inventory) -> Candidate[]`

1. `config.aliases?.[name]` — **exact lookup only**, no glob on the name. Miss,
   or an alias with no targets, returns `[]`.
2. Walk `targets` in order; `order` on every emitted candidate is the index of
   the target that produced it.
   - `host === 'local'` — expand the glob against
     `[...inventory.localModels, ...Object.keys(inventory.presets)]`. Classify
     each result: in `presets` and `isDs4Preset()` → `kind: 'ds4'`; in `presets`
     otherwise → `kind: 'preset'`; else → `kind: 'model'`. `backendId: null`.
   - otherwise — find the backend by id in `inventory.backends`. Drop the target
     entirely when the backend is missing, `!enabled`, or `!tested`. Else expand
     the glob against that backend's `remoteModels`; every result is
     `kind: 'model'`, `backendId: <id>`, `host: <id>`.
3. De-duplicate on the `(host, model)` pair, keeping the **first** occurrence
   (lowest `order`). Return the flattened list in authored order.

Import `isDs4Preset` from `./engines.js`.

### `partitionByWarmth(candidates, inventory) -> { warm: Candidate[], cold: Candidate[] }`

Preserves input order within each bucket.

- **warm** — a local candidate whose `model` is in `inventory.residentModels`,
  OR any remote candidate whose backend has `available !== false`.
- **cold** — every other candidate (in practice: non-resident local).

Remote candidates are warm unconditionally when their backend is available; the
manager does not control remote residency.

### `validateAlias(config, name, targets, localModels = []) -> {ok:true, value:AliasGroup, warnings:string[]} | {ok:false, error:string}`

Rejects (`ok:false`): a non-string or blank/whitespace name; a name in
`RESERVED_ALIAS_NAMES`; `targets` not an array or empty; any target that is not
an object, or whose `host`/`model` is not a non-empty string; two targets with
the same `host` + `model`.

Warns (`ok:true` with a non-empty `warnings`): the name collides with a key in
`config.presets` or with a known local model (an alias shadows a real model);
a target names a host that is not `local` and not a configured backend id.

**Source of the known-local-model list (amended 2026-08-03, see below).** The
known-local set is the `localModels` argument, falling back to
`config.localModels` when the argument is omitted. Entries may be bare strings
or scanned records (`{name}` / `{id}`).

> **Why this was amended.** As originally frozen this clause said "a known local
> model" without saying where that list comes from, and `validateAlias` — unlike
> `resolveAliasCandidates` — takes no `Inventory`. Both pair-1 workers
> independently defaulted to reading `config.localModels`, so they agreed and
> the suite went green, but `config.localModels` does not exist on the real
> persisted config: local models are produced at runtime by `scanLocalModels()`
> (`api/server.js`). Called as `validateAlias(config, name, targets)` against a
> real loaded config, the known-local set is always empty and the
> alias-shadows-a-real-local-model warning can never fire. That warning guards
> the exact footgun documented in step 4 of `migrateModelMappings` (the real
> `Qwen_Qwen3-8B-GGUF` case, where an alias shadowing a same-named local model
> makes it unservable locally), so it must not be dead code. The explicit
> argument mirrors the convention this contract already sets for
> `migrateModelMappings(config, localModels = [])`, for the same reason: the
> caller owns the local model list, and it may not be available at load time.
>
> **`[3I]` must pass the `scanLocalModels()` names as the fourth argument** when
> wiring the alias CRUD endpoint; omitting it silently disables the warning.
>
> **Shipped (`[3C]`).** The gap was real: `[3I]` called `validateAlias` with only
> three arguments at both `setDefaultAliasTarget()` and `PUT /api/aliases/:name`,
> leaving the warning dead in production. Both now pass `localModelNames()` — a
> 30s-cached projection of `scanLocalModels()` names — and the warning fires (it is
> what surfaces the `Qwen_Qwen3-8B-GGUF` shadowing notice in the UI).

`value.targets` are trimmed and normalized to `{host, model}` only — any extra
keys on an input target are dropped.

### `aliasListEntries(config, nowSeconds) -> object[]`

One OpenAI-style row per configured alias with at least one target, in
`Object.keys(config.aliases)` order. Replaces `defaultModelListEntries()`, and
keeps that function's field shape so `/v1/models` consumers do not break:

```js
{
  id: <alias name>, object: 'model', created: nowSeconds,
  owned_by: 'llamacpp', meta: null, n_ctx: null,
  displayName: <alias name>, status: 'alias', alias: null,
  aliasTarget: <first target's model>,        // back-compat scalar
  engine: 'ds4' | 'llama',                    // 'ds4' iff FIRST target is a ds4 preset
  targets: [{host, model}, ...]               // new: the full group
}
```

---

## `api/alias-migration.js`

### `migrateModelMappings(config, localModels = []) -> { migrated: boolean, warnings: string[] }`

*(Signature amended by `[2C]`; see step 4 and the note after it. The second
argument was added with step 4 and is optional.)*

**Mutates `config` in place.** No-op returning `{migrated:false, warnings:[]}`
when `config.aliases` is already present (this is the idempotency key).
Otherwise:

1. Create `config.aliases = {}`.
2. For each backend in `config.backends?.directory ?? []`, for each
   `[key, target]` of `backend.modelMapping ?? {}`, in insertion order:
   - `key === '*'` — set `backend.acceptsAny = target` when `target` is a
     non-blank string, else leave `acceptsAny` unset. Do not create an alias.
   - a falsy/blank `target` — skip (today's resolver treats `''` as "no
     mapping"), and push a warning.
   - otherwise — append `{host: backend.id, model: target}` to
     `config.aliases[key].targets`, creating the group if needed. When `key`
     contains `*` or `?`, still create it under the literal name and push a
     warning that alias names no longer glob.
   - Then `delete backend.modelMapping`.
3. Seed from the legacy defaults when set and non-blank:
   `config.aliases['default-big'] = {targets:[{host:'local', model:config.defaultBigModel.trim()}]}`,
   likewise `default-small`. Do not overwrite a group of that name already built
   in step 2 — append instead, and warn.
4. **Preserve local serving.** For every group built in step 2 whose alias name
   matches a known local reference, UNSHIFT `{host:'local', model:<aliasName>}`
   as its FIRST target, unless a `host:'local'` target is already present.
   The known-local set is `Object.keys(config.presets ?? {})`, plus the
   `localModels` argument, plus the pre-deletion values of `defaultBigModel` and
   `defaultSmallModel`. Push a warning naming each alias so seeded.
5. `delete config.defaultBigModel; delete config.defaultSmallModel;`

> **Why step 4 exists.** Verified against the operator's real `config.json`:
> two backends both map the key `Qwen_Qwen3-8B-GGUF`, which is ALSO a real local
> model (it is the configured `defaultSmallModel`). Folding those mappings alone
> produces a remote-only alias, and because an alias shadows a same-named real
> model, requests for it could no longer be served locally at all. The old
> `modelMapping` semantics were "local is primary; translate the name only IF we
> offload", so dropping the local target is a silent regression. Seeding it first
> reproduces the old behavior under the warm gate — resident local wins, remote
> absorbs when local is cold — and is strictly better, since a cold local model
> previously had no remote fallback outside the offload policy.

The signature therefore takes an optional second argument:

```js
migrateModelMappings(config, localModels = []) -> { migrated, warnings }
```

`localModels` is the caller's list of known local model names. It is optional
because `loadConfig()` may run before the local model list is available; with it
omitted, the preset ids and the two legacy default targets still cover the
common cases (including the real one above).

> **Shipped.** `api/alias-migration.js` implements step 4 as `preserveLocalServing()`,
> running after step 3 and before the step-5 deletes, and the fold records
> `foldedNames` so only groups built in step 2 are eligible. `api/server.js` calls
> `migrateModelMappings(cfg, localModelNames(true))` inside `loadConfig()`. Verified
> against the operator's real config (on a copy): one warning, `Qwen_Qwen3-8B-GGUF`
> led with its local target followed by borethrax then dahaka, `gemini-4-12b` stayed
> remote-only, ember's `"*"` became `acceptsAny` with no alias created, both legacy
> default keys were deleted, and a second run returned `migrated: false`.
>
> `[2T]` was already in flight against the unamended contract, so `[2C]` added the
> coverage: preset-id match, `localModels`-argument match, legacy-`defaultSmallModel`
> match (asserted deliberately WITHOUT passing `localModels`, proving the legacy
> default alone rescues local serving at load time), a non-matching name staying
> remote-only, no duplicate when a local target already exists, the seeded target
> being FIRST, and idempotency not stacking a second local target. Two pre-existing
> assertions that required the `Qwen_Qwen3-8B-GGUF` group to be remote-only were
> updated — that is precisely the behavior step 4 exists to change — and the
> directory-order test now additionally asserts the remote targets' models and full
> host ordering, so it checks strictly more than before. `[3T]`'s smoke assertion
> "both hosts fold into one alias, in directory order" was updated for the same
> reason and now requires the local target first.

### `synthesizeModelMapping(config, backendId) -> Object<string,string>`

The back-compat view for `GET /api/backends`. Walks `config.aliases` and returns
`{[aliasName]: target.model}` for every target whose `host === backendId`. When
one alias has several targets on the same backend, the **first** wins. Appends
`{'*': backend.acceptsAny}` when `acceptsAny` is set. Returns `{}` when nothing
matches.

### `foldModelMapping(config, backendId, mapping) -> { warnings: string[] }`

The back-compat write for `PUT /api/backends/:id`. **Mutates `config`.** Applies
the same per-key rules as step 2 of `migrateModelMappings`, except it MERGES
into the existing `config.aliases` rather than building it fresh: for each key,
replace any existing target on `backendId` within that alias group, and leave
targets belonging to other hosts untouched. Removing a key from `mapping` that
previously existed removes that backend's target from the corresponding group
(and removes the group entirely if it becomes empty). Always returns at least
one warning naming `modelMapping` as deprecated.

---

## `ui/src/pages/alias-editor.js`

The pair-4 contract, frozen in the `[4T]`/`[4I]` task descriptions rather than in
this file. Recorded here so the shipped module surface lives in one place. Pure
state transforms only — no React, no I/O; `Settings.jsx` owns every fetch and all
component state.

| Export | Purpose |
|---|---|
| `aliasesToRows(aliases)` | flatten the alias table into flat `{rowId, aliasName, host, model}` rows, grouped and ordered |
| `rowsToAliases(rows)` | fold edited rows back into an alias map, preserving row order within each alias |
| `diffAliases(original, edited)` | `{changed, removed}` — which aliases a save must `PUT` and which it must `DELETE` |
| `validateRows(rows, inventory)` | client-side errors/warnings mirroring the server's `validateAlias()` |

`RESERVED_ALIAS_NAMES` is duplicated from `api/model-aliases.js` because the UI
bundle cannot import from the server tree.

> **Amended (`[4C]`) — `rowsToAliases` blank-field handling.** The contract clause
> "Rows with a blank `aliasName`, host, or model are dropped" shipped implemented as
> dropping only on a blank `aliasName`; rows with a blank `host` or `model` survived
> into the output, and an alias whose every row was blank still appeared in the map.
> **The implementation was wrong and was fixed; the tests were right and were left
> untouched.** A row is now dropped unless `aliasName`, `host`, AND `model` are all
> non-blank after trimming, and because a group is only created once a valid row is
> seen, an all-blank alias is never created and is omitted for free.
>
> This matters beyond the unit test: a blank `host` would have been serialized into
> `config.aliases` and `PUT` to `/api/aliases`, where the server's `validateAlias()`
> rejects it — the user would have seen a confusing save failure instead of the
> incomplete row simply being filtered out client-side. Cross-checked against
> `Settings.jsx`: `validateRows()` already errors on a blank name/host/model and
> `save()` early-returns while `errorCount > 0`, so the stricter fold can never
> silently discard a row the user meant to keep.
