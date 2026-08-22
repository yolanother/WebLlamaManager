#!/bin/bash
# Llama Manager — safe source-checkout installer for the local `llm` command.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# Creates or removes the current checkout's per-user CLI symlink. The helper is
# idempotent, supports a test/deployment destination override, and refuses to
# overwrite or remove a command owned by another installation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="${LLAMA_MANAGER_BIN_DIR:-$HOME/.local/bin}"
SOURCE_PATH="$PROJECT_ROOT/cli/llm.js"
DESTINATION="$BIN_DIR/llm"

# Print the public installer contract and destination override.
print_help() {
  cat <<'EOF'
Usage: scripts/install-llm-cli.sh [install|uninstall|--help]

Install or remove this source checkout's dependency-free `llm` command.
The destination defaults to $HOME/.local/bin/llm. Set LLAMA_MANAGER_BIN_DIR
to choose another bin directory without requiring root.
EOF
}

# Install an idempotent symlink while preserving unrelated commands.
install_cli() {
  local current_target=""
  [ -f "$SOURCE_PATH" ] || { printf 'Missing CLI entrypoint: %s\n' "$SOURCE_PATH" >&2; return 1; }
  chmod +x "$SOURCE_PATH"
  mkdir -p "$BIN_DIR"
  if [ -e "$DESTINATION" ] || [ -L "$DESTINATION" ]; then
    if [ -L "$DESTINATION" ]; then current_target="$(readlink "$DESTINATION")"; fi
    if [ "$current_target" != "$SOURCE_PATH" ]; then
      printf 'Refusing to replace unrelated command: %s\n' "$DESTINATION" >&2
      return 1
    fi
  else
    ln -s "$SOURCE_PATH" "$DESTINATION"
  fi
  printf 'CLI installed: %s -> %s\n' "$DESTINATION" "$SOURCE_PATH"
}

# Remove only the symlink that targets this checkout's CLI entrypoint.
uninstall_cli() {
  local current_target=""
  if [ -L "$DESTINATION" ]; then current_target="$(readlink "$DESTINATION")"; fi
  if [ "$current_target" = "$SOURCE_PATH" ]; then
    rm -f "$DESTINATION"
    printf 'Removed source CLI link: %s\n' "$DESTINATION"
  elif [ -e "$DESTINATION" ] || [ -L "$DESTINATION" ]; then
    printf 'Left unrelated llm command untouched: %s\n' "$DESTINATION"
  else
    printf 'No source CLI link installed at %s\n' "$DESTINATION"
  fi
}

case "${1:-install}" in
  install) install_cli ;;
  uninstall) uninstall_cli ;;
  -h|--help|help) print_help ;;
  *) printf 'Unknown action: %s\n' "$1" >&2; print_help >&2; exit 2 ;;
esac
