#!/bin/bash
# Llama Manager — Kiosk session launcher.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Invoked by the "Llama Kiosk" Wayland session (see install-kiosk.sh). Resolves
# the dashboard URL from the canonical packaged manager EnvironmentFile, waits
# until it is reachable, then runs `cage` with full-screen Firefox, Chrome, or
# Chromium in kiosk mode and reports the compositor/browser exit status.
# Firefox is the offline-safe Ubuntu Desktop default; the launcher preserves
# its snap-compatible managed HOME when GDM supplies an incomplete environment.
# Chrome-family browsers remain supported when installed.
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
export HOME="${HOME:-/home/llama-kiosk}"
PROFILE_DIR="$HOME/.config/llama-kiosk/chrome"
CONTROL_HELPER="$SCRIPT_DIR/llama-kiosk-control.py"
CONTROL_HELPER_PID=""

# Stop the session-scoped control helper after Cage and its browser exit.
cleanup_control_helper() {
    [ -n "$CONTROL_HELPER_PID" ] || return 0
    kill "$CONTROL_HELPER_PID" 2>/dev/null || true
    wait "$CONTROL_HELPER_PID" 2>/dev/null || true
}
trap cleanup_control_helper EXIT

# Start the desktop-session helper only for the real kiosk session. It is bound
# to 127.0.0.1 by its own implementation and validates the dashboard Origin.
start_control_helper() {
    [ "${KIOSK_LAUNCH_ONCE:-0}" = "1" ] && return 0
    if [ -x "$CONTROL_HELPER" ]; then
        python3 "$CONTROL_HELPER" --dashboard-url "$URL" &
        CONTROL_HELPER_PID=$!
    else
        kiosk_warn "local System Login helper is missing or not executable"
    fi
}

# Poll URL until reachable or the time budget is exhausted. Never fatal: after
# the budget, fall through and let the browser show its own retry page.
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

# Launch cage with a supported browser. Firefox gets its native kiosk/private
# flags and an explicit Wayland environment; Chrome-family browsers retain the
# appliance profile and app-mode flags. Tests may request one launch only.
launch() {
    local browser status
    local -a cmd
    browser="$(kiosk_require_browser)" || return 1
    if [ "$browser" = "$KIOSK_SHELL_BIN" ]; then
        # The shell takes the URL and needs nothing else: it is fullscreen and
        # undecorated by construction, and it shows the appliance's own branded
        # waiting state until the manager is serving.
        cmd=(cage -- "$browser" "$URL")
    elif [ "$browser" = epiphany-browser ]; then
        # --private-instance, NOT --application-mode. Measured on the
        # appliance: --application-mode wants an epiphany WEB APP profile whose
        # directory name encodes a GApplication ID, so a plain directory makes
        # it abort -- "Failed to get GApplication ID from profile directory",
        # SIGTRAP in libglib, and the session died with status 133.
        # --private-instance takes an arbitrary --profile directory, which is
        # what we have. Cage gives the window the whole output either way.
        install -d "$PROFILE_DIR" 2>/dev/null || true
        cmd=(cage -- "$browser" --private-instance "--profile=$PROFILE_DIR" "$URL")
    elif [ "$browser" = firefox ]; then
        cmd=(cage -- env MOZ_ENABLE_WAYLAND=1
            "$browser" --kiosk --private-window "$URL")
    else
        cmd=(cage -- "$browser"
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
    fi
    if "${cmd[@]}"; then
        status=0
    else
        status=$?
    fi
    kiosk_warn "Cage/browser exited with status $status"
    return "$status"
}

start_control_helper
wait_for_url
launch
