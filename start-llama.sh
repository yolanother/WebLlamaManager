#!/bin/bash
set -euo pipefail

# Wrapper script to start llama.cpp in multi-model router mode inside the distrobox container

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# If a project .env exists, export its variables (simple KEY=VAL lines)
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    . "$PROJECT_ROOT/.env"
    set +a
fi

CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"

# Pass through environment variables (from systemd service or .env)
# Note: CONTEXT passed by manager takes precedence over CONTEXT_SIZE from systemd
export MODELS_DIR="${MODELS_DIR:-$HOME/models}"
export MODELS_MAX="${MODELS_MAX:-2}"
export CONTEXT="${CONTEXT:-${CONTEXT_SIZE:-8192}}"
export PORT="${LLAMA_PORT:-${PORT:-8080}}"
export NO_WARMUP="${NO_WARMUP:-}"
export FLASH_ATTN="${FLASH_ATTN:-}"
export GPU_LAYERS="${GPU_LAYERS:-99}"
export HF_TOKEN="${HF_TOKEN:-}"

echo "Starting llama.cpp in distrobox container: $CONTAINER_NAME"
echo "Models directory: $MODELS_DIR"

# Ensure models directory exists on host
mkdir -p "$MODELS_DIR"

# Use full path to distrobox
DISTROBOX="/usr/local/bin/distrobox"
if [ ! -x "$DISTROBOX" ]; then
    DISTROBOX=$(which distrobox 2>/dev/null || echo "distrobox")
fi

# Check if distrobox container exists
CONTAINER_LIST=$($DISTROBOX list 2>&1)
if ! echo "$CONTAINER_LIST" | grep -E "\\|[[:space:]]*${CONTAINER_NAME}[[:space:]]*\\|" > /dev/null; then
    echo "Error: Distrobox container '$CONTAINER_NAME' not found"
    echo "Available containers:"
    echo "$CONTAINER_LIST"
    exit 1
fi

# Enter the container and run the start script
exec $DISTROBOX enter "$CONTAINER_NAME" -- bash -c "
    export MODELS_DIR='$MODELS_DIR'
    export MODELS_MAX='$MODELS_MAX'
    export CONTEXT='$CONTEXT'
    export PORT='$PORT'
    export NO_WARMUP='$NO_WARMUP'
    export FLASH_ATTN='$FLASH_ATTN'
    export GPU_LAYERS='$GPU_LAYERS'
    export HF_TOKEN='$HF_TOKEN'
    cd '$SCRIPT_DIR' && ./container-start.sh
"
