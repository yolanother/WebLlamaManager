#!/bin/bash
# Llama Manager — dedicated ds4-server launcher (INTERNAL).
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Invoked ONLY by the Node server's ds4 supervisor (never run by hand), this
# mirrors start-embed.sh/start-preset.sh: it sources .env, optionally enters the
# distrobox, and runs a ds4-server instance (antirez/ds4, DeepSeek V4 Flash).
# ds4-server is a single-model OpenAI-compatible server with its own flag set —
# no /health, /slots, /props; readiness is GET /v1/models. The model GGUF lives
# under DS4_GGUF_DIR (deliberately OUTSIDE ~/models so the llama router never
# scans it).
#
# Env: DS4_MODEL (gguf path or bare name under DS4_GGUF_DIR, required),
#      DS4_SERVER_BIN (override; default resolves the auto-updater's managed
#        binary at DS4_STATE_DIR/current/ds4-server, else ~/.local/bin/ds4-server),
#      DS4_STATE_DIR (source installs: updater builds/current; packages: runtime
#        state only), LLAMA_MANAGER_PACKAGED (1 forces the root-owned binary at
#        /usr/lib/llama-manager-ds4/bin/ds4-server), DS4_PORT (default 5253),
#      DS4_CTX (0 = model default), DS4_GGUF_DIR
#      (default /home/yolan/models-ds4/deepseek-v4-gguf), DS4_POWER (1-100, opt),
#      DS4_KV_DISK_DIR (opt), DS4_KV_DISK_SPACE_MB (opt),
#      DS4_SSD_STREAMING (0/1 — 1 appends --ssd-streaming to stream MoE experts
#        off SSD, cutting resident weight RAM ~30G; set per-attempt by the adaptive
#        controller), DS4_SSD_STREAMING_CACHE_EXPERTS (expert-cache size for
#        --ssd-streaming-cache-experts, e.g. 32GB; only used when streaming is on),
#      DS4_EXTRA_SWITCHES (default "--rocm --cors"),
#      DS4_CONTAINER (default llama-rocm-7.2.4 — the SAME container the live
#        llama.cpp uses; the 7rc container's HSA runtime segfaults on gfx1151),
#      DS4_IN_DISTROBOX (1 = run inside distrobox [default], 0 = run on host).
# Flag: --print-cmd  prints the ds4-server command and exits (test seam).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; . "$SCRIPT_DIR/.env"; set +a; fi

# Resolve the ds4-server binary. Package installations never execute binaries
# from group-writable state: signed APT owns the fixed /usr/lib binary. For a
# source checkout, the auto-updater (api/ds4-updater.js) installs
# versioned builds under DS4_STATE_DIR/builds/<commit>/ and atomically flips a
# `current` symlink to the active one; prefer that managed binary so a swap takes
# effect on the next (re)start. config.ds4.binPath (passed through as
# DS4_SERVER_BIN) remains an explicit override/fallback: if it is set to a value
# OTHER than the legacy default path, it wins (operator pinned a specific binary).
DS4_STATE_DIR="${DS4_STATE_DIR:-$HOME/.local/share/ds4}"
DS4_CURRENT_BIN="$DS4_STATE_DIR/current/ds4-server"
DS4_LEGACY_DEFAULT="$HOME/.local/bin/ds4-server"
DS4_PACKAGED_BIN="/usr/lib/llama-manager-ds4/bin/ds4-server"
case "${LLAMA_MANAGER_PACKAGED:-}" in
  1|true)
    DS4_SERVER_BIN="$DS4_PACKAGED_BIN"
    ;;
  *)
    if [ -x "$DS4_CURRENT_BIN" ] && { [ -z "${DS4_SERVER_BIN:-}" ] || [ "${DS4_SERVER_BIN}" = "$DS4_LEGACY_DEFAULT" ]; }; then
      DS4_SERVER_BIN="$DS4_CURRENT_BIN"
    fi
    DS4_SERVER_BIN="${DS4_SERVER_BIN:-$DS4_LEGACY_DEFAULT}"
    ;;
esac
DS4_PORT="${DS4_PORT:-5253}"
DS4_CTX="${DS4_CTX:-0}"
DS4_GGUF_DIR="${DS4_GGUF_DIR:-/home/yolan/models-ds4/deepseek-v4-gguf}"
DS4_MODEL="${DS4_MODEL:-}"
DS4_POWER="${DS4_POWER:-}"
DS4_KV_DISK_DIR="${DS4_KV_DISK_DIR:-}"
DS4_KV_DISK_SPACE_MB="${DS4_KV_DISK_SPACE_MB:-}"
DS4_SSD_STREAMING="${DS4_SSD_STREAMING:-0}"
DS4_SSD_STREAMING_CACHE_EXPERTS="${DS4_SSD_STREAMING_CACHE_EXPERTS:-}"
DS4_EXTRA_SWITCHES="${DS4_EXTRA_SWITCHES:---rocm --cors}"
CONTAINER_NAME="${DS4_CONTAINER:-llama-rocm-7.2.4}"
DS4_IN_DISTROBOX="${DS4_IN_DISTROBOX:-1}"

if [ -z "$DS4_MODEL" ]; then
  echo "start-ds4.sh: DS4_MODEL is not set; nothing to serve" >&2
  exit 1
fi

# Resolve a bare/relative model name under DS4_GGUF_DIR; pass absolute paths through.
MODEL_ARG="$DS4_MODEL"
case "$DS4_MODEL" in
  /*) : ;;                                  # absolute path
  *) MODEL_ARG="$DS4_GGUF_DIR/$DS4_MODEL" ;;
esac

# Build the ds4-server argv (array preserves spaces in paths).
build_args() {
  DS4_ARGS=(-m "$MODEL_ARG" --host 127.0.0.1 --port "$DS4_PORT")
  [ "${DS4_CTX:-0}" != "0" ] && DS4_ARGS+=(-c "$DS4_CTX")
  [ -n "$DS4_POWER" ] && DS4_ARGS+=(--power "$DS4_POWER")
  if [ -n "$DS4_KV_DISK_DIR" ]; then
    DS4_ARGS+=(--kv-disk-dir "$DS4_KV_DISK_DIR")
    [ -n "$DS4_KV_DISK_SPACE_MB" ] && DS4_ARGS+=(--kv-disk-space-mb "$DS4_KV_DISK_SPACE_MB")
  fi
  # SSD expert-streaming: stream MoE experts off SSD to cut resident weight RAM
  # (~30G), letting a higher context fit. The adaptive controller sets these
  # per-attempt; the cache-experts size defaults to ds4-server's own default when
  # streaming is on but no size is given.
  if [ "${DS4_SSD_STREAMING:-0}" = "1" ]; then
    DS4_ARGS+=(--ssd-streaming)
    [ -n "$DS4_SSD_STREAMING_CACHE_EXPERTS" ] && DS4_ARGS+=(--ssd-streaming-cache-experts "$DS4_SSD_STREAMING_CACHE_EXPERTS")
  fi
  # Extra switches (e.g. --rocm --cors --quality --mtp <file>) — word-split.
  if [ -n "$DS4_EXTRA_SWITCHES" ]; then
    # shellcheck disable=SC2206
    local -a EXTRA=($DS4_EXTRA_SWITCHES)
    DS4_ARGS+=("${EXTRA[@]}")
  fi
}

build_args

if [ "${1:-}" = "--print-cmd" ]; then
  printf '%s ' "$DS4_SERVER_BIN" "${DS4_ARGS[@]}"; echo; exit 0
fi

echo "Starting ds4-server on 127.0.0.1:$DS4_PORT (model: $MODEL_ARG, distrobox: $DS4_IN_DISTROBOX)"

# ds4-server ROCm env. The binary was built against ROCm 7.0 libs but the 7.2.4
# container's sonames match, so it loads from /opt/rocm/lib. HSA override is
# required for the Strix Halo gfx1151 iGPU. --rocm (in DS4_EXTRA_SWITCHES) forces
# the ROCm backend.
run_on_host() {
  export LD_LIBRARY_PATH="/opt/rocm/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export HSA_OVERRIDE_GFX_VERSION=11.5.1
  exec "$DS4_SERVER_BIN" "${DS4_ARGS[@]}"
}

if [ "$DS4_IN_DISTROBOX" = "0" ]; then
  run_on_host
fi

DISTROBOX="/usr/local/bin/distrobox"
[ -x "$DISTROBOX" ] || DISTROBOX="$(which distrobox 2>/dev/null || echo distrobox)"

# Enter the container and exec ds4-server. The binary path + full argv are passed
# as POSITIONAL ARGS to the inner shell (not interpolated into the command string),
# and argv is rebuilt inside with proper quoting, so a model path containing spaces
# or shell metacharacters can never be word-split or injected. $0=ds4-launch,
# $1=binary, $2..=ds4-server args.
exec "$DISTROBOX" enter "$CONTAINER_NAME" -- bash -c '
  export LD_LIBRARY_PATH="/opt/rocm/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export HSA_OVERRIDE_GFX_VERSION=11.5.1
  BIN="$1"; shift
  exec "$BIN" "$@"
' ds4-launch "$DS4_SERVER_BIN" "${DS4_ARGS[@]}"
