#!/bin/bash
set -euo pipefail

model="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"

##
# Configure the model defaults
##
case "$model" in
  gpt120)
    # See https://github.com/ggml-org/llama.cpp/discussions/15396
    REPOID=Unsloth
    MODEL=gpt-oss-120b-GGUF
    QUANTIZATION=Q5_K_M
    CONTEXT=131072
    #CONTEXT=16000

    CHAT_TEMPLATE_KWARGS='{"reasoning_effort": "high"}'
    REASONING_FORMAT=deepseek

    TEMP=1.0
    TOP_P=1.0
    TOP_K=0
    MIN_P=0

    EXTRA_CMD_SWITCHES="--jinja"
    ;;
  qwen3)
    REPOID=Unsloth
    MODEL=Qwen3-Coder-30B-A3B-Instruct-GGUF
    QUANTIZATION=Q5_K_M
    CONTEXT=0

    CHAT_TEMPLATE_KWARGS=""
    REASONING_FORMAT=deepseek

    TEMP=0.7
    TOP_P=1.0
    TOP_K=20
    MIN_P=0

    EXTRA_CMD_SWITCHES="--jinja"
    ;;
  qwen2.5)
    REPOID=Qwen
    MODEL=Qwen2.5-Coder-32B-Instruct-GGUF
    QUANTIZATION=Q5_K_M
    CONTEXT=0

    CHAT_TEMPLATE_KWARGS=""
    REASONING_FORMAT=deepseek

    TEMP=0.7
    TOP_P=1.0
    TOP_K=20
    MIN_P=0

    EXTRA_CMD_SWITCHES="--jinja"
    ;;
  *)
    echo "Unrecognized model ('$model'). \nSupported models: GPT120, Qwen 3, Qwen2.5"
    exit 1
    ;;
esac

##
# Configure the server
##
: "${PORT:=8080}"
: "${MODELS_DIR:=$HOME/models}"
export HSA_OVERRIDE_GFX_VERSION=11.5.1
export ROCM_LLVM_PRE_VEGA=1

# Set llama.cpp cache directory to MODELS_DIR so HF downloads go there
export LLAMA_CACHE="$MODELS_DIR"
export IP_ADDRESS=$(ip addr show | grep "inet " | grep -v 127.0.0.1 | awk 'NR==1 {print $2}' | cut -d'/' -f1)

##
# Log the config
##
echo "Server Environment"
echo

echo "IP_ADDRESS=$IP_ADDRESS"
echo "PORT=$PORT"

echo "REPOID=$REPOID"
echo "MODEL=$MODEL"
echo "QUANTIZATION=$QUANTIZATION"
echo "CONTEXT=$CONTEXT"
echo "TEAMP=$TEMP"
echo "TOP_P=$TOP_P"
echo "TOP_K=$TOP_K"
echo "MIN_P=$MIN_P"

echo
echo
echo

##
# Start the Server
##

# Build command with optional parameters
CMD_ARGS=(
  -hf "$REPOID/$MODEL:$QUANTIZATION"
  --ctx_size "$CONTEXT"
  -np 1
  -ngl 99
  --no-mmap
  --parallel 1
  --host 0.0.0.0
  --port "$PORT"
  --models-dir "$MODELS_DIR"
)

# Add extra switches (like --jinja)
if [ -n "$EXTRA_CMD_SWITCHES" ]; then
  CMD_ARGS+=($EXTRA_CMD_SWITCHES)
fi

# Only add chat-template-kwargs if not empty
if [ -n "$CHAT_TEMPLATE_KWARGS" ]; then
  CMD_ARGS+=(--chat-template-kwargs "$CHAT_TEMPLATE_KWARGS")
fi

llama-server "${CMD_ARGS[@]}"
