#!/bin/bash
# Llama Manager — boot-time node identity resolution tests.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# This dependency-free harness verifies scripts/llama-manager-identity, the
# root-run step that decides what an appliance calls itself before the manager
# starts. It proves the resolution order (persistent state, then the live USB's
# writable partition, then the bootstrap name), that a live boot's chosen name is
# carried back onto the writable partition so it survives the RAM overlay, that a
# corrupt or empty store degrades to a reachable name instead of an empty
# hostname, and that a failure to apply the hostname never fails the unit and so
# never blocks the manager from starting.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IDENTITY="$REPO_ROOT/scripts/llama-manager-identity"
failures=0

assert_equals() {
  local description="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s (expected %q, got %q)\n' "$description" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

assert_absent() {
  local description="$1" path="$2"
  if [[ -e "$path" ]]; then
    printf '  FAIL %s (%q exists)\n' "$description" "$path"
    failures=$((failures + 1))
  else
    printf '  ok   %s\n' "$description"
  fi
}

# Builds a sandbox holding a fake hostnamectl that records the name it was asked
# to set, and exports the whole environment the script reads. Every test runs
# against this rather than the real machine's hostname.
#
# $1 current hostname reported by the fake hostnamectl
# $2 optional mirror directory standing in for the mounted writable partition
new_sandbox() {
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/llama-identity-test.XXXXXX")"
  mkdir -p "$SANDBOX/bin" "$SANDBOX/state"
  printf '%s\n' "$1" > "$SANDBOX/current-hostname"
  cat > "$SANDBOX/bin/hostnamectl" <<'FAKE'
#!/bin/bash
# Llama Manager — test double recording hostname changes.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
if [[ "${1:-}" == "hostname" ]]; then cat "$SANDBOX/current-hostname"; exit 0; fi
if [[ "${1:-}" == "set-hostname" ]]; then
  [[ -f "$SANDBOX/hostnamectl-fails" ]] && exit 1
  printf '%s\n' "$2" >> "$SANDBOX/set-hostname-calls"
  printf '%s\n' "$2" > "$SANDBOX/current-hostname"
  exit 0
fi
exit 1
FAKE
  chmod +x "$SANDBOX/bin/hostnamectl"

  cat > "$SANDBOX/bin/chown" <<'FAKE'
#!/bin/bash
# Llama Manager — test double recording ownership changes.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
printf '%s\n' "$*" >> "$SANDBOX/chown-calls"
FAKE
  chmod +x "$SANDBOX/bin/chown"

  printf '127.0.0.1\tlocalhost\n127.0.1.1\t%s\n::1\tip6-localhost\n' "$1" \
    > "$SANDBOX/hosts"

  export SANDBOX
  export LLAMA_MANAGER_HOSTS_FILE="$SANDBOX/hosts"
  export LLAMA_MANAGER_CHOWN="$SANDBOX/bin/chown"
  export LLAMA_MANAGER_HOSTNAMECTL="$SANDBOX/bin/hostnamectl"
  export LLAMA_MANAGER_NODE_NAME_FILE="$SANDBOX/state/node-name"
  if [[ -n "${2:-}" ]]; then
    mkdir -p "$SANDBOX/$2"
    export LLAMA_MANAGER_NODE_NAME_MIRROR="$SANDBOX/$2/node-name"
  else
    export LLAMA_MANAGER_NODE_NAME_MIRROR=""
  fi
}

drop_sandbox() {
  rm -rf "$SANDBOX"
  unset SANDBOX LLAMA_MANAGER_CHOWN LLAMA_MANAGER_HOSTNAMECTL \
    LLAMA_MANAGER_HOSTS_FILE LLAMA_MANAGER_NODE_NAME_FILE \
    LLAMA_MANAGER_NODE_NAME_MIRROR
}

# Records the hostname the script settled on, so a test can assert what avahi
# would end up publishing.
applied_hostname() {
  "$SANDBOX/bin/hostnamectl" hostname
}

test_unnamed_node_is_addressable_immediately() {
  printf 'test_unnamed_node_is_addressable_immediately\n'
  new_sandbox llama
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "an unnamed node reports the bootstrap name" "$("$IDENTITY" show 2>/dev/null)" "setup"
  assert_equals "an unnamed node is reachable at setup-llama-manager" "$(applied_hostname)" "setup-llama-manager"
  drop_sandbox
}

test_persistent_state_names_the_node() {
  printf 'test_persistent_state_names_the_node\n'
  new_sandbox llama
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the stored name becomes the hostname" "$(applied_hostname)" "nebula-llama-manager"
  drop_sandbox
}

test_live_boot_recovers_its_name_from_the_writable_partition() {
  printf 'test_live_boot_recovers_its_name_from_the_writable_partition\n'
  new_sandbox llama writable
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_MIRROR"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a live boot re-adopts the name it was given" "$(applied_hostname)" "nebula-llama-manager"
  assert_equals "the name is restored into the RAM overlay's state" \
    "$(cat "$LLAMA_MANAGER_NODE_NAME_FILE")" "nebula"
  drop_sandbox
}

test_state_written_by_the_manager_wins_over_the_mirror() {
  printf 'test_state_written_by_the_manager_wins_over_the_mirror\n'
  new_sandbox llama writable
  printf 'stale\n' > "$LLAMA_MANAGER_NODE_NAME_MIRROR"
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a freshly chosen name is applied, not the mirror" \
    "$(applied_hostname)" "nebula-llama-manager"
  assert_equals "the mirror is brought forward for the next boot" \
    "$(cat "$LLAMA_MANAGER_NODE_NAME_MIRROR")" "nebula"
  drop_sandbox
}

test_installed_disk_needs_no_writable_partition() {
  printf 'test_installed_disk_needs_no_writable_partition\n'
  new_sandbox llama
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "an installed disk still names itself" "$(applied_hostname)" "nebula-llama-manager"
  assert_absent "no mirror is invented where there is no writable partition" \
    "$SANDBOX/writable"
  drop_sandbox
}

test_a_corrupt_store_never_yields_an_empty_hostname() {
  printf 'test_a_corrupt_store_never_yields_an_empty_hostname\n'
  new_sandbox llama
  printf '!!!\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "unusable stored text falls back to the bootstrap name" \
    "$(applied_hostname)" "setup-llama-manager"
  drop_sandbox

  new_sandbox llama
  : > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "an empty store falls back to the bootstrap name" \
    "$(applied_hostname)" "setup-llama-manager"
  drop_sandbox
}

test_stored_text_is_re_normalized_before_it_is_published() {
  printf 'test_stored_text_is_re_normalized_before_it_is_published\n'
  new_sandbox llama
  printf '  Neb ULA!! \n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "hand-edited state is folded to a legal label" \
    "$(applied_hostname)" "neb-ula-llama-manager"
  drop_sandbox
}

test_an_already_correct_hostname_is_left_alone() {
  printf 'test_an_already_correct_hostname_is_left_alone\n'
  new_sandbox nebula-llama-manager
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_absent "avahi is not churned when nothing changed" "$SANDBOX/set-hostname-calls"
  drop_sandbox
}

test_state_stays_writable_by_the_manager_account() {
  printf 'test_state_stays_writable_by_the_manager_account\n'
  new_sandbox llama
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "root hands the store back to the service account" \
    "$(cat "$SANDBOX/chown-calls" 2>/dev/null)" \
    "llama-manager:llama-manager $LLAMA_MANAGER_NODE_NAME_FILE"
  drop_sandbox
}

test_the_node_can_still_resolve_its_own_name() {
  printf 'test_the_node_can_still_resolve_its_own_name\n'
  new_sandbox llama
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the loopback alias follows the hostname" \
    "$(awk '$1 == "127.0.1.1" { print $2 }' "$LLAMA_MANAGER_HOSTS_FILE")" \
    "nebula-llama-manager"
  assert_equals "the rest of the hosts file is left alone" \
    "$(awk '$1 == "127.0.0.1" { print $2 }' "$LLAMA_MANAGER_HOSTS_FILE")" \
    "localhost"
  assert_equals "no duplicate loopback alias is left behind" \
    "$(grep -c '^127.0.1.1' "$LLAMA_MANAGER_HOSTS_FILE")" "1"
  drop_sandbox
}

test_a_missing_loopback_alias_is_added() {
  printf 'test_a_missing_loopback_alias_is_added\n'
  new_sandbox llama
  printf '127.0.0.1\tlocalhost\n' > "$LLAMA_MANAGER_HOSTS_FILE"
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a hosts file with no alias gains one" \
    "$(awk '$1 == "127.0.1.1" { print $2 }' "$LLAMA_MANAGER_HOSTS_FILE")" \
    "nebula-llama-manager"
  drop_sandbox
}

test_a_hostname_failure_never_blocks_the_manager() {
  printf 'test_a_hostname_failure_never_blocks_the_manager\n'
  new_sandbox llama
  : > "$SANDBOX/hostnamectl-fails"
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the identity unit succeeds even when the hostname cannot be set" "$?" "0"
  drop_sandbox
}

test_unnamed_node_is_addressable_immediately
test_persistent_state_names_the_node
test_live_boot_recovers_its_name_from_the_writable_partition
test_state_written_by_the_manager_wins_over_the_mirror
test_installed_disk_needs_no_writable_partition
test_a_corrupt_store_never_yields_an_empty_hostname
test_stored_text_is_re_normalized_before_it_is_published
test_an_already_correct_hostname_is_left_alone
test_state_stays_writable_by_the_manager_account
test_the_node_can_still_resolve_its_own_name
test_a_missing_loopback_alias_is_added
test_a_hostname_failure_never_blocks_the_manager

if ((failures > 0)); then
  printf '\nFAIL: %d node identity assertion(s) failed\n' "$failures"
  exit 1
fi
printf '\nPASS: boot-time node identity resolution\n'
