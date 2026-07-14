# Architecture and Design Documentation

This directory contains design documents for Llama Manager features and architecture
decisions. For the full feature map see [features-overview.md](features-overview.md);
for the docs index see [README.md](README.md).

## Overview

Llama Manager is a control plane for local LLM inference on an AMD Strix Halo
(gfx1151) box. It runs **multiple inference engines** behind one OpenAI-compatible
API and routes/offloads requests across local and remote backends. It provides:

- **Multi-engine**: llama.cpp (router / single preset) and DS4 / DeepSeek V4 Flash
- **Web UI**: React interface for model management, monitoring, and chat
- **REST + OpenAI-Compatible API**: drop-in for OpenAI clients + full management API
- **Model aliasing & remote offload**: `default-big`/`default-small`, backend routing
- **Stability guards**: memory/thermal/restart governors for the shared CPU+iGPU die
- **MCP Server** + **real-time WebSocket monitoring**

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Web UI (React)                        │
│  Dashboard │ Models │ Chat │ Docs │ Settings │ API Docs     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Llama Manager API  (Express, :5250)           │
│  default-big/small aliasing · routing & offload · presets    │
│  guards (memory · thermal · restart · queue · protect-res.)  │
│  download · analytics · logging · OpenAI/Anthropic wrappers  │
└─────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌───────────────┐   ┌────────────────┐   ┌──────────────────┐
│  llama.cpp    │   │  DS4-server    │   │  remote backends │
│  :5251        │   │  DeepSeek V4   │   │  (Ollama, …)     │
│  router /     │   │  Flash :5253   │   │  offload target  │
│  single preset│   │  (exclusive)   │   └──────────────────┘
│  + embeddings │   │  adaptive ctx  │
│  :5252        │   │  + SSD stream  │
└───────────────┘   └────────────────┘
   (in distrobox ROCm container on the gfx1151 iGPU)
```

## Design Documents

| Document | Description |
|----------|-------------|
| [ModelManagement.md](Designs/ModelManagement.md) | Model switching, preset system, OOM recovery, and memory management |
| [ChatPage.md](Designs/ChatPage.md) | Full chat interface design |
| [DocsPage.md](Designs/DocsPage.md) | In-app documentation page design |
| [ApiDocs.md](Designs/ApiDocs.md) | API documentation enhancements |
| [OpenCode.md](Designs/OpenCode.md) | OpenCode AI integration |
| [Feature.md](Designs/Feature.md) | Template for documenting new features |

## Screenshots

See [screenshots/](screenshots/) for UI screenshots.

## Key Design Decisions

### Router vs Single Mode

- **Router Mode**: Default mode, supports multiple models loaded simultaneously with LRU eviction
- **Single Mode**: Activated via presets, optimized settings for specific models

### OpenAI API Compatibility

The `/api/v1/*` endpoints provide OpenAI-compatible API, enabling use with:
- Claude Desktop
- Continue.dev
- Any OpenAI SDK client

### MCP Integration

The MCP server exposes tools for:
- Querying loaded models
- Sending chat completions
- Managing model loading/unloading
- Monitoring server status

### Model Aliases

Models can have user-friendly display names (aliases) that appear in the UI while using the actual model path for API calls. Aliases are stored in `config.json` under `modelAliases`.

### Split Model Handling

Multi-part GGUF models (e.g., `model-00001-of-00003.gguf`) are automatically detected and grouped. Only the base model is shown in the UI, not individual part files.

### Download Management

- Downloads run via HuggingFace CLI in a Python venv (`.venv/`)
- Progress displayed in header with expandable details
- Errors shown with full details and copy button
- HF_TRANSFER enabled for faster downloads

## Configuration

Settings are stored in `config.json` and can be modified via:
- Web UI Settings page
- REST API
- Direct file editing

Environment variables override config file settings.
