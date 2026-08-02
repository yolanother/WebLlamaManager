# Model Management, Memory Recovery & Preset System

## Overview

Llama Manager operates in two mutually exclusive server modes and automatically handles memory constraints when loading large models. This document covers the full lifecycle of model switching, the preset system, automatic OOM recovery, and how configuration affects model loading behavior.

## Server Modes

### Router Mode (Default)

The default mode runs llama.cpp with `--models-dir` and `--models-max`, enabling on-demand multi-model loading with LRU eviction.

**Characteristics:**
- Models are auto-discovered from `~/models` and available to load on first request
- Up to `modelsMax` models are kept loaded simultaneously (configurable, default: 2)
- When the limit is reached, llama.cpp's internal LRU policy evicts the least recently used model
- No server restart needed to switch between models
- All models share the same `contextSize` and `gpuLayers` settings

**Startup flow:**
1. API server starts on configured port (default: 5250)
2. If `autoStart` is enabled, the API calls `POST /api/server/start` after a 1-second delay
3. `start-llama.sh` enters the distrobox container and runs `container-start.sh`
4. `container-start.sh` sets AMD GPU environment variables and launches llama-server with router flags

**State variables** (`api/server.js`):
```javascript
let currentMode = 'router';
let currentPreset = null;
```

### Exact Desired-Model Residency

Operators can declare exact concrete model identifiers that must remain loaded
locally in router mode. The declaration is persisted in
`config.modelResidency.desiredModels` and is intentionally separate from the
size-based anti-thrash policy: residency is an explicit identity contract, not
an estimate based on file size.

```http
PUT /api/models/residency
Content-Type: application/json

{"models":["google_gemma-4-E2B-it-qat-q4_0-gguf"]}
```

The router immediately begins restoring missing declared models and returns
`202 Accepted`. Send an empty array to release all declarations and restore the
ordinary routing and eviction behavior.

While a declaration is active:

- Requests for that exact model are forced to the local router, even when a
  remote backend can serve a similarly named model.
- A conflicting request is sent to a viable remote backend when possible.
  Otherwise it is rejected before eviction with HTTP `409` and code
  `RESIDENT_MODEL_PROTECTED`.
- Automated memory recovery, manual unloads, DS4 activation, and incompatible
  single-model presets cannot remove the declared resident.
- Router startup and restart restore any missing declarations before normal
  recovery continues.

`GET /api/models/residency` returns the desired models and their current loaded
state. `GET /api/models/residency/ready` refreshes the live router snapshot and
returns `503` whenever any declaration is missing. `/api/status`, `/health`, and
each `/v1/models` entry also expose residency state; a model alias derives its
readiness from the concrete alias target rather than from the synthetic alias
entry.

### Single Model Mode (Presets)

Activated by launching an optimized preset. Stops the router and starts llama.cpp with model-specific settings (sampling parameters, chat templates, reasoning format, custom switches).

**Characteristics:**
- Only one model loaded, with optimized configuration
- Supports model-specific sampling (temp, topP, topK, minP)
- Supports chat template kwargs (e.g., `{"reasoning_effort": "high"}`)
- Supports reasoning format flags (e.g., `--reasoning-format deepseek`)
- Falls back to router mode if the process exits with a non-zero code

## Preset System

### Presets

Presets are stored in `config.json` under the `presets` key. Default presets are seeded on first run and can be deleted or modified by users. Each preset supports:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `name` | Display name |
| `description` | Optional description |
| `modelPath` | Full local path to a GGUF file |
| `hfRepo` | HuggingFace repo reference (e.g., `Unsloth/Qwen3-Coder-Next-GGUF:Q5_K_M`) |
| `context` | Context size (0 = use model default) |
| `config.temp` | Sampling temperature |
| `config.topP` | Top-P sampling |
| `config.topK` | Top-K sampling |
| `config.minP` | Min-P sampling |
| `config.chatTemplateKwargs` | JSON string for chat template kwargs |
| `config.extraSwitches` | Additional CLI switches (default: `--jinja`) |

When both `hfRepo` and `modelPath` are set, `hfRepo` takes precedence.

#### Default Presets

The following presets are seeded on first installation:

| Preset ID | Model | Key Config |
|-----------|-------|------------|
| `gpt120` | GPT-OSS 120B | reasoning_effort: high, deepseek format, 131K context |
| `qwen3` | Qwen3 Coder 30B-A3B | deepseek reasoning, temp 0.7, topK 20 |
| `qwen2.5` | Qwen 2.5 Coder 32B | deepseek reasoning, temp 0.7, topK 20 |

### Preset Activation Flow

```
User or MCP tool activates preset
        │
        ▼
POST /api/presets/:presetId/activate
        │
        ▼
┌─────────────────────────┐
│  Validate preset exists  │
│  in config.presets       │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  stopLlamaServer()       │
│  - SIGTERM → wait 1s     │
│  - SIGKILL if still up   │
│  - pkill fallback        │
└───────────┬─────────────┘
            │
            ▼
  currentMode = 'single'
  currentPreset = presetId
            │
            ▼
  spawn start-preset.sh
  (enters distrobox, passes all config as env vars)
            │
            ▼
┌─────────────────────────┐
│  Monitor process exit    │
│  Non-zero exit code:     │
│  → Reset to router mode  │
│  → currentPreset = null  │
└─────────────────────────┘
```

### Startup Scripts

**`start-preset.sh`** handles all presets:
- Validates that `HF_REPO` or `MODEL_PATH` is set
- Sets AMD GPU environment (`HSA_OVERRIDE_GFX_VERSION=11.5.1`)
- Uses the source-configured binary or the package-pinned container binary
- Builds a literal argv array from environment values
- Passes argv after a fixed single-quoted Distrobox script; values are never
  interpolated as shell source
- If `HF_REPO` is set: uses `-hf 'repo'` flag (downloads/caches automatically)
- If `MODEL_PATH` is set: uses `--model 'path'` flag

**`container-start.sh`** handles router mode:
- Sets `LLAMA_CACHE=$MODELS_DIR` so HuggingFace downloads land in the models directory
- Launches with `--models-dir`, `--models-max`, `--ctx-size`, `-ngl`, `--no-mmap`
- Optionally adds `--no-warmup` and `--flash-attn`
- Uses an argv array so model and slot-cache paths remain single literal values

## Automatic OOM Recovery

### Proactive Admission

Before a managed inference request or `POST /api/models/load` contacts
llama.cpp, the API serializes it through the local request lane and estimates
the incoming model's full GGUF weights, KV cache, and runtime overhead against
host `MemAvailable`. This accounts for Strix Halo unified CPU/GPU memory because
GPU-layer weights consume the same host RAM budget.

The guard preserves operator-configured headroom by subtracting
`config.guard.headroomFrac` of total host RAM. Operators that prefer a fixed
reserve can set `config.guard.reservedHeadroomGb`, which overrides the fraction.
If the model does not currently fit, the manager unloads eligible competing
models and remeasures before attempting the load. If it still cannot fit, it
returns `507 MODEL_TOO_LARGE`; an explicit preload whose local size cannot be
resolved returns `503 MODEL_SIZE_UNKNOWN`. Neither case starts loading the
target model.

### Reactive Fallback

When a model passes proactive admission but llama.cpp still reports insufficient
GPU/GTT memory, the API layer retains a reactive unload-and-retry fallback for
runtime estimates that differ from the actual allocator footprint.

### Detection

The `isModelLoadFailure()` function checks for the specific failure pattern:

```javascript
function isModelLoadFailure(status, text) {
  return status === 500 && typeof text === 'string' && text.includes('failed to load');
}
```

This triggers on HTTP 500 responses from llama.cpp that contain "failed to load" in the body, which is the error llama.cpp returns when memory allocation fails during model loading.

### Recovery Flow

```
Client request (e.g., POST /v1/chat/completions with model A)
        │
        ▼
  Proxy request to llama.cpp
        │
        ├── Success ──▶ Stream/return response to client
        │
        └── 500 "failed to load" detected
                │
                ▼
        unloadOtherModels(modelA)
                │
                ▼
        ┌────────────────────────┐
        │  GET /models           │
        │  Find all loaded       │
        │  models except A       │
        └───────────┬────────────┘
                    │
                    ▼
        ┌────────────────────────┐
        │  For each loaded model │
        │  POST /models/unload   │
        │  Log: "Auto-unloading  │
        │   model X to make      │
        │   room for model A"    │
        └───────────┬────────────┘
                    │
                    ▼
        Retry original request
                    │
                    ├── Success ──▶ Stream/return response
                    │
                    └── Still fails ──▶ Check for template error
                                        │
                                        ├── Template error ──▶ Sanitize messages, retry
                                        │
                                        └── Other error ──▶ Return error to client
```

### Affected Endpoints

Proactive admission and the reactive fallback protect these model-loading paths:

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages API format |
| `POST /api/models/load` | Explicit model preload; unknown size fails closed |

### Message Sanitization (Template Error Recovery)

Some models reject messages that have both `content` and `thinking` keys when `tool_calls` are present. After the OOM retry, if a template error is detected, the system automatically sanitizes the messages:

```javascript
// Merges content into thinking, removes content key
{ role: 'assistant', tool_calls: [...], content: '...', thinking: '...' }
// Becomes:
{ role: 'assistant', tool_calls: [...], thinking: '<merged>' }
```

Detection uses: `text.includes('Cannot pass both content and thinking')`

## Transient Failure Retry

For connection-level failures (socket errors, timeouts during model switching), a `fetchWithRetry` function provides exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1st retry | 1 second |
| 2nd retry | 2 seconds |
| 3rd retry | 4 seconds |

This handles the brief window where llama.cpp is restarting or a model is being loaded. HTTP error responses (500, 404, etc.) are **not** retried by this mechanism — only connection failures.

## Configuration Reference

### Settings that Affect Model Loading

| Setting | Default | Range | Effect |
|---------|---------|-------|--------|
| `modelsMax` | 2 | 1-10 | Max simultaneous models in router mode. Passed as `--models-max` to llama.cpp. Higher values require more memory. |
| `contextSize` | 8192 | 512-262144 | Context window size for all models in router mode. Passed as `--ctx-size`. Larger values use more memory and slow warmup. |
| `gpuLayers` | 99 | 0-999 | Layers offloaded to GPU. 99 = all layers. Lower values use less GPU memory but slower inference. |
| `noWarmup` | false | boolean | Skip model warmup on load. Faster startup but first inference is slower. |
| `flashAttn` | false | boolean | Enable flash attention. Reduces memory usage and improves speed on compatible GPUs. |
| `autoStart` | true | boolean | Auto-start llama server in router mode when the API starts. |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODELS_DIR` | `~/models` | Directory containing GGUF model files |
| `API_PORT` | `3001` | Management API port |
| `LLAMA_PORT` | `8080` | llama.cpp server port |
| `MODELS_MAX` | `2` | Override for modelsMax |
| `CONTEXT_SIZE` | `8192` | Override for contextSize |
| `AUTO_START` | `true` | Override for autoStart |
| `HF_TOKEN` | _(unset)_ | Fallback HuggingFace token for gated model downloads; the installer and runtime launchers deliver it through protected files, never process arguments |
| `LLAMA_UI_URL` | _(unset)_ | Override URL for the llama.cpp native UI link |

Persisted `autoStart` must be the JSON boolean `true` to schedule the internal
`POST /api/server/start`; boolean `false` and legacy string values remain
passive. The safe configuration utility preserves valid JSON literals when
writing JSON files, as documented in
[dev-config](../Utilities/dev-config.md).

### Credential Delivery

The Settings-managed HuggingFace token remains the preferred source for model
downloads. When the `HF_TOKEN` environment fallback is used, `install.sh`
atomically writes it to a mode-0600 systemd `EnvironmentFile` in the user's
Llama Manager configuration directory. The generated unit references that file
instead of embedding the value in the unit or its command line.

`start-llama.sh` and `start-embed.sh` use the shared
`scripts/runtime-credentials.sh` helper to atomically create component-specific,
mode-0600 environment files beneath `$XDG_RUNTIME_DIR/llama-manager`. Distrobox
is launched with `HF_TOKEN` removed from its inherited host environment and
receives only `--env-file=<path>`; this prevents Distrobox's automatic
environment forwarding from expanding the raw credential into Podman arguments.
The raw credential is therefore absent from host and container-launch process
argument lists. The containing runtime directory is mode 0700.

Rotating the fallback credential requires updating the environment source and
rerunning `./install.sh`; subsequent runtime launches atomically replace their
component credential files. Revocation and creation of HuggingFace tokens must
be performed by an authorized operator in HuggingFace itself.

## Graceful Shutdown

When the API server receives SIGTERM or SIGINT:

1. Initiates ownership-scoped engine shutdown:
   - Sends SIGTERM to the llama.cpp process
   - Waits 1 second for graceful exit
   - If still running, sends SIGKILL
   - Performs robust host cleanup only if this manager spawned the engine
2. Sets a 10-second force-exit timeout as a safety net
3. Exits cleanly after llama.cpp is stopped

The systemd service (`llama-manager.service`) is configured to handle this via `systemctl --user stop llama-manager`, which sends SIGTERM and waits for clean shutdown.
Explicit start, mode-switch, and recovery operations still perform global stale
engine cleanup because those operations deliberately claim supervision. A
passive secondary manager that never started an engine performs no PID sweep or
port cleanup on shutdown.

## Switching Modes

### Router to Preset

1. User activates a preset via UI or `POST /api/presets/:id/activate`
2. Running router server is stopped
3. Single-model server starts with preset configuration
4. Mode switches to `'single'`, preset ID is recorded

### Preset to Router

1. User clicks "Start Server" (router mode) via UI or `POST /api/server/start`
2. Running single-model server is stopped
3. Router server starts with `modelsMax` and `contextSize` from config
4. Mode switches to `'router'`, preset is cleared

### Preset Failure Recovery

If a preset's llama.cpp process exits with a non-zero code (e.g., model file not found, GPU memory exhaustion):
1. Exit handler detects non-zero exit code
2. Automatically resets: `currentMode = 'router'`, `currentPreset = null`
3. The server is stopped but not restarted — user can manually start router mode or try a different preset

## Context Usage Tracking

The API monitors context utilization across all loaded models in real-time:

1. Queries `/models` to find loaded models and their assigned ports
2. For each loaded model, queries `/slots` on its worker port
3. Aggregates `n_ctx` (total context) and `n_decoded` (used context) across all slots
4. Reports per-model and aggregate usage percentage on the dashboard

This data feeds into the dashboard's Context progress ring and the historical analytics system.
