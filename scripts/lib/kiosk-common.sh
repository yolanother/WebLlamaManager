#!/bin/bash
# Llama Manager — Kiosk common library.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Shared helpers for scripts/install-kiosk.sh and scripts/llama-kiosk-launch.sh.
# Provides sandbox-aware path resolution (KIOSK_ROOT), canonical manager-env
# KIOSK_URL resolution, Firefox/Chrome browser discovery, dedicated-account and
# session lifecycle, persistent resource-ownership markers, idempotent backups,
# and a dry-run-aware command wrapper. This file is sourced, not executed.

# Guard against double-sourcing.
[ -n "${_KIOSK_COMMON_SOURCED:-}" ] && return 0
_KIOSK_COMMON_SOURCED=1

# Sandbox root for all system paths ("/" in production; a temp dir in tests).
KIOSK_ROOT="${KIOSK_ROOT:-/}"
# When "true", mutating helpers log their intent and change nothing.
KIOSK_DRY_RUN="${KIOSK_DRY_RUN:-false}"

# Resolve a logical absolute system path under KIOSK_ROOT.
# Arg: $1 = logical path (e.g. /etc/gdm3/custom.conf)
# Echo: the path prefixed by KIOSK_ROOT.
kiosk_path() {
    printf '%s\n' "${KIOSK_ROOT%/}/${1#/}"
}

# Resolve the dashboard URL the kiosk should display.
# Precedence: $KIOSK_URL env > KIOSK_URL= in manager env > localhost:$API_PORT.
# Arg: $1 = path to the canonical manager EnvironmentFile (need not exist).
# Echo: the resolved URL.
kiosk_resolve_url() {
    local env_file="$1" url="" api_port=""
    if [ -n "${KIOSK_URL:-}" ]; then printf '%s\n' "$KIOSK_URL"; return 0; fi
    if [ -f "$env_file" ]; then
        url="$(grep -E '^KIOSK_URL=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | xargs || true)"
        api_port="$(grep -E '^API_PORT=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | xargs || true)"
    fi
    if [ -n "$url" ]; then printf '%s\n' "$url"; return 0; fi
    printf 'http://localhost:%s/kiosk\n' "${api_port:-3001}"
}

# Absolute path to the install manifest (records what install changed).
kiosk_manifest_path() { kiosk_path /var/backups/llama-kiosk/manifest; }

# Read a manifest key. Arg: $1 = key. Echo: value, or empty string if absent.
kiosk_manifest_get() {
    local key="$1" mf; mf="$(kiosk_manifest_path)"
    [ -f "$mf" ] || return 0
    grep -E "^${key}=" "$mf" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# Set (creating or replacing) a manifest key.
# Args: $1 = key, $2 = value. No-op under dry-run (the manifest lives under
# /var/backups and must not be written when previewing).
kiosk_manifest_set() {
    local key="$1" val="$2" mf tmp
    [ "$KIOSK_DRY_RUN" = "true" ] && return 0
    mf="$(kiosk_manifest_path)"
    mkdir -p "$(dirname "$mf")"
    if [ -f "$mf" ] && grep -qE "^${key}=" "$mf"; then
        tmp="$(mktemp)"
        grep -vE "^${key}=" "$mf" > "$tmp" || true
        printf '%s=%s\n' "$key" "$val" >> "$tmp"
        mv "$tmp" "$mf"
    else
        printf '%s=%s\n' "$key" "$val" >> "$mf"
    fi
}

# --- logging -------------------------------------------------------------

# Log an informational message to stdout with a [kiosk] prefix.
# Args: $@ = message text.
kiosk_log()  { printf '[kiosk] %s\n' "$*"; }

# Log a warning message to stderr with a [kiosk] WARN: prefix.
# Args: $@ = message text.
kiosk_warn() { printf '[kiosk] WARN: %s\n' "$*" >&2; }

# Run a command, honoring dry-run. In dry-run mode the command is logged and
# skipped; otherwise it is logged and executed (its exit status is propagated).
# Args: the command and its arguments.
kiosk_run() {
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would run: $*"
        return 0
    fi
    "$@"
}

# --- backup / restore ----------------------------------------------------

# Absolute path of the backup directory (under KIOSK_ROOT).
# Echo: the fully qualified backup directory path.
kiosk_backup_dir() { kiosk_path /var/backups/llama-kiosk; }

# Idempotently back up a system file before install modifies it. No-op under
# dry-run (logs intent only). Only the FIRST backup is kept, so re-running
# install never clobbers the pristine original. Symlinks are copied as links,
# including dangling links whose targets do not exist. Records
# backup.<name>.existed (true/false) and backup.<name>.path in the manifest.
# Args: $1 = logical name (manifest/file key), $2 = logical source path.
kiosk_backup_file() {
    local name="$1" src_logical="$2" src backup
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would back up $src_logical"
        return 0
    fi
    src="$(kiosk_path "$src_logical")"
    backup="$(kiosk_backup_dir)/$name"
    mkdir -p "$(kiosk_backup_dir)"
    # Already recorded? Preserve the pristine first backup.
    if [ -n "$(kiosk_manifest_get "backup.$name.existed")" ]; then
        return 0
    fi
    if [ -e "$src" ] || [ -L "$src" ]; then
        cp -a "$src" "$backup"
        kiosk_manifest_set "backup.$name.existed" "true"
    else
        kiosk_manifest_set "backup.$name.existed" "false"
    fi
    kiosk_manifest_set "backup.$name.path" "$src_logical"
}

# Restore a previously backed-up file (used by uninstall).
# If existed=true, copies the backup back. If existed=false, removes the file
# that install created. Unknown/unrecorded name -> warn and no-op.
# Arg: $1 = logical name used at backup time.
kiosk_restore_file() {
    local name="$1" existed src_logical src backup
    existed="$(kiosk_manifest_get "backup.$name.existed")"
    src_logical="$(kiosk_manifest_get "backup.$name.path")"
    if [ -z "$existed" ] || [ -z "$src_logical" ]; then
        kiosk_warn "no backup recorded for '$name'; skipping restore"
        return 0
    fi
    src="$(kiosk_path "$src_logical")"
    backup="$(kiosk_backup_dir)/$name"
    if [ "$existed" = "true" ]; then
        kiosk_run cp -a "$backup" "$src"
        kiosk_log "restored $src_logical from backup"
    else
        kiosk_run rm -f "$src"
        kiosk_log "removed $src_logical (no original existed)"
    fi
}

# Find a supported Wayland kiosk browser. Prefer Chrome/Chromium when installed,
# then fall back to Ubuntu Desktop's offline Firefox snap command. Echoes the
# binary name, or fails with installation guidance when none is available.
# Honors KIOSK_FAKE_CHROME=1 to preserve the sandboxed installer test seam.
kiosk_require_browser() {
    if [ "${KIOSK_FAKE_CHROME:-0}" = "1" ]; then printf 'google-chrome\n'; return 0; fi
    local b
    for b in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$b" >/dev/null 2>&1; then printf '%s\n' "$b"; return 0; fi
    done
    if command -v firefox >/dev/null 2>&1; then printf 'firefox\n'; return 0; fi
    kiosk_warn "No supported browser found. Install Firefox, Chrome, or Chromium before continuing."
    return 1
}

# Ensure the `cage` compositor is installed (apt). Records in the manifest
# whether WE installed it, so uninstall can offer to remove it.
kiosk_ensure_cage() {
    if [ "${KIOSK_TEST_CAGE_MISSING:-0}" != 1 ] && command -v cage >/dev/null 2>&1; then
        [ "$(kiosk_manifest_get installed_cage)" = true ] || \
            kiosk_manifest_set installed_cage false
        return 0
    fi
    # In a sandbox we cannot apt-install; just record intent.
    if [ "$KIOSK_ROOT" != "/" ]; then
        kiosk_log "(sandbox) would apt-get install cage"
        kiosk_manifest_set installed_cage true
        return 0
    fi
    kiosk_log "Installing cage (Wayland kiosk compositor)..."
    kiosk_run apt-get update
    kiosk_run apt-get install -y cage
    kiosk_manifest_set installed_cage true
}

# Resolve the snap-compatible home for a dedicated kiosk account.
# Firefox's strict snap confinement permits normal homes under /home without a
# system-wide homedirs override. Arg: $1 = account name. Echo: logical path.
kiosk_account_home() {
    printf '/home/%s\n' "$1"
}

# Ensure the dedicated kiosk account exists. Production installs create a
# locked system account with a writable private home under /home and a normal
# shell so GDM and strict Firefox snap confinement can start the Wayland
# session. Sandboxed installs model the same lifecycle without touching the
# host user database. The manifest records ownership so uninstall never removes
# an account or home that predated Llama Manager.
# Args: $1 = account name.
kiosk_ensure_account() {
    local user="$1" logical_home home existing_home managed
    logical_home="$(kiosk_account_home "$user")"
    home="$(kiosk_path "$logical_home")"
    managed="$(kiosk_manifest_get installed_kiosk_account)"
    if [ "$KIOSK_ROOT" != "/" ]; then
        if [ -d "$home" ]; then
            [ "$managed" = true ] || kiosk_manifest_set installed_kiosk_account false
        else
            kiosk_run mkdir -p "$home"
            kiosk_manifest_set installed_kiosk_account true
        fi
        return 0
    fi
    if id "$user" >/dev/null 2>&1; then
        existing_home="$(getent passwd "$user" | cut -d: -f6)"
        if [ "$existing_home" != "$logical_home" ]; then
            kiosk_warn "existing account '$user' uses '$existing_home', not required home '$logical_home'; refusing to modify it"
            return 1
        fi
        [ "$managed" = true ] || kiosk_manifest_set installed_kiosk_account false
        return 0
    fi
    if { [ -e "$home" ] || [ -L "$home" ]; } && [ "$managed" != true ]; then
        kiosk_warn "$logical_home already exists but is not managed by this installer"
        return 1
    fi
    kiosk_run useradd --system --create-home --home-dir "$logical_home" \
        --shell /bin/bash --user-group "$user"
    kiosk_run chown -R "$user:$user" "$home"
    kiosk_manifest_set installed_kiosk_account true
}

# Remove the dedicated kiosk account only when this installer created it.
# Existing accounts are preserved. Sandboxed installs remove only the modeled
# private home directory.
# Args: $1 = account name.
kiosk_remove_account() {
    local user="$1" logical_home home existing_home
    [ "$(kiosk_manifest_get installed_kiosk_account)" = "true" ] || return 0
    kiosk_record_action remove-account
    [ "$(kiosk_manifest_get session_stopped)" = "true" ] || {
        kiosk_warn "refusing to remove '$user' before its graphical session is stopped"
        return 1
    }
    logical_home="$(kiosk_account_home "$user")"
    home="$(kiosk_path "$logical_home")"
    if [ "$KIOSK_ROOT" != "/" ]; then
        kiosk_run rm -rf "$home"
    elif id "$user" >/dev/null 2>&1; then
        existing_home="$(getent passwd "$user" | cut -d: -f6)"
        if [ "$existing_home" != "$logical_home" ] || [ -L "$home" ]; then
            kiosk_warn "refusing to remove '$user': its account or home no longer matches the managed kiosk resource"
            return 1
        fi
        kiosk_run userdel --remove "$user"
    else
        kiosk_warn "refusing to remove managed home '$logical_home' because account '$user' no longer exists"
        return 1
    fi
    kiosk_manifest_set installed_kiosk_account false
}

# Append an action to the optional test audit log.
# Args: action name.
kiosk_record_action() {
    [ -z "${KIOSK_TEST_ACTION_LOG:-}" ] || printf '%s\n' "$1" >> "$KIOSK_TEST_ACTION_LOG"
}

# Terminate the kiosk user's graphical/login session before runtime or account
# removal. loginctl termination is synchronous; any remaining process prevents
# user deletion rather than orphaning a helper or compositor under a deleted UID.
# Args: account name.
kiosk_stop_session() {
    local user="$1"
    kiosk_record_action stop-session
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would terminate login sessions for $user"
        return 0
    fi
    if [ "$KIOSK_ROOT" = "/" ] && id "$user" >/dev/null 2>&1; then
        if command -v loginctl >/dev/null 2>&1 && loginctl show-user "$user" >/dev/null 2>&1; then
            loginctl terminate-user "$user"
        fi
        if pgrep -u "$user" >/dev/null 2>&1; then
            kiosk_warn "processes for '$user' remain after session termination"
            return 1
        fi
    fi
    kiosk_manifest_set session_stopped true
}

# Install the kiosk launcher, helper, and shared library in a world-traversable
# system location. This is required because the dedicated kiosk account cannot
# be expected to read a source checkout inside an administrator's private home.
# Existing unmanaged content is never overwritten.
# Args: $1 = source repository root.
kiosk_install_runtime() {
    local source_root="$1" logical_dir="/usr/local/lib/llama-manager/kiosk" dest
    dest="$(kiosk_path "$logical_dir")"
    if [ -e "$dest" ] && [ -z "$(kiosk_manifest_get installed_runtime)" ]; then
        kiosk_warn "$logical_dir already exists but is not managed by this installer"
        return 1
    fi
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would install kiosk runtime to $logical_dir"
        return 0
    fi
    mkdir -p "$dest/lib"
    install -m 0755 "$source_root/scripts/llama-kiosk-launch.sh" "$dest/llama-kiosk-launch.sh"
    install -m 0755 "$source_root/scripts/llama-kiosk-control.py" "$dest/llama-kiosk-control.py"
    install -m 0644 "$source_root/scripts/lib/kiosk-common.sh" "$dest/lib/kiosk-common.sh"
    kiosk_manifest_set installed_runtime true
}

# Remove only the kiosk runtime directory created by this installer.
kiosk_remove_runtime() {
    local dest
    [ "$(kiosk_manifest_get installed_runtime)" = "true" ] || return 0
    dest="$(kiosk_path /usr/local/lib/llama-manager/kiosk)"
    kiosk_run rm -rf "$dest"
}

# Set or replace a "key=value" line under an [section]-less or simple INI file,
# appending if absent. Used for gdm custom.conf [daemon] keys.
# Args: $1 = file path, $2 = key, $3 = value.
kiosk_set_ini_key() {
    local file="$1" key="$2" val="$3" tmp
    [ "$KIOSK_DRY_RUN" = "true" ] && { kiosk_log "DRY-RUN would set $key=$val in $file"; return 0; }
    mkdir -p "$(dirname "$file")"
    touch "$file"
    if grep -qE "^${key}=" "$file"; then
        tmp="$(mktemp)"
        sed "s|^${key}=.*|${key}=${val}|" "$file" > "$tmp"
        mv "$tmp" "$file"
    else
        # Ensure a [daemon] section exists, then append the key under it.
        if ! grep -q '^\[daemon\]' "$file"; then
            printf '[daemon]\n' >> "$file"
        fi
        # Append key after the [daemon] header.
        tmp="$(mktemp)"
        awk -v k="$key" -v v="$val" '
            { print }
            /^\[daemon\]/ && !done { print k "=" v; done=1 }
        ' "$file" > "$tmp"
        mv "$tmp" "$file"
    fi
}

# Atomically publish the kiosk Wayland session desktop entry through a
# same-directory regular temp file, never following an existing destination
# symlink. The final entry is mode 0644.
# Arg: $1 = absolute path to llama-kiosk-launch.sh.
kiosk_write_session() {
    local launcher="$1" dest dest_dir temp content
    dest="$(kiosk_path /usr/share/wayland-sessions/llama-kiosk.desktop)"
    content="[Desktop Entry]
Name=Llama Kiosk
Comment=Full-screen Llama Manager dashboard
Exec=$launcher
Type=Application
DesktopNames=llama-kiosk"
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would write session file to $dest"
        return 0
    fi
    dest_dir="$(dirname "$dest")"
    mkdir -p "$dest_dir"
    temp="$(mktemp "$dest_dir/.llama-kiosk.desktop.XXXXXX")"
    if ! printf '%s\n' "$content" > "$temp" ||
        ! chmod 0644 "$temp" ||
        ! mv -Tf "$temp" "$dest"; then
        rm -f "$temp"
        return 1
    fi
    kiosk_log "wrote session entry: $dest"
}

# Full install: checks, backups, gdm autologin, session switch, session entry.
kiosk_install() {
    local user launcher gdm acct
    ensure_root "$@" || true
    user="$(kiosk_target_user)"
    launcher="/usr/local/lib/llama-manager/kiosk/llama-kiosk-launch.sh"
    gdm="$(kiosk_path /etc/gdm3/custom.conf)"
    acct="$(kiosk_path /var/lib/AccountsService/users/$user)"

    kiosk_require_browser >/dev/null
    kiosk_ensure_cage
    kiosk_ensure_account "$user"
    kiosk_install_runtime "$REPO_ROOT"

    # Back up before mutating.
    kiosk_backup_file gdm_custom_conf /etc/gdm3/custom.conf
    kiosk_backup_file "accountsservice_$user" "/var/lib/AccountsService/users/$user"
    kiosk_backup_file wayland_session /usr/share/wayland-sessions/llama-kiosk.desktop
    kiosk_manifest_set target_user "$user"

    # Enable gdm autologin for the user.
    kiosk_set_ini_key "$gdm" WaylandEnable true
    kiosk_set_ini_key "$gdm" AutomaticLoginEnable true
    kiosk_set_ini_key "$gdm" AutomaticLogin "$user"

    # Point the user's session at the kiosk (AccountsService [User] Session=).
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would set Session=llama-kiosk in $acct"
    else
        mkdir -p "$(dirname "$acct")"
        touch "$acct"
        grep -q '^\[User\]' "$acct" || printf '[User]\n' >> "$acct"
        local tmp; tmp="$(mktemp)"
        if grep -qE '^Session=' "$acct"; then
            sed 's|^Session=.*|Session=llama-kiosk|' "$acct" > "$tmp"
        else
            awk '{print} /^\[User\]/ && !d {print "Session=llama-kiosk"; d=1}' "$acct" > "$tmp"
        fi
        mv "$tmp" "$acct"
    fi

    # Generate the session entry.
    kiosk_write_session "$launcher"

    kiosk_manifest_set installed true
    kiosk_log "Kiosk installed."
    kiosk_log "Escape hatches: SSH, or Ctrl+Alt+F3 for a text console."

    # Bring the kiosk up now (no reboot needed) unless --no-start was given.
    if [ "${KIOSK_NO_START:-false}" = "true" ]; then
        kiosk_log "(--no-start) Skipping bring-up. Reboot or run 'restart' to enter the kiosk."
    else
        kiosk_restart "$@"
    fi
}

# Restart the display manager so gdm autologin re-enters the kiosk session,
# bringing the kiosk up (or refreshing it) without a reboot. Uses the generic
# 'display-manager.service' systemd alias so it works regardless of gdm vs gdm3
# unit naming. No-op (logged only) in dry-run or sandbox (--root) mode.
kiosk_restart() {
    ensure_root "$@" || true
    if [ "$KIOSK_ROOT" != "/" ] || [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN/sandbox: would restart display-manager.service to enter the kiosk session"
        return 0
    fi
    kiosk_warn "Restarting the display manager will end any current graphical session."
    kiosk_log "Restarting display manager to enter the kiosk session..."
    kiosk_run systemctl restart display-manager.service
}

# Full uninstall: restore backups, remove the session entry, report cage status.
# Safe to run even if install never completed (missing manifest -> warnings).
# Args: forwarded from the install-kiosk.sh dispatcher (may include --root etc.,
#       already consumed by the parent; ensure_root re-checks privilege).
kiosk_uninstall() {
    local user manifest
    manifest="$(kiosk_manifest_path)"
    if [ ! -f "$manifest" ]; then
        kiosk_log "No recorded kiosk installation found; nothing to uninstall."
        return 0
    fi
    ensure_root "$@" || true
    user="$(kiosk_manifest_get target_user)"
    [ -z "$user" ] && user="$(kiosk_target_user)"
    kiosk_stop_session "$user"

    # Restore every backed-up system file, including a pre-existing session
    # entry. An unrecorded entry is never removed by uninstall.
    kiosk_restore_file gdm_custom_conf
    kiosk_restore_file "accountsservice_$user"
    kiosk_restore_file wayland_session

    kiosk_remove_runtime
    kiosk_remove_account "$user"

    # Report cage (do not auto-remove an apt package).
    if [ "$(kiosk_manifest_get installed_cage)" = "true" ]; then
        kiosk_log "Note: 'cage' was installed by this script. To remove it: sudo apt remove cage"
    fi
    kiosk_log "Kiosk Chrome profile left at \$HOME/.config/llama-kiosk (delete manually if desired)."

    # Mark uninstalled (keep backups dir for audit; manifest reset of 'installed').
    kiosk_manifest_set installed false
    kiosk_log "Kiosk uninstalled. Reboot to return to the normal login screen."
}
