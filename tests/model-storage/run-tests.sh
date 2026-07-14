#!/bin/bash
# Llama Manager — model storage configuration integration tests.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Runs the public storage CLI against disposable filesystem roots to verify path
# containment, local/NFS/partition setup, transactional reconfiguration/reset,
# and service-user access without mounting devices or requiring root access.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/scripts/configure-model-storage.sh"
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/model-storage-results.XXXXXX")"
PASS_FILE="$RESULTS_DIR/pass"
FAIL_FILE="$RESULTS_DIR/fail"
: > "$PASS_FILE"
: > "$FAIL_FILE"

# Assert string equality. Args: description, expected, actual.
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf P >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf F >> "$FAIL_FILE"; printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$desc" "$expected" "$actual"
    fi
}

# Assert a file contains a fixed string. Args: description, file, string.
assert_contains() {
    local desc="$1" file="$2" expected="$3"
    if [ -f "$file" ] && grep -Fq -- "$expected" "$file"; then
        printf P >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf F >> "$FAIL_FILE"; printf '  FAIL %s\n       %s lacks: %s\n' "$desc" "$file" "$expected"
    fi
}

# Assert a file does not contain a fixed string. Args: description, file, string.
assert_not_contains() {
    local desc="$1" file="$2" unexpected="$3"
    if [ ! -f "$file" ] || ! grep -Fq -- "$unexpected" "$file"; then
        printf P >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf F >> "$FAIL_FILE"; printf '  FAIL %s\n       %s contains: %s\n' "$desc" "$file" "$unexpected"
    fi
}

# Return a new disposable system root.
new_root() { mktemp -d "${TMPDIR:-/tmp}/model-storage-test.XXXXXX"; }

# Seed the package identity and deterministic command shims inside a test root.
# Args: root. The shims execute probes against the relocated filesystem while
# recording which account and group the production flow requested.
seed_identity() {
    local root="$1"
    mkdir -p "$root/etc" "$root/test-bin"
    printf 'llama-manager:x:991:991:Llama Manager:/var/lib/llama-manager:/usr/sbin/nologin\n' > "$root/etc/passwd"
    printf 'llama-manager:x:991:llama-manager\n' > "$root/etc/group"
    cat > "$root/test-bin/runuser" <<'EOF'
#!/bin/bash
# Llama Manager test shim. See LICENSE in the repository root.
# Records the requested service identity, then executes the fixed probe command.
printf '%s\n' "$*" >> "$MODEL_STORAGE_TEST_RUNUSER_LOG"
while [ "$1" != "--" ]; do shift; done
shift
"$@"
EOF
    cat > "$root/test-bin/chgrp" <<'EOF'
#!/bin/bash
# Llama Manager test shim. See LICENSE in the repository root.
# Records group ownership setup without requiring the fake group on the host.
printf '%s\n' "$*" >> "$MODEL_STORAGE_TEST_ACCESS_LOG"
EOF
    chmod +x "$root/test-bin/runuser" "$root/test-bin/chgrp"
}

# Invoke the storage CLI with the package identity/test command shims.
# Args: root, mode and CLI arguments.
storage_cli() {
    local root="$1"; shift
    MODEL_STORAGE_RUNUSER="$root/test-bin/runuser" \
    MODEL_STORAGE_CHGRP="$root/test-bin/chgrp" \
    MODEL_STORAGE_TEST_RUNUSER_LOG="$root/runuser.log" \
    MODEL_STORAGE_TEST_ACCESS_LOG="$root/access.log" \
        "$CLI" "$@" --root "$root"
}

test_local_storage() {
    printf 'test_local_storage\n'
    local root rc outside
    root="$(new_root)"
    seed_identity "$root"
    storage_cli "$root" local --path /srv/llama-models >/dev/null 2>&1
    rc=$?
    assert_eq "local setup exits zero" 0 "$rc"
    assert_eq "local directory created" yes "$([ -d "$root/srv/llama-models" ] && echo yes || echo no)"
    assert_contains "service config records path" "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/llama-models"
    assert_contains "service state records type" "$root/etc/llama-manager/model-storage.state" "TYPE=local"

    storage_cli "$root" local --path /etc >/dev/null 2>&1
    assert_eq "unsafe system path rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    mkdir -p "$root/etc/protected" "$root/srv"
    chmod 0750 "$root/etc/protected"
    ln -s ../etc/protected "$root/srv/symlink-models"
    storage_cli "$root" local --path /srv/symlink-models >/dev/null 2>&1
    assert_eq "symlink resolving into protected path rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_eq "protected target mode unchanged" 750 "$(stat -c %a "$root/etc/protected")"

    ln -s ../etc "$root/srv/parent-link"
    storage_cli "$root" local --path /srv/parent-link/protected/models >/dev/null 2>&1
    assert_eq "symlinked parent resolving into protected path rejected" no \
        "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_eq "symlinked protected parent mode unchanged" 750 \
        "$(stat -c %a "$root/etc/protected")"

    outside="$(mktemp -d "${TMPDIR:-/tmp}/model-storage-outside.XXXXXX")"
    chmod 0700 "$outside"
    ln -s "$outside" "$root/srv/root-escape"
    storage_cli "$root" local --path /srv/root-escape/models >/dev/null 2>&1
    assert_eq "symlinked parent cannot escape relocated root" no \
        "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_eq "escaped target is not created" no \
        "$([ -e "$outside/models" ] && echo yes || echo no)"
    assert_eq "escaped parent mode unchanged" 700 "$(stat -c %a "$outside")"
    assert_contains "canonical manager env updated" "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/llama-models"
    assert_contains "write probe created as service account" "$root/runuser.log" "-u llama-manager -- touch"
    assert_contains "write probe removed as service account" "$root/runuser.log" "-u llama-manager -- rm -f"
    rm -rf "$root" "$outside"
}

test_nfs_storage() {
    printf 'test_nfs_storage\n'
    local root unit
    root="$(new_root)"
    seed_identity "$root"
    printf 'API_PORT=4567\n' > "$root/etc/llama-manager.env.seed"
    mkdir -p "$root/etc/llama-manager"
    mv "$root/etc/llama-manager.env.seed" "$root/etc/llama-manager/llama-manager.env"
    storage_cli "$root" nfs --server nas.home --export /volume/models \
        --mountpoint /srv/llama-models >/dev/null 2>&1
    assert_eq "NFS setup exits zero" 0 "$?"
    unit="$root/etc/systemd/system/srv-llama\x2dmodels.mount"
    assert_contains "NFS unit source" "$unit" "What=nas.home:/volume/models"
    assert_contains "NFS unit safe options" "$unit" "Options=rw,nosuid,nodev,noexec,_netdev"
    assert_contains "NFS state records type" "$root/etc/llama-manager/model-storage.state" "TYPE=nfs"
    assert_contains "manager env preserves unrelated settings" "$root/etc/llama-manager/llama-manager.env" "API_PORT=4567"
    assert_contains "manager env selects NFS mountpoint" "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/llama-models"
    assert_contains "service drop-in requires mount" "$root/etc/systemd/system/llama-manager.service.d/model-storage.conf" "Requires=srv-llama\\x2dmodels.mount"
    assert_contains "service drop-in orders after mount" "$root/etc/systemd/system/llama-manager.service.d/model-storage.conf" "After=srv-llama\\x2dmodels.mount"
    assert_contains "NFS grants operator group ownership" "$root/access.log" "llama-manager $root/srv/llama-models"
    assert_eq "NFS grants setgid group write mode" 2775 "$(stat -c %a "$root/srv/llama-models")"

    storage_cli "$root" nfs --server 'nas;reboot' --export /models --mountpoint /srv/models >/dev/null 2>&1
    assert_eq "unsafe NFS host rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    storage_cli "$root" nfs --server nas.home --export /models --mountpoint /srv/models \
        --options rw,suid >/dev/null 2>&1
    assert_eq "unsafe NFS option rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    storage_cli "$root" nfs --server nas.home --export /models --mountpoint /srv/models \
        --options rw,timeo=1evil >/dev/null 2>&1
    assert_eq "malformed numeric NFS option rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    mkdir -p "$root/srv/existing"
    printf 'keep me\n' > "$root/srv/existing/model.gguf"
    storage_cli "$root" nfs --server nas.home --export /models --mountpoint /srv/existing \
        >/dev/null 2>&1
    assert_eq "mount does not hide existing model files" no "$([ $? -eq 0 ] && echo yes || echo no)"
    rm -rf "$root"
}

test_partition_storage() {
    printf 'test_partition_storage\n'
    local root unit
    root="$(new_root)"
    seed_identity "$root"
    MODEL_STORAGE_TEST_UUID=abc-123 storage_cli "$root" partition --device /dev/nvme1n1p1 \
        --mountpoint /srv/llama-models --fs-type ext4 >/dev/null 2>&1
    assert_eq "partition setup exits zero" 0 "$?"
    unit="$root/etc/systemd/system/srv-llama\x2dmodels.mount"
    assert_contains "partition uses stable UUID" "$unit" "What=/dev/disk/by-uuid/abc-123"
    assert_contains "partition filesystem recorded" "$unit" "Type=ext4"
    assert_contains "partition state records type" "$root/etc/llama-manager/model-storage.state" "TYPE=partition"
    assert_contains "partition grants operator group ownership" "$root/access.log" "llama-manager $root/srv/llama-models"
    rm -rf "$root"
}

test_activation_requires_writable_target() {
    printf 'test_activation_requires_writable_target\n'
    local root
    root="$(new_root)"
    seed_identity "$root"
    MODEL_STORAGE_FORCE_NOT_WRITABLE=1 storage_cli "$root" local --path /srv/models >/dev/null 2>&1
    assert_eq "non-writable target rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_eq "failed verification writes no active config" no \
        "$([ -e "$root/etc/llama-manager/llama-manager.env" ] && echo yes || echo no)"
    MODEL_STORAGE_FORCE_NOT_WRITABLE=1 storage_cli "$root" nfs --server nas.home --export /models \
        --mountpoint /srv/models >/dev/null 2>&1
    assert_eq "failed mount verification removes generated unit" no \
        "$([ -e "$root/etc/systemd/system/srv-models.mount" ] && echo yes || echo no)"
    rm -rf "$root"
}

test_dry_run_does_not_mutate() {
    printf 'test_dry_run_does_not_mutate\n'
    local root unit
    root="$(new_root)"
    seed_identity "$root"
    storage_cli "$root" local --path /srv/preview --dry-run >/dev/null 2>&1
    assert_eq "local dry-run writes no manager env" no \
        "$([ -e "$root/etc/llama-manager/llama-manager.env" ] && echo yes || echo no)"
    assert_eq "local dry-run creates no storage directory" no \
        "$([ -d "$root/srv/preview" ] && echo yes || echo no)"

    storage_cli "$root" nfs --server nas.home --export /models \
        --mountpoint /srv/models >/dev/null 2>&1
    unit="$root/etc/systemd/system/srv-models.mount"
    storage_cli "$root" reset --dry-run >/dev/null 2>&1
    assert_contains "reset dry-run preserves model override" \
        "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/models"
    assert_eq "reset dry-run preserves generated mount unit" yes \
        "$([ -e "$unit" ] && echo yes || echo no)"
    rm -rf "$root"
}

test_reset_preserves_models() {
    printf 'test_reset_preserves_models\n'
    local root
    root="$(new_root)"
    seed_identity "$root"
    storage_cli "$root" nfs --server nas.home --export /models --mountpoint /srv/models >/dev/null 2>&1
    printf 'model bytes\n' > "$root/srv/models/example.gguf"
    storage_cli "$root" reset >/dev/null 2>&1
    assert_not_contains "reset removes model override" \
        "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR="
    assert_eq "reset removes generated mount unit" no \
        "$([ -e "$root/etc/systemd/system/srv-models.mount" ] && echo yes || echo no)"
    assert_eq "reset preserves model data" yes \
        "$([ -e "$root/srv/models/example.gguf" ] && echo yes || echo no)"
    rm -rf "$root"
}

test_reset_restores_original_override() {
    printf 'test_reset_restores_original_override\n'
    local root
    root="$(new_root)"
    seed_identity "$root"
    mkdir -p "$root/etc/llama-manager"
    printf 'API_PORT=4567\nMODELS_DIR=/srv/original-models\n' > \
        "$root/etc/llama-manager/llama-manager.env"
    storage_cli "$root" nfs --server nas.home --export /models \
        --mountpoint /srv/appliance-models >/dev/null 2>&1
    storage_cli "$root" reset >/dev/null 2>&1
    assert_contains "reset restores original model override" \
        "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/original-models"
    assert_contains "reset preserves unrelated original setting" \
        "$root/etc/llama-manager/llama-manager.env" "API_PORT=4567"
    rm -rf "$root"
}

test_reset_rolls_back_on_mount_cleanup_failure() {
    printf 'test_reset_rolls_back_on_mount_cleanup_failure\n'
    local root unit
    root="$(new_root)"
    seed_identity "$root"
    mkdir -p "$root/etc/llama-manager"
    printf 'API_PORT=4567\n' > "$root/etc/llama-manager/llama-manager.env"
    storage_cli "$root" nfs --server nas.home --export /models \
        --mountpoint /srv/models >/dev/null 2>&1
    unit="$root/etc/systemd/system/srv-models.mount"

    MODEL_STORAGE_FORCE_CLEANUP_FAILURE=1 storage_cli "$root" reset >/dev/null 2>&1
    assert_eq "reset cleanup failure returns failure" no \
        "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_contains "failed reset restores model override" \
        "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/models"
    assert_contains "failed reset preserves unrelated manager env" \
        "$root/etc/llama-manager/llama-manager.env" "API_PORT=4567"
    assert_contains "failed reset restores storage state" \
        "$root/etc/llama-manager/model-storage.state" "UNIT=srv-models.mount"
    assert_contains "failed reset restores service dependency" \
        "$root/etc/systemd/system/llama-manager.service.d/model-storage.conf" \
        "Requires=srv-models.mount"
    assert_eq "failed reset preserves generated mount unit" yes \
        "$([ -e "$unit" ] && echo yes || echo no)"
    rm -rf "$root"
}

test_missing_service_identity() {
    printf 'test_missing_service_identity\n'
    local root
    root="$(new_root)"
    "$CLI" local --path /srv/models --root "$root" >/dev/null 2>&1
    assert_eq "missing service account is rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_eq "missing account writes no config" no \
        "$([ -e "$root/etc/llama-manager/llama-manager.env" ] && echo yes || echo no)"
    rm -rf "$root"
}

test_transactional_reconfiguration() {
    printf 'test_transactional_reconfiguration\n'
    local root old_unit new_unit
    root="$(new_root)"
    seed_identity "$root"
    storage_cli "$root" nfs --server old-nas --export /models --mountpoint /srv/old >/dev/null 2>&1
    old_unit="$root/etc/systemd/system/srv-old.mount"
    new_unit="$root/etc/systemd/system/srv-new.mount"

    MODEL_STORAGE_FORCE_NOT_WRITABLE=1 storage_cli "$root" nfs --server new-nas \
        --export /models --mountpoint /srv/new >/dev/null 2>&1
    assert_eq "failed reconfigure returns failure" no "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_contains "failed reconfigure preserves old env" "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/old"
    assert_contains "failed reconfigure preserves old state" "$root/etc/llama-manager/model-storage.state" "UNIT=srv-old.mount"
    assert_eq "failed reconfigure preserves old unit" yes "$([ -e "$old_unit" ] && echo yes || echo no)"
    assert_eq "failed reconfigure removes new unit" no "$([ -e "$new_unit" ] && echo yes || echo no)"

    : > "$root/access.log"
    MODEL_STORAGE_FORCE_CLEANUP_FAILURE=1 storage_cli "$root" nfs --server new-nas \
        --export /models --mountpoint /srv/new >/dev/null 2>&1
    assert_eq "cleanup-stage failure returns failure" no "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_contains "cleanup-stage rollback restores old env" "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/old"
    assert_contains "cleanup-stage rollback restores old state" "$root/etc/llama-manager/model-storage.state" "UNIT=srv-old.mount"
    assert_eq "cleanup-stage rollback keeps old unit" yes "$([ -e "$old_unit" ] && echo yes || echo no)"
    assert_eq "cleanup-stage rollback removes candidate" no "$([ -e "$new_unit" ] && echo yes || echo no)"
    assert_eq "cleanup-stage rollback restores manager env group" 2 \
        "$(grep -Fc 'llama-manager.env' "$root/access.log")"

    storage_cli "$root" nfs --server new-nas --export /models --mountpoint /srv/new >/dev/null 2>&1
    assert_contains "successful reconfigure selects new env" "$root/etc/llama-manager/llama-manager.env" "MODELS_DIR=/srv/new"
    assert_eq "successful reconfigure removes old unit" no "$([ -e "$old_unit" ] && echo yes || echo no)"
    assert_eq "successful reconfigure keeps new unit" yes "$([ -e "$new_unit" ] && echo yes || echo no)"
    assert_contains "successful reconfigure updates dependency" "$root/etc/systemd/system/llama-manager.service.d/model-storage.conf" "Requires=srv-new.mount"

    storage_cli "$root" local --path /srv/local >/dev/null 2>&1
    assert_eq "mount-to-local removes old mount unit" no "$([ -e "$new_unit" ] && echo yes || echo no)"
    assert_contains "local dependency uses mount path" "$root/etc/systemd/system/llama-manager.service.d/model-storage.conf" "RequiresMountsFor=/srv/local"
    rm -rf "$root"
}

test_local_storage
test_nfs_storage
test_partition_storage
test_activation_requires_writable_target
test_dry_run_does_not_mutate
test_reset_preserves_models
test_reset_restores_original_override
test_reset_rolls_back_on_mount_cleanup_failure
test_missing_service_identity
test_transactional_reconfiguration

PASS="$(wc -c < "$PASS_FILE" | tr -d ' ')"
FAIL="$(wc -c < "$FAIL_FILE" | tr -d ' ')"
rm -rf "$RESULTS_DIR"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
