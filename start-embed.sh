#!/bin/bash
# Llama Manager — dedicated embedding server launcher (INTERNAL).
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Invoked ONLY by the Node server's embed supervisor (never run by hand), this
# mirrors start-llama.sh: it sources .env, enters the distrobox, and runs a
# llama-server instance dedicated to embeddings (`--embeddings`, which is
# mutually exclusive with generation, hence a separate process/port).
#
# Env: EMBED_MODEL (gguf path or repo id, required), EMBED_PORT (default 5252),
#      EMBED_GPU_LAYERS (default 99), EMBED_CTX (0 = model default),
#      MODELS_DIR, HF_TOKEN, DISTROBOX_CONTAINER.
# Flag: --print-cmd  prints the llama-server command and exits (test seam).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; . "$SCRIPT_DIR/.env"; set +a; fi

CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"
export MODELS_DIR="${MODELS_DIR:-$HOME/models}"
EMBED_MODEL="${EMBED_MODEL:-}"
EMBED_PORT="${EMBED_PORT:-5252}"
EMBED_GPU_LAYERS="${EMBED_GPU_LAYERS:-99}"
EMBED_CTX="${EMBED_CTX:-0}"
HF_TOKEN="${HF_TOKEN:-}"

if [ -z "$EMBED_MODEL" ]; then
  echo "start-embed.sh: EMBED_MODEL is not set; nothing to serve" >&2
  exit 1
fi

# Resolve a bare path under MODELS_DIR; pass repo ids / absolute paths through.
MODEL_ARG="$EMBED_MODEL"
case "$EMBED_MODEL" in
  /*) : ;;                                  # absolute path
  *:*) : ;;                                 # hf repo:quant form
  */*) [ -e "$MODELS_DIR/$EMBED_MODEL" ] && MODEL_ARG="$MODELS_DIR/$EMBED_MODEL" ;;
esac

# Build the llama-server command (array preserves spaces in paths).
build_cmd() {
  local -a c=(llama-server
    --model "$MODEL_ARG"
    --embeddings
    --host 0.0.0.0
    --port "$EMBED_PORT"
    -ngl "$EMBED_GPU_LAYERS"
    --no-mmap)
  [ "${EMBED_CTX:-0}" != "0" ] && c+=(--ctx-size "$EMBED_CTX")
  printf '%s ' "${c[@]}"
}

if [ "${1:-}" = "--print-cmd" ]; then
  build_cmd; echo; exit 0
fi

DISTROBOX="/usr/local/bin/distrobox"
[ -x "$DISTROBOX" ] || DISTROBOX="$(which distrobox 2>/dev/null || echo distrobox)"

echo "Starting embedding server in distrobox '$CONTAINER_NAME' on port $EMBED_PORT (model: $MODEL_ARG)"

# Enter the container; set the same AMD/ROCm unified-memory env container-start.sh
# uses, then exec the embeddings llama-server.
exec "$DISTROBOX" enter "$CONTAINER_NAME" -- bash -c "
  export HSA_OVERRIDE_GFX_VERSION=11.5.1
  export ROCM_LLVM_PRE_VEGA=1
  export GGML_HIP_UMA=1
  export GGML_CUDA_ENABLE_UNIFIED_MEMORY=1
  export LLAMA_CACHE='$MODELS_DIR'
  export HF_TOKEN='$HF_TOKEN'
  mkdir -p '$MODELS_DIR'
  exec $(build_cmd)
"
