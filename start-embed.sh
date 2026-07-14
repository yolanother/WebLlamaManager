#!/bin/bash
# Llama Manager — dedicated embedding server launcher (INTERNAL).
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Invoked ONLY by the Node server's embed supervisor (never run by hand), this
# mirrors start-llama.sh: it sources .env, enters the distrobox, and runs a
# llama-server instance dedicated to embeddings (`--embeddings`, which is
# mutually exclusive with generation, hence a separate process/port). Package
# mode pins its ROCm container and binary; source mode remains configurable.
#
# Env: EMBED_MODEL (gguf path or repo id, required), EMBED_PORT (default 5252),
#      EMBED_GPU_LAYERS (default 99), EMBED_CTX (0 = model default),
#      MODELS_DIR, HF_TOKEN, DISTROBOX_CONTAINER, LLAMA_SERVER_BIN.
# Flag: --print-cmd  prints the llama-server command and exits (test seam).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; . "$SCRIPT_DIR/.env"; set +a; fi

case "${LLAMA_MANAGER_PACKAGED:-}" in
  1|true)
    CONTAINER_NAME=llama-rocm-7.2.4
    LLAMA_SERVER_BIN=/usr/local/bin/llama-server
    ;;
  *)
    CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"
    LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-llama-server}"
    ;;
esac

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

CMD_ARGS=(
  --model "$MODEL_ARG"
  --embeddings
  --host 0.0.0.0
  --port "$EMBED_PORT"
  -ngl "$EMBED_GPU_LAYERS"
  --no-mmap
)
[ "${EMBED_CTX:-0}" != "0" ] && CMD_ARGS+=(--ctx-size "$EMBED_CTX")

if [ "${1:-}" = "--print-cmd" ]; then
  printf 'container=%s\n' "$CONTAINER_NAME"
  printf 'binary=%s\n' "$LLAMA_SERVER_BIN"
  printf 'command='
  printf '%q ' "$LLAMA_SERVER_BIN" "${CMD_ARGS[@]}"
  printf '\n'
  for argument in "${CMD_ARGS[@]}"; do
    printf 'arg=%q\n' "$argument"
  done
  exit 0
fi

DISTROBOX="/usr/local/bin/distrobox"
[ -x "$DISTROBOX" ] || DISTROBOX="$(which distrobox 2>/dev/null || echo distrobox)"

echo "Starting embedding server in distrobox '$CONTAINER_NAME' on port $EMBED_PORT (model: $MODEL_ARG)"

# Enter the container; set the same AMD/ROCm unified-memory env container-start.sh
# uses, then exec the embeddings llama-server. Values are passed as POSITIONAL
# ARGS to the inner shell (not interpolated into the command string) and the
# argv is rebuilt inside with proper quoting, so a model path containing spaces
# or shell metacharacters can never be word-split or injected. In package mode
# the absolute server path is passed independently of the operator's PATH.
exec "$DISTROBOX" enter "$CONTAINER_NAME" -- bash -c '
  export HSA_OVERRIDE_GFX_VERSION=11.5.1
  export ROCM_LLVM_PRE_VEGA=1
  export GGML_HIP_UMA=1
  export GGML_CUDA_ENABLE_UNIFIED_MEMORY=1
  export LLAMA_CACHE="$1"
  export HF_TOKEN="$2"
  mkdir -p "$1"
  server_bin="$3"
  shift 3
  exec "$server_bin" "$@"
' embed-launch "$MODELS_DIR" "$HF_TOKEN" "$LLAMA_SERVER_BIN" "${CMD_ARGS[@]}"
