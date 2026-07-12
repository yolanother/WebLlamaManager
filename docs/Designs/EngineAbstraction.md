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

> Full exclusive-mode pre-eviction + offload routing of non-ds4 requests while
> ds4 is active is a **later task** (epic task 3). This layer only makes preset
> activation start/stop the correct process and route ds4 requests to ds4.

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
    "runInDistrobox": true
  }
}
```

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
- `POST /api/v1/chat/completions` is forwarded straight to the ds4 port via
  `proxyChatToDs4`, bypassing slot assignment, prefix cache, `/tokenize`,
  `resolveBackend`, and `fetchWithRetry` error-sniffing. Streaming and
  non-streaming are both supported; the llama path is unchanged.
- The status/stats endpoint reports `engine` and (when ds4 active) `ds4` health.

## State variables (`api/server.js`)

```javascript
let currentMode = 'router';   // 'router' | 'single'
let currentPreset = null;
let currentEngine = 'llama';  // 'llama' | 'ds4'
```

## Live verification (pending)

The ds4 supervisor mechanics and routing helpers are unit-tested with the
process/HTTP mocked. A real ds4-server round-trip requires the 81GB model loaded
in an operator memory window (ds4 + gpt-oss-120b cannot coexist), so end-to-end
verification is performed manually after merge — activate a ds4 preset, confirm
`/api/v1/models` shows the ds4 model, and round-trip a chat completion.
