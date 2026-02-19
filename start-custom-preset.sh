#!/bin/bash
set -euo pipefail

# Wrapper script to start llama.cpp with a custom preset
# Supports both HuggingFace model references (-hf) and local file paths (--model)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# If a project .env exists, export its variables (simple KEY=VAL lines)
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    . "$PROJECT_ROOT/.env"
    set +a
fi

CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"

# Get configuration from environment
# For HF models: use HF_REPO (e.g., "unsloth/Qwen3-Coder-Next-GGUF:Q5_K_M")
# For local files: use MODEL_PATH (e.g., "/home/user/models/model.gguf")
HF_REPO="${HF_REPO:-}"
MODEL_PATH="${MODEL_PATH:-}"
PORT="${PORT:-8080}"
CONTEXT="${CONTEXT:-0}"
TEMP="${TEMP:-0.7}"
TOP_P="${TOP_P:-1.0}"
TOP_K="${TOP_K:-20}"
MIN_P="${MIN_P:-0}"
CHAT_TEMPLATE_KWARGS="${CHAT_TEMPLATE_KWARGS:-}"
EXTRA_SWITCHES="${EXTRA_SWITCHES:---jinja}"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"

if [ -z "$HF_REPO" ] && [ -z "$MODEL_PATH" ]; then
    echo "Error: Either HF_REPO or MODEL_PATH environment variable must be set"
    exit 1
fi

echo "Starting llama.cpp with custom preset"
if [ -n "$HF_REPO" ]; then
    echo "HF Model: $HF_REPO"
else
    echo "Model Path: $MODEL_PATH"
fi
echo "Port: $PORT"
echo "Context: $CONTEXT"
echo "Extra Switches: $EXTRA_SWITCHES"

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

# Enter the container and run llama-server
exec $DISTROBOX enter "$CONTAINER_NAME" -- bash -c "
    export HSA_OVERRIDE_GFX_VERSION=11.5.1
    export ROCM_LLVM_PRE_VEGA=1
    export LLAMA_CACHE='$MODELS_DIR'

    # Build command
    CMD_ARGS=(
        --host 0.0.0.0
        --port $PORT
        -np 1
        -ngl 99
        --no-mmap
        --parallel 1
        --models-dir '$MODELS_DIR'
    )

    # Add model source (HF or local path)
    if [ -n '$HF_REPO' ]; then
        CMD_ARGS+=(-hf '$HF_REPO')
    else
        CMD_ARGS+=(--model '$MODEL_PATH')
    fi

    # Add context if specified (0 means use model default)
    if [ '$CONTEXT' != '0' ]; then
        CMD_ARGS+=(--ctx-size $CONTEXT)
    fi

    # Add extra switches
    if [ -n '$EXTRA_SWITCHES' ]; then
        CMD_ARGS+=($EXTRA_SWITCHES)
    fi

    # Add chat template kwargs if specified
    if [ -n '$CHAT_TEMPLATE_KWARGS' ]; then
        CMD_ARGS+=(--chat-template-kwargs '$CHAT_TEMPLATE_KWARGS')
    fi

    echo 'Starting llama-server with custom preset...'
    echo \"Command: /home/yolan/.local/bin/llama-server \${CMD_ARGS[*]}\"

    exec /home/yolan/.local/bin/llama-server \"\${CMD_ARGS[@]}\"
"
