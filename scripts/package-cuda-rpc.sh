#!/bin/bash
#
# Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE
# file in the repository root.
#
# package-cuda-rpc.sh — turns the artifact tree staged by
# scripts/build-llama-cpp-cuda.sh into the two installable Debian packages that
# carry llama.cpp's CUDA `ggml-rpc-server` onto an appliance with a discrete
# NVIDIA card, so a normal install has it and a reflash does not lose it:
#
#   llama-manager-cuda-rpc         the engine: ggml-rpc-server + the ggml shared
#                                  libraries, into
#                                  /usr/lib/llama-manager/engine-cuda/<ref>/ with a
#                                  postinst-managed `current` symlink. ~68 MB.
#   llama-manager-cuda-runtime-13  the CUDA 13 toolkit runtime it links against
#                                  (libcudart, libcublas, libcublasLt), into
#                                  /usr/lib/llama-manager/engine-cuda/cuda-runtime-13/.
#                                  ~594 MB.
#
# The split is deliberate. The runtime libraries cannot be trimmed (nvprune
# rejects CUDA 13 redistributables as not relocatable) and no repository the
# appliance can reach offline provides them, so the bytes have to ship — but they
# change almost never, while the engine follows .llama-cpp-version. Splitting them
# makes an engine bump a 68 MB APT update instead of a 633 MB one, and lets a box
# that does have NVIDIA's own packages satisfy the dependency another way through
# the runtime package's Provides.
#
# The engine package ships relative symlinks (<ref>/libcudart.so.13 ->
# ../cuda-runtime-13/libcudart.so.13, and the same for cublas and cublasLt) so the
# binary's existing `$ORIGIN` RUNPATH resolves the whole chain with no
# LD_LIBRARY_PATH and no ld.so.conf entry: the installed directory is
# self-contained. Only libcuda.so.1 comes from outside, and that belongs to the
# NVIDIA driver, which is already on the box.
#
# Neither package ships a systemd unit. llama-manager starts and stops the
# rpc-server itself; a card usable only while a unit is enabled would not be
# shareable with the other workloads on the machine, which is the entire reason
# the CUDA path is an RPC server rather than a second linked engine.
#
#   scripts/package-cuda-rpc.sh                        # build both .debs
#   STAGE_DIR=/path/to/dist scripts/package-cuda-rpc.sh
#   PKG_VERSION=1.2.0 scripts/package-cuda-rpc.sh      # match a manager release
#
# Env overrides: STAGE_DIR, OUT_DIR, PKG_VERSION, ENGINE_REF.
#
# See docs/llama-cpp-cuda-rpc-build-and-deployment.md for the build that produces
# STAGE_DIR, the deployment procedure, and the respin-repo integration this
# mirrors.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v dpkg-deb >/dev/null || { echo "ERROR: dpkg-deb is required"; exit 1; }

# ---- Inputs -------------------------------------------------------------------
STAGE_DIR="${STAGE_DIR:-$REPO_ROOT/dist/llama-cpp-cuda}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist/packages}"
[ -d "$STAGE_DIR" ] || {
  echo "ERROR: no staged artifact tree at $STAGE_DIR"
  echo "       run scripts/build-llama-cpp-cuda.sh first, or set STAGE_DIR."
  exit 1
}
[ -x "$STAGE_DIR/ggml-rpc-server" ] || { echo "ERROR: $STAGE_DIR/ggml-rpc-server missing"; exit 1; }

# The engine directory is named for the llama.cpp commit it was built from, so a
# binary found on a box can always be traced back to a source revision. BUILD-INFO
# inside the staged tree is authoritative — it records what was actually compiled,
# whereas .llama-cpp-version only records what is currently pinned, and the two
# can differ if a stale tree is packaged.
if [ -z "${ENGINE_REF:-}" ]; then
  if [ -f "$STAGE_DIR/BUILD-INFO" ]; then
    ENGINE_REF="$(sed -n 's/^llama.cpp-ref=//p' "$STAGE_DIR/BUILD-INFO" | head -1)"
  fi
  [ -n "${ENGINE_REF:-}" ] || {
    echo "ERROR: cannot determine the llama.cpp ref: $STAGE_DIR/BUILD-INFO has no"
    echo "       llama.cpp-ref line. Set ENGINE_REF explicitly."
    exit 1
  }
  ENGINE_REF="${ENGINE_REF:0:8}"
fi

# Debian upstream versions must begin with a digit, so the commit is a build
# suffix rather than the version itself. PKG_VERSION exists so a release build can
# align these with the manager's own version, the way the respin source package
# does with ${binary:Version}.
ENGINE_VERSION="${PKG_VERSION:-0.0+$ENGINE_REF}-1"

# The runtime package is versioned by the CUDA libraries it actually carries, not
# by anything about llama.cpp, because it is upgraded on a completely different
# cadence.
CUBLAS_SO="$(ls "$STAGE_DIR"/libcublas.so.13.* 2>/dev/null | head -1 || true)"
[ -n "$CUBLAS_SO" ] || { echo "ERROR: no libcublas.so.13.* in $STAGE_DIR"; exit 1; }
RUNTIME_VERSION="$(basename "$CUBLAS_SO" | sed 's/^libcublas\.so\.//')-1"

ENGINE_PKG=llama-manager-cuda-rpc
RUNTIME_PKG=llama-manager-cuda-runtime-13
ENGINE_ROOT=usr/lib/llama-manager/engine-cuda

echo "=== llama-manager CUDA RPC packaging ==="
echo "  stage:           $STAGE_DIR"
echo "  engine ref:      $ENGINE_REF"
echo "  engine version:  $ENGINE_VERSION"
echo "  runtime version: $RUNTIME_VERSION"
echo "  out:             $OUT_DIR"
echo

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
ENGINE_TREE="$BUILD/$ENGINE_PKG"
RUNTIME_TREE="$BUILD/$RUNTIME_PKG"

# Writes the standard copyright stub every binary package is expected to carry.
write_copyright() {
  local tree="$1" pkg="$2"
  mkdir -p "$tree/usr/share/doc/$pkg"
  cat > "$tree/usr/share/doc/$pkg/copyright" <<'EOF'
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: llama.cpp
Source: https://github.com/ggerganov/llama.cpp

Files: usr/lib/llama-manager/engine-cuda/*
Copyright: The llama.cpp authors
License: MIT

Files: usr/lib/llama-manager/engine-cuda/cuda-runtime-13/*
Copyright: NVIDIA Corporation
License: NVIDIA-CUDA-EULA
 Redistributable CUDA runtime libraries, redistributed under the terms of the
 NVIDIA CUDA Toolkit End User License Agreement.
EOF
}

# Emits DEBIAN/md5sums so `dpkg -V` can verify the installed files, after
# normalising permissions. cp -a preserves the build user's mode, and a group- or
# world-writable file in a system package is both a lintian error and a real
# privilege problem, so the payload is forced to the standard read-only modes
# first.
write_md5sums() {
  local tree="$1"
  chmod -R u=rwX,go=rX "$tree"
  chmod 0755 "$tree/DEBIAN"
  # `if`, not `&&`: under set -e a failing test in an && list aborts the script,
  # and the runtime package legitimately has no maintainer scripts at all.
  if [ -f "$tree/DEBIAN/postinst" ]; then chmod 0755 "$tree/DEBIAN/postinst"; fi
  if [ -f "$tree/DEBIAN/postrm" ]; then chmod 0755 "$tree/DEBIAN/postrm"; fi
  ( cd "$tree" && find . -type f ! -path './DEBIAN/*' -printf '%P\0' \
      | xargs -0 md5sum > DEBIAN/md5sums )
}

# ---- 1. The CUDA runtime package ----------------------------------------------
echo "[1/3] Staging $RUNTIME_PKG"
mkdir -p "$RUNTIME_TREE/$ENGINE_ROOT/cuda-runtime-13" "$RUNTIME_TREE/DEBIAN"
cp -a "$STAGE_DIR"/libcudart.so.13.* "$STAGE_DIR"/libcublas.so.13.* \
      "$STAGE_DIR"/libcublasLt.so.13.* "$RUNTIME_TREE/$ENGINE_ROOT/cuda-runtime-13/"
# Recreate the SONAME links from each file's own SONAME rather than parsing
# version suffixes, which is what the loader actually follows.
ldconfig -n "$RUNTIME_TREE/$ENGINE_ROOT/cuda-runtime-13"
write_copyright "$RUNTIME_TREE" "$RUNTIME_PKG"
RUNTIME_SIZE="$(du -sk "$RUNTIME_TREE" | cut -f1)"
cat > "$RUNTIME_TREE/DEBIAN/control" <<EOF
Package: $RUNTIME_PKG
Version: $RUNTIME_VERSION
Section: libs
Priority: optional
Architecture: amd64
Maintainer: Llama Manager Release <releases@doubtech.com>
Installed-Size: $RUNTIME_SIZE
Provides: llama-manager-cuda-runtime
Description: CUDA 13 runtime libraries for the Llama Manager NVIDIA engine
 Installs the redistributable CUDA 13 runtime libraries (libcudart, libcublas and
 libcublasLt) that llama-manager-cuda-rpc links against, into a private directory
 under /usr/lib/llama-manager so they never shadow anything on the system linker
 path. These come from the CUDA toolkit rather than the NVIDIA driver, so a box
 with a working driver does not already have them, and they cannot be trimmed:
 nvprune rejects CUDA 13 redistributables as not relocatable.
 .
 They are packaged apart from the engine because they change on a completely
 different cadence. The engine follows the pinned llama.cpp revision and is a few
 tens of megabytes; these are an order of magnitude larger and are replaced only
 when the CUDA major version moves.
EOF
write_md5sums "$RUNTIME_TREE"

# ---- 2. The engine package ----------------------------------------------------
echo "[2/3] Staging $ENGINE_PKG"
mkdir -p "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF" "$ENGINE_TREE/DEBIAN"
cp -a "$STAGE_DIR/ggml-rpc-server" "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF/"
cp -a "$STAGE_DIR"/libggml*.so.*.*.* "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF/"
ldconfig -n "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF"
if [ -f "$STAGE_DIR/BUILD-INFO" ]; then cp -a "$STAGE_DIR/BUILD-INFO" "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF/"; fi

# The three CUDA libraries are reached through relative symlinks in the engine
# directory. All three are shipped even though only cudart and cublas are direct
# NEEDEDs: libcublas pulls libcublasLt in through its own $ORIGIN RUNPATH, and
# whether glibc expands that $ORIGIN to this directory or to the real one depends
# on how the object was opened. Shipping all three makes it resolve either way.
ln -s ../cuda-runtime-13/libcudart.so.13   "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF/libcudart.so.13"
ln -s ../cuda-runtime-13/libcublas.so.13   "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF/libcublas.so.13"
ln -s ../cuda-runtime-13/libcublasLt.so.13 "$ENGINE_TREE/$ENGINE_ROOT/$ENGINE_REF/libcublasLt.so.13"

# Read by the postinst to decide what `current` should point at, so that script
# stays static and needs no build-time substitution in either build path.
printf '%s\n' "$ENGINE_REF" > "$ENGINE_TREE/$ENGINE_ROOT/packaged-ref"

cp -a "$REPO_ROOT/packaging/$ENGINE_PKG.postinst" "$ENGINE_TREE/DEBIAN/postinst"
cp -a "$REPO_ROOT/packaging/$ENGINE_PKG.postrm"   "$ENGINE_TREE/DEBIAN/postrm"
chmod 0755 "$ENGINE_TREE/DEBIAN/postinst" "$ENGINE_TREE/DEBIAN/postrm"
write_copyright "$ENGINE_TREE" "$ENGINE_PKG"
ENGINE_SIZE="$(du -sk "$ENGINE_TREE" | cut -f1)"
cat > "$ENGINE_TREE/DEBIAN/control" <<EOF
Package: $ENGINE_PKG
Version: $ENGINE_VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Llama Manager Release <releases@doubtech.com>
Installed-Size: $ENGINE_SIZE
Depends: llama-manager, $RUNTIME_PKG (= $RUNTIME_VERSION)
Description: CUDA RPC engine for a discrete NVIDIA card on a Llama Manager appliance
 Installs llama.cpp's CUDA-backed ggml-rpc-server, built from the same pinned
 llama.cpp revision as the appliance's ROCm engine so the two agree on the RPC
 wire protocol by construction. llama-manager attaches to it with --rpc, which is
 how a model can be offloaded onto a discrete NVIDIA card by a router that is
 itself built for AMD ROCm.
 .
 The binary is installed under a revision-named directory with a 'current'
 symlink, so an engine can be staged and rolled back the way the ROCm engine is.
 .
 No systemd unit is shipped on purpose. The manager starts and stops the
 rpc-server itself as it schedules work onto the card; a card that were usable
 only while a unit was enabled could not be shared with the other workloads on the
 machine, which is the whole point of reaching it over RPC.
EOF
write_md5sums "$ENGINE_TREE"

# ---- 3. Build ------------------------------------------------------------------
echo "[3/3] Building packages"
mkdir -p "$OUT_DIR"
# Root-owned file ownership without needing root; the payload is all read-only
# system files.
dpkg-deb --root-owner-group --build "$RUNTIME_TREE" \
  "$OUT_DIR/${RUNTIME_PKG}_${RUNTIME_VERSION}_amd64.deb"
dpkg-deb --root-owner-group --build "$ENGINE_TREE" \
  "$OUT_DIR/${ENGINE_PKG}_${ENGINE_VERSION}_amd64.deb"

echo
echo "=== Done ==="
ls -la "$OUT_DIR"
echo
echo "Install on a box with an NVIDIA card (runtime first, or pass both to apt):"
echo "  sudo apt install ./${RUNTIME_PKG}_${RUNTIME_VERSION}_amd64.deb \\"
echo "                   ./${ENGINE_PKG}_${ENGINE_VERSION}_amd64.deb"
echo "Then /usr/lib/llama-manager/engine-cuda/current/ggml-rpc-server is the"
echo "binary llama-manager launches."
