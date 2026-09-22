#!/bin/bash
# Llama Manager — decision engine build script dry-run tests.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Verifies `scripts/decision-build-image.sh --print` emits the expected
# fetch/checksum, `podman build`, gfx1151-verification, `podman push` (zstd OCI
# archive to the NAS asset mirror) and summary commands WITHOUT running any of
# them — no podman, network access, or Frostburn GPU required. Also checks the
# script refuses to actually build outside Frostburn.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/decision-build-image.sh"
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/decision-build-results.XXXXXX")"
PASS_FILE="$RESULTS_DIR/pass"
FAIL_FILE="$RESULTS_DIR/fail"
: > "$PASS_FILE"
: > "$FAIL_FILE"

# Assert a string contains a fixed substring. Args: description, haystack, needle.
assert_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if [ "${haystack#*"$needle"}" != "$haystack" ]; then
        printf P >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf F >> "$FAIL_FILE"; printf '  FAIL %s\n       missing: %s\n' "$desc" "$needle"
    fi
}

# Assert a numeric equality. Args: description, expected, actual.
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf P >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf F >> "$FAIL_FILE"; printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$desc" "$expected" "$actual"
    fi
}

if [ ! -x "$SCRIPT" ]; then
    echo "FAIL scripts/decision-build-image.sh does not exist or is not executable"
    exit 1
fi

PRINT_OUTPUT="$("$SCRIPT" --print)"
PRINT_STATUS=$?
assert_eq "--print exits 0" "0" "$PRINT_STATUS"
assert_contains "fetches the pinned laya-server tarball" "$PRINT_OUTPUT" \
    "curl -fsSL -o "
assert_contains "fetch URL pins the commit AMENDMENT A3 names" "$PRINT_OUTPUT" \
    "https://github.com/noahbclarkson/laya-server/archive/819fa065dce72b3c117a2364bb4839c02a0abcb3.tar.gz"
assert_contains "verifies the tarball checksum before use" "$PRINT_OUTPUT" "sha256sum -c -"
assert_contains "extracts only the three files the Containerfile COPYs" "$PRINT_OUTPUT" \
    "laya-server-819fa065dce72b3c117a2364bb4839c02a0abcb3/server.py"
assert_contains "builds the pinned Containerfile" "$PRINT_OUTPUT" "podman build -f"
assert_contains "builds from packaging/decision/Containerfile" "$PRINT_OUTPUT" \
    "packaging/decision/Containerfile"
assert_contains "tags the image localhost/laya-server:rocm-<sha>" "$PRINT_OUTPUT" \
    "localhost/laya-server:rocm-"
assert_contains "runs check_gpu.py to verify the GPU is actually used" "$PRINT_OUTPUT" \
    "python check_gpu.py"
assert_contains "passes the ROCm gfx1151 override from the T0 spike" "$PRINT_OUTPUT" \
    "HSA_OVERRIDE_GFX_VERSION=11.5.1"
assert_contains "passes the kfd/dri device flags" "$PRINT_OUTPUT" "/dev/kfd"
assert_contains "exports a zstd-compressed OCI archive" "$PRINT_OUTPUT" \
    "podman push --compression-format zstd --force-compression"
assert_contains "archive lands on the NAS asset mirror" "$PRINT_OUTPUT" \
    "oci-archive:/volumes/llama-manager/assets/laya/laya-server-"
assert_contains "archive name carries the -rocm.oci.tar suffix" "$PRINT_OUTPUT" "-rocm.oci.tar"
assert_contains "prints the image id and size" "$PRINT_OUTPUT" "podman image inspect --format"
assert_contains "prints the archive sha256" "$PRINT_OUTPUT" "sha256sum "

# --print must be a pure dry run: it must not shell out to podman or curl.
FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/decision-build-fakebin.XXXXXX")"
for tool in podman curl; do
    cat > "$FAKE_BIN/$tool" <<EOF
#!/bin/sh
echo "UNEXPECTED-INVOCATION: $tool \$*" >&2
exit 99
EOF
    chmod +x "$FAKE_BIN/$tool"
done
PRINT_NO_TOOLS_STATUS=0
PATH="$FAKE_BIN:$PATH" "$SCRIPT" --print > "$RESULTS_DIR/no-tools-out" 2> "$RESULTS_DIR/no-tools-err" || PRINT_NO_TOOLS_STATUS=$?
assert_eq "--print still exits 0 with podman/curl shadowed by failing stubs" "0" "$PRINT_NO_TOOLS_STATUS"
if grep -q "UNEXPECTED-INVOCATION" "$RESULTS_DIR/no-tools-err" 2>/dev/null; then
    printf F >> "$FAIL_FILE"; printf '  FAIL --print invoked a real tool: %s\n' "$(cat "$RESULTS_DIR/no-tools-err")"
else
    printf P >> "$PASS_FILE"; printf '  ok   --print never shells out to podman or curl\n'
fi
rm -rf "$FAKE_BIN"

# Refuses to actually build off Frostburn (only checked when NOT printing).
if [ "$(hostname)" != "Frostburn" ]; then
    REAL_STATUS=0
    "$SCRIPT" > "$RESULTS_DIR/real-out" 2> "$RESULTS_DIR/real-err" || REAL_STATUS=$?
    if [ "$REAL_STATUS" -ne 0 ] && grep -q "refusing to build outside Frostburn" "$RESULTS_DIR/real-err"; then
        printf P >> "$PASS_FILE"; printf '  ok   refuses a real build off Frostburn\n'
    else
        printf F >> "$FAIL_FILE"; printf '  FAIL did not refuse a real build off Frostburn (status=%s)\n' "$REAL_STATUS"
    fi
else
    printf P >> "$PASS_FILE"; printf '  ok   (skipped Frostburn-refusal check: this IS Frostburn)\n'
fi

pass_count=$(wc -c < "$PASS_FILE")
fail_count=$(wc -c < "$FAIL_FILE")
echo
echo "decision build-image dry-run tests: $pass_count passed, $fail_count failed"
rm -rf "$RESULTS_DIR"
[ "$fail_count" -eq 0 ]
