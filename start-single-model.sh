#!/bin/bash
set -euo pipefail

# Wrapper script to start llama.cpp in single-model mode with optimized presets

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# If a project .env exists, export its variables (simple KEY=VAL lines)
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    . "$PROJECT_ROOT/.env"
    set +a
fi

CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"

# Get preset from environment
PRESET_ID="${PRESET_ID:-}"
PORT="${PORT:-8080}"

if [ -z "$PRESET_ID" ]; then
    echo "Error: PRESET_ID environment variable not set"
    exit 1
fi

echo "Starting llama.cpp in single-model mode"
echo "Preset: $PRESET_ID"
echo "Port: $PORT"

# Use full path to distrobox
DISTROBOX="/usr/local/bin/distrobox"
if [ ! -x "$DISTROBOX" ]; then
    DISTROBOX=$(which distrobox 2>/dev/null || echo "distrobox")
fi

# Check if distrobox container exists
CONTAINER_LIST=$($DISTROBOX list 2>&1)
if ! echo "$CONTAINER_LIST" | grep -E "\\|[[:space:]]*${CONTAINER_NAME}[[:space:]]*\\|" > /dev/null; then
    echo "Error: Distrobox container '$CONTAINER_NAME' not found"
    exit 1
fi

# Enter the container and run the single-model start script
exec $DISTROBOX enter "$CONTAINER_NAME" -- bash -c "
    export PORT='$PORT'
    export MODELS_DIR='${MODELS_DIR:-$HOME/models}'
    cd '$SCRIPT_DIR' && ./single-model-container-start.sh '$PRESET_ID'
"
