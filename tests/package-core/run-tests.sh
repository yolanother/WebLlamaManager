#!/bin/bash
# Llama Manager — package-safe source installer behavior tests.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# This dependency-free harness verifies that install.sh recognizes an existing
# Debian package installation and exits with signed-APT upgrade guidance before
# it can download dependencies, build assets, or overwrite package-owned files.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s (missing %q)\n' "$description" "$needle"
    failures=$((failures + 1))
  fi
}

test_packaged_install_helper_is_sourceable() {
  printf 'test_packaged_install_helper_is_sourceable\n'
  local result
  result="$(
    EMBED_SEED_LIB=1 . "$REPO_ROOT/install.sh"
    if declare -F llama_manager_is_packaged >/dev/null; then printf 1; else printf 0; fi
  )"
  assert_contains "packaged detection helper is public to shell tests" "$result" "1"
}

test_packaged_install_exits_with_apt_guidance() {
  printf 'test_packaged_install_exits_with_apt_guidance\n'
  local sandbox output status
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-package-test.XXXXXX")"
  : > "$sandbox/.packaged-install"
  output="$(LLAMA_MANAGER_PACKAGE_ROOT="$sandbox" bash "$REPO_ROOT/install.sh" 2>&1)"
  status=$?
  rm -rf "$sandbox"

  assert_contains "packaged install exits successfully" "$status" "0"
  assert_contains "explains package ownership" "$output" "root-owned Debian package"
  assert_contains "uses signed APT upgrade path" "$output" "apt install --only-upgrade llama-manager"
  if [[ "$output" == *"Installing API dependencies"* ]]; then
    printf '  FAIL packaged install continued into source writes\n'
    failures=$((failures + 1))
  else
    printf '  ok   exits before source dependency installation\n'
  fi
}

test_ctl_reports_overridden_runtime_paths() {
  printf 'test_ctl_reports_overridden_runtime_paths\n'
  local output
  output="$(
    LLAMA_MANAGER_CONFIG_DIR=/tmp/llama-config \
    LLAMA_MANAGER_DATA_DIR=/tmp/llama-data \
    LLAMA_MANAGER_CACHE_DIR=/tmp/llama-cache \
    MODELS_DIR=/tmp/llama-models \
    DS4_GGUF_DIR=/tmp/llama-ds4-models \
    DS4_STATE_DIR=/tmp/llama-ds4-state \
    SLOT_SAVE_PATH=/tmp/llama-slots \
      bash "$REPO_ROOT/scripts/llama-managerctl" paths 2>&1
  )"
  assert_contains "ctl reports config directory" "$output" "config_dir=/tmp/llama-config"
  assert_contains "ctl reports model directory" "$output" "models_dir=/tmp/llama-models"
  assert_contains "ctl reports DS4 state directory" "$output" "ds4_state_dir=/tmp/llama-ds4-state"
  assert_contains "ctl reports slot cache directory" "$output" "slot_cache_dir=/tmp/llama-slots"
}

test_ctl_manages_json_config_without_root() {
  printf 'test_ctl_manages_json_config_without_root\n'
  local sandbox output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ctl-config.XXXXXX")"
  printf '{}\n' > "$sandbox/config.json"

  CONFIG_PATH="$sandbox/config.json" bash "$REPO_ROOT/scripts/llama-managerctl" config set guard.enabled true >/dev/null
  output="$(CONFIG_PATH="$sandbox/config.json" bash "$REPO_ROOT/scripts/llama-managerctl" config get guard.enabled)"
  assert_contains "ctl persists nested JSON config" "$output" "true"

  CONFIG_PATH="$sandbox/config.json" bash "$REPO_ROOT/scripts/llama-managerctl" config delete guard.enabled >/dev/null
  output="$(CONFIG_PATH="$sandbox/config.json" bash "$REPO_ROOT/scripts/llama-managerctl" config get guard.enabled 2>&1 || true)"
  assert_contains "ctl reports deleted config keys" "$output" "not set"
  rm -rf "$sandbox"
}

test_ctl_only_targets_llama_manager_service() {
  printf 'test_ctl_only_targets_llama_manager_service\n'
  local sandbox output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ctl-systemd.XXXXXX")"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*"\n' > "$sandbox/systemctl"
  chmod +x "$sandbox/systemctl"

  output="$(LLAMA_MANAGER_SYSTEMCTL="$sandbox/systemctl" bash "$REPO_ROOT/scripts/llama-managerctl" restart)"
  assert_contains "ctl restart targets only canonical unit" "$output" "restart llama-manager.service"
  output="$(LLAMA_MANAGER_SYSTEMCTL="$sandbox/systemctl" bash "$REPO_ROOT/scripts/llama-managerctl" status)"
  assert_contains "ctl status targets only canonical unit" "$output" "status llama-manager.service"
  rm -rf "$sandbox"
}

test_ctl_selects_persistent_model_storage() {
  printf 'test_ctl_selects_persistent_model_storage\n'
  local sandbox model_dir output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ctl-models.XXXXXX")"
  model_dir="$sandbox/nas-models"
  mkdir -p "$model_dir"
  : > "$sandbox/llama-manager.env"
  printf 'process.exit(0);\n' > "$sandbox/accept-storage.mjs"

  LLAMA_MANAGER_ENV_FILE="$sandbox/llama-manager.env" \
    LLAMA_MANAGER_STORAGE_CHECKER="$sandbox/accept-storage.mjs" \
    bash "$REPO_ROOT/scripts/llama-managerctl" models set-directory "$model_dir" >/dev/null
  output="$(LLAMA_MANAGER_ENV_FILE="$sandbox/llama-manager.env" bash "$REPO_ROOT/scripts/llama-managerctl" models path)"
  assert_contains "ctl persists selected model directory" "$output" "$model_dir"
  rm -rf "$sandbox"
}

test_ctl_reads_path_overrides_from_package_environment_file() {
  printf 'test_ctl_reads_path_overrides_from_package_environment_file\n'
  local sandbox output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ctl-env.XXXXXX")"
  printf 'LLAMA_MANAGER_DATA_DIR=%s/state\nLLAMA_MANAGER_CACHE_DIR=%s/cache\nDS4_STATE_DIR=%s/ds4-state\n' \
    "$sandbox" "$sandbox" "$sandbox" > "$sandbox/llama-manager.env"
  output="$(LLAMA_MANAGER_ENV_FILE="$sandbox/llama-manager.env" bash "$REPO_ROOT/scripts/llama-managerctl" paths)"
  assert_contains "ctl reads data root from EnvironmentFile" "$output" "data_dir=$sandbox/state"
  assert_contains "ctl reads cache root from EnvironmentFile" "$output" "cache_dir=$sandbox/cache"
  assert_contains "ctl reads DS4 state from EnvironmentFile" "$output" "ds4_state_dir=$sandbox/ds4-state"
  rm -rf "$sandbox"
}

test_ctl_rejects_model_storage_unusable_by_service_identity() {
  printf 'test_ctl_rejects_model_storage_unusable_by_service_identity\n'
  local sandbox selected output status persisted
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ctl-denied.XXXXXX")"
  selected="$sandbox/operator-only"
  mkdir -p "$selected"
  printf 'MODELS_DIR=/safe/existing\n' > "$sandbox/llama-manager.env"
  printf 'process.stderr.write("service identity cannot write selected storage\\n"); process.exit(1);\n' \
    > "$sandbox/reject-storage.mjs"

  set +e
  output="$(LLAMA_MANAGER_ENV_FILE="$sandbox/llama-manager.env" \
    LLAMA_MANAGER_STORAGE_CHECKER="$sandbox/reject-storage.mjs" \
    bash "$REPO_ROOT/scripts/llama-managerctl" models set-directory "$selected" 2>&1)"
  status=$?
  set -e
  persisted="$(LLAMA_MANAGER_ENV_FILE="$sandbox/llama-manager.env" bash "$REPO_ROOT/scripts/llama-managerctl" models path)"

  if [ "$status" -ne 0 ]; then printf '  ok   inaccessible storage is rejected\n';
  else printf '  FAIL inaccessible storage was accepted\n'; failures=$((failures + 1)); fi
  assert_contains "rejection identifies service access" "$output" "service identity"
  assert_contains "failed validation preserves prior model path" "$persisted" "/safe/existing"
  rm -rf "$sandbox"
}

test_canonical_service_assets_are_package_safe() {
  printf 'test_canonical_service_assets_are_package_safe\n'
  local service polkit
  service="$(cat "$REPO_ROOT/llama-manager.service")"
  polkit="$(cat "$REPO_ROOT/packaging/90-llama-manager.rules" 2>/dev/null || true)"
  assert_contains "service uses dedicated account" "$service" "User=llama-manager"
  assert_contains "service uses dedicated group" "$service" "Group=llama-manager"
  assert_contains "service code is root-owned FHS content" "$service" "WorkingDirectory=/usr/lib/llama-manager/api"
  assert_contains "service opts into packaged path defaults" "$service" "Environment=LLAMA_MANAGER_PACKAGED=1"
  assert_contains "service declares root-owned DS4 binary" "$service" "Environment=DS4_SERVER_BIN=/usr/lib/llama-manager-ds4/bin/ds4-server"
  assert_contains "polkit checks manager group" "$polkit" 'subject.isInGroup("llama-manager")'
  assert_contains "polkit restricts authority to one unit" "$polkit" 'unit == "llama-manager.service"'
  if [[ "$service" == *"/home/yolan"* ]]; then
    printf '  FAIL canonical service contains a developer home path\n'
    failures=$((failures + 1))
  else
    printf '  ok   canonical service has no developer home path\n'
  fi
}

test_packaged_ds4_uses_root_owned_binary() {
  printf 'test_packaged_ds4_uses_root_owned_binary\n'
  local sandbox output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ds4-package.XXXXXX")"
  mkdir -p "$sandbox/current"
  printf '#!/bin/sh\n' > "$sandbox/current/ds4-server"
  chmod +x "$sandbox/current/ds4-server"

  output="$(LLAMA_MANAGER_PACKAGED=1 DS4_STATE_DIR="$sandbox" DS4_MODEL=model.gguf \
    bash "$REPO_ROOT/start-ds4.sh" --print-cmd)"
  assert_contains "packaged launcher selects package binary" "$output" "/usr/lib/llama-manager-ds4/bin/ds4-server"
  if [[ "$output" == *"$sandbox/current/ds4-server"* ]]; then
    printf '  FAIL packaged launcher selected writable DS4 state binary\n'
    failures=$((failures + 1))
  else
    printf '  ok   packaged launcher ignores writable DS4 state binary\n'
  fi
  rm -rf "$sandbox"
}

test_source_ds4_keeps_managed_state_binary() {
  printf 'test_source_ds4_keeps_managed_state_binary\n'
  local sandbox output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ds4-source.XXXXXX")"
  mkdir -p "$sandbox/current"
  printf '#!/bin/sh\n' > "$sandbox/current/ds4-server"
  chmod +x "$sandbox/current/ds4-server"
  output="$(DS4_STATE_DIR="$sandbox" DS4_MODEL=model.gguf bash "$REPO_ROOT/start-ds4.sh" --print-cmd)"
  assert_contains "source launcher retains managed current binary" "$output" "$sandbox/current/ds4-server"
  rm -rf "$sandbox"
}

test_packaged_service_uses_declared_offline_node_runtime() {
  printf 'test_packaged_service_uses_declared_offline_node_runtime\n'
  local service contract
  service="$(cat "$REPO_ROOT/llama-manager.service")"
  contract="$(cat "$REPO_ROOT/packaging/runtime-contract.env" 2>/dev/null || true)"
  assert_contains "service executes package-owned Node" "$service" "ExecStart=/usr/lib/llama-manager/node/bin/node"
  assert_contains "service validates package-owned Node before startup" "$service" "ExecStartPre=/usr/lib/llama-manager/node/bin/node /usr/lib/llama-manager/scripts/check-node-runtime.mjs"
  assert_contains "manifest declares minimum Node" "$contract" "LLAMA_MANAGER_NODE_VERSION_MIN=20.18.1"
  assert_contains "manifest declares bundled Node path" "$contract" "LLAMA_MANAGER_NODE_BIN=/usr/lib/llama-manager/node/bin/node"
  assert_contains "manifest declares DS4 package path" "$contract" "LLAMA_MANAGER_DS4_BIN=/usr/lib/llama-manager-ds4/bin/ds4-server"
  assert_contains "manifest declares storage validator path" "$contract" "LLAMA_MANAGER_STORAGE_CHECK=/usr/lib/llama-manager/scripts/check-model-storage.mjs"
  if [[ "$service" == *"ExecStart=/usr/bin/node"* ]]; then
    printf '  FAIL service depends on Ubuntu system Node\n'
    failures=$((failures + 1))
  else
    printf '  ok   service does not depend on Ubuntu system Node\n'
  fi
}

test_packaged_install_helper_is_sourceable
test_packaged_install_exits_with_apt_guidance
test_ctl_reports_overridden_runtime_paths
test_ctl_manages_json_config_without_root
test_ctl_only_targets_llama_manager_service
test_ctl_selects_persistent_model_storage
test_ctl_reads_path_overrides_from_package_environment_file
test_ctl_rejects_model_storage_unusable_by_service_identity
test_canonical_service_assets_are_package_safe
test_packaged_ds4_uses_root_owned_binary
test_source_ds4_keeps_managed_state_binary
test_packaged_service_uses_declared_offline_node_runtime

if [ "$failures" -ne 0 ]; then
  printf '\n%d failed\n' "$failures"
  exit 1
fi
printf '\nall package-core shell tests passed\n'
