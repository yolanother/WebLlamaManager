#!/bin/bash
set -euo pipefail

##
# Llama.cpp Multi-Model Router Mode
# Models are stored in ~/models
##

: "${PORT:=8080}"
: "${MODELS_DIR:=$HOME/models}"
: "${MODELS_MAX:=2}"
: "${CONTEXT:=8192}"
: "${NO_WARMUP:=}"
: "${FLASH_ATTN:=}"
: "${GPU_LAYERS:=99}"

# AMD GPU settings
export HSA_OVERRIDE_GFX_VERSION=11.5.1
export ROCM_LLVM_PRE_VEGA=1
export IP_ADDRESS=$(ip addr show | grep "inet " | grep -v 127.0.0.1 | awk 'NR==1 {print $2}' | cut -d'/' -f1)

# Set llama.cpp cache directory to MODELS_DIR so HF downloads go there
export LLAMA_CACHE="$MODELS_DIR"

# Ensure models directory exists
mkdir -p "$MODELS_DIR"

##
# Log the config
##
echo "=== Llama Server (Multi-Model Router Mode) ==="
echo
echo "IP_ADDRESS=$IP_ADDRESS"
echo "PORT=$PORT"
echo "MODELS_DIR=$MODELS_DIR"
echo "MODELS_MAX=$MODELS_MAX"
echo "CONTEXT=$CONTEXT"
echo "GPU_LAYERS=$GPU_LAYERS"
[ -n "$NO_WARMUP" ] && echo "NO_WARMUP=enabled"
[ -n "$FLASH_ATTN" ] && echo "FLASH_ATTN=enabled"
echo
echo "Available models:"
find "$MODELS_DIR" -name "*.gguf" -type f 2>/dev/null | head -20 || echo "  (none yet)"
echo
echo "Starting server in router mode..."
echo

##
# Start the Server in Router Mode
##

# Build command with optional flags
CMD="llama-server"
CMD="$CMD --models-dir $MODELS_DIR"
CMD="$CMD --models-max $MODELS_MAX"
CMD="$CMD --ctx-size $CONTEXT"
CMD="$CMD -ngl $GPU_LAYERS"
CMD="$CMD --no-mmap"
CMD="$CMD --jinja"
CMD="$CMD --host 0.0.0.0"
CMD="$CMD --port $PORT"
[ -n "$NO_WARMUP" ] && CMD="$CMD --no-warmup"
[ -n "$FLASH_ATTN" ] && CMD="$CMD --flash-attn"

echo "Command: $CMD"
exec $CMD
