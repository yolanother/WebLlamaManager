# Llama Manager — Feature Overview

Llama Manager is a self-hosted control plane for local LLM inference on an AMD
Strix Halo (gfx1151) box. It manages one or more inference engines, exposes a
single OpenAI-compatible API, routes and offloads requests across local and remote
backends, and protects a thermally- and memory-constrained shared CPU+iGPU box from
the failure modes that actually happen on this hardware.

This document is the map of what it does and how each piece works. Deep-dives live
in sibling docs; this is the index + the mental model.

> **Architecture note.** The server is a monolith (`api/server.js`) that wires
> side-effect-free **decision modules** (`api/*.js`, each with a `*.test.js`) to the
> real process/GPU/HTTP side effects. Every module header documents the specific
> failure mode it guards against. When reading the code, the pure module is where
> the logic lives; `server.js` is where it meets reality.

---

## 1. Engines (llama.cpp + DS4)

Two engines run behind one abstraction (`api/engines.js`):

- **llama.cpp** — the default. Runs either as a **router** (serves many models,
  loading/unloading on demand) or a **single preset** (one tuned model). Supports
  `/slots`, KV-cache persistence, speculative decoding, embeddings.
- **DS4** — [DeepSeek V4 Flash](ds4-engine.md) via `ds4-server`. Single-model,
  runs **exclusively** (nothing else loads locally), with adaptive context +
  SSD-streaming to fit an 80 GB model. See [`ds4-engine.md`](ds4-engine.md).

`currentEngine` tracks which is active. A preset declares its engine with an
`engine: "ds4"` field (default `"llama"`). Only one engine serves locally at a time;
the guards attribute memory/heat to "the local engine" regardless of which it is.

## 2. Router mode vs single-preset mode (llama.cpp)

- **Router** (`start-llama.sh`): llama.cpp with `--models-dir` serves any model in
  `~/models`, spawning a child process per model up to `MODELS_MAX`. Best for
  ad-hoc multi-model use.
- **Single preset** (`start-preset.sh`): one model with tuned sampling/flags. Best
  for a pinned production model.

**Auto mode-switch.** An incoming request transparently drives the right mode:
`ensureModelServed(model)` swaps into a preset that `autoActivate`s the model, or
back to the router if the current single preset can't serve it. Concurrent callers
share one in-flight swap; requests are queued during the swap, never 404'd.

## 3. One OpenAI-compatible API

Everything is served under `/api/v1/*` regardless of engine or backend:
`chat/completions`, `completions`, `embeddings`, `responses`,
`messages` (+ `count_tokens`, Anthropic-shaped), `rerank`, `models`. Point any
OpenAI-compatible client (OpenCode, Codex, SDKs) at `http://<host>:5250/api/v1`.

Request enrichment happens transparently:
- **`reasoning_effort`** — top-level OpenAI field is moved into
  `chat_template_kwargs`; otherwise per-model (`config.modelReasoningEffort`) or
  `config.defaultReasoningEffort` is applied.
- **Sampling defaults** — model-specific recommended `temp/top_p/top_k/min_p`
  (e.g. Gemma 4, Qwen 3.6) are filled in only when the caller left them unset.

### Realtime conversation context contract

Local llama.cpp models advertise a versioned `context_management` capability
object and provide exact production-template counts at
`chat/completions/input_tokens` and `responses/input_tokens`. Stable
`conversation_cache_key` values keep growing histories on a useful slot lineage;
clients without the extension receive a stable hashed conversation-head fallback
starting on the first user turn. Cold assignments erase the manager-owned slot
before use, preventing stale KV reuse across lineages or authorization scopes.

`context/prepare` creates an opaque, Authorization-scoped lease. `mode: "count"`
only renders/counts; `mode: "prefill"` queues KV work at background priority and
is cancelled when realtime work arrives. llama.cpp b9820 requires one internal
decode token to retain reusable KV; the manager discards it and advertises this
limit without emitting client output. Status and deletion use
`context/{id}`; `DELETE context/cache` removes every attributable memory and disk
record in the caller scope. Raw token and llama.cpp slot ids are never public.

Preparation is admitted under an explicit policy so it can run safely beside
live inference. `resident_only: true` is fail-closed for **both** count and
prefill — the manager never loads, switches, or evicts a model, and a nonresident
model returns HTTP 200 with `status: "skipped"`. Residency of the concrete
resolved model is re-checked *after* the local lane is acquired, so a model swap
racing the request reports `model_no_longer_resident` rather than certifying the
wrong model. `priority: "background"` implies `resident_only`, stays bounded
(HTTP 429 past the queue limit), and is cancelled to `status: "cancelled"` when
realtime work arrives; `priority: "realtime"` is refused outright. Every
response carries `contextCacheContract` plus both `requestedModel` and
`resolvedModel`, so an alias can never silently certify a different model.
`allow_model_load` remains supported as the legacy compatibility path but is
unsafe for realtime background prewarming and is overridden by `resident_only`
or background priority.

Chat extensions `request_priority: "realtime" | "interactive" | "background"`
and `routing: "local_only"` control the single local lane. Realtime skips queued
lower-priority work and preempts background work; background fairness can
interleave with interactive work but never bypasses queued realtime work.
`local_only` suppresses every
remote offload path and returns a machine-readable local-busy error instead of
silently sending prompt data elsewhere. Full rationale and limits are in
[ConversationContextCache.md](Designs/ConversationContextCache.md).

Every prepared-context lease and every chat completion carries a versioned
`timingEvidence` record that separates admission wait, input tokenization, KV
prefill, inference start, and first emitted content for one exact resolved model
and contract revision. Durations are milliseconds on a process-monotonic clock;
manager-observed and client-observed values are reported separately and never
substituted for one another. A dimension that cannot be measured carries an
explicit typed reason and is **never** reported as zero — llama.cpp folds input
tokenization into prompt processing and never reports decode start, so served
completions stay `complete: false` and certification runs through
`context/prepare`, where the manager brackets a discrete tokenization call and a
discrete prefill call itself. Records contain no prompt text, message content, or
credentials. Clocks, units, lifecycle ordering, cache semantics, version
compatibility, and privacy guarantees are defined in
[ContextTimingEvidence.md](Designs/ContextTimingEvidence.md).

## 4. Model alias groups

One global table, `config.aliases`, maps a client-facing **alias name** onto an
**ordered list of targets**, each naming a host (`local` or a backend id) and a model
on it (`api/model-aliases.js`). The router expands the alias into concrete candidates
and prefers whichever is **already warm**. Full operator guide:
[`features/model-alias-groups.md`](features/model-alias-groups.md).

- **Names are exact** — an alias is a literal string the client sends, never a glob,
  so every alias is advertised as a concrete `/v1/models` row (`status: 'alias'`).
- **Target models may glob** (`*`, `?`) and expand against that host's model list at
  resolve time; an exact target resolves whether or not the host lists it yet.
- **Local targets** may name a model, a llama preset id, or a ds4 preset id (a
  ds4-backed first target transparently triggers exclusive DS4 activation).
- **Warm gate** — a local candidate is warm only while **resident**; a remote
  candidate is warm while its backend is reachable. Ranking happens inside the warm
  tier; the cold tier (a local load, and therefore possibly an eviction) is a last
  resort. This is what stops a conversational alias from evicting a resident 120B.
  It is **soft** protection, conditioned on a remote member having queue capacity —
  hard pinning is `config.modelResidency.desiredModels`.
- **An alias shadows a real model of the same name**, since resolution runs at
  request entry. `auto` / `default-router` are rejected; a collision with a real
  local model or preset id warns.
- `default-big` / `default-small` are now **ordinary rows in this table**.
  `GET`/`POST /api/settings` keep `defaultBigModel`/`defaultSmallModel` as read/write
  views onto them, so a client pinned to `default-big` still gets whatever the
  operator has chosen — gpt-oss-120b today, DeepSeek V4 Flash tomorrow — with **no
  client change**.

CRUD at `/api/aliases` (`GET` returns each group with its live warm/cold candidate
preview; `PUT` replaces a group's targets; `DELETE` removes it), edited from
**Settings ▸ Aliases**. The retired per-backend `modelMapping` and the
`defaultBigModel`/`defaultSmallModel` keys are folded into this table by a one-time
idempotent migration in `loadConfig()` (`api/alias-migration.js`), which also seeds a
`local` first target on any folded group whose name is a real local model so
migration never drops local serving. `modelMapping` remains **deprecated but
accepted** on `GET`/`PUT /api/backends` for one release cycle, synthesized from and
folded back into the alias table.

Separately, **display aliases** (`config.modelAliases`) rename models in the UI /
`/v1/models` without changing routing.

## 5. Remote offload & smart routing

Llama Manager can forward requests to remote OpenAI-compatible backends
(`config.backends`, e.g. Ollama boxes) instead of loading everything locally. The
decision (`resolveBackend`) layers several triggers:

- **Offload policy** — `overflow` / `threshold` / `percentage` / `manual`, with
  `preferLocal` vs "spread work to remotes".
- **Queue overflow** — when the local queue is deep, offload if a remote can serve
  it (else queue deeper rather than fail).
- **Protect-resident** (`api/protect-resident.js`) — while a large model (≥ 40 GB)
  is resident and local slots are full, a request for a *different* model is
  offloaded rather than evicting the big one (evicting trips the amdgpu MES suspend
  wedge). This is the anti-thrash policy for the big model.
- **Thermal** — when the APU is hot, dispatch prefers remotes to cool the die.
- **Backfill race** — a stalled local request is raced against the fastest remote;
  first response wins.

Candidates are ranked by priority → measured tokens/sec (EMA) → shared-resource
weight → queue depth. When the request names an **alias**, the eligible candidates
are that alias's own targets (see §4) — a backend the alias does not name cannot
serve it, and the [warm gate](features/model-alias-groups.md#the-warm-gate) filters
them before ranking. For a **direct** model request, the only per-host mechanism left
is `backend.acceptsAny` (a model name to rewrite anything to, migrated from the old
`modelMapping["*"]` key). `acceptsAny` is a **host policy, not an alias fallback**:
an alias whose targets are all down never spills onto a catch-all host. Backends also
carry API-key env vars, cost/concurrency/timeout, and health/circuit-breaker state.
Managed at `/api/backends*`; their model translation lives in the alias table.

Local and remote inference lanes release capacity by the exact identifier
returned from queue acquisition. Unknown, missing, or duplicate releases are
no-ops, so watchdog cleanup and later response-close callbacks cannot reduce the
active count twice or bypass configured concurrency. Pending rows returned by
`GET /api/queue` use display IDs such as `q5`; `DELETE /api/queue/q5` and the
numeric `queueItemId` form cancel the same pending item. Synthetic active IDs
such as `slot5` are intentionally not accepted by the pending-item route.

While **DS4 is active** the box is exclusive: the DS4 model serves locally and
*every other* model offloads (or gets a clean 503) — see [`ds4-engine.md`](ds4-engine.md).

## 6. Presets

A preset is a saved model + launch configuration (`config.presets`). Fields include
`id`, `name`, `modelPath`/`hfRepo`, `context`, auto-activation rules, and a `config`
block. For **llama** presets: `temp/topP/topK/minP`, `chatTemplateKwargs`,
`reasoningFormat`, and `extraSwitches` (e.g. `--jinja`, `--flash-attn on`,
speculative-decoding `--model-draft ...`). For **DS4** presets: streaming/context
fields (see [`ds4-engine.md`](ds4-engine.md)). CRUD + activation at `/api/presets*`.

## 7. Stability guards

Each guard exists because of a real incident on this hardware. All are pure,
unit-tested decision modules wired into `server.js`.

| Guard | Module | Protects against |
|---|---|---|
| **Memory watchdog** | `mem-watchdog.js` | RAM-pressure restarts; defers while a request is streaming; DS4-aware (only restarts on a genuine leak above its 80 GB baseline) |
| **Thermal governor** | `resource-guard.js` | APU overheating on the shared CPU+iGPU die; pauses dispatch / offloads (never unloads); heat-source attribution so external heat doesn't throttle the model |
| **Restart governor** | `restart-governor.js` | Restart-thrash; debounce + circuit breaker + 15-min **wedged-GPU hold** + sustained-thrash hold |
| **Queue admission** | `queue-admission.js` | Overload; offload/queue-deeper instead of 503; hard ceiling backstop |
| **Slot reaper** | `slot-reaper.js` | Leaked local queue slots starving serving |
| **Engine kill** | `engine-kill.js` | Zombie models eating RAM; robust host-PID SIGKILL, surfaces D-state (wedged GPU) |
| **Upstream retry** | `upstream-retry.js` | Restarting the router while a child model is merely still loading (proxy-error 500 ≠ server down) |

Knobs live under `config.guard.*` (temps, `headroomFrac`, `memThresholdPct`, queue
caps, restart-governor timings, DS4 thresholds). See
[`strix-halo-gpu-stability.md`](strix-halo-gpu-stability.md) and
[`GOTCHAS.md`](GOTCHAS.md).

## 8. Slot / KV-cache persistence (llama.cpp)

For llama.cpp, conversations are pinned to a per-slot prefix cache so
same-conversation requests reuse the warmed KV cache, and slot KV state is
**saved/restored across model reloads** (`api/slot-cache.js`, `--slot-save-path`) so
a swapped-out model's conversations aren't re-prefilled cold. Prefix-cache hit/miss
stats surface in the stats stream. (DS4 has no `/slots`; this cleanly no-ops.)

## 9. Embeddings

A **dedicated** embeddings llama-server runs on its own port (5252) because
llama.cpp can't do embeddings and generation in one process
(`start-embed.sh`, `api/embeddings.js`, `config.embed`). Served OpenAI-compatibly at
`/api/v1/embeddings` (+ `/api/v1/rerank`). It may be evicted when DS4 needs the RAM.

## 10. Model download & HuggingFace

Download GGUFs from HuggingFace via the UI or `/api/pull` (progress tracked, gated
models surface a token prompt). HF token handling (`api/hf-token.js`) masks/redacts
the token in all API output. A **DS4-scoped** download endpoint (`/api/ds4/download`)
is repo-allowlisted (`config.ds4.allowedRepos`) and hard-pinned to the ds4 model
dir so ds4 GGUFs can never pollute `~/models`.

Every repo's file listing (`/api/repo/:author/:model/files`) is **ranked and
fit-checked** for this machine (`api/repo-recommendations.js`): one recommended
quant (best bit depth that fits, Q8 preferred over BF16), the rest sorted by fit
then quality, mmproj files kept separate and bundled into "Download recommended"
for vision models. The Download page shows a "Recommended models" chip row
(DeepSeek V4 Flash, Muse Glimmer 30B, the embedding models) that opens that view
directly. See [download-page.md](download-page.md).

## 11. Monitoring, logs & analytics

- **Live stats** (`/api/system/stats`, WebSocket `/ws`): CPU/RAM/GTT/GPU
  temperature/power/clock/busy, the llama stack's own CPU/RAM share, active engine,
  `ds4Runtime`, thermal guard state, queue depth, per-slot context, prefix-cache
  hit rate, downloads.
- **LLM request log** — every request's model/status/latency/tokens/tok-s/backend,
  streamed live (`/api/llm-logs`).
- **Crash & performance analytics** — time-series ring buffers and crash events
  (`/api/analytics*`), durable per-model prompt/decode/TTFT/speculative history
  with scenario labels, plus process monitoring (`/api/processes*`). See
  [`features/model-performance-history.md`](features/model-performance-history.md).
- **Server logs** with configurable filters (`/api/logs`).

## 12. Kiosk mode (optional)

Turn the host into a full-screen dashboard appliance (gdm autologin → a Wayland
`cage` session running Chrome on the dashboard). Standalone installer
`scripts/install-kiosk.sh`; target via `KIOSK_URL` in `.env`. See
[`Utilities/kiosk.md`](Utilities/kiosk.md).

---

## Ports

| Service | Env | Default | This deployment |
|---|---|---|---|
| API + Web UI | `API_PORT` | 3001 | **5250** |
| llama.cpp (OpenAI API) | `LLAMA_PORT` | 8080 | **5251** |
| Embeddings | `EMBED_PORT` | 5252 | 5252 |
| DS4 | `DS4_PORT` | 5253 | 5253 |

## Where things live

| Concern | File(s) |
|---|---|
| Server monolith / all endpoints | `api/server.js` |
| Engine abstraction, DS4 config/validation | `api/engines.js` |
| Model alias groups (incl. default-big/small) | `api/model-aliases.js`, `api/alias-migration.js`, `ui/src/pages/alias-editor.js` |
| Offload / protect-resident | `api/protect-resident.js` |
| DS4 engine | `api/ds4-supervisor.js`, `api/ds4-exclusive.js`, `api/ds4-adaptive.js`, `api/ds4-updater.js`, `start-ds4.sh` |
| Guards | `api/mem-watchdog.js`, `resource-guard.js`, `restart-governor.js`, `queue-admission.js`, `slot-reaper.js`, `engine-kill.js`, `upstream-retry.js` |
| Slot KV cache | `api/slot-cache.js` |
| Embeddings / HF token / app usage | `api/embeddings.js`, `api/hf-token.js`, `api/app-usage.js` |
| Launchers | `start-llama.sh`, `start-preset.sh`, `container-start.sh`, `start-ds4.sh`, `start-embed.sh` |
| UI | `ui/src/App.jsx` |
| Config | Source: `config.json`, `.env`; package: `/etc/llama-manager/` |

## Related docs

- [`features/model-alias-groups.md`](features/model-alias-groups.md) — alias groups: config shape, the warm gate, migration from `modelMapping`
- [`ds4-engine.md`](ds4-engine.md) — DeepSeek V4 Flash engine (this feature set's centerpiece)
- [`ds4-build.md`](ds4-build.md) / [`ds4-auto-update.md`](ds4-auto-update.md) — build + self-updater
- [`Designs/EngineAbstraction.md`](Designs/EngineAbstraction.md) — engine-seam design
- [`Designs/ModelManagement.md`](Designs/ModelManagement.md) — model lifecycle
- [`Designs/PackageSafeRuntime.md`](Designs/PackageSafeRuntime.md) — FHS paths, ownership, and authorization
- [`Utilities/package-installation.md`](Utilities/package-installation.md) — package operator guide
- [`llama-cpp-rocm-build-and-deployment.md`](llama-cpp-rocm-build-and-deployment.md) — the llama.cpp engine build
- [`strix-halo-gpu-stability.md`](strix-halo-gpu-stability.md) / [`GOTCHAS.md`](GOTCHAS.md) — hardware stability
