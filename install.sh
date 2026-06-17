#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Seed config.json's embed block (idempotent). Args: <config-path> <model-id>.
# Only sets embed.model when unset, so re-running install never clobbers a choice.
embed_seed_config() {
  local cfg="$1" model="$2"
  node -e '
    const fs=require("fs"); const [cfgPath,model]=process.argv.slice(1);
    let c={}; try{ c=JSON.parse(fs.readFileSync(cfgPath,"utf8")); }catch{}
    c.embed = c.embed || {};
    if(!c.embed.model){ c.embed.enabled=true; c.embed.model=model; }
    if(c.embed.port===undefined) c.embed.port=5252;
    if(c.embed.gpuLayers===undefined) c.embed.gpuLayers=99;
    if(c.embed.ctxSize===undefined) c.embed.ctxSize=0;
    if(c.embed.dimension===undefined) c.embed.dimension=1024;
    fs.writeFileSync(cfgPath, JSON.stringify(c,null,2));
  ' "$cfg" "$model"
}

# Download the bootstrap embedding model into MODELS_DIR if absent. Args: <models-dir>.
embed_bootstrap_model() {
  local models_dir="$1"
  local repo="Qwen/Qwen3-Embedding-0.6B-GGUF"
  local target="$models_dir/Qwen_Qwen3-Embedding-0.6B-GGUF"
  if [ -d "$target" ] && ls "$target"/*.gguf >/dev/null 2>&1; then
    echo "  Embedding model already present: $target"; return 0
  fi
  local HF_BIN=""
  [ -f "$VENV_DIR/bin/hf" ] && HF_BIN="$VENV_DIR/bin/hf"
  [ -z "$HF_BIN" ] && [ -f "$VENV_DIR/bin/huggingface-cli" ] && HF_BIN="$VENV_DIR/bin/huggingface-cli"
  if [ -z "$HF_BIN" ]; then echo "  Skipping embedding model download (no HF CLI)."; return 0; fi
  echo "  Downloading $repo (embedding model, ~600MB)..."
  "$HF_BIN" download "$repo" --include "*Q8_0.gguf" --local-dir "$target" || \
    echo "  Warning: embedding model download failed; select one later in the UI."
}

# Allow tests to source this file for its helpers without running the installer.
if [ "${EMBED_SEED_LIB:-0}" = "1" ]; then return 0 2>/dev/null || true; fi

SERVICE_NAME="llama-manager"

# Load configuration from .env file
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    echo "Loading configuration from .env"
    # Source .env file, expanding ~ to $HOME
    while IFS='=' read -r key value; do
        # Skip comments and empty lines
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        # Remove leading/trailing whitespace
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs)
        # Skip if no value
        [[ -z "$value" ]] && continue
        # Expand ~ to $HOME
        value="${value/#\~/$HOME}"
        # Export the variable
        export "$key=$value"
    done < "$ENV_FILE"
else
    echo "No .env file found, using defaults"
    echo "Copy .env.example to .env to customize configuration"
fi

# Set defaults if not defined
API_PORT="${API_PORT:-3001}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
MODELS_MAX="${MODELS_MAX:-2}"
CONTEXT_SIZE="${CONTEXT_SIZE:-8192}"
AUTO_START="${AUTO_START:-true}"
STATS_INTERVAL="${STATS_INTERVAL:-1000}"
LLAMA_UI_URL="${LLAMA_UI_URL:-}"
HF_TOKEN="${HF_TOKEN:-}"

echo "=== Llama Manager Installation ==="
echo
echo "Configuration:"
echo "  API_PORT=$API_PORT"
echo "  LLAMA_PORT=$LLAMA_PORT"
echo "  MODELS_DIR=$MODELS_DIR"
echo "  MODELS_MAX=$MODELS_MAX"
echo "  CONTEXT_SIZE=$CONTEXT_SIZE"
echo "  AUTO_START=$AUTO_START"
echo "  STATS_INTERVAL=$STATS_INTERVAL"
[ -n "$LLAMA_UI_URL" ] && echo "  LLAMA_UI_URL=$LLAMA_UI_URL"
[ -n "$HF_TOKEN" ] && echo "  HF_TOKEN=<set>"
echo

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ is required. Current version: $(node -v)"
    exit 1
fi

# Set up Python venv for huggingface-cli
VENV_DIR="$SCRIPT_DIR/.venv"
VENV_PIP="$VENV_DIR/bin/pip"

# Create or recreate venv if pip is missing
if [ ! -f "$VENV_PIP" ]; then
    echo "Creating Python virtual environment for HuggingFace CLI..."
    if command -v python3 &> /dev/null; then
        # Remove incomplete venv if it exists
        [ -d "$VENV_DIR" ] && rm -rf "$VENV_DIR"
        python3 -m venv "$VENV_DIR"
        if [ ! -f "$VENV_PIP" ]; then
            echo "  venv created without pip, bootstrapping pip..."
            curl -sS https://bootstrap.pypa.io/get-pip.py | "$VENV_DIR/bin/python"
        fi
    else
        echo "Warning: python3 not found. HuggingFace model downloads will not work."
        echo "Install with: sudo apt install python3 python3-venv"
    fi
fi

# Install huggingface-cli in venv
if [ -f "$VENV_PIP" ]; then
    echo "Installing huggingface-hub in virtual environment..."
    "$VENV_PIP" install --upgrade pip
    "$VENV_PIP" install huggingface-hub hf_transfer
    # Check for either 'hf' (new) or 'huggingface-cli' (old)
    if [ -f "$VENV_DIR/bin/hf" ]; then
        echo "  HuggingFace CLI installed: $VENV_DIR/bin/hf"
    elif [ -f "$VENV_DIR/bin/huggingface-cli" ]; then
        echo "  HuggingFace CLI installed: $VENV_DIR/bin/huggingface-cli"
    else
        echo "  Warning: HuggingFace CLI installation may have failed"
    fi
else
    echo "Warning: Could not set up Python venv. HuggingFace downloads will not work."
fi

# Bootstrap the embedding model + config so /v1/embeddings works after install.
echo
echo "Setting up embedding model..."
embed_bootstrap_model "$MODELS_DIR"
EMBED_DEFAULT_MODEL="Qwen_Qwen3-Embedding-0.6B-GGUF/$(ls "$MODELS_DIR/Qwen_Qwen3-Embedding-0.6B-GGUF"/*.gguf 2>/dev/null | head -1 | xargs -r basename)"
[ "$EMBED_DEFAULT_MODEL" = "Qwen_Qwen3-Embedding-0.6B-GGUF/" ] && EMBED_DEFAULT_MODEL=""
if [ -n "$EMBED_DEFAULT_MODEL" ]; then
  embed_seed_config "$SCRIPT_DIR/config.json" "$EMBED_DEFAULT_MODEL"
  echo "  Embedding config seeded: $EMBED_DEFAULT_MODEL"
fi

# Check if service is already running
SERVICE_WAS_RUNNING=false
SERVICE_WAS_ENABLED=false

if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SERVICE_WAS_RUNNING=true
    echo "[0/6] Stopping existing service..."
    # Use timeout to prevent hanging if the graceful shutdown takes too long
    timeout 15 systemctl --user stop "$SERVICE_NAME" 2>/dev/null || {
        echo "  Graceful stop timed out, force killing..."
        systemctl --user kill -s SIGKILL "$SERVICE_NAME" 2>/dev/null || true
        sleep 1
    }
    echo "  Service stopped."
fi

if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    SERVICE_WAS_ENABLED=true
fi

echo
echo "[1/6] Creating models directory..."
mkdir -p "$MODELS_DIR"
echo "  Models will be stored in: $MODELS_DIR"

echo
echo "[2/6] Installing API dependencies..."
cd "$SCRIPT_DIR/api"
npm install

echo
echo "[3/6] Installing UI dependencies and building..."
cd "$SCRIPT_DIR/ui"
npm install
npm run build

echo
echo "[4/6] Setting up systemd user service..."
mkdir -p ~/.config/systemd/user

# Generate service file with configured values
USER_ID=$(id -u)
USER_PATH=$(echo "$PATH")
cat > ~/.config/systemd/user/${SERVICE_NAME}.service << EOF
[Unit]
Description=Llama Manager API and Multi-Model Server
After=network.target
# Stop the infinite restart/leak loop: if the service fails >5 times in 2min,
# systemd gives up instead of relaunching every 10s (each relaunch used to leak a
# hung distrobox/fuser into a wedged container and lock the host).
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR/api
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
TimeoutStopSec=15

# Configuration
Environment=NODE_ENV=production
Environment=API_PORT=$API_PORT
Environment=LLAMA_PORT=$LLAMA_PORT
Environment=EMBED_PORT=5252
Environment=MODELS_DIR=$MODELS_DIR
Environment=MODELS_MAX=$MODELS_MAX
Environment=CONTEXT_SIZE=$CONTEXT_SIZE
Environment=AUTO_START=$AUTO_START
Environment=STATS_INTERVAL=$STATS_INTERVAL
Environment=LLAMA_UI_URL=$LLAMA_UI_URL
Environment=HF_TOKEN=$HF_TOKEN

# Allow the service to manage distrobox containers
Environment=XDG_RUNTIME_DIR=/run/user/$USER_ID
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$USER_ID/bus
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

# Remove any legacy direct llama-server launcher unit. It predates llama-manager,
# conflicts with it (both drive llama-server on the same GPU/ports), and with
# Restart=always and no StartLimit it crash-loops on a missing wrapper and has
# hard-locked the host. llama-manager is the one canonical service.
LEGACY_UNIT="$HOME/.config/systemd/user/llama-server.service"
if [ -f "$LEGACY_UNIT" ]; then
    echo "  Removing legacy conflicting unit: llama-server.service"
    systemctl --user disable --now llama-server.service 2>/dev/null || true
    rm -f "$LEGACY_UNIT"
fi

# Reload systemd
systemctl --user daemon-reload

echo
echo "[5/6] Restarting service..."

# Re-enable if it was enabled before
if [ "$SERVICE_WAS_ENABLED" = true ]; then
    systemctl --user enable "$SERVICE_NAME"
    echo "  Service enabled."
fi

# Restart if it was running before
if [ "$SERVICE_WAS_RUNNING" = true ]; then
    systemctl --user start "$SERVICE_NAME"
    echo "  Service started."

    # Wait a moment and check status
    sleep 2
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
        echo "  Service is running."
    else
        echo "  Warning: Service may have failed to start. Check logs:"
        echo "    journalctl --user -u $SERVICE_NAME -f"
    fi
else
    echo "  Service was not running before. Start manually with:"
    echo "    systemctl --user start $SERVICE_NAME"
fi

echo
echo "[6/6] Installation complete!"
echo

# Get IP address for network access
IP_ADDRESS=$(ip addr show | grep "inet " | grep -v 127.0.0.1 | awk 'NR==1 {print $2}' | cut -d'/' -f1)

echo "=== Access ==="
echo "  Web UI:     http://localhost:$API_PORT"
echo "              http://${IP_ADDRESS}:$API_PORT"
echo "  Llama API:  http://localhost:$LLAMA_PORT"
echo "              http://${IP_ADDRESS}:$LLAMA_PORT"
echo

if [ "$SERVICE_WAS_RUNNING" = false ]; then
    echo "=== Next Steps ==="
    echo
    echo "1. Enable the service to start on boot:"
    echo "   systemctl --user enable $SERVICE_NAME"
    echo
    echo "2. Start the service now:"
    echo "   systemctl --user start $SERVICE_NAME"
    echo
    echo "3. Check service status:"
    echo "   systemctl --user status $SERVICE_NAME"
    echo
    echo "4. View logs:"
    echo "   journalctl --user -u $SERVICE_NAME -f"
    echo
    echo "To enable lingering (keep service running after logout):"
    echo "   sudo loginctl enable-linger $USER"
fi
