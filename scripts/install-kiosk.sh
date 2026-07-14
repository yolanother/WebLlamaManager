#!/bin/bash
# Llama Manager — Optional kiosk dashboard installer/uninstaller.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Turns this host into a dashboard appliance: on boot, gdm auto-logs into a
# dedicated "Llama Kiosk" Wayland session that runs the `cage` compositor with
# full-screen Chrome pointed at the Llama Manager dashboard. GNOME stays
# installed; uninstall restores the original login behavior from backups taken
# at install time. Standalone and optional — NOT wired into install.sh.
#
# Usage:
#   scripts/install-kiosk.sh install   [--dry-run] [--root DIR] [--no-start]
#   scripts/install-kiosk.sh uninstall [--dry-run] [--root DIR]
#   scripts/install-kiosk.sh restart   [--dry-run] [--root DIR]
#   scripts/install-kiosk.sh --help
#
# install   : configure gdm autologin + kiosk session, then bring it up now.
# uninstall : restore the original login behavior from backups.
# restart   : restart the display manager to (re)enter the kiosk session now,
#             without rebooting (e.g. after the dashboard service restarts).
#
# --dry-run  : print intended actions, change nothing.
# --root     : (testing) relocate all system paths under DIR; skips sudo re-exec.
# --no-start : (install only) configure but do NOT bring the kiosk up now.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION_NAME="llama-kiosk"

# Preserve the original CLI arguments so a sudo re-exec can replay them verbatim
# (the parse loop below consumes "$@" via shift).
ORIG_ARGV=("$@")

# Print usage to stdout.
usage() {
    cat <<'EOF'
Usage:
  scripts/install-kiosk.sh install   [--dry-run] [--root DIR] [--no-start]
  scripts/install-kiosk.sh uninstall [--dry-run] [--root DIR]
  scripts/install-kiosk.sh restart   [--dry-run] [--root DIR]
  scripts/install-kiosk.sh --help

  install    Configure gdm autologin + kiosk session, then bring it up now.
  uninstall  Restore the original login behavior from backups.
  restart    Restart the display manager to (re)enter the kiosk session now,
             without rebooting.

  --dry-run   Print intended actions, change nothing.
  --root DIR  (testing) relocate all system paths under DIR; skips sudo.
  --no-start  (install only) configure but do NOT bring the kiosk up now.
EOF
}

# --- parse arguments -----------------------------------------------------
SUBCMD=""
export KIOSK_DRY_RUN="false"
export KIOSK_NO_START="false"
ROOT_OVERRIDE=""
while [ $# -gt 0 ]; do
    case "$1" in
        install|uninstall|restart) SUBCMD="$1" ;;
        --dry-run)         KIOSK_DRY_RUN="true" ;;
        --no-start)        KIOSK_NO_START="true" ;;
        --root)
            if [ -z "${2:-}" ] || [ "${2#--}" != "${2:-}" ]; then
                echo "Error: --root requires a directory argument." >&2; usage >&2; exit 2
            fi
            ROOT_OVERRIDE="$2"; shift ;;
        -h|--help)         usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [ -z "$SUBCMD" ]; then
    echo "Error: expected 'install', 'uninstall', or 'restart'." >&2
    usage >&2
    exit 2
fi

# Apply sandbox root if provided (testing) before sourcing the library.
if [ -n "$ROOT_OVERRIDE" ]; then
    export KIOSK_ROOT="$ROOT_OVERRIDE"
fi

# shellcheck source=scripts/lib/kiosk-common.sh
source "$SCRIPT_DIR/lib/kiosk-common.sh"

# Re-exec under sudo for real (non-sandboxed, non-dry-run) runs that touch /etc.
# Replays the original CLI arguments (ORIG_ARGV) under sudo so the subcommand
# and flags survive the re-exec.
ensure_root() {
    # Only production root ("/") needs privilege escalation; a --root sandbox
    # (any other value) and dry-run runs never invoke sudo.
    [ "${KIOSK_ROOT%/}" = "" ] || [ "$KIOSK_ROOT" = "/" ] || return 0   # sandbox: skip sudo
    [ "$KIOSK_DRY_RUN" = "true" ] && return 0                            # dry-run: skip sudo
    if [ "$(id -u)" -ne 0 ]; then
        if command -v sudo >/dev/null 2>&1; then
            kiosk_log "Re-executing under sudo for system changes..."
            exec sudo -E "$0" "${ORIG_ARGV[@]}"
        fi
        echo "Error: must run as root (sudo) for system changes." >&2
        exit 1
    fi
}

# The dedicated unprivileged appliance account gdm will auto-login. Keeping the
# kiosk separate ensures the administrator's GNOME session and preferences are
# never repurposed by appliance mode.
# Echo: username.
kiosk_target_user() { printf '%s\n' "${KIOSK_ACCOUNT:-llama-kiosk}"; }

case "$SUBCMD" in
    install)   kiosk_install   "$@" ;;
    uninstall) kiosk_uninstall "$@" ;;
    restart)   kiosk_restart   "$@" ;;
esac
