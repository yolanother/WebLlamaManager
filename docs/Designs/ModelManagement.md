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

### Single Model Mode (Presets)

Activated by launching an optimized preset. Stops the router and starts llama.cpp with model-specific settings (sampling parameters, chat templates, reasoning format, custom switches).

**Characteristics:**
- Only one model loaded, with optimized configuration
- Supports model-specific sampling (temp, topP, topK, minP)
- Supports chat template kwargs (e.g., `{"reasoning_effort": "high"}`)
- Supports reasoning format flags (e.g., `--reasoning-format deepseek`)
- Falls back to router mode if the process exits with a non-zero code

## Preset System

### Built-in Presets

Defined in `OPTIMIZED_PRESETS` in `api/server.js`. Each preset specifies a HuggingFace repo, quantization, context size, and model-specific config:

| Preset ID | Model | Key Config |
|-----------|-------|------------|
| `gpt120` | GPT-OSS 120B | reasoning_effort: high, deepseek format, 131K context |
| `qwen3` | Qwen3 Coder 30B-A3B | deepseek reasoning, temp 0.7, topK 20 |
| `qwen2.5` | Qwen 2.5 Coder 32B | deepseek reasoning, temp 0.7, topK 20 |

### Custom Presets

Users create custom presets via the web UI or API. Stored in `config.json` under the `customPresets` key. Each custom preset supports:

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

### Preset Activation Flow

```
User clicks "Activate Preset"
        │
        ▼
POST /api/presets/:presetId/activate
        │
        ▼
┌─────────────────────────┐
│  Validate preset exists  │
│  (built-in or custom)    │
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
            ├── Built-in preset ──▶ spawn start-single-model.sh
            │                       (enters distrobox, uses PRESET_ID env var)
            │
            └── Custom preset ──▶ spawn start-custom-preset.sh
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

**`start-custom-preset.sh`** handles custom presets:
- Validates that `HF_REPO` or `MODEL_PATH` is set
- Sets AMD GPU environment (`HSA_OVERRIDE_GFX_VERSION=11.5.1`)
- Uses the correct binary at `~/.local/bin/llama-server` (not the outdated `/usr/local/bin/llama-server`)
- Builds the command dynamically based on environment variables
- If `HF_REPO` is set: uses `-hf 'repo'` flag (downloads/caches automatically)
- If `MODEL_PATH` is set: uses `--model 'path'` flag

**`container-start.sh`** handles router mode:
- Sets `LLAMA_CACHE=$MODELS_DIR` so HuggingFace downloads land in the models directory
- Launches with `--models-dir`, `--models-max`, `--ctx-size`, `-ngl`, `--no-mmap`
- Optionally adds `--no-warmup` and `--flash-attn`

## Automatic OOM Recovery

When a model fails to load because there isn't enough GPU/GTT memory (typically because other models are already consuming it), the API layer automatically unloads competing models and retries.

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

The OOM recovery logic is applied to all three proxy endpoints that load models on-demand:

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages API format |

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
| `HF_TOKEN` | _(unset)_ | HuggingFace token for gated model downloads |
| `LLAMA_UI_URL` | _(unset)_ | Override URL for the llama.cpp native UI link |

## Graceful Shutdown

When the API server receives SIGTERM or SIGINT:

1. Initiates `stopLlamaServer()`:
   - Sends SIGTERM to the llama.cpp process
   - Waits 1 second for graceful exit
   - If still running, sends SIGKILL
   - Falls back to `pkill` if process handle is lost
2. Sets a 10-second force-exit timeout as a safety net
3. Exits cleanly after llama.cpp is stopped

The systemd service (`llama-manager.service`) is configured to handle this via `systemctl --user stop llama-manager`, which sends SIGTERM and waits for clean shutdown.

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
