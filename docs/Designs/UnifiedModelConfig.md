# Unified Model Configuration

**Work Item:** LM-0MLTACWX501VQG78  
**Status:** Design Draft  
**Authors:** Sorra The Orc, Yolan (Discord discussion), AI Assistant  

## Overview

This design merges the current two-mode system (router mode vs. preset/single mode) into a unified model configuration approach. Presets become the primary abstraction for exposing models to API clients, eliminating the confusing split between "download and use" vs. "configure and activate."

## Current State

### Two Mutually Exclusive Modes

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ROUTER MODE (Default)                            │
│  - llama-server started with --models-dir ~/models --models-max 2       │
│  - Models auto-discovered, loaded on-demand                             │
│  - Model ID = file path (e.g., "qwen/qwen2.5-coder.gguf")              │
│  - All models share same context, GPU layers, sampling defaults         │
│  - Multi-model with LRU eviction                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                          (server restart)
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      SINGLE/PRESET MODE                                  │
│  - llama-server started with --model <path> + custom flags              │
│  - Only one model loaded with optimized config                          │
│  - Model ID = preset ID (e.g., "qwen3")                                 │
│  - Custom context, sampling, chat templates, reasoning format           │
│  - No multi-model capability                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Problems

1. **Model ID inconsistency**: In router mode, clients use file paths. In preset mode, clients use preset IDs. This breaks tooling like opencode that expects consistent model names.

2. **Presets don't apply in router mode**: Users create presets expecting them to be used when the model loads, but router mode ignores all preset configuration.

3. **No per-model config in multi-model**: Router mode forces all models to share the same context size, GPU layers, etc.

4. **Confusing UX**: Users must understand the mode system to configure their setup correctly.

## Proposed Design

### Core Concept: Preset-First Architecture

Every model exposed to API clients is defined by a preset. The preset ID becomes the canonical model identifier.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         MODEL CONFIGURATIONS                             │
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │ qwen3-fast      │  │ qwen3-large     │  │ mistral-7b      │          │
│  │ ─────────────── │  │ ─────────────── │  │ ─────────────── │          │
│  │ model: qwen3... │  │ model: qwen3... │  │ model: mistr... │          │
│  │ context: 4096   │  │ context: 32768  │  │ context: 8192   │          │
│  │ temp: 0.7       │  │ temp: 0.7       │  │ temp: 0.8       │          │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘          │
│           │                    │                    │                    │
│           └────────────────────┼────────────────────┘                    │
│                                │                                         │
│                                ▼                                         │
│                    ┌─────────────────────┐                              │
│                    │   UNIFIED ROUTER    │                              │
│                    │   ───────────────── │                              │
│                    │   Maps preset ID    │                              │
│                    │   to model + config │                              │
│                    │   Decides: hot-swap │                              │
│                    │   or restart?       │                              │
│                    └─────────────────────┘                              │
│                                │                                         │
│                                ▼                                         │
│                    ┌─────────────────────┐                              │
│                    │     llama.cpp       │                              │
│                    └─────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Automatic Preset Creation

When a model is downloaded (or discovered in ~/models), a default preset is automatically created:

```javascript
// On model download/discovery
const defaultPreset = {
  id: generatePresetId(modelFileName),    // e.g., "qwen2.5-coder-32b"
  name: extractModelName(modelFileName),  // Human-readable name
  modelPath: fullPathToModel,
  context: 8192,                          // Default context
  config: {
    temp: 0.7,
    topP: 1.0,
    topK: 20,
    minP: 0,
    extraSwitches: '--jinja'
  }
};
```

**Preset ID Generation:**
- Strip `.gguf` extension
- Strip quantization suffix (e.g., `-Q5_K_M`)
- Convert to lowercase, replace spaces with hyphens
- Example: `Qwen2.5-Coder-32B-Instruct-Q5_K_M.gguf` → `qwen2.5-coder-32b-instruct`

### Request Flow

```
Client Request
POST /v1/chat/completions
{ "model": "qwen3-fast", ... }
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 1. PRESET LOOKUP                                                       │
│    preset = config.presets["qwen3-fast"]                              │
│    → Returns { modelPath, context, config, ... }                      │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 2. COMPATIBILITY CHECK                                                 │
│    Compare preset config to current server config:                    │
│    - Same context size?                                               │
│    - Same GPU layers?                                                 │
│    - Same extra switches that require restart?                        │
│                                                                        │
│    Result: COMPATIBLE or INCOMPATIBLE                                  │
└───────────────────────────────────────────────────────────────────────┘
        │
        ├─────────────── COMPATIBLE ───────────────┐
        │                                          │
        │                                          ▼
        │                              ┌─────────────────────────────┐
        │                              │ 3a. HOT-SWAP PATH           │
        │                              │     - Map preset ID to      │
        │                              │       file path             │
        │                              │     - Forward to llama.cpp  │
        │                              │       with model=filepath   │
        │                              │     - Inject sampling       │
        │                              │       params into request   │
        │                              └─────────────────────────────┘
        │                                          │
        │                                          │
 INCOMPATIBLE                                      │
        │                                          │
        ▼                                          │
┌─────────────────────────────┐                    │
│ 3b. RESTART PATH            │                    │
│     - Stop llama-server     │                    │
│     - Restart with new      │                    │
│       context/GPU config    │                    │
│     - Forward request       │                    │
│     - Update "current       │                    │
│       server config"        │                    │
└─────────────────────────────┘                    │
        │                                          │
        │                                          │
        └──────────────────┬───────────────────────┘
                           │
                           ▼
                   Response to Client
```

### Configuration Compatibility Rules

| Setting | Requires Restart? | Notes |
|---------|------------------|-------|
| `context` | Yes | llama.cpp allocates KV cache at startup |
| `gpuLayers` | Yes | GPU memory allocation is fixed at startup |
| `flashAttn` | Yes | Compilation flag affects KV cache format |
| `reasoningFormat` | Yes | Requires `--reasoning-format` CLI flag |
| `extraSwitches` | Depends | Some flags are runtime, some require restart |
| `temp`, `topP`, `topK`, `minP` | No | Can be passed per-request |
| `chatTemplateKwargs` | No | Can be passed per-request via `extra_body` |

### Server State Tracking

```javascript
// Current server configuration (what llama-server was started with)
let serverConfig = {
  context: 8192,
  gpuLayers: 99,
  flashAttn: false,
  modelsMax: 2,
  // ... other startup params
};

// Check if a preset is compatible with current server config
function isCompatible(preset) {
  if (preset.context > serverConfig.context) return false;
  if (preset.config?.gpuLayers !== serverConfig.gpuLayers) return false;
  // ... other checks
  return true;
}
```

### Sampling Parameter Injection

For compatible requests, inject preset sampling params into the request body:

```javascript
async function proxyWithPreset(preset, originalBody) {
  const body = {
    ...originalBody,
    model: preset.modelPath,  // Map preset ID → file path
    temperature: preset.config?.temp ?? originalBody.temperature,
    top_p: preset.config?.topP ?? originalBody.top_p,
    top_k: preset.config?.topK ?? originalBody.top_k,
    min_p: preset.config?.minP ?? originalBody.min_p,
  };
  
  // Chat template kwargs via extra_body if supported
  if (preset.config?.chatTemplateKwargs) {
    body.extra_body = {
      ...body.extra_body,
      chat_template_kwargs: JSON.parse(preset.config.chatTemplateKwargs)
    };
  }
  
  return fetch(llamaUrl, { body: JSON.stringify(body) });
}
```

## API Changes

### Model Listing

`GET /api/models` returns presets instead of raw files:

```json
{
  "models": [
    {
      "id": "qwen3-fast",
      "name": "Qwen3 Fast",
      "modelPath": "/home/user/models/qwen3.gguf",
      "context": 4096,
      "status": "available"
    },
    {
      "id": "qwen3-large", 
      "name": "Qwen3 Large Context",
      "modelPath": "/home/user/models/qwen3.gguf",
      "context": 32768,
      "status": "loaded"
    }
  ]
}
```

### Backward Compatibility

For transition period, support both preset IDs and raw file paths:

```javascript
function resolveModel(modelId) {
  // First, try as preset ID
  if (config.presets[modelId]) {
    return config.presets[modelId];
  }
  
  // Fall back to file path (legacy behavior)
  const modelPath = join(MODELS_DIR, modelId);
  if (existsSync(modelPath)) {
    console.warn(`[compat] Model "${modelId}" resolved as file path. ` +
                 `Consider creating a preset for consistent behavior.`);
    return {
      id: modelId,
      modelPath: modelPath,
      context: serverConfig.context,  // Use current server defaults
      config: {}
    };
  }
  
  return null;  // Not found
}
```

## Migration Path

### Phase 1: Auto-create presets for existing models

On server startup, scan ~/models and create presets for any models without one:

```javascript
function migrateExistingModels() {
  const localModels = scanLocalModels();
  
  for (const model of localModels) {
    const presetId = generatePresetId(model.name);
    
    if (!config.presets[presetId]) {
      config.presets[presetId] = {
        id: presetId,
        name: model.name,
        modelPath: model.path,
        context: config.contextSize,  // Use current default
        config: {
          temp: 0.7,
          topP: 1.0,
          topK: 20,
          minP: 0,
          extraSwitches: '--jinja'
        }
      };
      console.log(`[migration] Created preset "${presetId}" for ${model.name}`);
    }
  }
  
  saveConfig();
}
```

### Phase 2: Deprecate raw file path model IDs

- Log warnings when file paths are used directly
- Update documentation to use preset IDs
- Update opencode config examples

### Phase 3: Remove file path support

- Remove fallback in `resolveModel()`
- Require all API requests to use preset IDs

## UI Changes

### Model Management Section

Merge "Downloads" and "Presets" into unified "Models" section:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ MODELS                                                         [+ Add] │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ qwen3-fast                                              [Loaded] ● │ │
│ │ Qwen3 Coder 30B-A3B • Context: 4K • /models/qwen3.gguf           │ │
│ │ [Edit] [Duplicate] [Delete]                                       │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ qwen3-large                                                    ○ │ │
│ │ Qwen3 Coder 30B-A3B • Context: 32K • /models/qwen3.gguf          │ │
│ │ [Edit] [Duplicate] [Delete]                                       │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ mistral-7b                                                     ○ │ │
│ │ Mistral 7B Instruct • Context: 8K • /models/mistral-7b.gguf      │ │
│ │ [Edit] [Duplicate] [Delete]                                       │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**"Duplicate" creates a variant preset** pointing to the same model file with different config.

### Remove Global Defaults

Move `contextSize`, `gpuLayers`, etc. from Settings to the preset creation flow:

- When creating a preset, user specifies context
- "Use recommended" option could pull from HuggingFace metadata (future enhancement)

## Implementation Plan

### Milestone 1: Preset-as-Model-ID (MVP)

1. Add `resolveModel()` function to map preset ID → model config
2. Modify `/v1/chat/completions` to use `resolveModel()`
3. Inject sampling params from preset into requests
4. Keep backward compatibility with file paths

### Milestone 2: Auto-create Presets

1. Add `generatePresetId()` function
2. Hook into model download completion to create preset
3. Add migration for existing models on startup

### Milestone 3: Smart Restart

1. Track `serverConfig` state
2. Implement `isCompatible()` check
3. Add restart path for incompatible presets
4. Handle in-flight requests during restart

### Milestone 4: UI Unification

1. Merge Models/Presets UI sections
2. Add "Duplicate" action for presets
3. Remove global default settings
4. Update preset creation flow

## Open Questions

1. **HuggingFace metadata**: Should we attempt to read recommended settings from model cards? Yolan mentioned this exists but availability is inconsistent.

2. **Preset naming conflicts**: What happens if two models generate the same preset ID? Suggest appending a numeric suffix.

3. **Remote model support**: Discord mentioned presets could route to third-party APIs. Should this be in scope for v1?

4. **Server restart UX**: When restart is needed, should we queue the request and wait, or return an error asking client to retry?

## References

- Discord discussion: Sorra The Orc & Yolan (2026-02-19)
- Current design: [ModelManagement.md](./ModelManagement.md)
- Work item: LM-0MLTACWX501VQG78
