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

# AMD GPU settings
export HSA_OVERRIDE_GFX_VERSION=11.5.1
export ROCM_LLVM_PRE_VEGA=1
export IP_ADDRESS=$(ip addr show | grep "inet " | grep -v 127.0.0.1 | awk 'NR==1 {print $2}' | cut -d'/' -f1)

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
echo
echo "Available models:"
find "$MODELS_DIR" -name "*.gguf" -type f 2>/dev/null | head -20 || echo "  (none yet)"
echo
echo "Starting server in router mode..."
echo

##
# Start the Server in Router Mode
##
llama-server \
  --models-dir "$MODELS_DIR" \
  --models-max "$MODELS_MAX" \
  --ctx-size "$CONTEXT" \
  -ngl 99 \
  --no-mmap \
  --jinja \
  --host 0.0.0.0 \
  --port "$PORT"
