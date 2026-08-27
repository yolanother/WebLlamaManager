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
# never blocks the manager from starting. It also pins the --no-block on the avahi
# re-announcement, which is not a preference: this unit is ordered Before= avahi,
# so a blocking restart from inside it deadlocks systemd's transaction and leaves
# avahi stopped -- measured on a live appliance, not theorised.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IDENTITY="$REPO_ROOT/scripts/llama-manager-identity"
UNIT="$REPO_ROOT/llama-manager-identity.service"
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

  cat > "$SANDBOX/bin/systemctl" <<'FAKE'
#!/bin/bash
# Llama Manager — test double recording systemd requests.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
printf '%s\n' "$*" >> "$SANDBOX/systemctl-calls"
FAKE
  chmod +x "$SANDBOX/bin/systemctl"

  printf '127.0.0.1\tlocalhost\n127.0.1.1\t%s\n::1\tip6-localhost\n' "$1" \
    > "$SANDBOX/hosts"

  export SANDBOX
  export LLAMA_MANAGER_HOSTS_FILE="$SANDBOX/hosts"
  export LLAMA_MANAGER_CHOWN="$SANDBOX/bin/chown"
  export LLAMA_MANAGER_SYSTEMCTL="$SANDBOX/bin/systemctl"
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
  unset SANDBOX LLAMA_MANAGER_CHOWN LLAMA_MANAGER_SYSTEMCTL LLAMA_MANAGER_HOSTNAMECTL \
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

test_avahi_is_told_to_republish_after_a_rename() {
  printf 'test_avahi_is_told_to_republish_after_a_rename\n'
  new_sandbox llama
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a renamed node is re-announced over mDNS" \
    "$(cat "$SANDBOX/systemctl-calls" 2>/dev/null)" \
    "--no-block try-restart avahi-daemon.service"
  drop_sandbox
}

test_avahi_is_left_alone_when_the_name_did_not_change() {
  printf 'test_avahi_is_left_alone_when_the_name_did_not_change\n'
  new_sandbox nebula-llama-manager
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_absent "an unchanged name does not withdraw this node's mDNS records" \
    "$SANDBOX/systemctl-calls"
  drop_sandbox
}

test_the_mirror_is_written_at_the_partition_root() {
  printf 'test_the_mirror_is_written_at_the_partition_root\n'
  # Measured on real media: casper bind-mounts the writable partition into
  # /var/log and /var/crash from a subdirectory named for the boot date, so a
  # mirror written through an existing mount lands somewhere the next boot never
  # looks. This pins the partition being mounted at its own root instead.
  new_sandbox llama
  unset LLAMA_MANAGER_NODE_NAME_MIRROR
  export LLAMA_MANAGER_WRITABLE_DEVICE="$SANDBOX/bin/fake-device"
  export LLAMA_MANAGER_WRITABLE_MOUNT="$SANDBOX/writable-root"
  export LLAMA_MANAGER_MOUNT="$SANDBOX/bin/mount"
  export LLAMA_MANAGER_UMOUNT="$SANDBOX/bin/umount"
  cat > "$SANDBOX/bin/mount" <<'FAKE'
#!/bin/bash
# Llama Manager — test double standing in for mounting the writable partition.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
printf '%s\n' "$*" >> "$SANDBOX/mount-calls"
mkdir -p "$2"
FAKE
  cat > "$SANDBOX/bin/umount" <<'FAKE'
#!/bin/bash
# Llama Manager — test double recording the writable partition being released.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
printf '%s\n' "$*" >> "$SANDBOX/umount-calls"
FAKE
  chmod +x "$SANDBOX/bin/mount" "$SANDBOX/bin/umount"

  # A block device is what the resolver looks for; without one it must simply
  # decline to persist rather than guess at a path.
  "$IDENTITY" apply >/dev/null 2>&1
  assert_absent "no partition is mounted when the label resolves to nothing" \
    "$SANDBOX/mount-calls"

  # Now give it something that looks like the labelled partition. The stand-in
  # cannot be a real block device, so the resolver is pointed at /dev/zero.
  export LLAMA_MANAGER_WRITABLE_DEVICE=/dev/zero
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the partition is mounted at its own root" \
    "$(cat "$SANDBOX/mount-calls" 2>/dev/null)" \
    "/dev/zero $SANDBOX/writable-root"
  assert_equals "the mirror is written at the partition root" \
    "$(cat "$SANDBOX/writable-root/llama-manager/node-name" 2>/dev/null)" "nebula"
  assert_equals "the partition is released again" \
    "$(cat "$SANDBOX/umount-calls" 2>/dev/null)" "$SANDBOX/writable-root"

  unset LLAMA_MANAGER_WRITABLE_DEVICE LLAMA_MANAGER_WRITABLE_MOUNT \
    LLAMA_MANAGER_MOUNT LLAMA_MANAGER_UMOUNT
  drop_sandbox
}

test_avahi_does_not_publish_on_loopback() {
  printf 'test_avahi_does_not_publish_on_loopback\n'
  # MEASURED ON HARDWARE, where this silently broke the whole feature. avahi
  # joins mDNS on `lo` seconds before the real interface appears, publishes the
  # hostname there, then re-probes when eno1 comes up and CONFLICTS WITH ITS OWN
  # loopback record:
  #   Host name conflict, retrying with setup-llama-manager-2
  # The node was then reachable only at a name nobody would guess, while this
  # script reported "already published as setup-llama-manager.local" -- it checks
  # the SYSTEM HOSTNAME, not what avahi published. The /etc/hosts alias made
  # on-box getent succeed too, so every local check passed while remote
  # resolution failed. That is exactly how it survived a hardware verification.
  new_sandbox llama
  printf '[server]\nuse-ipv4=yes\n' > "$SANDBOX/avahi-daemon.conf"
  LLAMA_MANAGER_AVAHI_CONF="$SANDBOX/avahi-daemon.conf" "$IDENTITY" apply >/dev/null 2>&1
  if grep -qE '^deny-interfaces=([^=]*,)?lo(,[^=]*)?$' "$SANDBOX/avahi-daemon.conf"; then
    printf '  ok   avahi is told not to publish on loopback\n'
  else
    printf '  FAIL avahi still publishes on loopback; it will rename itself to -2\n'
    failures=$((failures + 1))
  fi
  drop_sandbox
}

test_an_operator_deny_list_is_extended_not_replaced() {
  printf 'test_an_operator_deny_list_is_extended_not_replaced\n'
  new_sandbox llama
  printf '[server]\ndeny-interfaces=docker0\n' > "$SANDBOX/avahi-daemon.conf"
  LLAMA_MANAGER_AVAHI_CONF="$SANDBOX/avahi-daemon.conf" "$IDENTITY" apply >/dev/null 2>&1
  if grep -qE '^deny-interfaces=.*docker0' "$SANDBOX/avahi-daemon.conf"; then
    printf '  ok   an existing deny-interfaces entry survives\n'
  else
    printf '  FAIL an operator deny-interfaces entry was discarded\n'
    failures=$((failures + 1))
  fi
  drop_sandbox
}

# AN INSTALLED DISK KEEPS THE NAME IT WAS INSTALLED WITH.
#
# subiquity writes /etc/hostname from the installer's identity page, but nothing
# in the install writes /var/lib/llama-manager/node-name, and the live USB's
# "writable" partition does not exist on an installed disk -- so both stores are
# empty on the very first boot after installation. Without a third source the
# bootstrap probe wins and the box renames ITSELF back to setup-llama-manager,
# discarding the name the operator chose and the address they were given.
#
# The running hostname is that third source. It is authoritative precisely
# because something already set it: the installer, an operator, a cloud image.
test_an_installed_disk_keeps_the_name_it_was_installed_with() {
  printf 'test_an_installed_disk_keeps_the_name_it_was_installed_with\n'
  new_sandbox dracmoreth-llama-manager
  # No node-name file and no mirror: exactly a freshly installed disk.
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the installed name is recovered from the hostname" \
    "$("$IDENTITY" show 2>/dev/null)" "dracmoreth"
  assert_equals "the box still answers where it was installed" \
    "$(applied_hostname)" "dracmoreth-llama-manager"
  # And it is persisted, so this recovery happens once rather than every boot.
  assert_equals "the recovered name is written to the store" \
    "$(cat "$LLAMA_MANAGER_NODE_NAME_FILE" 2>/dev/null)" "dracmoreth"
  drop_sandbox
}

# The recovery must not defeat the bootstrap collision probe. A box whose
# hostname is the bootstrap name has NOT been named by anyone -- treating it as
# a chosen name would pin every unconfigured box to "setup" and stop them
# stepping aside from each other.
test_a_bootstrap_hostname_is_not_a_chosen_name() {
  printf 'test_a_bootstrap_hostname_is_not_a_chosen_name\n'
  # A box already wearing a bootstrap VARIANT is the discriminating case: if the
  # hostname were mistaken for a chosen name the node would be pinned to
  # "setup-2" forever, never re-probing, even once the box it stepped aside from
  # is gone. Rejecting it sends the node back through the probe, which finds the
  # base name free and takes it.
  new_sandbox setup-2-llama-manager
  arm_collision_probe
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a bootstrap variant is re-probed, not pinned" \
    "$("$IDENTITY" show 2>/dev/null)" "setup"
  drop_sandbox
}

# Same for the variants the probe itself hands out.
test_a_bootstrap_variant_hostname_is_not_a_chosen_name() {
  printf 'test_a_bootstrap_variant_hostname_is_not_a_chosen_name\n'
  new_sandbox setup-3-llama-manager
  arm_collision_probe
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a setup-N box is still unnamed" \
    "$("$IDENTITY" show 2>/dev/null)" "setup"
  drop_sandbox
}

# A hostname that is not one of ours says nothing about what this node is
# called. Ubuntu's own <user>-<product> default lands here, and inventing a node
# name out of it would be worse than the bootstrap name.
test_a_foreign_hostname_is_not_mistaken_for_a_node_name() {
  printf 'test_a_foreign_hostname_is_not_mistaken_for_a_node_name\n'
  new_sandbox yolan-ubuntu
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "an unrelated hostname leaves the node unnamed" \
    "$("$IDENTITY" show 2>/dev/null)" "setup"
  drop_sandbox
}

# The stores still outrank the hostname: the manager and the live mirror are
# where a DELIBERATE name lives, and a stale hostname must not override one.
test_the_store_still_outranks_the_running_hostname() {
  printf 'test_the_store_still_outranks_the_running_hostname\n'
  new_sandbox stale-llama-manager
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the stored name wins over the running hostname" \
    "$("$IDENTITY" show 2>/dev/null)" "nebula"
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

test_the_unit_cannot_hold_mdns_hostage() {
  printf 'test_the_unit_cannot_hold_mdns_hostage\n'
  # Ordering identity before avahi is what stops avahi ever publishing the wrong
  # name at boot, but it also makes every avahi start wait on this unit. A bounded
  # start is what keeps a wedged resolver from costing the box mDNS entirely.
  local timeout
  timeout="$(grep -c '^TimeoutStartSec=' "$UNIT")"
  assert_equals "the identity unit bounds its own start" "$timeout" "1"
  local before
  before="$(grep -c '^Before=avahi-daemon.service' "$UNIT")"
  assert_equals "identity is published before avahi first announces it" "$before" "1"
}

# Installs a fake getent whose "taken" names are whatever is listed in
# $SANDBOX/taken-names, and which records every name it was asked about. Stands
# in for the mDNS lookup the bootstrap probe performs.
arm_collision_probe() {
  cat > "$SANDBOX/bin/getent" <<'FAKE'
#!/bin/bash
# Llama Manager — test double standing in for an mDNS hostname lookup.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
printf '%s\n' "$2" >> "$SANDBOX/getent-calls"
[[ -f "$SANDBOX/getent-fails" ]] && exit 1
if grep -qxF "$2" "$SANDBOX/taken-names" 2>/dev/null; then
  printf '192.168.1.50 %s\n' "$2"
  exit 0
fi
exit 2
FAKE
  chmod +x "$SANDBOX/bin/getent"
  : > "$SANDBOX/taken-names"
  export LLAMA_MANAGER_GETENT="$SANDBOX/bin/getent"
}

test_an_unclaimed_bootstrap_name_is_taken_as_is() {
  printf 'test_an_unclaimed_bootstrap_name_is_taken_as_is\n'
  new_sandbox llama
  arm_collision_probe
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the first box on the link keeps the memorable name" \
    "$(applied_hostname)" "setup-llama-manager"
  drop_sandbox
}

test_a_second_unconfigured_node_steps_aside() {
  printf 'test_a_second_unconfigured_node_steps_aside\n'
  # O1. Three boxes out of the same box of thumb drives all want
  # setup-llama-manager. Left alone, avahi renames the loser behind our back and
  # the node goes on believing it is called "setup" -- so it reports a URL that
  # reaches a DIFFERENT machine. The node probes and steps aside itself instead.
  new_sandbox llama
  arm_collision_probe
  printf 'setup-llama-manager.local\n' > "$SANDBOX/taken-names"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a taken bootstrap name is stepped over" \
    "$(applied_hostname)" "setup-2-llama-manager"
  assert_equals "and the node knows which name it actually took" \
    "$("$IDENTITY" show 2>/dev/null)" "setup-2"
  drop_sandbox
}

test_the_bootstrap_probe_keeps_stepping_until_it_finds_a_gap() {
  printf 'test_the_bootstrap_probe_keeps_stepping_until_it_finds_a_gap\n'
  new_sandbox llama
  arm_collision_probe
  printf 'setup-llama-manager.local\nsetup-2-llama-manager.local\n' \
    > "$SANDBOX/taken-names"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the third box lands on the third name" \
    "$(applied_hostname)" "setup-3-llama-manager"
  drop_sandbox
}

test_the_name_the_probe_settled_on_survives_the_next_boot() {
  printf 'test_the_name_the_probe_settled_on_survives_the_next_boot\n'
  new_sandbox llama writable
  arm_collision_probe
  printf 'setup-llama-manager.local\n' > "$SANDBOX/taken-names"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "the chosen name is persisted, not re-derived" \
    "$(cat "$LLAMA_MANAGER_NODE_NAME_FILE")" "setup-2"
  assert_equals "and is carried onto the writable partition" \
    "$(cat "$LLAMA_MANAGER_NODE_NAME_MIRROR")" "setup-2"
  drop_sandbox
}

test_a_named_node_is_never_probed() {
  printf 'test_a_named_node_is_never_probed\n'
  # The probe exists to break a tie between unconfigured boxes. An operator's
  # chosen name is not a tie, and renaming a node the operator named would be a
  # far worse failure than a duplicate.
  new_sandbox llama
  arm_collision_probe
  printf 'nebula-llama-manager.local\n' > "$SANDBOX/taken-names"
  printf 'nebula\n' > "$LLAMA_MANAGER_NODE_NAME_FILE"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a chosen name is published even when something else holds it" \
    "$(applied_hostname)" "nebula-llama-manager"
  assert_absent "and no probe is made at all" "$SANDBOX/getent-calls"
  drop_sandbox
}

test_a_node_does_not_step_aside_from_itself() {
  printf 'test_a_node_does_not_step_aside_from_itself\n'
  # A box that already answers to setup-llama-manager finds itself when it
  # probes. Reading that as a collision would rename the node on every single
  # boot, walking it up to setup-9 and changing its address each time.
  new_sandbox setup-llama-manager
  arm_collision_probe
  printf 'setup-llama-manager.local\n' > "$SANDBOX/taken-names"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a node keeps the bootstrap name it already publishes" \
    "$(applied_hostname)" "setup-llama-manager"
  drop_sandbox
}

test_a_probe_that_fails_still_leaves_the_node_named() {
  printf 'test_a_probe_that_fails_still_leaves_the_node_named\n'
  # No resolver, no network, or a wedged lookup must not cost the box its name.
  # A possibly-duplicate name beats no name, exactly as everywhere else here.
  new_sandbox llama
  arm_collision_probe
  : > "$SANDBOX/getent-fails"
  "$IDENTITY" apply >/dev/null 2>&1
  assert_equals "a failed probe falls back to the bootstrap name" \
    "$(applied_hostname)" "setup-llama-manager"
  drop_sandbox
}

test_the_bootstrap_probe_is_bounded() {
  printf 'test_the_bootstrap_probe_is_bounded\n'
  # An mDNS query for a name nobody holds does not fail -- it waits. This unit is
  # ordered before avahi, so an unbounded probe would stall the boot and cost the
  # appliance mDNS entirely, which is the failure the unit's TimeoutStartSec
  # exists to bound. Pin that the probe bounds itself too.
  local bounded
  bounded="$(grep -c 'timeout .*GETENT\|timeout .*\$GETENT\|PROBE_TIMEOUT' "$IDENTITY")"
  if ((bounded > 0)); then
    printf '  ok   the bootstrap probe cannot wait forever\n'
  else
    printf '  FAIL the bootstrap probe cannot wait forever (no timeout around it)\n'
    failures=$((failures + 1))
  fi
}

test_the_unit_cannot_hold_mdns_hostage
test_an_unclaimed_bootstrap_name_is_taken_as_is
test_a_second_unconfigured_node_steps_aside
test_the_bootstrap_probe_keeps_stepping_until_it_finds_a_gap
test_the_name_the_probe_settled_on_survives_the_next_boot
test_a_named_node_is_never_probed
test_a_node_does_not_step_aside_from_itself
test_a_probe_that_fails_still_leaves_the_node_named
test_the_bootstrap_probe_is_bounded
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
test_avahi_is_told_to_republish_after_a_rename
test_avahi_is_left_alone_when_the_name_did_not_change
test_the_mirror_is_written_at_the_partition_root
test_avahi_does_not_publish_on_loopback
test_an_operator_deny_list_is_extended_not_replaced
test_an_installed_disk_keeps_the_name_it_was_installed_with
test_a_bootstrap_hostname_is_not_a_chosen_name
test_a_bootstrap_variant_hostname_is_not_a_chosen_name
test_a_foreign_hostname_is_not_mistaken_for_a_node_name
test_the_store_still_outranks_the_running_hostname
test_a_hostname_failure_never_blocks_the_manager

if ((failures > 0)); then
  printf '\nFAIL: %d node identity assertion(s) failed\n' "$failures"
  exit 1
fi
printf '\nPASS: boot-time node identity resolution\n'
