#!/bin/bash
# Llama Manager — source-checkout user-service and local CLI uninstaller.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# Stops and disables the per-user manager service and removes only the `llm`
# command symlink owned by this source checkout. Project files, models, and any
# unrelated command at the same destination remain untouched.

set -euo pipefail

SERVICE_NAME="llama-manager"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Llama Manager Uninstallation ==="
echo

echo "Stopping service..."
systemctl --user stop $SERVICE_NAME 2>/dev/null || true

echo "Disabling service..."
systemctl --user disable $SERVICE_NAME 2>/dev/null || true

echo "Removing service file..."
rm -f ~/.config/systemd/user/${SERVICE_NAME}.service

echo "Removing local CLI link..."
"$SCRIPT_DIR/scripts/install-llm-cli.sh" uninstall

echo "Reloading systemd..."
systemctl --user daemon-reload

echo
echo "Service uninstalled. Project files remain in place."
echo "To fully remove, delete the project directory manually."
