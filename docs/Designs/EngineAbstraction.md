# Engine Abstraction & the ds4-server Engine

## Overview

Llama Manager historically assumed one inference engine everywhere: llama.cpp
(router or single-preset mode). The **engine abstraction** introduces a second
engine type — **ds4** (antirez/ds4 `ds4-server`, serving DeepSeek V4 Flash) —
behind a small descriptor seam so the rest of the server branches on an engine
descriptor instead of scattering `if (ds4)` checks.

Only one engine serves at a time. Activating a ds4 preset stops llama-server
entirely and hands the box to the ds4 supervisor; activating a llama preset (or
router) stops ds4-server first. The two never co-reside — the 81GB DeepSeek V4
model cannot coexist with the llama models in 124GB RAM.

Activation runs in **true exclusive mode**: local llama models are pre-evicted
with **verified memory reclamation** before ds4-server is spawned, and while ds4
is active every non-ds4 request is offloaded to a remote backend (or cleanly
503'd) instead of loading a second model locally. See
[Exclusive DS4 mode](#exclusive-ds4-mode-pre-eviction--offload-routing).

## Why ds4 needs its own engine

`ds4-server` is a different binary with a different flag set and a reduced HTTP
surface:

- OpenAI-compatible routes only: `/v1/models`, `/v1/chat/completions`,
  `/v1/messages`, `/v1/responses`, `/v1/completions`.
- **No** `/health`, `/slots`, `/props`, `/metrics`. Readiness/health = a `GET
  /v1/models` that returns HTTP 200.
- Exactly **one model per process** (no router, no on-demand multi-model).
- No llama.cpp slot machinery (prefix cache, `/tokenize`, slot save/restore).

## Components

### `api/engines.js` (pure, unit-tested)

Side-effect-free helpers used by both the server and the supervisor:

| Export | Purpose |
|---|---|
| `ENGINE_TYPES` | `{ LLAMA: 'llama', DS4: 'ds4' }` |
| `presetEngine(preset)` | Normalized engine of a preset (defaults to `llama`; unknown → `llama`) |
| `isDs4Preset(preset)` | `presetEngine === 'ds4'` |
| `resolveDs4Config(config, env)` | Resolve `config.ds4` + `DS4_*` env overrides + defaults |
| `engineDescriptor(type, opts)` | `{ type, binPath, port, startScript, supportsSlots, supportsRouter, healthPath, modelsShape }` |
| `validatePresetEngineFields(body)` | Validate the `engine` field + ds4 preset fields (pure; no FS) |
| `resolveDs4ModelPath(modelPath, ggufDir)` | Absolute path pass-through; relative resolved under the ds4 ggufDir |
| `ds4ModelEntry(preset, {created})` | OpenAI `/v1/models` entry for a ds4 model (`owned_by: 'ds4'`) |
| `ds4ModelsList(config, state)` | `[ds4 model]` when ds4 active, else `null` |
| `ds4TargetUrl(port, path)` | `http://127.0.0.1:<port>/<path>` |

### `api/ds4-supervisor.js` (dependency-injected, unit-tested)

`createDs4Supervisor(deps)` returns a state machine `{ start, stop, restart,
health, isRunning, getPid, getActivePreset }`, modeled on the embed-server
supervisor but extracted so start/stop/restart/exit→restart is testable with
`spawn`/`fetch`/timers injected. It:

- spawns `start-ds4.sh` with the ds4 launch env,
- probes readiness/health against `GET /v1/models`,
- auto-restarts on unexpected exit through the shared **restart governor**
  (`restart-governor.js`), and
- on `stop()` SIGTERM→SIGKILLs the child and calls an injected host-side kill
  that reaps `ds4-server` and frees the ds4 port — a pattern that can **never**
  match the `llama-server` process pattern (and vice-versa).

### `start-ds4.sh` (launcher)

Sibling of `start-embed.sh`/`start-preset.sh`. Invoked only by the supervisor.
Enters the distrobox container (default **`llama-rocm-7.2.4`** — the same
container the live llama.cpp uses; the `7rc` container's HSA runtime segfaults
on the gfx1151 iGPU), exports `LD_LIBRARY_PATH=/opt/rocm/lib` and
`HSA_OVERRIDE_GFX_VERSION=11.5.1`, and execs `ds4-server` with:

```
ds4-server -m <model> --host 127.0.0.1 --port <port> \
  [-c <ctx>] [--power <1-100>] \
  [--kv-disk-dir <dir> --kv-disk-space-mb <n>] \
  <extraSwitches (default "--rocm --cors")>
```

`--print-cmd` prints the resolved command and exits (test seam). Env: `DS4_MODEL`
(required), `DS4_SERVER_BIN`, `DS4_PORT`, `DS4_CTX`, `DS4_GGUF_DIR`, `DS4_POWER`,
`DS4_KV_DISK_DIR`, `DS4_KV_DISK_SPACE_MB`, `DS4_EXTRA_SWITCHES`, `DS4_CONTAINER`,
`DS4_IN_DISTROBOX`.

## Config schema

New top-level `config.ds4` block (seeded on first boot; `DS4_*` env still
overrides at read time):

```json
{
  "ds4": {
    "binPath": "/home/yolan/.local/bin/ds4-server",
    "port": 5253,
    "ggufDir": "/home/yolan/models-ds4/deepseek-v4-gguf",
    "container": "llama-rocm-7.2.4",
    "runInDistrobox": true,
    "allowEmbedServer": true
  }
}
```

`allowEmbedServer` (default `true`, `DS4_ALLOW_EMBED_SERVER` override): whether the
small embedding server (~5GB) may stay resident alongside ds4. Exclusive-DS4
activation counts it in the eviction budget and stops it if it would not fit.

Port allocation: API 5250, LLAMA 5251, EMBED 5252, **DS4 5253**.

> The ds4 ggufDir is deliberately **outside** `~/models` so the llama router
> never scans DeepSeek V4 GGUFs.

Presets gain an optional `engine` field (`"llama"` default | `"ds4"`). A **ds4
preset** stores:

```json
{
  "id": "ds4-deepseek-v4-flash",
  "name": "DeepSeek V4 Flash",
  "engine": "ds4",
  "modelPath": "/home/yolan/models-ds4/deepseek-v4-gguf/DeepSeek-V4-Flash-IQ2XXS-...gguf",
  "context": 65536,
  "config": {
    "power": 90,
    "kvDiskDir": "/var/kv-ds4",
    "kvDiskSpaceMb": 40000,
    "extraSwitches": "--rocm --cors"
  }
}
```

`modelPath` is resolved under `config.ds4.ggufDir` when relative and must exist.
`power` (1–100), `context` (≥0), `kvDiskSpaceMb` (≥0) are validated on create/update.

## Request routing while ds4 is active

- `GET /api/models` and `GET /api/v1/models` list only the ds4 model
  (`owned_by: 'ds4'`) plus configured default aliases — the llama `/models` shape
  and disk scan are skipped.
- `POST /api/v1/chat/completions` and `POST /api/v1/completions` apply the
  exclusive routing table below. A request for the **ds4 model** is forwarded
  straight to the ds4 port (`proxyChatToDs4` / `proxyCompletionsToDs4`), bypassing
  slot assignment, prefix cache, `/tokenize`, and `fetchWithRetry`
  error-sniffing. A request for **any other model** is offloaded to a remote
  backend (never loaded locally beside ds4's 81GB). Streaming and non-streaming
  are both supported; the llama path is unchanged.
- The status/stats endpoint reports `engine` and (when ds4 active) `ds4` health.

## Exclusive DS4 mode (pre-eviction + offload routing)

The 81GB DeepSeek V4 model plus gpt-oss-120b (~61GB) cannot coexist in 124GB
unified RAM, and ds4-server sets its own `oom_score_adj=1000` (it is the first
thing the kernel OOM-kills). So activation must **pre-evict and verify** before
spawning ds4 — never load-then-OOM. The decision logic is a pure, GPU-free module
`api/ds4-exclusive.js` (unit-tested in `ds4-exclusive.test.js`); `server.js` wires
it to the real side effects.

### `api/ds4-exclusive.js` (pure, unit-tested)

| Export | Purpose |
|---|---|
| `ds4ModelMatches(model, ids)` | Normalized (case/punctuation-insensitive, substring) match of a request's model to the ds4 engine |
| `ds4RequestTarget({requestedModel, ds4ModelIds, hasViableRemote})` | Routing table → `{target:'local-ds4'\|'remote'\|'reject'}` |
| `reclaimTargetBytes({ds4ModelBytes, headroomBytes})` | MemAvailable that must be free before spawn (model + headroom) |
| `reclaimSatisfied({memAvailableBytes, targetBytes})` | Whether enough RAM is reclaimed |
| `pollForReclaim({readMemAvailable, targetBytes, timeoutMs, intervalMs, sleep, now})` | Poll MemAvailable until reclaimed or timeout (injectable clock; never spawns ds4 itself) |
| `shouldKeepEmbedServer({allowEmbedServer, ds4ModelBytes, embedServerBytes, totalBytes, headroomBytes})` | Embed-server residency within the budget |
| `ds4Exclusive503Body(requestedModel, ds4ModelName)` | OpenAI-style 503 error body (`type/code: exclusive_ds4_mode`) |

### Activation sequence (`activateDs4Exclusive` in server.js)

1. Flip `currentEngine = 'ds4'` immediately so `ensureModelServed` early-returns
   and no new local llama load can race the eviction.
2. Set `ds4SwapPromise` — a swap gate that incoming chat/completions & completions
   requests `await` so mid-swap traffic is **held and served after readiness**,
   never 404'd.
3. `stopLlamaServer()`; stop the embed server unless `shouldKeepEmbedServer` says
   it fits the budget.
4. **Verify reclaim**: `pollForReclaim` on `/proc/meminfo` MemAvailable until it
   reaches `reclaimTargetBytes` (ds4 weights + guard headroom), with a timeout
   (`DS4_RECLAIM_TIMEOUT_MS`, default 180s). **On timeout ds4 is NOT spawned** —
   the box rolls back to the llama router and the activate call returns 503. This
   is the fix for the load-then-OOM pre-eviction bug.
5. Spawn ds4-server. Readiness (`GET /v1/models`) is awaited in the **background**;
   the HTTP activate returns after spawn, and the swap gate releases on readiness.

### Routing table while ds4 active

| Requested model | Action |
|---|---|
| The ds4 model (or alias) | Serve locally on ds4-server |
| Any other model, a remote backend can serve it | **Offload** to the fastest viable remote (`findFastestAvailableBackend` + `buildRemoteRouting`) — never loaded locally |
| Any other model, no viable backend | **503** `exclusive_ds4_mode` (never queue forever, never load locally) |

### Deactivation (`deactivateDs4Exclusive` in server.js)

Activating a llama preset or router mode while ds4 is active reverses the sequence
with the **same verified-reclaim discipline**: stop ds4-server, free its port,
flip `currentEngine = 'llama'`, and verify ds4's ~81GB is released (poll
MemAvailable to a headroom target) before llama-server starts. Gated on
`ds4SwapPromise` so mid-swap requests wait.

### Tuning knobs (env)

`DS4_RECLAIM_TIMEOUT_MS` (180000), `DS4_RECLAIM_INTERVAL_MS` (2000),
`DS4_READY_TIMEOUT_MS` (600000), `DS4_READY_INTERVAL_MS` (3000),
`DS4_ALLOW_EMBED_SERVER` (from `config.ds4.allowEmbedServer`, default true).

ds4 memory-watchdog knobs live under `config.guard`:
`ds4ExpectedResidentGb` (85 — ds4's expected resident baseline in GiB) and
`ds4MemLeakMarginFrac` (0.15 — fractional RSS growth over baseline that counts as
a leak). Only when ds4's RSS exceeds `ds4ExpectedResidentGb × (1 + margin)` **and**
system memory is over `guard.memThresholdPct` does the watchdog restart ds4.

## Guards under ds4 (mem-watchdog, restart governor, thermal, slots, kill)

The stability guards were built from real llama incidents (OOM + thermal redline,
restart thrash, wedged-amdgpu lockup). A ds4-server running 81GB hot on the same
iGPU with guards blind to it would reintroduce every one of those failure modes,
so each guard is engine-aware. **Exclusive mode means exactly one local engine is
ever active**, so a single "local engine" governor/watchdog is correct.

- **Memory watchdog** (`api/mem-watchdog.js` + the `MEM_WATCHDOG_INTERVAL` loop).
  The loop no longer early-returns when `llamaProcess` is null; it branches on
  `currentEngine`. Under ds4 it checks the ds4 supervisor is running and that a
  `ds4-server` process is the heaviest-RSS process, then gates the restart on
  `shouldRestartForResidentLeak`. ds4 holds ~81GB **by design**, so a system-memory
  threshold breach at that baseline is **not** a leak and a restart would only
  reload the same 81GB (minutes of iGPU downtime). The gate therefore requires
  ds4's RSS (`ds4ServerRssBytes()`) to have grown past
  `guard.ds4ExpectedResidentGb × (1 + guard.ds4MemLeakMarginFrac)` (defaults 85 GiB
  and 0.15 → ~97.75 GiB) **and** the system to be under pressure. It fails **safe**
  on an unknown baseline (never restarts on pressure alone). The streaming-defer
  (`shouldDeferMemRestart`, commit d77c5f7) and zero-token prompt-processing grace
  (d6770e6) still apply — ds4 requests share the `activeRequests` map (backend
  `'ds4'`). The restart itself goes through `restartLlamaServer({governed:false})`,
  which delegates to the ds4 supervisor when ds4 is active.

- **Restart governor** (`api/restart-governor.js`). The ds4 supervisor already
  routes auto-restarts through the shared `restartDecision` (debounce +
  circuit-breaker + sustained-thrash). It now also forwards a `getWedged()` signal
  (`containerExecWedged`/`consecutiveFailedRestarts`), so the **wedged-GPU 15-min
  hold** (commit e960d04) applies to ds4 too — a locked GPU won't get a fresh 81GB
  probe every cooldown.

- **Thermal governor** (`api/resource-guard.js` + the thermal loop). Heat
  attribution is what decides whether the die heat is "the llama stack" (throttle)
  or external (leave alone — commit 7c954e3). `getAppUsage` now counts comm
  `ds4-server` as app load (`engines.isEngineProcessComm`), so ds4's CPU/iGPU heat
  is attributed to the stack and the governor pauses/offloads correctly under ds4.
  `thermalDecision` never unloads for heat regardless of engine.

- **Slots** (`api/slot-reaper.js`, the `/slots` proof-of-life probe). ds4-server
  has no llama.cpp `/slots`. Both the per-slot proof-of-life probe and the
  leaked-slot reaper explicitly no-op under ds4 (`engines.engineSupportsSlots`) —
  ds4 requests never take a `llamaQueue` slot, so there is nothing to reap and no
  `/slots` fetch is issued (no errors, no log spam). Remote/ds4 request stall
  handling still runs.

- **Kill / emergency paths.** The `llama-server` and `ds4-server` pkill patterns
  are disjoint (`ds4RunKill` frees the ds4 port and never matches `llama-server`,
  and vice-versa). Shutdown stops all three (`llama`, `embed`, `ds4`); ds4
  deactivation and the mem-watchdog restart both reap ds4 via the supervisor.

## State variables (`api/server.js`)

```javascript
let currentMode = 'router';   // 'router' | 'single'
let currentPreset = null;
let currentEngine = 'llama';  // 'llama' | 'ds4'
```

## Live verification (pending)

The ds4 supervisor mechanics, routing helpers, and exclusive-mode decision logic
(reclaim budget/poll, routing table, embed budget, 503 body) are unit-tested with
the process/HTTP/clock/meminfo mocked. A real ds4-server round-trip requires the
81GB model loaded in an operator memory window (ds4 + gpt-oss-120b cannot
coexist), so end-to-end verification is performed manually after merge:

1. With gpt-oss-120b resident, watch `free -m -s1` (or `watch -n1 free -m`) and
   activate the ds4 preset. Confirm MemAvailable never drops below the guard
   headroom and **swap never grows** during the swap — the reclaim poll gates the
   spawn.
2. Confirm `GET /api/v1/models` lists the ds4 model and a chat completion for it
   round-trips through ds4-server.
3. While ds4 is active, send a chat/completions for a **non-ds4** model: it must
   land on a configured offload backend, or return a clean 503
   (`type: exclusive_ds4_mode`) if no backend maps it — it must **never** load a
   second model locally.
4. Send a chat request **during** the activation window: it must be held and
   answered after ds4 readiness, not errored.
5. Deactivate (activate a llama preset / router): confirm ds4 stops, its ~81GB is
   released, and llama routing resumes.
