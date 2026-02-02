# Llama Manager

A systemd service with web UI for managing llama.cpp models on AMD GPUs using distrobox.

## Features

- Web UI for model selection and management
- HuggingFace model search and download
- Automatic model switching
- systemd user service for auto-start on boot
- REST API for programmatic control

## Requirements

- Node.js 18+
- distrobox with the `llama-rocm-7rc-rocwmma` container
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

## Manual Start (Development)

```bash
# Terminal 1: Start the API server
cd api
npm install
npm run dev

# Terminal 2: Start the UI dev server
cd ui
npm install
npm run dev
# Access at http://localhost:3000
```

## Architecture

```
llama-server/
├── api/                    # Express API server
│   ├── server.js           # Main API with model management
│   └── package.json
├── ui/                     # React frontend
│   ├── src/
│   │   ├── App.jsx         # Main UI component
│   │   ├── App.css         # Styles
│   │   └── ...
│   └── package.json
├── container-start.sh      # llama.cpp start script (runs inside container)
├── start-llama.sh          # Wrapper that enters distrobox and runs container-start.sh
├── llama-manager.service   # systemd user service file
├── config.json             # Model configurations (auto-generated)
├── install.sh              # Installation script
└── uninstall.sh            # Uninstallation script
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Server status (running, model, health) |
| `/api/models` | GET | List configured models |
| `/api/models` | POST | Add new model configuration |
| `/api/models/:id` | DELETE | Remove model configuration |
| `/api/start` | POST | Start llama server with model |
| `/api/stop` | POST | Stop llama server |
| `/api/restart` | POST | Restart with current/new model |
| `/api/pull` | POST | Download model from HuggingFace |
| `/api/search` | GET | Search HuggingFace for GGUF models |

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

## Ports

- **3001**: API server and web UI
- **8080**: llama.cpp server (OpenAI-compatible API)

## Adding Models

Models can be added via the web UI or by editing `config.json`:

```json
{
  "models": {
    "my-model": {
      "name": "My Custom Model",
      "repoid": "TheBloke",
      "model": "SomeModel-GGUF",
      "quantization": "Q5_K_M",
      "context": 8192,
      "temp": 0.7,
      "topP": 1.0,
      "topK": 20,
      "minP": 0,
      "extraSwitches": "--jinja"
    }
  },
  "currentModel": "my-model",
  "autoStart": true
}
```

## Troubleshooting

### Service won't start
Check logs: `journalctl --user -u llama-manager -f`

### distrobox errors
Ensure the container is created: `distrobox list`
If not running: `distrobox enter llama-rocm-7rc-rocwmma` to initialize

### Permission denied
Run: `chmod +x start-llama.sh container-start.sh`

### Service stops after logout
Enable lingering: `sudo loginctl enable-linger $USER`
