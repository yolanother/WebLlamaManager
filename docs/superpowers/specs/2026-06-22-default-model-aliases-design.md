# Design: `default-big` / `default-small` model aliases

Date: 2026-06-22

> ## ⚠️ SUPERSEDED — historical record only
>
> **Superseded by** [2026-08-03-model-alias-groups-design.md](2026-08-03-model-alias-groups-design.md)
> (shipped 2026-08-03). Do not implement against this document.
>
> Everything below describes retired code. Specifically:
>
> - `api/default-models.js` and `api/default-models.test.js` are **deleted**.
>   `resolveDefaultModel()`, `validateDefaultModelTarget()`, and
>   `defaultModelListEntries()` no longer exist; `api/model-aliases.js` replaces
>   them.
> - The top-level `config.defaultBigModel` / `config.defaultSmallModel` keys are
>   **deleted from the config** by a one-time migration. `default-big` and
>   `default-small` are now ordinary rows in the global `config.aliases` table,
>   each an ordered list of targets rather than one scalar name.
>   `GET`/`POST /api/settings` keep the two field names as read/write **views**
>   onto those aliases, so the General settings tab and existing clients are
>   unaffected.
> - The restriction that a default-model target may not be a **llama** preset id
>   (only a model name or a ds4 preset id) was deliberately **lifted** — an alias
>   target may name a model, a llama preset, or a ds4 preset.
>
> Current operator documentation: [`docs/features/model-alias-groups.md`](../../features/model-alias-groups.md).

## Problem

Clients pin a specific model name in their requests. When that name doesn't match
the model the server currently has loaded/preferred, routing triggers a model
shift (unload/reload), which is slow and wasteful. We want the server to own the
choice of the "ideal" big and small models so clients can target a stable alias
and avoid unnecessary shifts.

## Solution

Two operator-configurable settings, `defaultBigModel` and `defaultSmallModel`,
expose two stable request-time model names:

- `default-big`  → resolves to `config.defaultBigModel`
- `default-small` → resolves to `config.defaultSmallModel`

When a client sends `{"model": "default-big"}`, the server rewrites the model name
to the configured target **before** routing, so the request flows through the
normal backend resolution, loading, and stats path as if the client had asked for
the real model directly. The operator retargets `default-big`/`default-small`
centrally without clients changing anything.

If a target is unset (`null`/empty), its alias is inactive: the name passes through
unchanged (and routes per existing behavior — i.e. catch-all mapping or a 404 the
same as any unknown model).

## Components

### `api/default-models.js` (new, pure module)

Mirrors the existing extracted-helper pattern (`api/embeddings.js`,
`api/resource-guard.js`): pure functions, no I/O, unit-tested with `node:test`.

- `BIG_ALIAS = 'default-big'`, `SMALL_ALIAS = 'default-small'` constants.
- `resolveDefaultModel(requestedModel, config)` → string. Returns the configured
  target when `requestedModel` is `default-big`/`default-small` and that target is
  a non-empty string; otherwise returns `requestedModel` unchanged. Exact match
  only (case-sensitive).
- `defaultModelListEntries(config, nowSeconds)` → array of synthetic `/v1/models`
  entries (`{ id, object: 'model', created, owned_by, ... }`) for each alias whose
  target is configured. Returns `[]` when both unset. Shape matches the existing
  entries built by the models endpoint (id + the same metadata fields the endpoint
  already emits).

### Config schema

- `loadConfig()` defaults gain `defaultBigModel: null`, `defaultSmallModel: null`.
- `config.json` gains the two keys (both `null` by default).
- No migration needed beyond the default-fill that `loadConfig` already does for
  absent keys.

### Request handlers (`server.js`)

In each of the three handlers, immediately after `requestedModel` is read from
`req.body.model` and before `resolveBackend()` is called:

```js
const requestedModel = req.body.model || 'default';
const actualModel = resolveDefaultModel(requestedModel, config);
// use actualModel everywhere requestedModel was used downstream
```

Applied to: chat/completions (~6104), completions (~6950), embeddings (~7155).
Using the resolved real name downstream means routing, telemetry, and stats are
attributed to the actual target model, not the alias.

### `/api/settings`

- GET adds `defaultBigModel` / `defaultSmallModel` to the response.
- POST accepts both. An empty string normalizes to `null`. Any other string is
  stored verbatim (lenient — we do not reject an unknown/not-yet-loaded name, same
  as a direct request to such a model). Persisted via `saveConfig`.

### `/v1/models`

After building the existing list, append `defaultModelListEntries(config, now)`.
Entries appear only for configured aliases; an unset alias is not advertised.

### Web settings UI (React)

Two `<select>` controls — "Default Big Model" and "Default Small Model" —
populated from the available-models list already loaded in the settings view,
each with a "— none —" option mapping to `null`. Wired through the existing
settings GET/POST flow.

## Testing

`api/default-models.test.js` (node:test):

- `resolveDefaultModel`: `default-big`/`default-small` resolve to configured
  targets; pass through when target unset; non-alias names pass through; exact
  match only.
- `defaultModelListEntries`: emits an entry per configured alias; `[]` when both
  unset; entry ids are `default-big`/`default-small`.

Manual / integration smoke (documented, not automated here):

- POST `/api/settings` with the two fields round-trips through GET.
- A chat request with `model: "default-big"` routes to the configured target.
- `/v1/models` includes/excludes the synthetic entries based on config.

## Out of scope

- Per-client or per-key default overrides.
- Dynamic/auto-selection of the "ideal" model (these are static operator settings).
- Additional aliases beyond big/small.
