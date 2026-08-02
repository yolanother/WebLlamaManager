#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Shared credential-file helpers for Llama Manager runtime launchers. The module
# atomically writes mode-0600 container env files beneath the per-user runtime
# directory so Distrobox receives only a file path, never a raw secret in argv.

# Writes one component's protected runtime environment and prints its path.
#
# Arguments:
#   $1 - stable component name used for the env filename
#   $2 - Hugging Face token, which may be empty but must be one line
# Returns:
#   Prints the absolute env-file path on success.
runtime_credentials_write() {
  local component="$1" token="$2"
  local runtime_root="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}/llama-manager-$UID}"
  local credential_dir="$runtime_root/llama-manager"
  local destination="$credential_dir/$component.env"
  local temporary

  [[ "$component" =~ ^[A-Za-z0-9._-]+$ ]] \
    || { printf 'Invalid runtime credential component: %s\n' "$component" >&2; return 1; }
  [[ "$token" != *$'\n'* && "$token" != *$'\r'* ]] \
    || { printf 'Runtime credentials must be single-line values\n' >&2; return 1; }

  umask 077
  mkdir -p "$credential_dir"
  chmod 700 "$credential_dir"
  temporary="$(mktemp "$credential_dir/.${component}.env.XXXXXX")"
  printf 'HF_TOKEN=%s\n' "$token" > "$temporary"
  chmod 600 "$temporary"
  mv -fT "$temporary" "$destination"
  printf '%s\n' "$destination"
}
