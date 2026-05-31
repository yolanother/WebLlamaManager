#!/bin/bash
# Llama Manager — Kiosk common library.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Shared helpers for scripts/install-kiosk.sh and scripts/llama-kiosk-launch.sh.
# Provides: sandbox-aware path resolution (KIOSK_ROOT), .env-driven KIOSK_URL
# resolution, install-manifest read/write, idempotent file backups, and a
# dry-run-aware command wrapper. This file is meant to be SOURCED, not executed.

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
# Precedence: $KIOSK_URL env > KIOSK_URL= in .env > http://localhost:$API_PORT.
# Arg: $1 = path to a .env file (need not exist).
# Echo: the resolved URL.
kiosk_resolve_url() {
    local env_file="$1" url="" api_port=""
    if [ -n "${KIOSK_URL:-}" ]; then printf '%s\n' "$KIOSK_URL"; return 0; fi
    if [ -f "$env_file" ]; then
        url="$(grep -E '^KIOSK_URL=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | xargs || true)"
        api_port="$(grep -E '^API_PORT=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | xargs || true)"
    fi
    if [ -n "$url" ]; then printf '%s\n' "$url"; return 0; fi
    printf 'http://localhost:%s\n' "${api_port:-3001}"
}
