#!/bin/bash
#
# Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE
# file in the repository root.
#
# build-llama-cpp-cuda.sh — canonical CUDA build of llama.cpp's `rpc-server` (plus
# the ggml shared libraries it needs) so a discrete NVIDIA card can be used as a
# compute device by the ROCm/HIP llama-server router that llama-manager runs.
#
# The router itself stays HIP-built and unchanged. It reaches the NVIDIA card over
# llama.cpp's RPC backend: this script produces the *server* half (`rpc-server`,
# CUDA-backed) and the *client* half (`libggml-rpc.so`, backend-agnostic) from the
# SAME pinned llama.cpp commit as scripts/build-llama-cpp.sh, so the wire protocol
# versions agree by construction. A mismatched pair fails the RPC hello handshake.
#
# nvcc is required only to COMPILE. The produced binaries need nothing but
# `libcuda.so.1` at run time, which the NVIDIA driver already installs — so the
# appliance never needs a CUDA toolkit. The compile therefore happens inside a
# `nvidia/cuda:*-devel-*` Docker image and no GPU is needed to build.
#
#   scripts/build-llama-cpp-cuda.sh                 # build, stage into dist/
#   LLAMA_CUDA_CLEAN=1 scripts/build-llama-cpp-cuda.sh   # wipe the build dir first
#   CUDA_ARCHS=86 scripts/build-llama-cpp-cuda.sh   # 86 = Ampere GA102 (RTX 3090)
#
# Env overrides: LLAMA_CPP_DIR, CUDA_IMAGE, CUDA_ARCHS, STAGE_DIR, JOBS,
#                LLAMA_CUDA_CLEAN, BUILD_SUBDIR.
#
# See docs/llama-cpp-cuda-rpc-build-and-deployment.md for the deployment procedure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Load the pinned version --------------------------------------------------
# Deliberately the SAME file the ROCm build reads. The RPC protocol version is a
# compile-time constant in ggml/include/ggml-rpc.h; building the two halves from
# different commits is the most likely way this fails.
VERSION_FILE="$REPO_ROOT/.llama-cpp-version"
[ -f "$VERSION_FILE" ] || { echo "ERROR: missing $VERSION_FILE"; exit 1; }
# shellcheck disable=SC1090
source "$VERSION_FILE"
: "${LLAMA_CPP_REPO:?LLAMA_CPP_REPO not set in .llama-cpp-version}"
: "${LLAMA_CPP_REF:?LLAMA_CPP_REF not set in .llama-cpp-version}"

# ---- Settings (override via env) ---------------------------------------------
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$HOME/llama.cpp}"
# Kept separate from the ROCm build's `build/` directory: that tree is NOT
# disposable, the installed HIP llama-server resolves its shared libraries
# through a RUNPATH pointing into it.
BUILD_SUBDIR="${BUILD_SUBDIR:-build-cuda}"
# The driver on the target reports the maximum CUDA it accepts (`nvidia-smi`,
# "CUDA UMD Version"). drakemore: 610.43.02 / CUDA 13.3.
CUDA_IMAGE="${CUDA_IMAGE:-nvidia/cuda:13.0.1-devel-ubuntu24.04}"
# 86 = compute capability 8.6, Ampere GA102 — the RTX 3090. Add more
# semicolon-separated values to fatten the binary for other cards.
CUDA_ARCHS="${CUDA_ARCHS:-86}"
STAGE_DIR="${STAGE_DIR:-$REPO_ROOT/dist/llama-cpp-cuda}"
JOBS="${JOBS:-$(nproc)}"
LLAMA_CUDA_CLEAN="${LLAMA_CUDA_CLEAN:-0}"
BUILD_DIR="$LLAMA_CPP_DIR/$BUILD_SUBDIR"

echo "=== llama.cpp CUDA rpc-server build ==="
echo "  repo:      $LLAMA_CPP_REPO"
echo "  ref:       $LLAMA_CPP_REF"
echo "  checkout:  $LLAMA_CPP_DIR"
echo "  build dir: $BUILD_DIR"
echo "  image:     $CUDA_IMAGE"
echo "  archs:     $CUDA_ARCHS"
echo "  stage:     $STAGE_DIR"
echo "  jobs:      $JOBS   clean: $LLAMA_CUDA_CLEAN"
echo

# ---- 1. Manage the pinned checkout (host side) -------------------------------
if [ ! -d "$LLAMA_CPP_DIR/.git" ]; then
  echo "[1/4] Cloning llama.cpp -> $LLAMA_CPP_DIR"
  git clone "$LLAMA_CPP_REPO" "$LLAMA_CPP_DIR"
else
  echo "[1/4] Using existing checkout $LLAMA_CPP_DIR"
fi
HEAD_SHA="$(git -C "$LLAMA_CPP_DIR" rev-parse HEAD)"
if [ "$HEAD_SHA" != "$LLAMA_CPP_REF" ]; then
  echo "  fetching origin..."
  git -C "$LLAMA_CPP_DIR" fetch --quiet origin
  echo "  checking out pinned commit $LLAMA_CPP_REF"
  git -C "$LLAMA_CPP_DIR" checkout --quiet --detach "$LLAMA_CPP_REF"
  git -C "$LLAMA_CPP_DIR" submodule update --init --recursive --quiet 2>/dev/null || true
else
  echo "  already at pinned commit $LLAMA_CPP_REF"
fi
echo "  HEAD now: $(git -C "$LLAMA_CPP_DIR" log -1 --format='%h %s')"

# The wire-protocol version both halves must agree on. Printed so a deployment
# can be checked against a running peer without guessing.
RPC_PROTO="$(awk '/define RPC_PROTO_(MAJOR|MINOR|PATCH)_VERSION/ {print $3}' \
  "$LLAMA_CPP_DIR/ggml/include/ggml-rpc.h" | paste -sd. -)"
echo "  RPC protocol version: $RPC_PROTO"

[ "$LLAMA_CUDA_CLEAN" = "1" ] && { echo "  (clean) removing $BUILD_DIR"; rm -rf "$BUILD_DIR"; }

# ---- 2/3. Configure + build inside the CUDA toolkit container ----------------
# GGML_NATIVE is OFF on purpose: the build host and the appliance are not
# guaranteed to be the same microarchitecture, and -march=native would emit
# instructions that fault on the target.
echo "[2/4] Configuring + [3/4] building in $CUDA_IMAGE (this is the long part)..."
docker run --rm \
  -v "$LLAMA_CPP_DIR:/src" \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  "$CUDA_IMAGE" \
  bash -c "
    set -euo pipefail
    cmake -S /src -B /src/$BUILD_SUBDIR \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_CUDA=ON \
      -DGGML_RPC=ON \
      -DCMAKE_CUDA_ARCHITECTURES='$CUDA_ARCHS' \
      -DGGML_NATIVE=OFF \
      -DBUILD_SHARED_LIBS=ON \
      -DLLAMA_BUILD_SERVER=OFF \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_CURL=OFF
    cmake --build /src/$BUILD_SUBDIR --target rpc-server -j '$JOBS'
  "

# ---- 4. Stage the artifact set ------------------------------------------------
# rpc-server plus every ggml shared library it loads. libggml-rpc.so is staged
# too even though the server does not need it: it is the CLIENT half, and the
# HIP router's engine directory is missing it (the ROCm build does not pass
# -DGGML_RPC=ON). It is backend-agnostic — sockets and ggml-base only — so the
# copy built here is the one that goes into the router's engine directory.
NEW_BIN="$BUILD_DIR/bin/rpc-server"
[ -x "$NEW_BIN" ] || { echo "ERROR: build did not produce $NEW_BIN"; exit 1; }

echo "[4/4] Staging -> $STAGE_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -a "$NEW_BIN" "$STAGE_DIR/"
cp -a "$BUILD_DIR"/bin/libggml*.so* "$STAGE_DIR/"
# A provenance stamp, so a binary found on a box can be traced back to a commit.
cat > "$STAGE_DIR/BUILD-INFO" <<EOF
llama.cpp-ref=$LLAMA_CPP_REF
rpc-proto=$RPC_PROTO
cuda-image=$CUDA_IMAGE
cuda-archs=$CUDA_ARCHS
built-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo
echo "=== Done ==="
ls -la "$STAGE_DIR"
echo
echo "Staged a CUDA rpc-server built from $LLAMA_CPP_REF (RPC protocol $RPC_PROTO)."
echo "Deploy per docs/llama-cpp-cuda-rpc-build-and-deployment.md."
