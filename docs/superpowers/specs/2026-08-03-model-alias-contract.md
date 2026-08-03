# Shared module contract — Model Alias Groups

**This contract is authoritative and frozen.** Both the test worker and the
implementation worker in each pair code against it independently, without
talking to each other. If you believe the contract is wrong, DO NOT silently
deviate — post an `orch tasks progress` comment on your task naming the problem,
and comment on your pair partner's task too.

Spec: `docs/superpowers/specs/2026-08-03-model-alias-groups-design.md`

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
Translation matches the outgoing `resolveModelMapping()`: `*` → `.*`, `?` → `.`,
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

### `validateAlias(config, name, targets) -> {ok:true, value:AliasGroup, warnings:string[]} | {ok:false, error:string}`

Rejects (`ok:false`): a non-string or blank/whitespace name; a name in
`RESERVED_ALIAS_NAMES`; `targets` not an array or empty; any target that is not
an object, or whose `host`/`model` is not a non-empty string; two targets with
the same `host` + `model`.

Warns (`ok:true` with a non-empty `warnings`): the name collides with a key in
`config.presets` or with a known local model (an alias shadows a real model);
a target names a host that is not `local` and not a configured backend id.

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

### `migrateModelMappings(config) -> { migrated: boolean, warnings: string[] }`

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
