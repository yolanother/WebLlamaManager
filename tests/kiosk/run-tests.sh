#!/bin/bash
# Llama Manager — Kiosk test harness.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Dependency-free bash test runner for the kiosk feature. Sources
# scripts/lib/kiosk-common.sh inside a throwaway sandbox (KIOSK_ROOT) and
# asserts behavior of the pure helpers plus the installer's --dry-run path.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Counters live in files, not shell variables: the test functions below run
# their bodies inside subshells (for environment isolation), and variable
# increments inside a subshell would not propagate back to the parent. Each
# assertion appends one byte to a pass/fail file; the parent tallies at the end.
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kiosk-results.XXXXXX")"
PASS_FILE="$RESULTS_DIR/pass"
FAIL_FILE="$RESULTS_DIR/fail"
: > "$PASS_FILE"
: > "$FAIL_FILE"

# Assert string equality. Args: description, expected, actual.
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$desc" "$expected" "$actual"
    fi
}

# Assert a file exists. Args: description, path.
assert_file() {
    local desc="$1" path="$2"
    if [ -f "$path" ]; then printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       missing file: %s\n' "$desc" "$path"; fi
}

# Assert a file does NOT exist. Args: description, path.
assert_no_file() {
    local desc="$1" path="$2"
    if [ ! -e "$path" ]; then printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       file should not exist: %s\n' "$desc" "$path"; fi
}

# Fresh sandbox dir for a test. Echoes the path.
new_sandbox() { mktemp -d "${TMPDIR:-/tmp}/kiosk-test.XXXXXX"; }

test_url_resolution() {
    printf 'test_url_resolution\n'
    ( # subshell so KIOSK_URL/env don't leak
      unset KIOSK_URL
      source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb; sb="$(new_sandbox)"

      # No .env -> default port 3001
      assert_eq "default url" "http://localhost:3001" "$(kiosk_resolve_url "$sb/none.env")"

      # API_PORT in .env -> default host, that port
      printf 'API_PORT=4444\n' > "$sb/a.env"
      assert_eq "url from API_PORT" "http://localhost:4444" "$(kiosk_resolve_url "$sb/a.env")"

      # Explicit KIOSK_URL in .env wins over API_PORT
      printf 'API_PORT=4444\nKIOSK_URL=http://dash.local:9000/\n' > "$sb/b.env"
      assert_eq "url from KIOSK_URL" "http://dash.local:9000/" "$(kiosk_resolve_url "$sb/b.env")"

      # KIOSK_URL env var beats everything
      KIOSK_URL="http://override:1" assert_eq "env override" "http://override:1" "$(KIOSK_URL=http://override:1 kiosk_resolve_url "$sb/b.env")"
      rm -rf "$sb"
    )
}

test_manifest() {
    printf 'test_manifest\n'
    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb; sb="$(new_sandbox)"; export KIOSK_ROOT="$sb"

      # Missing key -> empty
      assert_eq "missing key empty" "" "$(kiosk_manifest_get foo)"

      # Set then get
      kiosk_manifest_set foo bar
      assert_eq "get after set" "bar" "$(kiosk_manifest_get foo)"
      assert_file "manifest created" "$(kiosk_manifest_path)"

      # Replace existing key (no duplicate lines)
      kiosk_manifest_set foo baz
      assert_eq "get after replace" "baz" "$(kiosk_manifest_get foo)"
      assert_eq "single line for key" "1" "$(grep -c '^foo=' "$(kiosk_manifest_path)")"

      # Value may contain '=' and spaces
      kiosk_manifest_set url "http://x:1/?a=b c"
      assert_eq "value with = and space" "http://x:1/?a=b c" "$(kiosk_manifest_get url)"
      rm -rf "$sb"
    )
}

test_backup() {
    printf 'test_backup\n'
    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb; sb="$(new_sandbox)"; export KIOSK_ROOT="$sb"

      # Source file exists -> backed up, manifest records existed=true
      mkdir -p "$(dirname "$(kiosk_path /etc/gdm3/custom.conf)")"
      printf 'ORIGINAL\n' > "$(kiosk_path /etc/gdm3/custom.conf)"
      kiosk_backup_file gdm_custom_conf /etc/gdm3/custom.conf
      assert_file "backup written" "$(kiosk_path /var/backups/llama-kiosk/gdm_custom_conf)"
      assert_eq "existed=true" "true" "$(kiosk_manifest_get backup.gdm_custom_conf.existed)"
      assert_eq "path recorded" "/etc/gdm3/custom.conf" "$(kiosk_manifest_get backup.gdm_custom_conf.path)"

      # Mutate source, back up again -> pristine backup preserved (idempotent)
      printf 'CHANGED\n' > "$(kiosk_path /etc/gdm3/custom.conf)"
      kiosk_backup_file gdm_custom_conf /etc/gdm3/custom.conf
      assert_eq "backup still pristine" "ORIGINAL" "$(cat "$(kiosk_path /var/backups/llama-kiosk/gdm_custom_conf)")"

      # Missing source -> existed=false, no backup file
      kiosk_backup_file accountsservice /var/lib/AccountsService/users/tester
      assert_eq "existed=false" "false" "$(kiosk_manifest_get backup.accountsservice.existed)"
      assert_no_file "no backup for missing src" "$(kiosk_path /var/backups/llama-kiosk/accountsservice)"

      # Dry-run mutating command changes nothing
      export KIOSK_DRY_RUN=true
      kiosk_run touch "$sb/should-not-exist"
      assert_no_file "dry-run no write" "$sb/should-not-exist"
      export KIOSK_DRY_RUN=false
      rm -rf "$sb"
    )
}

test_cli() {
    printf 'test_cli\n'
    local out
    # --help exits 0 and mentions both subcommands
    out="$(bash "$REPO_ROOT/scripts/install-kiosk.sh" --help 2>&1)"; local rc=$?
    assert_eq "help exit 0" "0" "$rc"
    assert_eq "help mentions install" "yes" "$(printf '%s' "$out" | grep -q 'install' && echo yes || echo no)"
    assert_eq "help mentions uninstall" "yes" "$(printf '%s' "$out" | grep -q 'uninstall' && echo yes || echo no)"
    assert_eq "help mentions restart" "yes" "$(printf '%s' "$out" | grep -q 'restart' && echo yes || echo no)"

    # Unknown subcommand exits nonzero
    bash "$REPO_ROOT/scripts/install-kiosk.sh" frobnicate >/dev/null 2>&1
    assert_eq "unknown subcmd nonzero" "no" "$([ $? -eq 0 ] && echo yes || echo no)"

    # Dry-run install in a sandbox does not require root and writes nothing real
    local sb; sb="$(new_sandbox)"
    out="$(bash "$REPO_ROOT/scripts/install-kiosk.sh" install --dry-run --root "$sb" 2>&1)"; rc=$?
    assert_eq "dry-run install exit 0" "0" "$rc"
    assert_no_file "dry-run wrote no session file" "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"

    # Dry-run restart in a sandbox is a no-op that exits 0 (no display-manager touch)
    bash "$REPO_ROOT/scripts/install-kiosk.sh" restart --dry-run --root "$sb" >/dev/null 2>&1
    assert_eq "dry-run restart exit 0" "0" "$?"
    rm -rf "$sb"
}

test_url_resolution
test_manifest
test_backup
test_cli

# Tally the file-based counters in the parent shell and exit nonzero on any fail.
PASS=$(wc -c < "$PASS_FILE" | tr -d ' ')
FAIL=$(wc -c < "$FAIL_FILE" | tr -d ' ')
rm -rf "$RESULTS_DIR"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
