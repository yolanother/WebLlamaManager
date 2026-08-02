#!/bin/bash
# Llama Manager — llama.cpp router distrobox launcher.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# This host-side launcher forwards router settings into the ROCm distrobox and
# executes container-start.sh. Debian packages use immutable container/binary
# selections and address package scripts through Distrobox's /run/host mount;
# source checkouts preserve their configured container and checkout paths. The
# Hugging Face credential is delivered through a protected runtime env file so
# neither Distrobox nor process-status argv exposes its value.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/scripts/runtime-credentials.sh"
# If a project .env exists, export its variables (simple KEY=VAL lines)
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    . "$PROJECT_ROOT/.env"
    set +a
fi

case "${LLAMA_MANAGER_PACKAGED:-}" in
  1|true)
    CONTAINER_NAME=llama-rocm-7.2.4
    CONTAINER_START=/run/host/usr/lib/llama-manager/container-start.sh
    LLAMA_SERVER_BIN=/usr/local/bin/llama-server
    ;;
  *)
    CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"
    CONTAINER_START="$SCRIPT_DIR/container-start.sh"
    LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/.local/bin/llama-server}"
    ;;
esac

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
export SLOT_SAVE_PATH="${SLOT_SAVE_PATH:-$HOME/.cache/llama-slots}"

if [ "${1:-}" = "--print-cmd" ]; then
    printf 'container=%s launcher=%s llama_server=%s\n' \
        "$CONTAINER_NAME" "$CONTAINER_START" "$LLAMA_SERVER_BIN"
    exit 0
fi

echo "Starting llama.cpp in distrobox container: $CONTAINER_NAME"
echo "Models directory: $MODELS_DIR"

# Ensure models directory exists on host
mkdir -p "$MODELS_DIR"

# Use full path to distrobox, with an explicit test/packaging override.
DISTROBOX="${DISTROBOX_BIN:-/usr/local/bin/distrobox}"
if ! command -v "$DISTROBOX" >/dev/null 2>&1; then
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

# Store the secret outside argv. Distrobox passes this path to the container
# manager's --env-file option; process listings reveal only the protected path.
CREDENTIAL_FILE="$(runtime_credentials_write llama "$HF_TOKEN")"

# Enter the container and run the selected script. Non-secret values remain
# separate argv elements so configuration is never interpolated as shell source.
# Distrobox forwards its host environment by default, so remove HF_TOKEN from
# that environment before entry and let only the protected env file supply it.
exec env -u HF_TOKEN "$DISTROBOX" enter --additional-flags "--env-file=$CREDENTIAL_FILE" \
    "$CONTAINER_NAME" -- /usr/bin/env \
    "MODELS_DIR=$MODELS_DIR" \
    "MODELS_MAX=$MODELS_MAX" \
    "CONTEXT=$CONTEXT" \
    "PORT=$PORT" \
    "NO_WARMUP=$NO_WARMUP" \
    "FLASH_ATTN=$FLASH_ATTN" \
    "GPU_LAYERS=$GPU_LAYERS" \
    "SLOT_SAVE_PATH=$SLOT_SAVE_PATH" \
    "LLAMA_SERVER_BIN=$LLAMA_SERVER_BIN" \
    bash "$CONTAINER_START"
