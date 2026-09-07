#!/bin/bash
# Llama Manager — llama.cpp multi-model router process launcher.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# This script runs inside the ROCm Distrobox, applies gfx1151 unified-memory
# settings, prepares model and slot-cache directories, and execs llama-server
# with a literal argv so configurable paths cannot be split or glob-expanded.

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
# How the router loads model weights. This MUST stay overridable, because the router
# merges its own CLI args on top of every per-model preset section, so any load-mode
# flag set here silently overrides what an individual model asked for.
#   none      -> --no-mmap. The long-standing default; preserved so nothing regresses.
#   per-model -> emit NO global flag, letting each [model] section in --models-preset
#                decide. Models without a section fall back to llama.cpp's own default
#                (auto: mmap unless a device cannot). Required by duo mode, whose
#                Qwen3.8-Flash-Next planner keeps its 51GB n-gram table on disk via
#                --lazy-mode, and --lazy-mode does nothing without mmap.
#   mmap|auto|mlock|mmap+mlock|dio -> passed straight through as --load-mode.
: "${LOAD_MODE:=none}"
# Where the router (and the per-model children it spawns) persist slot KV caches.
# The manager (api/server.js) saves/restores conversation contexts here so a model
# reload doesn't force a cold re-prefill. distrobox shares $HOME, so this same path
# is visible to the manager on the host. Empty disables slot persistence.
: "${SLOT_SAVE_PATH:=$HOME/.cache/llama-slots}"

# AMD GPU settings
export HSA_OVERRIDE_GFX_VERSION=11.5.1
export ROCM_LLVM_PRE_VEGA=1

# Strix Halo / unified-memory GPU: tell the HIP backend it can place buffers
# in GTT (system RAM) instead of the tiny BIOS-reserved VRAM partition.
# Without this, llama.cpp tries to fit the whole model in VRAM (~1GB on Strix
# Halo by default) and silently falls back to CPU for any model that doesn't fit.
#
# GGML_CUDA_ENABLE_UNIFIED_MEMORY was also set here, on the assumption that it
# was merely the older name for the same setting. On b10752 that is FALSE, and
# the two are not interchangeable: with it set, any sufficiently large model
# fails to load outright. Measured on drakemore with the 82GB
# Qwen3.8-Flash-Next planner, same binary and args, only the environment varying:
#   GGML_HIP_UMA=1 alone                     -> loads and serves
#   GGML_CUDA_ENABLE_UNIFIED_MEMORY=1 alone  -> "failed to load", instantly,
#                                               without the child even allocating
#   both together                            -> fails
# The failure is immediate and memory never moves, so it is a rejected fit
# calculation rather than an exhausted allocation. Only the HIP-native name is
# set now. Do not reinstate the CUDA one as a compatibility alias without
# re-measuring against a large model — a small model hides this completely.
export GGML_HIP_UMA=1

export IP_ADDRESS=$(ip addr show | grep "inet " | grep -v 127.0.0.1 | awk 'NR==1 {print $2}' | cut -d'/' -f1)

# Set llama.cpp cache directory to MODELS_DIR so HF downloads go there
export LLAMA_CACHE="$MODELS_DIR"

# Ensure models directory exists
mkdir -p "$MODELS_DIR"

# Ensure the slot-save directory exists (router writes KV dumps here)
[ -n "$SLOT_SAVE_PATH" ] && mkdir -p "$SLOT_SAVE_PATH"

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
[ -n "$SLOT_SAVE_PATH" ] && echo "SLOT_SAVE_PATH=$SLOT_SAVE_PATH"
echo
echo "Available models:"
find "$MODELS_DIR" -name "*.gguf" -type f 2>/dev/null | head -20 || echo "  (none yet)"
echo
echo "Starting server in router mode..."
echo

##
# Start the Server in Router Mode
##

# Build command with optional flags.
# Use the FULL PATH to the managed binary, not a bare `llama-server`. The container's
# non-login PATH resolves bare `llama-server` to a stale /usr/local/bin/llama-server,
# which (with the freshly rebuilt shared libs in ~/llama.cpp/build/bin) is an
# ABI mismatch and makes every model fail to load. The router also spawns its
# per-model child servers using this same binary, so it must be the current build.
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/.local/bin/llama-server}"
CMD=(
    "$LLAMA_SERVER_BIN"
    --models-dir "$MODELS_DIR"
    --models-max "$MODELS_MAX"
    --ctx-size "$CONTEXT"
    -ngl "$GPU_LAYERS"
    --jinja
    --host 0.0.0.0
    --port "$PORT"
)
# Optional discrete-GPU accelerator. The manager decides whether duo may use the card
# (api/duo-accelerator.js: no NVIDIA card, accelerator switched off, or the pods agent
# holding it all mean "no") and passes an endpoint only when it may. Empty on every
# AMD-only box, so no --rpc flag reaches the router there at all.
[ -n "${LLAMA_RPC_ENDPOINT:-}" ] && CMD+=(--rpc "$LLAMA_RPC_ENDPOINT")

# Load mode. "per-model" deliberately emits nothing so that a [model] section in
# --models-preset can choose its own; anything else is applied to every child.
case "$LOAD_MODE" in
    per-model) ;;
    none)      CMD+=(--no-mmap) ;;
    *)         CMD+=(--load-mode "$LOAD_MODE") ;;
esac
[ -n "$NO_WARMUP" ] && CMD+=(--no-warmup)
[ -n "$FLASH_ATTN" ] && CMD+=(--flash-attn on)
# --slot-save-path is propagated by the router to every per-model child server,
# enabling POST /slots/{id}?action=save|restore for conversation KV persistence.
[ -n "$SLOT_SAVE_PATH" ] && CMD+=(--slot-save-path "$SLOT_SAVE_PATH")
# Per-model overrides the router cannot auto-detect (e.g. the gemma-4 MTP draft
# model). The manager writes this INI; each [model] section merges onto the
# router's auto-generated preset (--model/--mmproj/--ctx-size preserved).
[ -n "${MODELS_PRESET:-}" ] && [ -f "$MODELS_PRESET" ] && CMD+=(--models-preset "$MODELS_PRESET")

# A custom-built llama-server links against shared libs (libllama, libmtmd,
# libggml-*) that live BESIDE it, and its RUNPATH records the build directory of
# the machine that compiled it — a path that need not exist on the machine that
# RUNS it. DT_RUNPATH is searched after LD_LIBRARY_PATH, so pointing that at the
# binary's own directory makes a relocated build self-contained without patching
# the ELF. Guarded on libllama.so so the toolbox's self-contained
# /usr/local/bin/llama-server is left exactly as it was.
LLAMA_BIN_DIR=$(dirname "$LLAMA_SERVER_BIN")
if [ -e "$LLAMA_BIN_DIR/libllama.so" ]; then
    export LD_LIBRARY_PATH="$LLAMA_BIN_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    echo "Using bundled engine libs from $LLAMA_BIN_DIR"
fi

printf 'Command:'
printf ' %q' "${CMD[@]}"
printf '\n'
exec "${CMD[@]}"
