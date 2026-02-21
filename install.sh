#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# Reload systemd
systemctl --user daemon-reload

echo
echo "[5/6] Starting service..."

# Re-enable if it was enabled before
if [ "$SERVICE_WAS_ENABLED" = true ]; then
    systemctl --user enable "$SERVICE_NAME"
    echo "  Service enabled."
fi

# Start if service is enabled (regardless of previous running state)
if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
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
    echo "  Service is not enabled. Start manually with:"
    echo "    systemctl --user enable $SERVICE_NAME"
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

if ! systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
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
