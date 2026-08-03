<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Operator guide to model alias groups (`config.aliases`): the single global table
that maps one client-facing model name onto an ordered list of targets spread
across the local engine and remote backends. Documents the config shape, how to
create an alias from the UI or the API, exact alias names vs. globbed target
models, local vs. remote targets, the warm gate that keeps a cold local load from
evicting a resident model — and its documented limits — why `acceptsAny` is a
host policy and never an alias fallback, the one-time migration from the retired
per-backend `modelMapping`, and the deprecated compatibility shim. Read this
before authoring, retargeting, or debugging any alias.
-->

# Model Alias Groups

One global table, `config.aliases`, answers the question "which real model serves
this request?". An **alias name** is a literal string a client sends; it maps to an
**ordered list of targets**, each naming a host (`local`, or a remote backend id)
and a model on that host. The router expands the alias into concrete candidates and
prefers whichever one is **already warm**.

This replaces three overlapping mechanisms that could not express "this name means
any of these several models, wherever they live":

| Retired | Was | Why it was not enough |
|---|---|---|
| `backend.modelMapping` | per-backend name translation | remote only — it could never name a local model, and one alias spread over three hosts had to be typed three times |
| `backend.modelMapping["*"]` | a `"*"` key in that same map | never an alias at all; it is a host policy ("send me anything"), wedged into the alias map |
| `defaultBigModel` / `defaultSmallModel` | two global scalars | exactly two hardcoded names, exactly one target each |

All three are gone from the config. `default-big` and `default-small` still work —
they are now ordinary rows in the same alias table, with no special status beyond
being read/written by the General settings tab.

**Design + contract:** [`2026-08-03-model-alias-groups-design.md`](../superpowers/specs/2026-08-03-model-alias-groups-design.md)
· [`2026-08-03-model-alias-contract.md`](../superpowers/specs/2026-08-03-model-alias-contract.md).
**Code:** `api/model-aliases.js` (resolution, warmth, validation, `/v1/models` rows),
`api/alias-migration.js` (one-time fold + the deprecation shim),
`api/server.js` (wiring, `/api/aliases` CRUD), `ui/src/pages/alias-editor.js`
(Settings ▸ Aliases state transforms).

---

## Config shape

```jsonc
"aliases": {
  "conversational-model": {
    "targets": [
      { "host": "local",                     "model": "google_gemma-4-12B-it-qat-q4_0-gguf" },
      { "host": "borethrax-ollama-mnfmirep", "model": "gemma4:12b" }
    ]
  },
  "default-big":   { "targets": [{ "host": "local", "model": "Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M" }] },
  "default-small": { "targets": [{ "host": "local", "model": "Qwen_Qwen3-8B-GGUF" }] }
}
```

A target is exactly `{host, model}` — any other key you send is dropped on save.

### Alias names are exact; target models may be globs

**Names never glob.** An alias is matched by exact string equality against the
model the client asked for. Two globbed names could both match one request, and
every alias must be advertisable as a concrete `/v1/models` row, so the name is
always literal.

**Target models may glob**, using `*` (any run) and `?` (one character), anchored
at both ends. Variants are a real thing on remote hosts, so
`{host: "borethrax-ollama-mnfmirep", model: "gemma4:*"}` is valid and expands
against that backend's cached model list at resolve time.

An **exact** target model is never filtered against the inventory — it resolves to
one candidate whether or not the host currently advertises it, because a model can
be valid but not yet listed. A **globbed** target that matches nothing contributes
zero candidates and the alias simply has one fewer member.

### Local targets: model, llama preset, or ds4 preset

A `local` target's `model` may name a bare model in `~/models`, a **llama preset
id**, or a **ds4 preset id**. Disambiguation follows the engine's existing rule: if
`config.presets[model]` exists it is a preset (ds4 or llama per `isDs4Preset()`),
otherwise it is a model name. Pinning an alias to a llama preset is allowed — that
is how you bind an alias to a tuned launch config (context size, flags, speculative
decoding), which the retired `validateDefaultModelTarget()` refused to do.

If the **first** target is a local ds4 preset, the alias's `/v1/models` row reports
`engine: "ds4"`, and requesting the alias transparently triggers exclusive DS4
activation. See [`ds4-engine.md`](../ds4-engine.md).

### Remote targets

`host` is a backend id from `config.backends.directory`. A target is dropped from
resolution entirely when its backend is **missing, disabled, or untested** — so a
half-configured host silently contributes nothing rather than producing a candidate
that cannot be reached.

### Order is authored intent

Target order is preserved through resolution and is the final tiebreak when the
ranking produces a tie. Reorder targets in the UI with the per-row move controls.

### An alias shadows a real model of the same name

Alias resolution runs at request entry, **before** model lookup. Naming an alias
after a model that really exists locally makes the alias win — requests for that
name go to the alias's targets, not to the local model. This is deliberate (it is
what makes retargeting a fleet possible) but it is a footgun, so:

- `auto` and `default-router` are **rejected** outright — they belong to the chat
  router's classifier (`AUTO_MODEL_ALIASES` in `api/chat-router.js`).
- A name that collides with a real local model or a preset id is **warned** about,
  not rejected. The UI shows *"…is also a real model or preset — this alias will
  shadow it."* and still lets you save.

The migration deals with this same hazard automatically — see
[Migration step 4](#step-4-preserve-local-serving) below.

---

## The warm gate

This is the point of the feature. Candidates feed the existing `resolveBackend()`
ranking (priority → measured tok/s EMA → shared-resource weight → queue depth,
under the thermal and memory guards). One gate sits in front of it, splitting the
alias's candidates into two tiers:

| Tier | Members |
|---|---|
| **warm** | a **local** candidate that is already **resident**, OR any **remote** candidate whose backend is enabled, tested, and circuit-closed |
| **cold** | everything else — in practice, a local candidate that would have to be **loaded** |

**Ranking happens inside tier 1. Tier 2 is consulted only when tier 1 is empty.**

Remote candidates count as warm unconditionally (when their backend is reachable)
because the manager does not control remote residency — an Ollama host that loads
on demand is its own concern.

So a `conversational-model` request does **not** evict the resident gpt-oss-120b
just because a local member ranks well on paper. A cold local load is the expensive
action on this box: it can force an eviction, and evicting a large model is exactly
what trips the amdgpu wedge and the memory-pressure incidents the guards exist for.
Remote hosts exist to absorb this.

When the gate fires you will see it in the server log:

```
[routing] alias warm-gate: 'conversational-model' has no warm local target; serving from a warm remote member rather than loading "google_gemma-4-12B-it-qat-q4_0-gguf"
```

### The warm gate is soft protection, not a residency guarantee

⚠️ **An alias is not a pin.** The gate only fires when there is a remote member that
can actually take the request right now — it is conditioned on a remote backend
being enabled, tested, circuit-closed, endpoint-compatible, and **under its
concurrency limit**. Every backend on this deployment runs
`maxConcurrentRequests: 1`.

Under sustained remote saturation the gate cannot fire, the alias correctly falls
back to its **cold local member** as the spec's documented last resort, and that
local load **can evict a resident model**. This was observed live during the epic's
verification: at 13:07 the gate held three consecutive requests on the remote and
nothing was evicted, but at 13:17–13:18, with both remotes momentarily queue-full
under an external workload, the same alias cold-loaded locally and LRU-evicted
`google_gemma-4-E2B`. (The reroute machinery did pull the request back out to a
remote mid-flight once capacity reappeared, but the local load had already begun.)

**If you need a specific big model to stay resident no matter what, that is a
different mechanism:** `config.modelResidency.desiredModels` (currently empty). It
is a hard pin and outranks the warm gate; the gate is deliberately additive and
only ever *sets* `shouldOffload`, so an explicitly desired resident model still
wins. Use aliases for "serve this from whatever is warm", and `desiredModels` for
"this must not be unloaded".

### `acceptsAny` is a host policy, NOT an alias fallback

`backend.acceptsAny` (a model name string, migrated from the old
`modelMapping["*"]` key) means "send me anything you can't place, rewritten to this
model". It applies to **direct model requests only**.

**An alias whose targets are all down does not spill onto a catch-all host.** If
every member of `conversational-model` is unreachable, the request fails over per
normal routing and can fail — it does not silently land on an unrelated model. An
alias is an explicit contract; letting a catch-all absorb it would make the alias
mean something the operator never authored.

### Consequence: one alias can serve genuinely different models

`gemma4:*` on a host holding both `gemma4:12b` and `gemma4:27b` yields two
candidates that are different models — as does a local vs. a remote member of the
same group. Consecutive requests to one alias can therefore land on different
sizes. This is deliberate and is the price of "use whatever is warm". If you need
determinism, author a single-target alias.

---

## Creating and editing aliases

### In the UI — Settings ▸ Aliases

The tab (formerly **Model Mapping**) edits the global alias table as flat target
rows grouped by alias:

- **+ Add Alias** creates a group; rename it in place.
- **+ Target** appends a target row to that group.
- **Host** is a `<select>`: `Local` plus every configured backend.
- **Model** is a combobox backed by a `<datalist>` of that host's models — the
  local model list, or the backend's cached `remoteModels`. It accepts **free
  text**, which is how you type a glob such as `gemma4:*` that no host advertises
  literally.
- Move controls reorder targets within a group.
- Save writes one `PUT` per changed alias and one `DELETE` per removed alias.

Validation runs client-side with the same rules the server applies. Errors (blank
name/host/model, a reserved name, duplicate targets) disable **Save Aliases** and
show a banner; warnings (the shadowing case) do not block saving. Incomplete rows
— a row missing a host or a model — are dropped on fold rather than serialized,
since the server would reject them with a confusing error.

Aliases pointing at themselves are not offered: `/v1/models` rows with
`status: 'alias'` are filtered out of the model suggestion lists.

### Over the API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/aliases` | every group plus its resolved candidate preview |
| `PUT` | `/api/aliases/:name` | create or **replace** a group's targets |
| `DELETE` | `/api/aliases/:name` | remove a group |

`PUT` is a **replace, not a merge** — removing a target is expressed by omitting it
from the body. The body is `{"targets": [{"host": …, "model": …}, …]}`.

`GET /api/aliases` returns, per alias, the authored `targets` plus the live
resolution: `candidates`, `warm`, `cold`, `resolvable`, and `localTarget` (the
concrete local model the local engine would serve, or `null` for a remote-only
group). It also returns `reserved: ["auto", "default-router"]`. This preview is the
fastest way to answer "why did my alias route there?".

```bash
curl -sS http://127.0.0.1:5250/api/aliases | jq

curl -sS -X PUT http://127.0.0.1:5250/api/aliases/conversational-model \
  -H 'content-type: application/json' \
  -d '{"targets":[{"host":"local","model":"google_gemma-4-12B-it-qat-q4_0-gguf"},
                  {"host":"borethrax-ollama-mnfmirep","model":"gemma4:12b"}]}'
```

A successful `PUT` returns `{success, created, alias, warnings}` — check
`warnings`; a shadowing warning is reported there and in the `backends` log, and
does not fail the request.

### `default-big` / `default-small`

The General settings tab still shows **Default Big Model** and **Default Small
Model** dropdowns, and `GET`/`POST /api/settings` still speak `defaultBigModel` /
`defaultSmallModel`. Both are now **views onto the `default-big` / `default-small`
alias groups** in single-target form — the top-level config keys no longer exist.
Reading synthesizes the scalar from the alias's first target; writing replaces that
alias's targets. They also appear as ordinary editable rows on the Aliases tab, and
editing them there is equivalent.

### In `/v1/models`

Every alias with at least one usable target is advertised as a concrete row, so a
client can discover it:

```jsonc
{
  "id": "conversational-model", "object": "model", "created": 1754251200,
  "owned_by": "llamacpp", "meta": null, "n_ctx": null,
  "displayName": "conversational-model",
  "status": "alias",
  "alias": null,
  "aliasTarget": "google_gemma-4-12B-it-qat-q4_0-gguf",  // scalar: FIRST target's model (back-compat)
  "engine": "llama",                                     // "ds4" iff the FIRST target is a local ds4 preset
  "targets": [                                           // additive: the full group
    { "host": "local", "model": "google_gemma-4-12B-it-qat-q4_0-gguf" },
    { "host": "borethrax-ollama-mnfmirep", "model": "gemma4:12b" }
  ]
}
```

The field shape is inherited from the retired `defaultModelListEntries()` — the
scalar `aliasTarget` is kept because capability resolution reads it — so existing
`/v1/models` consumers keep working; `targets` is purely additive.

Note this is separate from **display aliases** (`config.modelAliases`), which only
rename models in the UI and `/v1/models` and change no routing at all.

---

## Migration from `modelMapping`

`migrateModelMappings()` runs once inside `loadConfig()`, keyed on `config.aliases`
being absent, so it is idempotent across the reboots this box actually does:

1. **Fold.** Every backend's `modelMapping` entry becomes
   `{host: <backendId>, model: <target>}` appended to the alias named by the key.
   Two hosts mapping the same key therefore converge into **one** group with two
   targets, in directory order. A blank target is skipped with a warning (the old
   resolver treated `""` as "no mapping"). A key containing `*` or `?` migrates
   under its literal name with a warning, since alias names no longer glob.
2. **Divert `"*"`** to `backend.acceptsAny`, then `delete backend.modelMapping`.
3. **Seed the defaults.** `default-big` / `default-small` from `defaultBigModel` /
   `defaultSmallModel`. A collision with a group already built in step 1 appends
   and warns — it never overwrites.
4. **Preserve local serving** — see below.
5. **Delete** `defaultBigModel` and `defaultSmallModel`. The alias table is now the
   single source of truth.

### Step 4: preserve local serving

**This step exists because of a real regression found against the operator's own
config, and it is the subtlest part of the whole feature.**

Two backends (borethrax and dahaka) both mapped the key `Qwen_Qwen3-8B-GGUF`.
Migration correctly folds them into one alias with two remote targets. But
`Qwen_Qwen3-8B-GGUF` is **also a real local model** — it was the configured
`defaultSmallModel`. Because an alias shadows a real model of the same name, the
folded alias would have resolved to the two remote targets **only**: local would no
longer be a candidate at all, and the model would have become unservable locally.

The old semantics were "local is primary; translate the name only *if* we offload",
so dropping the local target is a silent regression, not a redesign.

**Step 4 therefore unshifts `{host: 'local', model: <aliasName>}` as the FIRST
target of any group built in step 1 whose name matches a known local reference**,
unless a `local` target is already present. The known-local set is
`Object.keys(config.presets)`, plus the caller's `localModels` argument, plus the
**pre-deletion** values of `defaultBigModel` / `defaultSmallModel` (read before step
5 removes them — which is why the legacy defaults alone rescue this case even when
`loadConfig()` runs before the local model list exists).

Only groups **folded in step 1** are eligible; the `default-big` / `default-small`
groups seeded in step 3 are not.

Under the warm gate this reproduces the old behavior exactly — resident local wins,
remote absorbs when local is cold — and is strictly better, since previously a cold
local model had no remote fallback outside the offload policy.

Verified on the real config, this produced:

```jsonc
"Qwen_Qwen3-8B-GGUF": { "targets": [
  { "host": "local",                     "model": "Qwen_Qwen3-8B-GGUF" },  // ← step 4
  { "host": "borethrax-ollama-mnfmirep", "model": "qwen3-vl:8b" },
  { "host": "dahaka-ollama-mngx88pk",    "model": "qwen3:8b" }
]},
"gemini-4-12b":  { "targets": [{ "host": "borethrax-ollama-mnfmirep", "model": "gemma4:12b" }] },
"default-big":   { "targets": [{ "host": "local", "model": "Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M" }] },
"default-small": { "targets": [{ "host": "local", "model": "Qwen_Qwen3-8B-GGUF" }] }
```

with one warning (`alias 'Qwen_Qwen3-8B-GGUF' also names a local model or preset;
seeded a local target first so migration does not drop local serving`), ember's
`{"*": "qwen3-8b-jetson:latest"}` diverted to `acceptsAny` with **no alias
created**, `gemini-4-12b` correctly left remote-only, both legacy default keys
deleted, and a second run reporting `migrated: false`.

### Deprecated `modelMapping` compatibility shim

`modelMapping` is **deprecated but still works for one release cycle**:

- `GET /api/backends` **synthesizes** a flat `modelMapping` per backend from the
  alias table (`{aliasName: target.model}` for every target on that backend; when
  one alias has several targets on the same host the first wins), and appends
  `{"*": acceptsAny}` when set. It is not stored on the backend any more.
- `PUT /api/backends/:id` still **accepts** `modelMapping` and folds it into the
  alias table, merging rather than clobbering: targets belonging to other hosts are
  left untouched, and dropping a key removes only that backend's target (removing
  the group if it becomes empty). It always logs a deprecation warning.

The Remote Hosts tab shows this synthesized view read-only, captioned *"Synthesized
from the alias table — edit it on the Aliases tab."*

**Use `GET /api/aliases` instead.** A flat per-backend mapping cannot express a
local target or a multi-host group, so the shim is lossy by construction.

---

## Worked example: `conversational-model`

The driving use case: one stable name that resolves to whichever suitable model is
already warm — the local Gemma 4 12B when it is resident, the Ollama box otherwise.

```bash
curl -sS -X PUT http://127.0.0.1:5250/api/aliases/conversational-model \
  -H 'content-type: application/json' \
  -d '{"targets":[
        {"host":"local","model":"google_gemma-4-12B-it-qat-q4_0-gguf"},
        {"host":"borethrax-ollama-mnfmirep","model":"gemma4:12b"}]}'
```

Clients then just ask for it, with no knowledge of where it runs:

```bash
curl -sS http://127.0.0.1:5250/api/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"conversational-model","messages":[{"role":"user","content":"hi"}]}'
```

**When the local 12B is resident**, `warm` holds the local candidate and the
request is served locally.

**When it is not** — the live state at the time of writing — `GET /api/aliases`
shows the gate's inputs directly:

```jsonc
{
  "name": "conversational-model",
  "warm": [{ "host": "borethrax-ollama-mnfmirep", "model": "gemma4:12b", "kind": "model", "order": 1 }],
  "cold": [{ "host": "local", "model": "google_gemma-4-12B-it-qat-q4_0-gguf", "kind": "model", "order": 0 }],
  "resolvable": true,
  "localTarget": "google_gemma-4-12B-it-qat-q4_0-gguf"
}
```

and requests are served remotely (`system_fingerprint: fp_ollama`), leaving
whatever large model is resident untouched — the behavior verified live with a 32B
resident and both local slots full at `modelsMax: 2`.

Note `localTarget` is still populated for a cold-tier local member: it is the name
the local engine *would* serve, not a claim that it is being served.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Alias request behaves like an unknown model | `GET /api/aliases` — `resolvable: false`, or the name is missing. A miss is a **no-op**: the name is passed through unchanged as a literal model, exactly as before aliases existed. |
| A target never appears in `candidates` | Its backend is missing, `enabled: false`, or `tested: false` — those are dropped silently. Or its glob matched nothing in that host's cached `remoteModels`. |
| Alias keeps going remote | Working as designed. Look for `[routing] alias warm-gate:` in the logs — the local member is cold. |
| Alias cold-loaded locally and evicted something | The warm gate could not fire: no remote member had queue capacity. See [the soft-protection caveat](#the-warm-gate-is-soft-protection-not-a-residency-guarantee); use `config.modelResidency.desiredModels` for a hard pin. |
| A real local model became unreachable after adding an alias | The alias shadows it. Add `{host: 'local', model: <thatName>}` as the first target — that is what migration step 4 does automatically. |
| `"auto" is reserved by the chat router` | Reserved names are `auto` and `default-router`. Pick another. |
| An old client still sends `modelMapping` | Still honored through the deprecated shim on `GET`/`PUT /api/backends`; migrate it to `/api/aliases`. |

## Related

- [`features-overview.md`](../features-overview.md) — where aliasing sits in the whole feature map
- [`../superpowers/specs/2026-08-03-model-alias-groups-design.md`](../superpowers/specs/2026-08-03-model-alias-groups-design.md) — design + rationale
- [`../superpowers/specs/2026-08-03-model-alias-contract.md`](../superpowers/specs/2026-08-03-model-alias-contract.md) — the frozen module contract, as amended
- [`memory-pressure-governor.md`](memory-pressure-governor.md) — why a cold local load is the expensive action on this box
- [`../ds4-engine.md`](../ds4-engine.md) — ds4-preset targets and exclusive activation
