#!/bin/bash
#
# Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE
# file in the repository root.
#
# build-llama-cpp.sh — canonical ROCm build of the llama.cpp `llama-server` binary
# for the AMD Strix Halo iGPU (gfx1151) that the llama-manager router runs.
#
# It manages a pinned llama.cpp checkout (commit recorded in ../.llama-cpp-version),
# configures and compiles it INSIDE the `llama-rocm-7rc-rocwmma` distrobox (which
# provides ROCm 7 + rocwmma), and installs the resulting `llama-server` to
# ~/.local/bin — where container-start.sh's `--models-dir` / `--models-preset`
# router picks it up via the distrobox PATH. The binary finds its shared libs via
# RUNPATH into the build tree, so the build directory is kept after install.
#
# This build is intentionally NOT run by install.sh (it is a ~30-minute compile).
# install.sh only checks for the binary and points here. Run it on demand:
#
#   scripts/build-llama-cpp.sh            # build the pinned commit, install binary
#   LLAMA_CPP_CLEAN=1 scripts/build-llama-cpp.sh   # wipe the build dir first (clean build)
#   LLAMA_CPP_DIR=/path scripts/build-llama-cpp.sh # use a different checkout location
#
# Env overrides: LLAMA_CPP_DIR, DISTROBOX_CONTAINER, INSTALL_BIN, JOBS, LLAMA_CPP_CLEAN.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Load the pinned version --------------------------------------------------
VERSION_FILE="$REPO_ROOT/.llama-cpp-version"
[ -f "$VERSION_FILE" ] || { echo "ERROR: missing $VERSION_FILE"; exit 1; }
# shellcheck disable=SC1090
source "$VERSION_FILE"
: "${LLAMA_CPP_REPO:?LLAMA_CPP_REPO not set in .llama-cpp-version}"
: "${LLAMA_CPP_REF:?LLAMA_CPP_REF not set in .llama-cpp-version}"

# ---- Settings (override via env) ---------------------------------------------
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$HOME/llama.cpp}"
DISTROBOX_CONTAINER="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"
INSTALL_BIN="${INSTALL_BIN:-$HOME/.local/bin/llama-server}"
JOBS="${JOBS:-$(nproc)}"
LLAMA_CPP_CLEAN="${LLAMA_CPP_CLEAN:-0}"
BUILD_DIR="$LLAMA_CPP_DIR/build"

echo "=== Llama.cpp ROCm build ==="
echo "  repo:      $LLAMA_CPP_REPO"
echo "  ref:       $LLAMA_CPP_REF"
echo "  checkout:  $LLAMA_CPP_DIR"
echo "  container: $DISTROBOX_CONTAINER"
echo "  install:   $INSTALL_BIN"
echo "  jobs:      $JOBS   clean: $LLAMA_CPP_CLEAN"
echo

# ---- 1. Manage the pinned checkout (host side) -------------------------------
if [ ! -d "$LLAMA_CPP_DIR/.git" ]; then
  echo "[1/4] Cloning llama.cpp -> $LLAMA_CPP_DIR"
  git clone "$LLAMA_CPP_REPO" "$LLAMA_CPP_DIR"
else
  echo "[1/4] Using existing checkout $LLAMA_CPP_DIR"
fi
cd "$LLAMA_CPP_DIR"
echo "  fetching origin..."
git fetch --quiet origin
echo "  checking out pinned commit $LLAMA_CPP_REF"
git checkout --quiet --detach "$LLAMA_CPP_REF"
git submodule update --init --recursive --quiet 2>/dev/null || true
echo "  HEAD now: $(git log -1 --format='%h %s')"

# ---- 2/3. Configure + build INSIDE the distrobox (ROCm toolchain) ------------
# Flags mirror the known-good config captured from the prior build's CMakeCache:
#   GGML_HIP=ON, AMDGPU_TARGETS=gfx1151, shared libs, server+tools, native, Release.
[ "$LLAMA_CPP_CLEAN" = "1" ] && { echo "  (clean) removing $BUILD_DIR"; rm -rf "$BUILD_DIR"; }

echo "[2/4] Configuring + [3/4] building in distrobox '$DISTROBOX_CONTAINER' (this is the long part)..."
distrobox enter "$DISTROBOX_CONTAINER" -- bash -lc "
  set -euo pipefail
  cd '$LLAMA_CPP_DIR'
  cmake -S . -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_HIP=ON \
    -DAMDGPU_TARGETS=gfx1151 \
    -DGGML_HIP_NO_VMM=ON \
    -DGGML_HIP_MMQ_MFMA=ON \
    -DGGML_HIP_ROCWMMA_FATTN=ON \
    -DGGML_NATIVE=ON \
    -DBUILD_SHARED_LIBS=ON \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_TOOLS_INSTALL=ON \
    -DCMAKE_HIP_COMPILER=/opt/rocm-7.0/llvm/bin/clang++
  cmake --build build --target llama-server -j '$JOBS'
"

# ---- 4. Install the binary (libs resolved via its RUNPATH into build/bin) -----
NEW_BIN="$BUILD_DIR/bin/llama-server"
[ -x "$NEW_BIN" ] || { echo "ERROR: build did not produce $NEW_BIN"; exit 1; }
mkdir -p "$(dirname "$INSTALL_BIN")"
echo "[4/4] Installing $NEW_BIN -> $INSTALL_BIN"
cp -f "$NEW_BIN" "$INSTALL_BIN"

echo
echo "=== Done. Verifying (inside container) ==="
distrobox enter "$DISTROBOX_CONTAINER" -- bash -lc "'$INSTALL_BIN' --version 2>&1 | head -3" || true
echo
echo "Built llama.cpp $LLAMA_CPP_REF and installed llama-server to $INSTALL_BIN."
echo "Restart the router with: systemctl --user restart llama-manager.service (or ./install.sh)."
