#!/bin/bash
# Llama Manager — Kiosk common library.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Shared helpers for scripts/install-kiosk.sh and scripts/llama-kiosk-launch.sh.
# Provides sandbox-aware path resolution (KIOSK_ROOT), canonical manager-env
# KIOSK_URL resolution, Firefox/Chrome browser discovery, dedicated-account and
# session lifecycle, normal locked-account validation, persistent
# resource-ownership markers, idempotent backups, terminal uninstall guards,
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

# Resolve the DRM device the compositor should be pinned to, if any.
#
# Returns a /dev/dri/cardN path when the machine has MORE THAN ONE GPU and one
# of them is driven by amdgpu; empty otherwise. Empty means "let wlroots
# choose", which is exactly what a single-GPU appliance -- almost every
# appliance -- has always done, so its display path is unchanged.
#
# WHY THIS EXISTS: with a second GPU present, wlroots picks a render device on
# its own and may pick one it cannot allocate the other card's connected output
# on. Measured on drakemore the moment the NVIDIA driver was installed: cage
# logged "Failed to pick primary buffer format for output 'HDMI-A-2'" followed
# by "Failed to create swapchain" in a hot loop -- 72 errors in two minutes --
# and the APU's output went dark, where the previous boot on nouveau logged
# none. Pinning makes the display path deterministic instead of dependent on
# kernel enumeration order.
#
# The APU is preferred deliberately. It is the appliance's own GPU and the one
# every appliance has, so the kiosk renders identically whether or not a
# discrete card is fitted -- and it leaves the discrete card entirely free for
# compute rather than holding a compositor.
# Echo: the device path, or nothing.
kiosk_drm_devices() {
    local drm amd="" count=0 card driver
    drm="$(kiosk_path /sys/class/drm)"
    [ -d "$drm" ] || return 0
    for card in "$drm"/card[0-9]*; do
        # Only whole cards, never the per-connector nodes (card1-DP-3).
        case "${card##*/}" in *-*) continue ;; esac
        # -L, not -e: sysfs always makes this a symlink, and -e would follow
        # it and reject a card whose driver target is not itself readable.
        [ -L "$card/device/driver" ] || continue
        count=$((count + 1))
        # Last component of the link TEXT, not its resolved target: the name
        # is all we need and this still works if the target is unreadable.
        driver="$(basename "$(readlink "$card/device/driver" 2>/dev/null)" 2>/dev/null || true)"
        if [ "$driver" = amdgpu ] && [ -z "$amd" ]; then amd="/dev/dri/${card##*/}"; fi
    done
    # One GPU needs no pin, and with no AMD card there is nothing to prefer --
    # pinning to a card we have not reasoned about would be a guess.
    [ "$count" -gt 1 ] || return 0
    [ -n "$amd" ] || return 0
    printf '%s\n' "$amd"
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

# The browsers this kiosk will drive, most preferred first.
#
# ORDER IS DELIBERATE AND FIREFOX IS LAST. Measured on the appliance: Ubuntu's
# Firefox is a SNAP, and on a fresh profile it runs its first-run onboarding
# instead of the URL it was handed. It never requested the dashboard once --
# the manager's request log stayed empty across every restart -- while opening
# HTTPS connections to Mozilla infrastructure from an appliance that is
# supposed to work unplugged. Pre-seeding prefs did not help: Firefox 147 moved
# to a new "Profile Groups" layout, so a user.js in the profiles.ini profile is
# not read. That is what a black screen with a cursor looks like from the
# outside: a compositor with nothing mapped on it.
#
# epiphany-browser is a real .deb rather than a snap, so it carries no
# confinement, no vendor onboarding, and no self-updating revision. It is the
# WebKitGTK fallback docs/KIOSK.md already named.
#
# `cog` is deliberately absent despite the docs calling it preferred: it is not
# packaged for noble at all, so recommending it was recommending nothing.
# The appliance's own kiosk shell, installed beside the launcher.
KIOSK_SHELL_BIN="${KIOSK_SHELL_BIN:-/usr/local/lib/llama-manager/kiosk/llama-kiosk-shell.py}"

KIOSK_DEFAULT_BROWSERS='epiphany-browser google-chrome google-chrome-stable chromium chromium-browser firefox'

# Find a supported Wayland kiosk browser. Echoes the binary name, or fails with
# installation guidance when none is available.
#
# LLAMA_KIOSK_BROWSERS overrides the list, space separated, most preferred
# first. docs/KIOSK.md has always documented this override; it was never
# implemented, so an operator who tried to work around a bad browser choice got
# no effect and no error.
#
# Honors KIOSK_FAKE_CHROME=1 to preserve the sandboxed installer test seam.
kiosk_require_browser() {
    if [ "${KIOSK_FAKE_CHROME:-0}" = "1" ]; then printf 'google-chrome\n'; return 0; fi
    # The appliance's OWN shell comes first. It is not a browser and has no
    # browser furniture to suppress -- no chrome, tabs, menus, downloads,
    # navigation, onboarding, or "set as default browser?" prompt. Everything
    # below it is a general-purpose browser kept only as a fallback for an
    # image where the shell is missing.
    if [ -x "$KIOSK_SHELL_BIN" ]; then printf '%s\n' "$KIOSK_SHELL_BIN"; return 0; fi
    local b
    for b in ${LLAMA_KIOSK_BROWSERS:-$KIOSK_DEFAULT_BROWSERS}; do
        if command -v "$b" >/dev/null 2>&1; then printf '%s\n' "$b"; return 0; fi
    done
    kiosk_warn "No supported browser found. Tried: ${LLAMA_KIOSK_BROWSERS:-$KIOSK_DEFAULT_BROWSERS}"
    return 1
}


# Require the `cage` compositor from the appliance's offline package set.
# Runtime package-manager access would make target installation depend on a
# network mirror and can leave GDM selecting a session that cannot start.
kiosk_ensure_cage() {
    if [ "${KIOSK_TEST_CAGE_MISSING:-0}" != 1 ] && command -v cage >/dev/null 2>&1; then
        [ "$(kiosk_manifest_get installed_cage)" = true ] || \
            kiosk_manifest_set installed_cage false
        return 0
    fi
    kiosk_warn "Cage compositor is missing; reinstall the offline appliance package set."
    return 1
}

# Resolve the snap-compatible home for a dedicated kiosk account.
# Firefox's strict snap confinement permits normal homes under /home without a
# system-wide homedirs override. Arg: $1 = account name. Echo: logical path.
kiosk_account_home() {
    printf '/home/%s\n' "$1"
}

# Ensure the dedicated kiosk account exists. Production installs create a
# locked normal account with a writable private home under /home and a normal
# shell so GDM and strict Firefox snap confinement can start the Wayland
# session. Existing accounts must already be normal and locked; the installer
# never changes their credentials. Sandboxed installs model the same lifecycle
# without touching the host user database. The manifest records ownership so
# uninstall never removes an account or home that predated Llama Manager.
# Args: $1 = account name.
kiosk_ensure_account() {
    local user="$1" logical_home home existing_home managed uid uid_min password_state
    logical_home="$(kiosk_account_home "$user")"
    home="$(kiosk_path "$logical_home")"
    managed="$(kiosk_manifest_get installed_kiosk_account)"
    if [ "$KIOSK_ROOT" != "/" ]; then
        if [ -L "$home" ]; then
            kiosk_warn "$logical_home is a symlink; refusing to use it as the kiosk home"
            return 1
        elif [ -e "$home" ] && [ ! -d "$home" ]; then
            kiosk_warn "$logical_home exists but is not a directory"
            return 1
        elif [ -d "$home" ]; then
            [ "$managed" = true ] || kiosk_manifest_set installed_kiosk_account false
        else
            kiosk_run mkdir -p "$home"
            kiosk_manifest_set installed_kiosk_account true
        fi
        return 0
    fi
    if id "$user" >/dev/null 2>&1; then
        existing_home="$(getent passwd "$user" | cut -d: -f6)"
        uid="$(getent passwd "$user" | cut -d: -f3)"
        uid_min="$(awk '$1 == "UID_MIN" { print $2; exit }' /etc/login.defs 2>/dev/null || true)"
        uid_min="${uid_min:-1000}"
        if [ "$existing_home" != "$logical_home" ]; then
            kiosk_warn "existing account '$user' uses '$existing_home', not required home '$logical_home'; refusing to modify it"
            return 1
        fi
        if ! [[ "$uid" =~ ^[0-9]+$ && "$uid_min" =~ ^[0-9]+$ ]] || [ "$uid" -lt "$uid_min" ]; then
            kiosk_warn "existing account '$user' is a system account; refusing to use it for confined Firefox"
            return 1
        fi
        password_state="$(passwd --status "$user" 2>/dev/null | awk '{ print $2 }')"
        if [ "$password_state" != L ]; then
            kiosk_warn "existing account '$user' is not password-locked; refusing to modify its credentials"
            return 1
        fi
        if [ -L "$home" ] || [ ! -d "$home" ]; then
            kiosk_warn "existing account '$user' does not have a real directory at '$logical_home'"
            return 1
        fi
        [ "$managed" = true ] || kiosk_manifest_set installed_kiosk_account false
        return 0
    fi
    if [ -e "$home" ] || [ -L "$home" ]; then
        kiosk_warn "$logical_home already exists while account '$user' is absent; refusing to claim it"
        return 1
    fi
    kiosk_run useradd --create-home --home-dir "$logical_home" \
        --shell /bin/bash --user-group --password '!' "$user"
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
    if [ -e "$dest" ] && [ "$(kiosk_manifest_get installed_runtime)" != true ]; then
        kiosk_warn "$logical_dir already exists but is not managed by this installer"
        return 1
    fi
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would install kiosk runtime to $logical_dir"
        return 0
    fi
    install -d -m 0755 "$dest" "$dest/lib"
    install -m 0755 "$source_root/scripts/llama-kiosk-launch.sh" "$dest/llama-kiosk-launch.sh"
    install -m 0755 "$source_root/scripts/llama-kiosk-control.py" "$dest/llama-kiosk-control.py"
    # The appliance's own shell. Installed unconditionally: kiosk_require_browser
    # prefers it over any browser, and an image that shipped the launcher without
    # it would silently fall back to a general-purpose browser.
    install -m 0755 "$source_root/scripts/llama-kiosk-shell.py" "$dest/llama-kiosk-shell.py"
    install -m 0644 "$source_root/scripts/lib/kiosk-common.sh" "$dest/lib/kiosk-common.sh"
    kiosk_manifest_set installed_runtime true
}

# Remove only the kiosk runtime directory created by this installer.
kiosk_remove_runtime() {
    local dest
    [ "$(kiosk_manifest_get installed_runtime)" = "true" ] || return 0
    dest="$(kiosk_path /usr/local/lib/llama-manager/kiosk)"
    kiosk_run rm -rf "$dest"
    kiosk_manifest_set installed_runtime false
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

# Declare which xdg-desktop-portal backend serves this session.
#
# The session entry sets DesktopNames=llama-kiosk, so XDG_CURRENT_DESKTOP is
# `llama-kiosk` — a desktop name no portal backend claims. xdg-desktop-portal
# then starts, serves nothing, and every request fails.
#
# MEASURED on the appliance: the portal was running and
# `org.freedesktop.portal.Settings` did not exist on it. Firefox logged
# "Failed to read portal settings: ... No such interface" on every launch, and
# epiphany-browser did not survive it at all —
# "libportal-CRITICAL: Failed to create XdpPortal instance: Could not connect:
# Permission denied", then SIGABRT. A kiosk whose browser aborts on startup is
# a black screen with a cursor, which is exactly what the appliance showed.
#
# Ubuntu ships gnome.portal and gtk.portal but maps them only through
# gnome-portals.conf, which applies to GNOME. gtk is the right backend here: it
# is the generic one, it is present on the image, and the kiosk needs Settings
# and OpenURI rather than anything GNOME-specific.
#
# Named for the desktop it serves, per xdg-desktop-portal's
# <desktop>-portals.conf convention, so it applies to this session only and
# leaves a normal desktop session untouched.
# Arg: none.
kiosk_write_portal_config() {
    local dest dest_dir temp content
    dest="$(kiosk_path /usr/share/xdg-desktop-portal/llama-kiosk-portals.conf)"
    content="[preferred]
default=gtk"
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would write portal config to $dest"
        return 0
    fi
    dest_dir="$(dirname "$dest")"
    mkdir -p "$dest_dir"
    temp="$(mktemp "$dest_dir/.llama-kiosk-portals.XXXXXX")"
    if ! printf '%s\n' "$content" > "$temp" ||
        ! chmod 0644 "$temp" ||
        ! mv -Tf "$temp" "$dest"; then
        rm -f "$temp"
        return 1
    fi
    kiosk_log "wrote portal config: $dest"
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
    kiosk_backup_file portal_config /usr/share/xdg-desktop-portal/llama-kiosk-portals.conf
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
        tmp="$(mktemp)"
        if grep -qE '^SystemAccount=' "$acct"; then
            sed 's|^SystemAccount=.*|SystemAccount=false|' "$acct" > "$tmp"
        else
            awk '{print} /^\[User\]/ && !d {print "SystemAccount=false"; d=1}' "$acct" > "$tmp"
        fi
        mv "$tmp" "$acct"
        chmod 0644 "$acct"
    fi

    # Generate the session entry.
    kiosk_write_session "$launcher"

    # And tell xdg-desktop-portal which backend serves it. Without this the
    # session's browser aborts or degrades on a portal that answers nothing.
    kiosk_write_portal_config

    kiosk_manifest_set installed true
    kiosk_log "Kiosk installed."
    # Do NOT promise escape hatches this image does not have. MEASURED on the
    # appliance: Ctrl+Alt+F2 and Ctrl+Alt+F3 reach no TTY, and sshd is not
    # installed on a release target at all -- so the previous message sent an
    # operator whose kiosk had failed to two doors that are not there. Naming a
    # recovery route that does not exist costs more than naming none.
    kiosk_log "If the kiosk fails, recover from GRUB's recovery mode, or enable"
    kiosk_log "diagnostic SSH at install time to reach this machine remotely."

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
    if [ "$(kiosk_manifest_get installed)" = "false" ]; then
        kiosk_log "Kiosk is already uninstalled; nothing to uninstall."
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
