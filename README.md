<img src="ui/public/favicon/favicon-96x96.png" alt="Llama Manager" align="left" width="64" height="64" style="margin-right: 16px;">

# Llama Manager

<img width="1500" height="1167" alt="image" src="https://github.com/user-attachments/assets/e57cad3c-8d95-45c3-a504-b984249f90aa" />

A comprehensive LLM management, debugging, and performance monitoring platform for llama.cpp. Provides a modern web UI with real-time GPU/CPU/memory telemetry, persistent historical analytics, request tracking with error breakdown, token throughput analysis, full conversation logging, and a hands-free fullscreen dashboard for wall-mounted monitoring. Supports multi-model router mode on AMD GPUs via distrobox with on-demand model loading, LRU eviction, and OpenAI-compatible API proxying.

<br clear="left">

## Features

### Monitoring & Analytics
- **Real-time telemetry**: Live GPU temperature, power draw, VRAM/GTT usage, CPU load, and context utilization with 1-second resolution
- **Historical analytics**: Persistent minute-level data (JSONL, up to 1 year) with configurable time ranges (1H/1D/1W/1M/1Y) and automatic downsampling
- **Request tracking**: Per-request logging with status codes, latency, error messages, and stacked success/error volume charts
- **Token throughput**: Generation speed (tok/s) tracking across completions with historical trend analysis
- **Error breakdown**: Status code distribution bar charts for diagnosing API issues
- **Fullscreen dashboard**: Auto-paging, hands-free display mode for wall-mounted monitors with configurable cycle interval

### LLM Debugging
- **Conversation logging**: Full request/response capture for LLM API calls including messages, token counts, and timing
- **Request body inspection**: Detailed HTTP request/response logging with expandable error details
- **Process monitoring**: View and manage running llama-server processes with resource usage
- **Server log streaming**: Real-time log output with configurable noise filters

### Model Management
- **Multi-model router**: Load and unload models dynamically without restarting, with LRU eviction
- **HuggingFace integration**: Search and download GGUF models with progress tracking
- **Optimized presets**: One-click configurations for specific models (custom sampling, chat templates, reasoning formats)
- **Model aliases**: Friendly display names for your models

### Infrastructure
- **OpenAI-compatible API**: Drop-in replacement proxy with automatic message sanitization for tool-call edge cases
- **MCP Server**: Integration with AI agents like Claude Desktop
- **Full Chat Interface**: Multi-conversation chat with streaming, code highlighting, and image support
- **systemd service**: Auto-start on boot, runs in background
- **Models stored in ~/models**: All models in one place, easy to manage

## Screenshots

<details>
<summary><strong>Dashboard</strong> - Server status, system resources, and performance analytics</summary>

![Dashboard](docs/screenshots/dashboard.png)
</details>

<details>
<summary><strong>Chat</strong> - Multi-conversation chat with streaming responses</summary>

![Chat](docs/screenshots/chat.png)
</details>

<details>
<summary><strong>Models</strong> - Load, unload, and manage local models</summary>

![Models](docs/screenshots/models.png)
</details>

<details>
<summary><strong>Presets</strong> - Optimized configurations for specific models</summary>

![Presets](docs/screenshots/presets.png)
</details>

<details>
<summary><strong>Download</strong> - Search and download models from HuggingFace</summary>

![Download Search](docs/screenshots/download-search.png)
![Download Files](docs/screenshots/download-files.png)
</details>

<details>
<summary><strong>Logs & Processes</strong> - Real-time server logs and process monitoring</summary>

![Logs](docs/screenshots/logs.png)
![Processes](docs/screenshots/processes.png)
</details>

<details>
<summary><strong>Documentation</strong> - In-app docs and API reference</summary>

![Docs](docs/screenshots/docs.png)
![API Docs](docs/screenshots/api-docs-openai.png)
</details>

## Requirements

- Node.js 18+
- distrobox with the `llama-rocm-7rc-rocwmma` container (configurable via `DISTROBOX_CONTAINER` in `.env`)
- llama.cpp compiled with ROCm support (inside the container)

## Quick Start

```bash
# Install dependencies and build UI
./install.sh

# Enable service to start on boot
systemctl --user enable llama-manager

# Start the service
systemctl --user start llama-manager

# Access the web UI
# http://localhost:3001
```

## How It Works

The server runs llama.cpp in **router mode**, which means:

1. Models are auto-discovered from `~/models`
2. Multiple models can be loaded simultaneously (default: 2)
3. Models load on-demand when first requested
4. LRU eviction when hitting the max models limit
5. No server restart needed to switch models

### Using Models

Via the web UI:
1. Open http://localhost:3001
2. Click "Load" on any model in the Local Models section
3. Make API requests specifying the model name

Via API:
```bash
# List available models
curl http://localhost:8080/models

# Load a model
curl -X POST http://localhost:8080/models/load \
  -H "Content-Type: application/json" \
  -d '{"model": "Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q5_k_m.gguf"}'

# Chat with a model
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q5_k_m.gguf",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Directory Structure

```
llama-server/
├── api/
│   ├── server.js           # Express API (model management, downloads)
│   └── package.json
├── ui/
│   ├── src/App.jsx         # React UI
│   └── ...
├── container-start.sh      # Starts llama-server in router mode (runs in container)
├── start-llama.sh          # Wrapper that enters distrobox
├── llama-manager.service   # systemd user service
├── config.json             # Configuration (auto-generated)
├── install.sh              # Installation script
└── uninstall.sh            # Uninstallation script

~/models/                   # Your GGUF model files
├── Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/
│   └── qwen2.5-coder-32b-instruct-q5_k_m.gguf
├── Unsloth_Qwen3-Coder-30B-A3B-Instruct-GGUF/
│   └── ...
└── ...
```

## API Endpoints

### Management API (port 3001)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Server status |
| `/api/models` | GET | List local & loaded models |
| `/api/models/load` | POST | Load a model |
| `/api/models/unload` | POST | Unload a model |
| `/api/server/start` | POST | Start llama server |
| `/api/server/stop` | POST | Stop llama server |
| `/api/pull` | POST | Download model from HuggingFace |
| `/api/search` | GET | Search HuggingFace for GGUF models |
| `/api/repo/:author/:model/files` | GET | List files in a HuggingFace repo |

### Llama Server (port 8080)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/models` | GET | List models with status |
| `/models/load` | POST | Load a model |
| `/models/unload` | POST | Unload a model |
| `/v1/chat/completions` | POST | Chat completions (OpenAI-compatible) |
| `/v1/completions` | POST | Text completions |
| `/health` | GET | Health check |

## Service Management

```bash
# Start
systemctl --user start llama-manager

# Stop
systemctl --user stop llama-manager

# Restart
systemctl --user restart llama-manager

# Check status
systemctl --user status llama-manager

# View logs
journalctl --user -u llama-manager -f

# Enable auto-start
systemctl --user enable llama-manager

# Disable auto-start
systemctl --user disable llama-manager

# Keep running after logout (requires sudo once)
sudo loginctl enable-linger $USER
```

## Configuration

Edit `config.json` to change settings:

```json
{
  "autoStart": true,      // Auto-start llama server when API starts
  "modelsMax": 2,         // Max models loaded simultaneously
  "contextSize": 8192     // Default context size
}
```

Environment variables (set in systemd service or shell):
- `MODELS_DIR`: Models directory (default: `~/models`)
- `API_PORT`: Management API port (default: `3001`)
- `LLAMA_PORT`: Llama server port (default: `8080`)
- `MODELS_MAX`: Max simultaneous models (default: `2`)
- `CONTEXT`: Context size (default: `8192`)

## Adding Models

### Via Web UI
1. Go to "Download from HuggingFace" section
2. Search for a model (e.g., "qwen coder gguf")
3. Click on a repository to see available files
4. Click "Download" on the quantization you want

### Manually
Place `.gguf` files directly in `~/models/`:
```bash
# Create a subdirectory for organization
mkdir -p ~/models/my-model
cp /path/to/model.gguf ~/models/my-model/

# Or download with huggingface-cli
huggingface-cli download Qwen/Qwen2.5-Coder-32B-Instruct-GGUF \
  --include "*Q5_K_M*.gguf" \
  --local-dir ~/models/Qwen_Qwen2.5-Coder-32B-Instruct-GGUF
```

## Troubleshooting

### Models not appearing
- Check that files end in `.gguf`
- Verify they're in `~/models` or subdirectories
- Restart the API: `systemctl --user restart llama-manager`

### Server won't start
Check logs: `journalctl --user -u llama-manager -f`

### distrobox errors
Ensure the container exists: `distrobox list`
If not running, initialize it: `distrobox enter llama-rocm-7rc-rocwmma` (or set `DISTROBOX_CONTAINER` in `.env` to use a different container)

### Permission denied
```bash
chmod +x start-llama.sh container-start.sh
```

### Service stops after logout
Enable lingering: `sudo loginctl enable-linger $USER`

### Model loading fails
- Check GPU memory availability
- Try reducing `modelsMax` in config.json
- Try a smaller quantization (Q4 instead of Q5/Q6)

## OpenCode Setup

Llama Manager works with [OpenCode](https://opencode.ai) as an OpenAI-compatible provider.

### Quick Setup

Paste this prompt into OpenCode to have it configure itself:

```
Configure yourself to use my local Llama Manager as a provider. Create or update opencode.json with:
- Provider ID: "llama-manager"
- Use @ai-sdk/openai-compatible
- Base URL: http://localhost:5250/api/v1
- No API key needed (local server)

Then fetch the available models from http://localhost:5250/api/v1/models and add them to the config.
Set reasonable context limits based on the model names (32k for most, 128k for models with "128k" in name).
```

### Manual Configuration

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "llama-manager": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Llama Manager",
      "options": {
        "baseURL": "http://localhost:5250/api/v1"
      },
      "models": {
        "your-model-id": {
          "name": "Your Model Name",
          "limit": {
            "context": 32768,
            "output": 4096
          }
        }
      }
    }
  }
}
```

Replace `your-model-id` with the actual model IDs from your loaded models. Get the list with:

```bash
curl http://localhost:5250/api/v1/models
```

## MCP Server

Llama Manager includes an MCP (Model Context Protocol) server for integration with AI agents like Claude Desktop.

### Setup with Claude Desktop

Add to your Claude Desktop config (`~/.config/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "llama-manager": {
      "command": "node",
      "args": ["/path/to/llama-server/mcp/server.js"],
      "env": {
        "LLAMA_MANAGER_URL": "http://localhost:5250"
      }
    }
  }
}
```

Replace `/path/to/llama-server` with the actual path to this repository.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `llama_get_status` | Get server status, mode, and health |
| `llama_get_stats` | Get CPU, memory, GPU, and context usage |
| `llama_get_analytics` | Get time-series performance data |
| `llama_list_models` | List local and loaded models |
| `llama_load_model` | Load a model into the server |
| `llama_unload_model` | Unload a model from the server |
| `llama_start_server` | Start the llama server in router mode |
| `llama_stop_server` | Stop the llama server |
| `llama_get_settings` | Get current server settings |
| `llama_update_settings` | Update server settings |
| `llama_list_presets` | List available optimized presets |
| `llama_activate_preset` | Activate an optimized preset |
| `llama_search_models` | Search HuggingFace for GGUF models |
| `llama_download_model` | Download a model from HuggingFace |
| `llama_get_processes` | List running llama-server processes |
| `llama_get_logs` | Get recent server logs |
| `llama_chat` | Send a chat completion request |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLAMA_MANAGER_URL` | `http://localhost:5250` | Llama Manager API URL |

## Documentation

Additional documentation is available in the [docs/](docs/) directory:

- [Architecture Overview](docs/Designs.md) - System architecture and design decisions
- [Feature Template](docs/Designs/Feature.md) - Template for documenting new features
- [Chat Page Design](docs/Designs/ChatPage.md) - Full chat interface design
- [Docs Page Design](docs/Designs/DocsPage.md) - In-app documentation design
- [API Docs Design](docs/Designs/ApiDocs.md) - API documentation enhancements
- [OpenCode Integration](docs/Designs/OpenCode.md) - OpenCode AI setup and configuration
