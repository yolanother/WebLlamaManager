#!/bin/bash
# Llama Manager — single-model preset distrobox launcher.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# This host-side launcher converts preset settings into a literal llama-server
# argv and passes it through a fixed Distrobox shell. Package installations pin
# the ROCm container and server binary; source installations retain their
# configured values. No preset or model value is evaluated as shell source.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    . "$PROJECT_ROOT/.env"
    set +a
fi

case "${LLAMA_MANAGER_PACKAGED:-}" in
    1|true)
        CONTAINER_NAME=llama-rocm-7.2.4
        LLAMA_SERVER_BIN=/usr/local/bin/llama-server
        ;;
    *)
        CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"
        LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/.local/bin/llama-server}"
        ;;
esac

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
    printf 'Error: Either HF_REPO or MODEL_PATH environment variable must be set\n' >&2
    exit 1
fi

CMD_ARGS=(
    --host 0.0.0.0
    --port "$PORT"
    -np 1
    -ngl 99
    --no-mmap
    --parallel 1
    --models-dir "$MODELS_DIR"
)

if [ -n "$HF_REPO" ]; then
    CMD_ARGS+=(-hf "$HF_REPO")
else
    CMD_ARGS+=(--model "$MODEL_PATH")
fi

if [ "$CONTEXT" != 0 ]; then
    CMD_ARGS+=(--ctx-size "$CONTEXT")
fi

if [ -n "$EXTRA_SWITCHES" ]; then
    read -r -a EXTRA_ARGS <<< "$EXTRA_SWITCHES"
    CMD_ARGS+=("${EXTRA_ARGS[@]}")
fi

if [ -n "$CHAT_TEMPLATE_KWARGS" ]; then
    CMD_ARGS+=(--chat-template-kwargs "$CHAT_TEMPLATE_KWARGS")
fi

if [ "${1:-}" = "--print-cmd" ]; then
    printf 'container=%s\n' "$CONTAINER_NAME"
    printf 'binary=%s\n' "$LLAMA_SERVER_BIN"
    printf 'extra_switches=%q\n' "$EXTRA_SWITCHES"
    for argument in "${CMD_ARGS[@]}"; do
        printf 'arg=%q\n' "$argument"
    done
    exit 0
fi

printf 'Starting llama.cpp with preset\n'
if [ -n "$HF_REPO" ]; then
    printf 'HF Model: %s\n' "$HF_REPO"
else
    printf 'Model Path: %s\n' "$MODEL_PATH"
fi
printf 'Port: %s\nContext: %s\nExtra Switches: %s\n' "$PORT" "$CONTEXT" "$EXTRA_SWITCHES"

DISTROBOX=/usr/local/bin/distrobox
if [ ! -x "$DISTROBOX" ]; then
    DISTROBOX="$(which distrobox 2>/dev/null || echo distrobox)"
fi

CONTAINER_LIST="$("$DISTROBOX" list 2>&1)"
if ! echo "$CONTAINER_LIST" | grep -E "\\|[[:space:]]*${CONTAINER_NAME}[[:space:]]*\\|" > /dev/null; then
    printf "Error: Distrobox container '%s' not found\n" "$CONTAINER_NAME" >&2
    exit 1
fi

# The script text is fixed and single-quoted. Every mutable value follows the
# script as a positional argument, so quotes and metacharacters remain data.
exec "$DISTROBOX" enter "$CONTAINER_NAME" -- bash -c '
    export HSA_OVERRIDE_GFX_VERSION=11.5.1
    export ROCM_LLVM_PRE_VEGA=1
    MODELS_DIR="$1"
    LLAMA_SERVER_BIN="$2"
    shift 2
    export LLAMA_CACHE="$MODELS_DIR"
    printf "Starting llama-server with preset...\nCommand:"
    printf " %q" "$LLAMA_SERVER_BIN" "$@"
    printf "\n"
    exec "$LLAMA_SERVER_BIN" "$@"
' preset-launch "$MODELS_DIR" "$LLAMA_SERVER_BIN" "${CMD_ARGS[@]}"
