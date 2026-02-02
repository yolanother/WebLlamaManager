#!/bin/bash
set -euo pipefail

SERVICE_NAME="llama-manager"

echo "=== Llama Manager Uninstallation ==="
echo

echo "Stopping service..."
systemctl --user stop $SERVICE_NAME 2>/dev/null || true

echo "Disabling service..."
systemctl --user disable $SERVICE_NAME 2>/dev/null || true

echo "Removing service file..."
rm -f ~/.config/systemd/user/${SERVICE_NAME}.service

echo "Reloading systemd..."
systemctl --user daemon-reload

echo
echo "Service uninstalled. Project files remain in place."
echo "To fully remove, delete the project directory manually."
