#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="llama-manager"

echo "=== Llama Manager Installation ==="
echo

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ is required. Current version: $(node -v)"
    exit 1
fi

echo "[1/4] Installing API dependencies..."
cd "$SCRIPT_DIR/api"
npm install

echo
echo "[2/4] Installing UI dependencies and building..."
cd "$SCRIPT_DIR/ui"
npm install
npm run build

echo
echo "[3/4] Setting up systemd user service..."
mkdir -p ~/.config/systemd/user

# Update service file with correct user ID
USER_ID=$(id -u)
sed "s|/run/user/1000|/run/user/$USER_ID|g" "$SCRIPT_DIR/llama-manager.service" > ~/.config/systemd/user/${SERVICE_NAME}.service

# Reload systemd
systemctl --user daemon-reload

echo
echo "[4/4] Installation complete!"
echo
echo "=== Next Steps ==="
echo
echo "1. Enable the service to start on boot:"
echo "   systemctl --user enable $SERVICE_NAME"
echo
echo "2. Start the service now:"
echo "   systemctl --user start $SERVICE_NAME"
echo
echo "3. Check service status:"
echo "   systemctl --user status $SERVICE_NAME"
echo
echo "4. View logs:"
echo "   journalctl --user -u $SERVICE_NAME -f"
echo
echo "5. Access the UI at: http://localhost:3001"
echo "   Llama server runs on: http://localhost:8080"
echo
echo "To enable lingering (keep service running after logout):"
echo "   sudo loginctl enable-linger $USER"
