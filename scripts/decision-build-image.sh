#!/bin/bash
# Llama Manager — build, verify and export the pinned Laya DECISION engine image.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Builds packaging/decision/Containerfile into localhost/laya-server:rocm-<sha>,
# where <sha> is this repo's short HEAD commit. Runs ONLY on Frostburn (never
# drakemore — AMENDMENT A1 of docs/plans/2026-09-22-laya-decision-engine.md):
# fetches and checksum-verifies the pinned laya-server source tarball into a
# throwaway build-context directory (so the Containerfile itself needs no
# network access and stays reproducible from that context alone), builds the
# image, then proves the AMD Strix Halo iGPU (gfx1151) is actually used by
# running laya-server's own check_gpu.py inside the image with the ROCm
# device/group flags and failing unless its output names gfx1151. Finally
# exports a zstd-compressed OCI archive to the NAS asset mirror
# (/volumes/llama-manager/assets/laya/) and prints the image id, archive
# sha256 and size. `--print` emits every build/verify/export command this
# script would run, without running any of them — used by
# tests/decision/run-tests.sh as a dry-run check of the command shape.
#
# Usage: scripts/decision-build-image.sh [--print]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINERFILE="$REPO_ROOT/packaging/decision/Containerfile"

# Pinned upstream source (AMENDMENT A3): commit + tarball checksum, verified
# before the Containerfile ever sees the files it copies.
LAYA_SERVER_SHA="819fa065dce72b3c117a2364bb4839c02a0abcb3"
LAYA_SRC_URL="https://github.com/noahbclarkson/laya-server/archive/${LAYA_SERVER_SHA}.tar.gz"
LAYA_SRC_SHA256="9d27a7c78994a076502dcbc27ffa5d74e173b5a31e233dc6c0541de13d3d8533"

# Winning GPU runtime from the W6-T0 spike (AMENDMENT A2).
HSA_OVERRIDE_GFX_VERSION="11.5.1"
GPU_ARGS=(--device /dev/kfd --device /dev/dri --group-add keep-groups --security-opt seccomp=unconfined
    -e "HSA_OVERRIDE_GFX_VERSION=${HSA_OVERRIDE_GFX_VERSION}")

NAS_ASSET_DIR="/volumes/llama-manager/assets/laya"

PRINT_ONLY=false
if [ "${1:-}" = "--print" ]; then
    PRINT_ONLY=true
fi

if [ "$PRINT_ONLY" = false ] && [ "$(hostname)" != "Frostburn" ]; then
    echo "decision-build-image.sh: refusing to build outside Frostburn (host: $(hostname))." >&2
    exit 1
fi

SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
IMAGE="localhost/laya-server:rocm-${SHORT_SHA}"
ARCHIVE="${NAS_ASSET_DIR}/laya-server-${SHORT_SHA}-rocm.oci.tar"
BUILD_CTX="$(mktemp -d "${TMPDIR:-/tmp}/laya-build-ctx.XXXXXX")"
trap 'rm -rf "$BUILD_CTX"' EXIT

# Print a command's argv, shell-quoted, one line, instead of running it.
print_cmd() {
    printf '%q ' "$@"
    printf '\n'
}

echo "== fetch + checksum-verify the pinned laya-server source =="
if [ "$PRINT_ONLY" = true ]; then
    print_cmd curl -fsSL -o "$BUILD_CTX/laya-src.tar.gz" "$LAYA_SRC_URL"
    echo "printf '%s  %s\\n' '$LAYA_SRC_SHA256' '$BUILD_CTX/laya-src.tar.gz' | sha256sum -c -"
    print_cmd tar -xzf "$BUILD_CTX/laya-src.tar.gz" -C "$BUILD_CTX" --strip-components=1 \
        "laya-server-${LAYA_SERVER_SHA}/server.py" "laya-server-${LAYA_SERVER_SHA}/check_gpu.py" \
        "laya-server-${LAYA_SERVER_SHA}/requirements.txt"
else
    curl -fsSL -o "$BUILD_CTX/laya-src.tar.gz" "$LAYA_SRC_URL"
    printf '%s  %s\n' "$LAYA_SRC_SHA256" "$BUILD_CTX/laya-src.tar.gz" | sha256sum -c -
    tar -xzf "$BUILD_CTX/laya-src.tar.gz" -C "$BUILD_CTX" --strip-components=1 \
        "laya-server-${LAYA_SERVER_SHA}/server.py" "laya-server-${LAYA_SERVER_SHA}/check_gpu.py" \
        "laya-server-${LAYA_SERVER_SHA}/requirements.txt"
fi

echo "== build $IMAGE from $CONTAINERFILE =="
if [ "$PRINT_ONLY" = true ]; then
    print_cmd podman build -f "$CONTAINERFILE" -t "$IMAGE" "$BUILD_CTX"
else
    podman build -f "$CONTAINERFILE" -t "$IMAGE" "$BUILD_CTX"
fi

echo "== verify the gfx1151 iGPU is actually used =="
if [ "$PRINT_ONLY" = true ]; then
    print_cmd podman run --rm "${GPU_ARGS[@]}" "$IMAGE" python check_gpu.py
else
    GPU_OUTPUT="$(podman run --rm "${GPU_ARGS[@]}" "$IMAGE" python check_gpu.py)"
    echo "$GPU_OUTPUT"
    case "$GPU_OUTPUT" in
        *gfx1151*) ;;
        *)
            echo "decision-build-image.sh: check_gpu.py did not report gfx1151" >&2
            exit 1
            ;;
    esac
fi

echo "== export a zstd OCI archive to the NAS asset mirror =="
if [ "$PRINT_ONLY" = true ]; then
    print_cmd podman push --compression-format zstd --force-compression "$IMAGE" "oci-archive:$ARCHIVE"
else
    podman push --compression-format zstd --force-compression "$IMAGE" "oci-archive:$ARCHIVE"
fi

echo "== summary =="
if [ "$PRINT_ONLY" = true ]; then
    print_cmd podman image inspect --format '{{.Id}} {{.Size}}' "$IMAGE"
    print_cmd sha256sum "$ARCHIVE"
else
    IMAGE_ID="$(podman image inspect --format '{{.Id}}' "$IMAGE")"
    IMAGE_SIZE="$(podman image inspect --format '{{.Size}}' "$IMAGE")"
    ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
    ARCHIVE_SIZE="$(stat -c%s "$ARCHIVE")"
    printf 'image=%s\nimage_id=%s\nimage_size_bytes=%s\narchive=%s\narchive_sha256=%s\narchive_size_bytes=%s\n' \
        "$IMAGE" "$IMAGE_ID" "$IMAGE_SIZE" "$ARCHIVE" "$ARCHIVE_SHA256" "$ARCHIVE_SIZE"
fi
