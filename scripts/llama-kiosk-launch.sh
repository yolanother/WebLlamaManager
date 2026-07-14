#!/bin/bash
# Llama Manager — Kiosk session launcher.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Invoked by the "Llama Kiosk" Wayland session (see install-kiosk.sh). Resolves
# the dashboard URL from the canonical packaged manager EnvironmentFile, waits
# until it is reachable, then replaces itself with `cage` running full-screen
# Chrome in kiosk mode.
#
# Starts the separate loopback-only control helper so the local kiosk can switch
# to GDM without adding a remotely reachable API route.
#
# Test seams (env): KIOSK_WAIT_BUDGET (seconds, default 60),
# KIOSK_LAUNCH_ONCE=1 (do not loop or start the helper), KIOSK_URL override.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/kiosk-common.sh
source "$SCRIPT_DIR/lib/kiosk-common.sh"

MANAGER_ENV_FILE="${LLAMA_MANAGER_ENV_FILE:-/etc/llama-manager/llama-manager.env}"
URL="$(kiosk_resolve_url "$MANAGER_ENV_FILE")"
WAIT_BUDGET="${KIOSK_WAIT_BUDGET:-60}"
PROFILE_DIR="${HOME:-/tmp}/.config/llama-kiosk/chrome"
CONTROL_HELPER="$SCRIPT_DIR/llama-kiosk-control.py"

# Start the desktop-session helper only for the real kiosk session. It is bound
# to 127.0.0.1 by its own implementation and validates the dashboard Origin.
start_control_helper() {
    [ "${KIOSK_LAUNCH_ONCE:-0}" = "1" ] && return 0
    if [ -x "$CONTROL_HELPER" ]; then
        python3 "$CONTROL_HELPER" --dashboard-url "$URL" &
    else
        kiosk_warn "local System Login helper is missing or not executable"
    fi
}

# Poll URL until reachable or the time budget is exhausted. Never fatal: after
# the budget, fall through and let Chrome show its own retry page.
wait_for_url() {
    local waited=0
    while [ "$waited" -lt "$WAIT_BUDGET" ]; do
        if curl --silent --output /dev/null --max-time 2 "$URL"; then
            kiosk_log "dashboard reachable at $URL"
            return 0
        fi
        kiosk_log "waiting for $URL ... (${waited}s/${WAIT_BUDGET}s)"
        sleep 2
        waited=$((waited+2))
    done
    kiosk_warn "dashboard not reachable after ${WAIT_BUDGET}s; launching anyway"
    return 0
}

# Pick the Chrome binary.
chrome_bin() {
    local b
    for b in google-chrome google-chrome-stable chromium chromium-browser; do
        command -v "$b" >/dev/null 2>&1 && { printf '%s\n' "$b"; return 0; }
    done
    printf 'google-chrome\n'
}

# Launch cage + Chrome. With KIOSK_LAUNCH_ONCE set, run once (tests); otherwise
# exec so the session lifecycle is tied to the compositor.
launch() {
    local chrome; chrome="$(chrome_bin)"
    local -a cmd=(cage -- "$chrome"
        --kiosk
        --ozone-platform=wayland
        --noerrdialogs
        --disable-infobars
        --no-first-run
        --disable-session-crashed-bubble
        --disable-features=Translate
        --password-store=basic
        "--user-data-dir=$PROFILE_DIR"
        "--app=$URL")
    if [ "${KIOSK_LAUNCH_ONCE:-0}" = "1" ]; then
        "${cmd[@]}"
    else
        exec "${cmd[@]}"
    fi
}

start_control_helper
wait_for_url
launch
