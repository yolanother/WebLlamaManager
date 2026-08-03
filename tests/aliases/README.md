# Model alias groups — API smoke tests

Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE
file in the repository root.

Black-box HTTP tests for the model alias groups feature. They boot the real
`api/server.js` against a throwaway config on a free port, drive the alias
endpoints, and assert the responses — no mocks, no stubs, no unit-level access to
the modules under test.

## Run

```bash
tests/aliases/run-tests.sh
```

Exits 0 when every assertion passes, non-zero otherwise, and prints an
`N passed, M failed` summary. Needs only `bash`, `curl`, and `node` — the same
dependencies the server itself has.

## What it covers

| Test | Asserts |
|---|---|
| `test_boot_migration` | Booting against a pre-alias config folds every `backend.modelMapping` into `config.aliases`, diverts `{"*": …}` to `backend.acceptsAny`, seeds `default-big`/`default-small` from the legacy `defaultBigModel`/`defaultSmallModel` keys and deletes them, and leaves no `modelMapping` behind. A second boot against the migrated file changes nothing (deep-equal). |
| `test_aliases_crud` | `GET /api/aliases` lists the migrated aliases; `PUT /api/aliases/:name` creates a multi-target alias (one `local`, one remote) that survives a restart; the reserved names `auto` and `default-router` and an empty `targets` array are rejected 4xx; `DELETE` removes the alias from the listing. |
| `test_v1_models_advertises_aliases` | Every configured alias appears in `/v1/models` with `status: 'alias'`, including `default-big`/`default-small` and a freshly created one; a deleted alias disappears. |
| `test_model_mapping_back_compat` | `GET /api/backends` still synthesizes a `modelMapping` object matching what was migrated (with `acceptsAny` surfacing as the `*` key); `PUT /api/backends/:id` carrying a `modelMapping` still succeeds, replaces only that host's targets in the alias table, and reads back through both `GET /api/aliases` and the synthesized view. |
| `test_settings_back_compat` | `GET /api/settings` still reports `defaultBigModel`/`defaultSmallModel` synthesized from the aliases; `POST`-ing a new value reads back and is reflected in the `default-big` alias. |

## Safety

The suite never touches the repository's real `config.json` or the running dev
server:

- `CONFIG_PATH` points at a `mktemp -d` work directory, seeded by
  `fixtures/seed-config.mjs`. So do `MODELS_DIR`, `HOME`, and the
  `LLAMA_MANAGER_{CONFIG,DATA,CACHE}_DIR` overrides, so no runtime state escapes
  into the checkout.
- The API, llama, and embed ports are each picked at random from 20000–28999
  and probed free first, so the live dev server's ports are never bound.
- `AUTO_START=false` and `EMBED_ENABLED=false` keep the boot from launching an
  inference engine.
- The server process is killed (SIGTERM, escalating to SIGKILL) from an
  `EXIT INT TERM` trap, so a failed assertion or an interrupt still leaves no
  orphan process behind. The work directory is removed on a clean run and kept
  (with its path printed) when something failed, so the migrated config and the
  server log can be inspected.

The server's runtime dependencies must be installed first — a fresh git worktree
has no `api/node_modules`, and the suite refuses to run without it:

```bash
npm ci --prefix api
```

## Notes for whoever implements the endpoints

- **Response envelope of `GET /api/aliases` is not pinned.** The design spec
  fixes the routes but not the body shape, so `fixtures/json-probe.mjs`
  normalizes `{aliases: {name: {targets: […]}}}`, `{aliases: [{name, targets}]}`,
  and a bare root map to the same view. Any of those passes.
- **`DELETE` is asserted through the collection.** The spec lists no
  `GET /api/aliases/:name`, so "the alias is gone" is checked by its absence from
  `GET /api/aliases` rather than by a 404 on a per-alias GET.
- Status codes are asserted as classes (`2xx` for success, `4xx` for a rejected
  alias), not exact codes, so 200-vs-201 is the implementation's call.

The module-level semantics these endpoints sit on are specified in
`docs/superpowers/specs/2026-08-03-model-alias-contract.md`; the feature design
is in `docs/superpowers/specs/2026-08-03-model-alias-groups-design.md`.
