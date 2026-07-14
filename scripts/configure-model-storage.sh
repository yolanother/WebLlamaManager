#!/bin/bash
# Llama Manager — safe model storage setup and recovery utility.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Configures the MODELS_DIR consumed by the packaged manager service for a local
# directory, an existing filesystem partition, or an NFS export. Mount-backed
# modes generate portable systemd mount units, activate them, verify the service
# account can write, and only then atomically update the canonical manager env,
# root-only state, and service dependency. Reconfiguration and reset restore the
# prior active contract on failure, and reset never deletes model data.
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
ROOT="/"
DRY_RUN=false
MODE="${1:-}"
[ $# -gt 0 ] && shift
PATH_VALUE=""
SERVER=""
EXPORT_PATH=""
MOUNTPOINT=""
OPTIONS=""
DEVICE=""
FS_TYPE=""
SERVICE_USER="llama-manager"
SERVICE_GROUP="llama-manager"
RUNUSER_BIN="${MODEL_STORAGE_RUNUSER:-runuser}"
CHGRP_BIN="${MODEL_STORAGE_CHGRP:-chgrp}"
ENV_LOGICAL="/etc/llama-manager/llama-manager.env"
STATE_LOGICAL="/etc/llama-manager/model-storage.state"
DROPIN_LOGICAL="/etc/systemd/system/llama-manager.service.d/model-storage.conf"

# Print command usage and the supported storage modes.
usage() {
    cat <<EOF
Usage:
  $SCRIPT_NAME local --path ABSOLUTE_PATH [--root DIR] [--dry-run]
  $SCRIPT_NAME nfs --server HOST --export /PATH --mountpoint /PATH [--options LIST] [--root DIR] [--dry-run]
  $SCRIPT_NAME partition --device /dev/DEVICE --mountpoint /PATH --fs-type ext4|xfs|btrfs [--root DIR] [--dry-run]
  $SCRIPT_NAME reset [--root DIR] [--dry-run]

The partition mode mounts an existing filesystem and never formats a device.
NFS v1 intentionally supports credential-free DNS/IPv4 servers only.
EOF
}

# Log a storage setup message.
log() { printf '[model-storage] %s\n' "$*"; }

# Resolve an absolute system path beneath the optional test root.
# Args: logical absolute path. Echoes physical path.
root_path() { printf '%s/%s\n' "${ROOT%/}" "${1#/}"; }

# Read one literal key from the private root-owned storage state file.
# Args: key. Echoes the final value or nothing when absent.
state_get() {
    local key="$1" state
    state="$(root_path "$STATE_LOGICAL")"
    [ -f "$state" ] || return 0
    grep -E "^${key}=" "$state" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# Run a mutating command unless this is a dry-run preview.
# Args: command and arguments.
run() {
    if [ "$DRY_RUN" = true ]; then log "DRY-RUN would run: $*"; return 0; fi
    "$@"
}

# Reject paths unsafe for model data or systemd EnvironmentFile values.
# Args: absolute model or mount path.
validate_storage_path() {
    local value="$1"
    [[ "$value" = /* ]] || { echo "Error: storage path must be absolute." >&2; return 1; }
    [[ "$value" != *[$'\n\r\t ']* ]] || { echo "Error: whitespace is not supported in storage paths." >&2; return 1; }
    [[ "$value" != *","* && "$value" != *".."* ]] || { echo "Error: unsafe storage path." >&2; return 1; }
    case "$value" in
        /|/bin|/bin/*|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/proc|/proc/*|/run|/run/*|/sys|/sys/*|/usr|/usr/*)
            echo "Error: refusing to use protected system path '$value'." >&2
            return 1
            ;;
    esac
}

# Resolve symlinks and missing path components, then apply the protected-path
# policy to the actual target. Relocated roots must remain inside their sandbox.
# Args: logical absolute path.
validate_resolved_target() {
    local logical="$1" physical resolved root_resolved resolved_logical
    physical="$(root_path "$logical")"
    [ ! -L "$physical" ] || { echo "Error: model storage path must not be a symlink." >&2; return 1; }
    resolved="$(realpath -m -- "$physical")"
    root_resolved="$(realpath -m -- "$(root_path /)")"
    if [ "$root_resolved" = / ]; then
        resolved_logical="$resolved"
    else
        case "$resolved" in
            "$root_resolved") resolved_logical=/ ;;
            "$root_resolved"/*) resolved_logical="/${resolved#"$root_resolved"/}" ;;
            *) echo "Error: resolved model storage path escapes the configured root." >&2; return 1 ;;
        esac
    fi
    validate_storage_path "$resolved_logical"
}

# Validate a credential-free DNS name or IPv4 literal for an NFS source.
# Args: server host. IPv6 is intentionally deferred to avoid ambiguous sources.
validate_nfs_server() {
    [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || {
        echo "Error: NFS server must be a DNS name or IPv4 address." >&2
        return 1
    }
}

# Validate an NFS export path without allowing option/source injection.
# Args: export path.
validate_nfs_export() {
    [[ "$1" = /* && "$1" != *[$'\n\r\t ,']* && "$1" != *".."* ]] || {
        echo "Error: NFS export must be a safe absolute path." >&2
        return 1
    }
}

# Validate NFS mount options against the credential-free v1 allowlist.
# Args: comma-separated options.
validate_nfs_options() {
    local item
    IFS=',' read -r -a option_items <<< "$1"
    for item in "${option_items[@]}"; do
        case "$item" in
            rw|ro|hard|soft|sync|async|noatime|nodiratime|_netdev|nosuid|nodev|noexec|vers=3|vers=4|vers=4.0|vers=4.1|vers=4.2|proto=tcp) ;;
            *)
                [[ "$item" =~ ^(timeo|retrans|rsize|wsize)=[0-9]+$ ]] || {
                    echo "Error: unsupported or unsafe NFS option '$item'." >&2
                    return 1
                }
                ;;
        esac
    done
}

# Ensure a required safety option occurs exactly once in a comma list.
# Args: existing list, option. Echoes normalized list.
ensure_option() {
    local list="$1" option="$2"
    case ",$list," in
        *",$option,"*) printf '%s\n' "$list" ;;
        *) printf '%s,%s\n' "$list" "$option" ;;
    esac
}

# Add non-escalating defaults required for remotely supplied storage.
# Args: user-provided or default NFS option list. Echoes normalized safe list.
safe_nfs_options() {
    local result="${1:-rw}"
    result="$(ensure_option "$result" nosuid)"
    result="$(ensure_option "$result" nodev)"
    result="$(ensure_option "$result" noexec)"
    result="$(ensure_option "$result" _netdev)"
    printf '%s\n' "$result"
}

# Require root for production system configuration, but not a relocated test root.
ensure_root() {
    [ "$ROOT" != "/" ] && return 0
    [ "$DRY_RUN" = true ] && return 0
    [ "$(id -u)" -eq 0 ] || { echo "Error: run with sudo for system configuration." >&2; exit 1; }
}

# Require the package-created service user/group and group membership before
# touching storage. Relocated roots use their seeded passwd/group fixtures.
ensure_service_identity() {
    local passwd_file group_file user_line group_line user_gid group_gid members
    if [ "$ROOT" = "/" ]; then
        getent passwd "$SERVICE_USER" >/dev/null 2>&1 || { echo "Error: service account '$SERVICE_USER' does not exist." >&2; return 1; }
        getent group "$SERVICE_GROUP" >/dev/null 2>&1 || { echo "Error: service group '$SERVICE_GROUP' does not exist." >&2; return 1; }
        id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -Fxq "$SERVICE_GROUP" || {
            echo "Error: '$SERVICE_USER' must belong to '$SERVICE_GROUP'." >&2; return 1;
        }
        return 0
    fi
    passwd_file="$(root_path /etc/passwd)"
    group_file="$(root_path /etc/group)"
    user_line="$(grep -E "^${SERVICE_USER}:" "$passwd_file" 2>/dev/null | tail -n1 || true)"
    group_line="$(grep -E "^${SERVICE_GROUP}:" "$group_file" 2>/dev/null | tail -n1 || true)"
    [ -n "$user_line" ] || { echo "Error: service account '$SERVICE_USER' does not exist in relocated root." >&2; return 1; }
    [ -n "$group_line" ] || { echo "Error: service group '$SERVICE_GROUP' does not exist in relocated root." >&2; return 1; }
    user_gid="$(printf '%s\n' "$user_line" | cut -d: -f4)"
    group_gid="$(printf '%s\n' "$group_line" | cut -d: -f3)"
    members="$(printf '%s\n' "$group_line" | cut -d: -f4)"
    [ "$user_gid" = "$group_gid" ] || case ",$members," in
        *",$SERVICE_USER,"*) ;;
        *) echo "Error: '$SERVICE_USER' must belong to '$SERVICE_GROUP'." >&2; return 1 ;;
    esac
}

# Parse options shared by each subcommand and its mode-specific arguments.
parse_options() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --path) PATH_VALUE="${2:-}"; shift ;;
            --server) SERVER="${2:-}"; shift ;;
            --export) EXPORT_PATH="${2:-}"; shift ;;
            --mountpoint) MOUNTPOINT="${2:-}"; shift ;;
            --options) OPTIONS="${2:-}"; shift ;;
            --device) DEVICE="${2:-}"; shift ;;
            --fs-type) FS_TYPE="${2:-}"; shift ;;
            --root) ROOT="${2:-}"; shift ;;
            --dry-run) DRY_RUN=true ;;
            --service-user) SERVICE_USER="${2:-}"; shift ;;
            --service-group) SERVICE_GROUP="${2:-}"; shift ;;
            -h|--help) usage; exit 0 ;;
            *) echo "Error: unknown option '$1'." >&2; usage >&2; exit 2 ;;
        esac
        shift
    done
    [[ "$ROOT" = /* ]] || { echo "Error: --root must be absolute." >&2; exit 2; }
}

# Return the systemd mount unit name corresponding to an absolute mountpoint.
# Args: mountpoint. Echoes escaped .mount unit name.
mount_unit_name() { systemd-escape --path --suffix=mount "$1"; }

# Write a generated systemd mount unit for an existing filesystem source.
# Args: unit name, source, mountpoint, filesystem type, mount options.
write_mount_unit() {
    local unit="$1" source="$2" where="$3" type="$4" options="$5" dest
    dest="$(root_path "/etc/systemd/system/$unit")"
    [ "$DRY_RUN" = true ] && { log "DRY-RUN would write $dest"; return 0; }
    if [ -e "$dest" ] && ! grep -Fq 'Llama Manager generated model storage mount' "$dest"; then
        echo "Error: refusing to replace existing systemd unit '$unit'." >&2
        return 1
    fi
    mkdir -p "$(dirname "$dest")"
    cat > "$dest" <<EOF
# Llama Manager generated model storage mount. See LICENSE in the repository root.
# Mounts the selected model store before llama-manager.service starts.
[Unit]
Description=Llama Manager model storage
After=network-online.target
Wants=network-online.target
Before=llama-manager.service

[Mount]
What=$source
Where=$where
Type=$type
Options=$options

[Install]
WantedBy=multi-user.target
EOF
}

# Activate a generated mount in production; relocated roots only generate and
# inspect the portable unit without invoking the host systemd instance.
# Args: unit name.
activate_mount() {
    local unit="$1"
    [ "$ROOT" != "/" ] && return 0
    run systemctl daemon-reload || return 1
    run systemctl enable --now "$unit" || return 1
}

# Stop and remove one generated mount unit without touching its mountpoint data.
# Args: unit name.
remove_mount_unit() {
    local unit="$1" dest
    [ -n "$unit" ] || return 0
    dest="$(root_path "/etc/systemd/system/$unit")"
    if [ ! -f "$dest" ] || ! grep -Fq 'Llama Manager generated model storage mount' "$dest"; then
        echo "Error: refusing to remove unrecognized mount unit '$unit'." >&2
        return 1
    fi
    if [ "$ROOT" = "/" ]; then
        run systemctl disable --now "$unit" || return 1
    fi
    run rm -f "$dest" || return 1
    [ "$ROOT" != "/" ] || run systemctl daemon-reload || return 1
}

# Refuse to mount over existing files, which would hide them until unmount and
# make a storage selection appear to have lost models.
# Args: physical mountpoint directory.
ensure_empty_mountpoint() {
    local physical="$1"
    if [ -n "$(find "$physical" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
        echo "Error: mountpoint '$physical' is not empty." >&2
        return 1
    fi
}

# Roll back only a mount unit generated by this utility. Model contents and the
# mountpoint directory are deliberately preserved.
# Args: unit name.
rollback_mount() {
    remove_mount_unit "$1" >/dev/null 2>&1 || true
}

# Give the service account and operator group setgid read/write access. NFS and
# partition exports that refuse ownership/mode changes fail clearly before the
# manager is pointed at them.
# Args: logical storage path.
prepare_operator_access() {
    local logical="$1" physical
    physical="$(root_path "$logical")"
    run "$CHGRP_BIN" "$SERVICE_GROUP" "$physical" || return 1
    run chmod 2775 "$physical" || return 1
    if [ "$ROOT" = "/" ] && [ "$DRY_RUN" != true ]; then
        [ "$(stat -c %G "$physical")" = "$SERVICE_GROUP" ] || {
            echo "Error: storage root is not owned by group '$SERVICE_GROUP'." >&2; return 1;
        }
        [ "$(stat -c %a "$physical")" = 2775 ] || {
            echo "Error: storage root does not grant setgid group write access." >&2; return 1;
        }
    fi
}

# Verify the target by creating and removing a probe as the service account.
# The probe is never created as root, preventing a false positive on storage the
# actual daemon cannot manage.
# Args: logical storage path.
verify_writable() {
    local logical="$1" physical probe
    [ "${MODEL_STORAGE_FORCE_NOT_WRITABLE:-0}" = 1 ] && {
        echo "Error: model storage is not writable." >&2
        return 1
    }
    physical="$(root_path "$logical")"
    [ "$DRY_RUN" = true ] && return 0
    probe="$physical/.llama-manager-write-test.$$"
    "$RUNUSER_BIN" -u "$SERVICE_USER" -- touch "$probe" 2>/dev/null || {
        echo "Error: $SERVICE_USER cannot create files in '$logical'." >&2
        return 1
    }
    "$RUNUSER_BIN" -u "$SERVICE_USER" -- rm -f "$probe" 2>/dev/null || {
        echo "Error: $SERVICE_USER cannot remove files in '$logical'." >&2
        return 1
    }
}

# Read MODELS_DIR literally from the canonical manager EnvironmentFile.
env_models_dir() {
    local env_file
    env_file="$(root_path "$ENV_LOGICAL")"
    [ -f "$env_file" ] || return 0
    grep '^MODELS_DIR=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# Render the canonical manager EnvironmentFile with MODELS_DIR set or removed,
# preserving every unrelated setting without evaluating shell content.
# Args: output file, mode (set/remove), optional value.
render_manager_env() {
    local output="$1" action="$2" value="${3:-}" current
    current="$(root_path "$ENV_LOGICAL")"
    if [ -f "$current" ]; then
        grep -v '^MODELS_DIR=' "$current" > "$output" || true
    else
        cat > "$output" <<'EOF'
# Llama Manager — package service environment overrides.
# Copyright (c) Llama Manager project. See LICENSE in the repository root.
EOF
    fi
    [ "$action" != set ] || printf 'MODELS_DIR=%s\n' "$value" >> "$output"
}

# Copy a file into place atomically with a fixed mode.
# Args: source, destination, numeric mode.
atomic_install() {
    local source="$1" destination="$2" mode="$3" temp
    mkdir -p "$(dirname "$destination")" || return 1
    temp="$(mktemp "$(dirname "$destination")/.llama-manager-storage.XXXXXX")" || return 1
    cp "$source" "$temp" || { rm -f "$temp"; return 1; }
    chmod "$mode" "$temp" || { rm -f "$temp"; return 1; }
    mv "$temp" "$destination" || { rm -f "$temp"; return 1; }
}

# Snapshot a file for transaction rollback.
# Args: logical path, snapshot name, transaction directory.
snapshot_file() {
    local logical="$1" name="$2" txn="$3" source
    source="$(root_path "$logical")"
    if [ -f "$source" ]; then cp -a "$source" "$txn/$name"; else : > "$txn/$name.missing"; fi
}

# Restore one snapshotted file exactly, including prior absence.
# Args: logical path, snapshot name, transaction directory.
restore_file() {
    local logical="$1" name="$2" txn="$3" destination
    destination="$(root_path "$logical")"
    if [ -f "$txn/$name.missing" ]; then
        rm -f "$destination"
    else
        atomic_install "$txn/$name" "$destination" "$(stat -c %a "$txn/$name")"
    fi
}

# Render and atomically commit manager env, state, and service mount dependency.
# Args: txn, type, path, source, unit.
commit_metadata() {
    local txn="$1" type="$2" path="$3" source="$4" unit="$5"
    local base_present base_value env_dest state_dest dropin_dest
    base_present="$(state_get BASE_MODELS_DIR_PRESENT)"
    base_value="$(state_get BASE_MODELS_DIR)"
    if [ -z "$base_present" ]; then
        base_value="$(env_models_dir)"
        [ -n "$base_value" ] && base_present=true || base_present=false
    fi
    render_manager_env "$txn/env.new" set "$path" || return 1
    cat > "$txn/state.new" <<EOF
TYPE=$type
PATH=$path
SOURCE=$source
UNIT=$unit
BASE_MODELS_DIR_PRESENT=$base_present
BASE_MODELS_DIR=$base_value
EOF
    [ -s "$txn/state.new" ] || return 1
    if [ -n "$unit" ]; then
        cat > "$txn/dropin.new" <<EOF
# Llama Manager generated model storage dependency. See LICENSE in the repository root.
[Unit]
Requires=$unit
After=$unit
EOF
    else
        cat > "$txn/dropin.new" <<EOF
# Llama Manager generated local model storage dependency. See LICENSE in the repository root.
[Unit]
RequiresMountsFor=$path
EOF
    fi
    env_dest="$(root_path "$ENV_LOGICAL")"
    state_dest="$(root_path "$STATE_LOGICAL")"
    dropin_dest="$(root_path "$DROPIN_LOGICAL")"
    atomic_install "$txn/dropin.new" "$dropin_dest" 0644 || return 1
    atomic_install "$txn/env.new" "$env_dest" 0660 || return 1
    "$CHGRP_BIN" "$SERVICE_GROUP" "$env_dest" || return 1
    atomic_install "$txn/state.new" "$state_dest" 0600 || return 1
}

# Reload unit dependencies and restart the manager only when it is already
# running, so an active process switches storage before an old mount is removed.
reload_manager() {
    [ "$ROOT" != "/" ] && return 0
    run systemctl daemon-reload || return 1
    run systemctl try-restart llama-manager.service || return 1
}

# Restore transaction metadata snapshots and reload the prior manager contract.
# Args: transaction directory.
restore_metadata() {
    local txn="$1" env_dest
    restore_file "$DROPIN_LOGICAL" dropin.old "$txn"
    restore_file "$ENV_LOGICAL" env.old "$txn"
    restore_file "$STATE_LOGICAL" state.old "$txn"
    env_dest="$(root_path "$ENV_LOGICAL")"
    [ ! -f "$env_dest" ] || "$CHGRP_BIN" "$SERVICE_GROUP" "$env_dest" || return 1
    reload_manager || true
}

# Commit a verified storage candidate, restart active manager processes onto it,
# and only then retire the previous mount. Failures restore prior metadata and
# leave the prior active unit/state intact.
# Args: type, logical path, source, new unit, whether new unit was created.
commit_storage_transaction() {
    local type="$1" path="$2" source="$3" new_unit="$4" new_created="$5"
    local old_unit txn config_dir old_unit_path
    if [ "$DRY_RUN" = true ]; then
        log "DRY-RUN would select $type storage at $path"
        return 0
    fi
    old_unit="$(state_get UNIT)"
    config_dir="$(root_path /etc/llama-manager)"
    mkdir -p "$config_dir"
    txn="$(mktemp -d "$config_dir/.model-storage-txn.XXXXXX")"
    snapshot_file "$ENV_LOGICAL" env.old "$txn"
    snapshot_file "$STATE_LOGICAL" state.old "$txn"
    snapshot_file "$DROPIN_LOGICAL" dropin.old "$txn"
    if [ -n "$old_unit" ]; then
        old_unit_path="$(root_path "/etc/systemd/system/$old_unit")"
        [ -f "$old_unit_path" ] && cp -a "$old_unit_path" "$txn/old-unit"
    fi

    if ! commit_metadata "$txn" "$type" "$path" "$source" "$new_unit"; then
        restore_metadata "$txn"
        [ "$new_created" != true ] || rollback_mount "$new_unit"
        rm -rf "$txn"
        return 1
    fi
    if ! reload_manager; then
        restore_metadata "$txn"
        [ "$new_created" != true ] || rollback_mount "$new_unit"
        rm -rf "$txn"
        return 1
    fi
    if [ -n "$old_unit" ] && [ "$old_unit" != "$new_unit" ]; then
        if [ "${MODEL_STORAGE_FORCE_CLEANUP_FAILURE:-0}" = 1 ] || ! remove_mount_unit "$old_unit"; then
            if [ -f "$txn/old-unit" ]; then
                atomic_install "$txn/old-unit" "$(root_path "/etc/systemd/system/$old_unit")" 0644
                activate_mount "$old_unit" || true
            fi
            restore_metadata "$txn"
            [ "$new_created" != true ] || rollback_mount "$new_unit"
            rm -rf "$txn"
            return 1
        fi
    fi
    rm -rf "$txn"
}

# Configure a local directory with setgid group access for manager operators.
configure_local() {
    [ -n "$PATH_VALUE" ] || { echo "Error: local mode requires --path." >&2; exit 2; }
    validate_storage_path "$PATH_VALUE"
    local physical
    physical="$(root_path "$PATH_VALUE")"
    validate_resolved_target "$PATH_VALUE"
    run mkdir -p "$physical"
    validate_resolved_target "$PATH_VALUE"
    prepare_operator_access "$PATH_VALUE"
    verify_writable "$PATH_VALUE"
    commit_storage_transaction local "$PATH_VALUE" "$PATH_VALUE" "" false
}

# Configure and activate a credential-free NFS model store.
configure_nfs() {
    [ -n "$SERVER" ] && [ -n "$EXPORT_PATH" ] && [ -n "$MOUNTPOINT" ] || {
        echo "Error: nfs mode requires --server, --export, and --mountpoint." >&2; exit 2;
    }
    validate_nfs_server "$SERVER"
    validate_nfs_export "$EXPORT_PATH"
    validate_storage_path "$MOUNTPOINT"
    OPTIONS="${OPTIONS:-rw}"
    validate_nfs_options "$OPTIONS"
    OPTIONS="$(safe_nfs_options "$OPTIONS")"
    local unit physical source old_unit old_source created=false
    unit="$(mount_unit_name "$MOUNTPOINT")"
    source="$SERVER:$EXPORT_PATH"
    old_unit="$(state_get UNIT)"
    old_source="$(state_get SOURCE)"
    if [ -n "$old_unit" ] && [ "$unit" = "$old_unit" ] && [ "$source" != "$old_source" ]; then
        echo "Error: changing a mount source in place is unsafe; select a new mountpoint." >&2
        return 1
    fi
    physical="$(root_path "$MOUNTPOINT")"
    validate_resolved_target "$MOUNTPOINT"
    run mkdir -p "$physical"
    validate_resolved_target "$MOUNTPOINT"
    if [ "$unit" != "$old_unit" ]; then
        [ "$DRY_RUN" = true ] || ensure_empty_mountpoint "$physical"
        write_mount_unit "$unit" "$source" "$MOUNTPOINT" nfs "$OPTIONS"
        if ! activate_mount "$unit"; then rollback_mount "$unit"; return 1; fi
        created=true
    fi
    if ! prepare_operator_access "$MOUNTPOINT" || ! verify_writable "$MOUNTPOINT"; then
        [ "$created" != true ] || rollback_mount "$unit"
        return 1
    fi
    commit_storage_transaction nfs "$MOUNTPOINT" "$source" "$unit" "$created"
}

# Configure and activate an already-formatted local partition by stable UUID.
configure_partition() {
    [ -n "$DEVICE" ] && [ -n "$MOUNTPOINT" ] && [ -n "$FS_TYPE" ] || {
        echo "Error: partition mode requires --device, --mountpoint, and --fs-type." >&2; exit 2;
    }
    [[ "$DEVICE" =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] || { echo "Error: unsafe device path." >&2; exit 2; }
    validate_storage_path "$MOUNTPOINT"
    case "$FS_TYPE" in ext4|xfs|btrfs) ;; *) echo "Error: unsupported filesystem '$FS_TYPE'." >&2; exit 2 ;; esac
    if [ "$ROOT" = "/" ]; then
        [ -b "$DEVICE" ] || { echo "Error: '$DEVICE' is not a block device." >&2; exit 1; }
    fi
    local uuid unit physical source old_unit old_source created=false
    uuid="${MODEL_STORAGE_TEST_UUID:-}"
    [ "$ROOT" = "/" ] && uuid="$(blkid -s UUID -o value "$DEVICE")"
    [[ "$uuid" =~ ^[A-Za-z0-9-]+$ ]] || { echo "Error: device has no safe filesystem UUID." >&2; exit 1; }
    unit="$(mount_unit_name "$MOUNTPOINT")"
    source="/dev/disk/by-uuid/$uuid"
    old_unit="$(state_get UNIT)"
    old_source="$(state_get SOURCE)"
    if [ -n "$old_unit" ] && [ "$unit" = "$old_unit" ] && [ "$source" != "$old_source" ]; then
        echo "Error: changing a mount source in place is unsafe; select a new mountpoint." >&2
        return 1
    fi
    physical="$(root_path "$MOUNTPOINT")"
    validate_resolved_target "$MOUNTPOINT"
    run mkdir -p "$physical"
    validate_resolved_target "$MOUNTPOINT"
    if [ "$unit" != "$old_unit" ]; then
        [ "$DRY_RUN" = true ] || ensure_empty_mountpoint "$physical"
        write_mount_unit "$unit" "$source" "$MOUNTPOINT" "$FS_TYPE" "rw,nosuid,nodev,noexec"
        if ! activate_mount "$unit"; then rollback_mount "$unit"; return 1; fi
        created=true
    fi
    if ! prepare_operator_access "$MOUNTPOINT" || ! verify_writable "$MOUNTPOINT"; then
        [ "$created" != true ] || rollback_mount "$unit"
        return 1
    fi
    commit_storage_transaction partition "$MOUNTPOINT" "$source" "$unit" "$created"
}

# Remove generated service/mount configuration while preserving model contents.
reset_storage() {
    local unit base_present base_value env_temp txn config_dir unit_path state_file
    state_file="$(root_path "$STATE_LOGICAL")"
    if [ ! -f "$state_file" ]; then
        log "No generated model storage state found; nothing to reset."
        return 0
    fi
    if [ "$DRY_RUN" = true ]; then
        log "DRY-RUN would remove generated storage configuration without deleting models"
        return 0
    fi
    unit="$(state_get UNIT)"
    base_present="$(state_get BASE_MODELS_DIR_PRESENT)"
    base_value="$(state_get BASE_MODELS_DIR)"
    config_dir="$(root_path /etc/llama-manager)"
    mkdir -p "$config_dir"
    txn="$(mktemp -d "$config_dir/.model-storage-reset.XXXXXX")"
    snapshot_file "$ENV_LOGICAL" env.old "$txn"
    snapshot_file "$STATE_LOGICAL" state.old "$txn"
    snapshot_file "$DROPIN_LOGICAL" dropin.old "$txn"
    if [ -n "$unit" ]; then
        unit_path="$(root_path "/etc/systemd/system/$unit")"
        [ ! -f "$unit_path" ] || cp -a "$unit_path" "$txn/old-unit"
    fi
    env_temp="$txn/env.new"
    if [ "$base_present" = true ]; then
        render_manager_env "$env_temp" set "$base_value"
    else
        render_manager_env "$env_temp" remove
    fi
    if ! atomic_install "$env_temp" "$(root_path "$ENV_LOGICAL")" 0660 ||
        ! "$CHGRP_BIN" "$SERVICE_GROUP" "$(root_path "$ENV_LOGICAL")" ||
        ! rm -f "$(root_path "$STATE_LOGICAL")" "$(root_path "$DROPIN_LOGICAL")"; then
        restore_metadata "$txn"
        rm -rf "$txn"
        return 1
    fi
    if ! reload_manager; then
        restore_metadata "$txn"
        rm -rf "$txn"
        return 1
    fi
    if [ -n "$unit" ] && {
        [ "${MODEL_STORAGE_FORCE_CLEANUP_FAILURE:-0}" = 1 ] || ! remove_mount_unit "$unit";
    }; then
        if [ -f "$txn/old-unit" ]; then
            atomic_install "$txn/old-unit" "$(root_path "/etc/systemd/system/$unit")" 0644
            activate_mount "$unit" || true
        fi
        restore_metadata "$txn"
        rm -rf "$txn"
        return 1
    fi
    rm -rf "$txn"
    log "Configuration removed; model data was not deleted."
}

case "$MODE" in
    local|nfs|partition|reset) ;;
    -h|--help|"") usage; exit 0 ;;
    *) echo "Error: unknown mode '$MODE'." >&2; usage >&2; exit 2 ;;
esac

parse_options "$@"
ensure_root
ensure_service_identity
case "$MODE" in
    local) configure_local ;;
    nfs) configure_nfs ;;
    partition) configure_partition ;;
    reset) reset_storage ;;
esac
log "Model storage configuration complete. Restart llama-manager.service to use it."
