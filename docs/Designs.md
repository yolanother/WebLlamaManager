# Architecture and Design Documentation

This directory contains design documents for Llama Manager features and architecture decisions.

## Overview

Llama Manager is a service for managing llama.cpp in multi-model router mode. It provides:

- **Web UI**: React-based interface for model management, monitoring, and chat
- **REST API**: Full API for programmatic control
- **OpenAI-Compatible API**: Drop-in replacement for OpenAI API clients
- **MCP Server**: Model Context Protocol server for AI agent integration
- **Real-time Monitoring**: WebSocket-based stats and log streaming

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Web UI (React)                        │
│  Dashboard │ Models │ Chat │ Docs │ Settings │ API Docs     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Llama Manager API                         │
│  Express Server (port 3001)                                  │
│  - Model management                                          │
│  - Settings & presets                                        │
│  - Download management                                       │
│  - Analytics & logging                                       │
│  - OpenAI API wrapper                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    llama.cpp Server                          │
│  (Running in distrobox container)                            │
│  - Router mode: Multiple models, dynamic loading             │
│  - Single mode: Optimized preset configurations              │
└─────────────────────────────────────────────────────────────┘
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
