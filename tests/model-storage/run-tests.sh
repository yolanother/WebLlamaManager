#!/bin/bash
# Llama Manager — model storage configuration integration tests.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Runs the public storage CLI against disposable filesystem roots to verify safe
# local, NFS, and partition configuration without mounting devices or requiring
# root access.
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
    if [ -f "$file" ] && grep -Fq "$expected" "$file"; then
        printf P >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf F >> "$FAIL_FILE"; printf '  FAIL %s\n       %s lacks: %s\n' "$desc" "$file" "$expected"
    fi
}

# Return a new disposable system root.
new_root() { mktemp -d "${TMPDIR:-/tmp}/model-storage-test.XXXXXX"; }

test_local_storage() {
    printf 'test_local_storage\n'
    local root rc
    root="$(new_root)"
    "$CLI" local --path /srv/llama-models --root "$root" >/dev/null 2>&1
    rc=$?
    assert_eq "local setup exits zero" 0 "$rc"
    assert_eq "local directory created" yes "$([ -d "$root/srv/llama-models" ] && echo yes || echo no)"
    assert_contains "service config records path" "$root/etc/llama-manager/model-storage.conf" "MODELS_DIR=/srv/llama-models"
    assert_contains "service config records type" "$root/etc/llama-manager/model-storage.conf" "MODEL_STORAGE_TYPE=local"

    "$CLI" local --path /etc --root "$root" >/dev/null 2>&1
    assert_eq "unsafe system path rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    rm -rf "$root"
}

test_nfs_storage() {
    printf 'test_nfs_storage\n'
    local root unit
    root="$(new_root)"
    "$CLI" nfs --server nas.home --export /volume/models \
        --mountpoint /srv/llama-models --root "$root" >/dev/null 2>&1
    assert_eq "NFS setup exits zero" 0 "$?"
    unit="$root/etc/systemd/system/srv-llama\x2dmodels.mount"
    assert_contains "NFS unit source" "$unit" "What=nas.home:/volume/models"
    assert_contains "NFS unit safe options" "$unit" "Options=rw,nosuid,nodev,noexec,_netdev"
    assert_contains "NFS config records type" "$root/etc/llama-manager/model-storage.conf" "MODEL_STORAGE_TYPE=nfs"

    "$CLI" nfs --server 'nas;reboot' --export /models --mountpoint /srv/models --root "$root" >/dev/null 2>&1
    assert_eq "unsafe NFS host rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    "$CLI" nfs --server nas.home --export /models --mountpoint /srv/models \
        --options rw,suid --root "$root" >/dev/null 2>&1
    assert_eq "unsafe NFS option rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    "$CLI" nfs --server nas.home --export /models --mountpoint /srv/models \
        --options rw,timeo=1evil --root "$root" >/dev/null 2>&1
    assert_eq "malformed numeric NFS option rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    mkdir -p "$root/srv/existing"
    printf 'keep me\n' > "$root/srv/existing/model.gguf"
    "$CLI" nfs --server nas.home --export /models --mountpoint /srv/existing \
        --root "$root" >/dev/null 2>&1
    assert_eq "mount does not hide existing model files" no "$([ $? -eq 0 ] && echo yes || echo no)"
    rm -rf "$root"
}

test_partition_storage() {
    printf 'test_partition_storage\n'
    local root unit
    root="$(new_root)"
    MODEL_STORAGE_TEST_UUID=abc-123 "$CLI" partition --device /dev/nvme1n1p1 \
        --mountpoint /srv/llama-models --fs-type ext4 --root "$root" >/dev/null 2>&1
    assert_eq "partition setup exits zero" 0 "$?"
    unit="$root/etc/systemd/system/srv-llama\x2dmodels.mount"
    assert_contains "partition uses stable UUID" "$unit" "What=/dev/disk/by-uuid/abc-123"
    assert_contains "partition filesystem recorded" "$unit" "Type=ext4"
    assert_contains "partition config records type" "$root/etc/llama-manager/model-storage.conf" "MODEL_STORAGE_TYPE=partition"
    rm -rf "$root"
}

test_activation_requires_writable_target() {
    printf 'test_activation_requires_writable_target\n'
    local root
    root="$(new_root)"
    MODEL_STORAGE_FORCE_NOT_WRITABLE=1 "$CLI" local --path /srv/models --root "$root" >/dev/null 2>&1
    assert_eq "non-writable target rejected" no "$([ $? -eq 0 ] && echo yes || echo no)"
    assert_eq "failed verification writes no active config" no \
        "$([ -e "$root/etc/llama-manager/model-storage.conf" ] && echo yes || echo no)"
    MODEL_STORAGE_FORCE_NOT_WRITABLE=1 "$CLI" nfs --server nas.home --export /models \
        --mountpoint /srv/models --root "$root" >/dev/null 2>&1
    assert_eq "failed mount verification removes generated unit" no \
        "$([ -e "$root/etc/systemd/system/srv-models.mount" ] && echo yes || echo no)"
    rm -rf "$root"
}

test_reset_preserves_models() {
    printf 'test_reset_preserves_models\n'
    local root
    root="$(new_root)"
    "$CLI" nfs --server nas.home --export /models --mountpoint /srv/models --root "$root" >/dev/null 2>&1
    printf 'model bytes\n' > "$root/srv/models/example.gguf"
    "$CLI" reset --root "$root" >/dev/null 2>&1
    assert_eq "reset removes service config" no \
        "$([ -e "$root/etc/llama-manager/model-storage.conf" ] && echo yes || echo no)"
    assert_eq "reset removes generated mount unit" no \
        "$([ -e "$root/etc/systemd/system/srv-models.mount" ] && echo yes || echo no)"
    assert_eq "reset preserves model data" yes \
        "$([ -e "$root/srv/models/example.gguf" ] && echo yes || echo no)"
    rm -rf "$root"
}

test_local_storage
test_nfs_storage
test_partition_storage
test_activation_requires_writable_target
test_reset_preserves_models

PASS="$(wc -c < "$PASS_FILE" | tr -d ' ')"
FAIL="$(wc -c < "$FAIL_FILE" | tr -d ' ')"
rm -rf "$RESULTS_DIR"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
