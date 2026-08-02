#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Hermetic integration tests for live release-tree synchronization. The tests
# exercise successful payload-first publication and an interrupted payload pass,
# proving inactive history is not retransmitted and existing live symlinks remain
# on the last-known-good snapshots until every new referent is complete.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYNC_SCRIPT="$ROOT_DIR/distribution/release-service/sync-public-tree.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/release-sync-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

# Records whether two string values are equal without stopping later checks.
assert_eq() {
  local description="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '  ok   %s\n' "$description"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' \
      "$description" "$expected" "$actual"
  fi
}

# Records whether a path does not exist, including as a dangling symlink.
assert_absent() {
  local description="$1" path="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '  ok   %s\n' "$description"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  FAIL %s\n       unexpected path: %s\n' "$description" "$path"
  fi
}

# Creates local and live trees with old, new, and inactive historical snapshots.
make_fixture() {
  local fixture="$1" source="$fixture/source" live="$fixture/live"
  mkdir -p \
    "$source/releases/apt/new-apt/dists/noble" \
    "$source/releases/apt/pruned-apt" \
    "$source/releases/images/new-images" \
    "$source/releases/images/pruned-images" \
    "$live/releases/apt/old-apt/dists/noble" \
    "$live/releases/images/old-images"

  printf 'new apt metadata\n' > "$source/releases/apt/new-apt/dists/noble/InRelease"
  printf 'inactive apt history\n' > "$source/releases/apt/pruned-apt/InRelease"
  printf 'new checksum\n' > "$source/releases/images/new-images/SHA256SUMS"
  printf 'new image bytes\n' > "$source/releases/images/new-images/appliance.iso"
  printf 'inactive image history\n' > "$source/releases/images/pruned-images/appliance.iso"
  printf 'old apt metadata\n' > "$live/releases/apt/old-apt/dists/noble/InRelease"
  printf 'old checksum\n' > "$live/releases/images/old-images/SHA256SUMS"
  printf 'old image bytes\n' > "$live/releases/images/old-images/appliance.iso"

  ln -s releases/apt/new-apt "$source/apt"
  ln -s releases/images/new-images "$source/images"
  ln -s releases/apt/old-apt "$live/apt"
  ln -s releases/images/old-images "$live/images"
}

# Verifies a complete sync transfers active snapshots before switching pointers.
test_successful_atomic_publication() {
  local fixture="$TEST_ROOT/success"
  make_fixture "$fixture"

  "$SYNC_SCRIPT" "$fixture/source" "$fixture/live"

  assert_eq "APT pointer activates the complete snapshot" \
    "releases/apt/new-apt" "$(readlink "$fixture/live/apt")"
  assert_eq "image pointer activates the complete snapshot" \
    "releases/images/new-images" "$(readlink "$fixture/live/images")"
  assert_eq "new manifest and image are published together" \
    $'new checksum\nnew image bytes' \
    "$(printf '%s\n' "$(cat "$fixture/live/images/SHA256SUMS")" "$(cat "$fixture/live/images/appliance.iso")")"
  assert_absent "pruned APT history is not retransmitted" \
    "$fixture/live/releases/apt/pruned-apt"
  assert_absent "pruned image history is not retransmitted" \
    "$fixture/live/releases/images/pruned-images"
}

# Verifies a failure after one payload transfer leaves every live pointer intact.
test_interrupted_payload_preserves_live_release() {
  local fixture="$TEST_ROOT/interrupted"
  local wrapper="$fixture/rsync-wrapper"
  make_fixture "$fixture"

  cat > "$wrapper" <<'EOF'
#!/usr/bin/env bash
# Test-only rsync wrapper: complete one payload transfer, then simulate a lost
# connection before the remaining payload and activation phases can run.
set -euo pipefail
count_file="${RSYNC_CALL_COUNT_FILE:?}"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
[ "$count" -lt 2 ] || exit 75
exec /usr/bin/rsync "$@"
EOF
  chmod +x "$wrapper"

  if RSYNC_BIN="$wrapper" RSYNC_CALL_COUNT_FILE="$fixture/rsync-count" \
      "$SYNC_SCRIPT" "$fixture/source" "$fixture/live"; then
    assert_eq "interrupted sync reports failure" "nonzero" "zero"
  else
    assert_eq "interrupted sync reports failure" "nonzero" "nonzero"
  fi

  assert_eq "interruption preserves the old APT pointer" \
    "releases/apt/old-apt" "$(readlink "$fixture/live/apt")"
  assert_eq "interruption preserves the old image pointer" \
    "releases/images/old-images" "$(readlink "$fixture/live/images")"
  assert_eq "old image remains available after interruption" \
    "old image bytes" "$(cat "$fixture/live/images/appliance.iso")"
}

printf 'Release sync integration tests\n'
test_successful_atomic_publication
test_interrupted_payload_preserves_live_release

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
