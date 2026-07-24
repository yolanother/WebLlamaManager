#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Installs, enables, disables, or reports the systemd --user units for the
# automatic Llama Manager release service. It copies the paired oneshot service
# and timer into the user's systemd unit directory, reloads the user manager, and
# (on install) enables and starts the timer so the commit watcher begins ticking.
# Everything runs as the invoking user (yolan); no root or sudo is used. This does
# NOT provision the signing passphrase — that one-time operator step is separate
# (see write-passphrase.sh and the README).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SELF_DIR/systemd"
UNIT_DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(llama-manager-release.service llama-manager-release.timer)

usage() { printf 'Usage: install-units.sh {install|enable|disable|uninstall|status}\n'; }

install_units() {
  mkdir -p "$UNIT_DEST"
  local u
  for u in "${UNITS[@]}"; do
    cp "$UNIT_SRC/$u" "$UNIT_DEST/$u"
    printf 'Installed %s\n' "$UNIT_DEST/$u"
  done
  systemctl --user daemon-reload
  systemctl --user enable --now llama-manager-release.timer
  printf 'Enabled and started llama-manager-release.timer\n'
  printf 'Tip: run `loginctl enable-linger %s` so the timer runs without an active login session.\n' "$USER"
}

disable_units() {
  systemctl --user disable --now llama-manager-release.timer || true
  printf 'Disabled llama-manager-release.timer\n'
}

uninstall_units() {
  disable_units
  local u
  for u in "${UNITS[@]}"; do
    rm -f "$UNIT_DEST/$u"
  done
  systemctl --user daemon-reload
  printf 'Removed release-service units from %s\n' "$UNIT_DEST"
}

status_units() {
  systemctl --user status llama-manager-release.timer --no-pager || true
  printf '\n--- next scheduled tick ---\n'
  systemctl --user list-timers llama-manager-release.timer --no-pager || true
}

case "${1:-}" in
  install) install_units ;;
  enable) systemctl --user enable --now llama-manager-release.timer ;;
  disable) disable_units ;;
  uninstall) uninstall_units ;;
  status) status_units ;;
  *) usage >&2; exit 2 ;;
esac
