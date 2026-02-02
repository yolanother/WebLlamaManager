#!/bin/bash
set -euo pipefail

# Wrapper script to start llama.cpp in multi-model router mode inside the distrobox container

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="llama-rocm-7rc-rocwmma"

# Pass through environment variables
export MODELS_DIR="${MODELS_DIR:-$HOME/models}"
export MODELS_MAX="${MODELS_MAX:-2}"
export CONTEXT="${CONTEXT:-8192}"
export PORT="${PORT:-8080}"

echo "Starting llama.cpp in distrobox container: $CONTAINER_NAME"
echo "Models directory: $MODELS_DIR"

# Ensure models directory exists on host
mkdir -p "$MODELS_DIR"

# Check if distrobox container exists
if ! distrobox list | grep -q "$CONTAINER_NAME"; then
    echo "Error: Distrobox container '$CONTAINER_NAME' not found"
    exit 1
fi

# Enter the container and run the start script
exec distrobox enter "$CONTAINER_NAME" -- bash -c "
    export MODELS_DIR='$MODELS_DIR'
    export MODELS_MAX='$MODELS_MAX'
    export CONTEXT='$CONTEXT'
    export PORT='$PORT'
    cd '$SCRIPT_DIR' && ./container-start.sh
"
