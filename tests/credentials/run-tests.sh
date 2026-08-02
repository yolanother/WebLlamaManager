#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Hermetic integration tests for runtime credential delivery. A fake Distrobox
# records launcher arguments so sentinel secrets can be proven absent from argv
# while still reaching protected env files for router and embedding runtimes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/credential-argv-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS_COUNT=0
FAIL_COUNT=0
SENTINEL='hf_sentinel_must_never_reach_argv_42'

# Records whether a string contains an expected literal substring.
assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS_COUNT=$((PASS_COUNT + 1)); printf '  ok   %s\n' "$description"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  FAIL %s\n' "$description"
  fi
}

# Records whether a string omits a forbidden literal substring.
assert_not_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  FAIL %s\n' "$description"
  else
    PASS_COUNT=$((PASS_COUNT + 1)); printf '  ok   %s\n' "$description"
  fi
}

# Records whether two string values are equal.
assert_eq() {
  local description="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS_COUNT=$((PASS_COUNT + 1)); printf '  ok   %s\n' "$description"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' \
      "$description" "$expected" "$actual"
  fi
}

# Creates isolated launcher copies and a Distrobox replacement that logs argv
# plus whether Distrobox inherited the raw credential from the host environment.
make_fixture() {
  local fixture="$1"
  mkdir -p "$fixture/launchers/scripts" "$fixture/runtime"
  cp "$REPO_ROOT/start-llama.sh" "$fixture/launchers/start-llama.sh"
  cp "$REPO_ROOT/start-embed.sh" "$fixture/launchers/start-embed.sh"
  [ ! -f "$REPO_ROOT/scripts/runtime-credentials.sh" ] \
    || cp "$REPO_ROOT/scripts/runtime-credentials.sh" "$fixture/launchers/scripts/runtime-credentials.sh"

  cat > "$fixture/distrobox" <<'EOF'
#!/usr/bin/env bash
# Test-only Distrobox replacement that records one argument per line.
set -euo pipefail
: "${DISTROBOX_ARGV_LOG:?}"
printf '%s\n' "$@" > "$DISTROBOX_ARGV_LOG"
if [ "${1:-}" = enter ]; then
  : "${DISTROBOX_ENV_LOG:?}"
  if [ "${HF_TOKEN+x}" = x ]; then
    printf 'set\n' > "$DISTROBOX_ENV_LOG"
  else
    printf 'unset\n' > "$DISTROBOX_ENV_LOG"
  fi
fi
if [ "${1:-}" = list ]; then
  printf '| 000000000000 | credential-test | running | test |\n'
fi
EOF
  chmod +x "$fixture/distrobox"
}

# Runs one launcher and verifies the secret travels by protected file, not argv.
test_launcher() {
  local name="$1"
  local fixture="$TEST_ROOT/$name" launcher
  local model_args=()
  make_fixture "$fixture"
  launcher="$fixture/launchers/start-$name.sh"
  if [ "$name" = embed ]; then
    model_args=(EMBED_MODEL=/models/embed.gguf EMBED_PORT=5252)
  fi

  set +e
  env \
    DISTROBOX_BIN="$fixture/distrobox" \
    DISTROBOX_ARGV_LOG="$fixture/argv" \
    DISTROBOX_ENV_LOG="$fixture/environment" \
    DISTROBOX_CONTAINER=credential-test \
    XDG_RUNTIME_DIR="$fixture/runtime" \
    HF_TOKEN="$SENTINEL" \
    "${model_args[@]}" \
    bash "$launcher" > "$fixture/output" 2>&1
  local status=$?
  set -e

  assert_eq "$name launcher uses the injected runtime" "0" "$status"
  local argv=''
  [ ! -f "$fixture/argv" ] || argv="$(cat "$fixture/argv")"
  assert_not_contains "$name argv omits the credential" "$argv" "$SENTINEL"
  assert_contains "$name argv uses an env file" "$argv" "--env-file"
  assert_eq "$name Distrobox environment omits the credential" "unset" \
    "$(cat "$fixture/environment" 2>/dev/null || true)"

  local credential_file="$fixture/runtime/llama-manager/$name.env"
  assert_eq "$name credential file mode" "600" \
    "$(stat -c '%a' "$credential_file" 2>/dev/null || true)"
  assert_eq "$name credential reaches protected file" "HF_TOKEN=$SENTINEL" \
    "$(cat "$credential_file" 2>/dev/null || true)"
}

# Verifies the systemd installer writes a protected file and references only it.
test_service_credentials() {
  local fixture="$TEST_ROOT/service" credential_file="$TEST_ROOT/service/credentials.env"
  mkdir -p "$fixture"
  (
    EMBED_SEED_LIB=1 . "$REPO_ROOT/install.sh"
    write_service_credentials "$credential_file" "$SENTINEL"
  )

  assert_eq "service credential file mode" "600" "$(stat -c '%a' "$credential_file")"
  assert_eq "service credential reaches protected file" "HF_TOKEN=$SENTINEL" \
    "$(cat "$credential_file")"
  local installer
  installer="$(cat "$REPO_ROOT/install.sh")"
  assert_not_contains "systemd unit omits raw HF_TOKEN assignment" \
    "$installer" 'Environment=HF_TOKEN='
  assert_contains "systemd unit references protected EnvironmentFile" \
    "$installer" 'EnvironmentFile=-$CREDENTIAL_ENV'
}

printf 'Runtime credential argv tests\n'
test_launcher llama
test_launcher embed
test_service_credentials

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
