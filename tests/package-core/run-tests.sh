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

test_ctl_reads_path_overrides_from_package_configuration_file() {
  printf 'test_ctl_reads_path_overrides_from_package_configuration_file\n'
  local sandbox output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ctl-env.XXXXXX")"
  printf 'LLAMA_MANAGER_DATA_DIR=%s/state\nLLAMA_MANAGER_CACHE_DIR=%s/cache\nDS4_STATE_DIR=%s/ds4-state\n' \
    "$sandbox" "$sandbox" "$sandbox" > "$sandbox/llama-manager.env"
  output="$(LLAMA_MANAGER_ENV_FILE="$sandbox/llama-manager.env" bash "$REPO_ROOT/scripts/llama-managerctl" paths)"
  assert_contains "ctl reads data root from package configuration" "$output" "data_dir=$sandbox/state"
  assert_contains "ctl reads cache root from package configuration" "$output" "cache_dir=$sandbox/cache"
  assert_contains "ctl reads DS4 state from package configuration" "$output" "ds4_state_dir=$sandbox/ds4-state"
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
  set +e
  persisted="$(LLAMA_MANAGER_ENV_FILE="$sandbox/llama-manager.env" bash "$REPO_ROOT/scripts/llama-managerctl" models path)"

  if [ "$status" -ne 0 ]; then printf '  ok   inaccessible storage is rejected\n';
  else printf '  FAIL inaccessible storage was accepted\n'; failures=$((failures + 1)); fi
  assert_contains "rejection identifies service access" "$output" "service identity"
  assert_contains "failed validation preserves prior model path" "$persisted" "/safe/existing"
  rm -rf "$sandbox"
}

test_canonical_service_assets_are_package_safe() {
  printf 'test_canonical_service_assets_are_package_safe\n'
  local service polkit tmpfiles
  service="$(cat "$REPO_ROOT/llama-manager.service")"
  polkit="$(cat "$REPO_ROOT/packaging/90-llama-manager.rules" 2>/dev/null || true)"
  tmpfiles="$(cat "$REPO_ROOT/packaging/llama-manager.tmpfiles" 2>/dev/null || true)"
  assert_contains "service uses dedicated account" "$service" "User=llama-manager"
  assert_contains "service uses dedicated group" "$service" "Group=llama-manager"
  assert_contains "service code is root-owned FHS content" "$service" "WorkingDirectory=/usr/lib/llama-manager/api"
  assert_contains "service opts into packaged path defaults" "$service" "LLAMA_MANAGER_PACKAGED=1"
  assert_contains "service launches through immutable package code" "$service" "/usr/lib/llama-manager/scripts/run-packaged-service"
  assert_contains "polkit checks manager group" "$polkit" 'subject.isInGroup("llama-manager")'
  # Authority is scoped to an explicit list of package-owned units. The identity
  # unit is in it because renaming has to take effect live, and granting the
  # manager THAT UNIT is narrower than granting it the hostname1 polkit action,
  # which would let it set any hostname over D-Bus. The list is asserted
  # element-by-element, and the absence of a permissive fallthrough is asserted
  # too: widening this rule is a privilege change and should fail the suite until
  # someone states the new intent here.
  assert_contains "polkit authorises the manager unit" "$polkit" '"llama-manager.service"'
  assert_contains "polkit authorises the identity unit" "$polkit" '"llama-manager-identity.service"'
  assert_contains "polkit authorises by explicit unit list" "$polkit" 'units.indexOf(unit) !== -1'
  assert_contains "polkit still gates on the manager group" "$polkit" 'subject.isInGroup("llama-manager")'
  if printf '%s' "$polkit" | grep -qE 'polkit\.Result\.YES' ; then
    :
  else
    fail "polkit rule no longer grants anything"
  fi
  if printf '%s' "$polkit" | grep -qE 'return polkit\.Result\.YES;[[:space:]]*\}[[:space:]]*$' ; then
    fail "polkit grants unconditionally at the end of the rule"
  fi
  assert_contains "tmpfiles provisions rootless Podman runtime before service start" "$tmpfiles" \
    "d /run/llama-manager 0700 llama-manager llama-manager -"
  assert_contains "service reuses the tmpfiles runtime directory" "$service" "RuntimeDirectory=llama-manager"
  assert_contains "service preserves the private runtime mode" "$service" "RuntimeDirectoryMode=0700"
  assert_contains "service permits rootless subordinate-id mapping helpers" "$service" "NoNewPrivileges=no"
  if [[ "$service" == *"NoNewPrivileges=yes"* ]]; then
    printf '  FAIL service blocks rootless Podman newuidmap/newgidmap helpers\n'
    failures=$((failures + 1))
  else
    printf '  ok   service does not block rootless subordinate-id helpers\n'
  fi
  assert_contains "service retains private temporary storage" "$service" "PrivateTmp=yes"
  assert_contains "service retains read-only package and OS trees" "$service" "ProtectSystem=full"
  assert_contains "service retains kernel module protection" "$service" "ProtectKernelModules=yes"
  assert_contains "service retains setuid/setgid creation restrictions" "$service" "RestrictSUIDSGID=yes"
  assert_contains "service bounds mapping helper capabilities to uid and gid setup" "$service" \
    "CapabilityBoundingSet=CAP_SETUID CAP_SETGID"
  assert_contains "service grants Node only the port 80 bind capability" "$service" \
    "AmbientCapabilities=CAP_NET_BIND_SERVICE"
  if [[ "$service" == *"/home/yolan"* ]]; then
    printf '  FAIL canonical service contains a developer home path\n'
    failures=$((failures + 1))
  else
    printf '  ok   canonical service has no developer home path\n'
  fi
}

test_packaged_ds4_uses_root_owned_binary() {
  printf 'test_packaged_ds4_uses_root_owned_binary\n'
  local sandbox output container_binary host_output host_binary
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-ds4-package.XXXXXX")"
  mkdir -p "$sandbox/current"
  printf '#!/bin/sh\n' > "$sandbox/current/ds4-server"
  chmod +x "$sandbox/current/ds4-server"

  output="$(LLAMA_MANAGER_PACKAGED=1 DS4_STATE_DIR="$sandbox" DS4_MODEL=model.gguf \
    bash "$REPO_ROOT/start-ds4.sh" --print-cmd)"
  container_binary="${output%% *}"
  if [ "$container_binary" = "/run/host/usr/lib/llama-manager-ds4/bin/ds4-server" ]; then
    printf '  ok   packaged distrobox launcher maps the package binary through host root\n'
  else
    printf '  FAIL packaged distrobox binary path is %s\n' "$container_binary"
    failures=$((failures + 1))
  fi
  if [[ "$output" == *"$sandbox/current/ds4-server"* ]]; then
    printf '  FAIL packaged launcher selected writable DS4 state binary\n'
    failures=$((failures + 1))
  else
    printf '  ok   packaged launcher ignores writable DS4 state binary\n'
  fi
  host_output="$(LLAMA_MANAGER_PACKAGED=1 DS4_IN_DISTROBOX=0 DS4_STATE_DIR="$sandbox" \
    DS4_MODEL=model.gguf bash "$REPO_ROOT/start-ds4.sh" --print-cmd)"
  host_binary="${host_output%% *}"
  if [ "$host_binary" = "/usr/lib/llama-manager-ds4/bin/ds4-server" ]; then
    printf '  ok   packaged host launcher retains the host package path\n'
  else
    printf '  FAIL packaged host binary path is %s\n' "$host_binary"
    failures=$((failures + 1))
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

test_llama_launcher_maps_package_scripts_into_distrobox() {
  printf 'test_llama_launcher_maps_package_scripts_into_distrobox\n'
  local sandbox output source_output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-container-paths.XXXXXX")"
  output="$(LLAMA_MANAGER_PACKAGED=1 DISTROBOX_CONTAINER=operator-container \
    LLAMA_SERVER_BIN=/tmp/operator-llama MODELS_DIR="$sandbox/models" \
    bash "$REPO_ROOT/start-llama.sh" --print-cmd 2>&1)"
  assert_contains "packaged llama uses fixed ROCm container" "$output" "container=llama-rocm-7.2.4"
  assert_contains "packaged llama maps container launcher through host root" "$output" \
    "launcher=/run/host/usr/lib/llama-manager/container-start.sh"
  assert_contains "packaged llama selects container-owned server" "$output" \
    "llama_server=/usr/local/bin/llama-server"

  source_output="$(DISTROBOX_CONTAINER=source-container LLAMA_SERVER_BIN=/source/llama-server \
    MODELS_DIR="$sandbox/models" bash "$REPO_ROOT/start-llama.sh" --print-cmd 2>&1)"
  assert_contains "source llama preserves configured container" "$source_output" "container=source-container"
  assert_contains "source llama preserves checkout launcher" "$source_output" "launcher=$REPO_ROOT/container-start.sh"
  assert_contains "source llama preserves configured server" "$source_output" "llama_server=/source/llama-server"
  rm -rf "$sandbox"
}

test_preset_launcher_preserves_adversarial_values_as_arguments() {
  printf 'test_preset_launcher_preserves_adversarial_values_as_arguments\n'
  local sandbox marker model_dir model_path switches kwargs hf_repo output hf_output source_output
  local quoted_model_dir quoted_model quoted_switches quoted_kwargs quoted_hf
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-preset-argv.XXXXXX")"
  marker="$sandbox/injected"
  model_dir="$sandbox/models with spaces [literal]"
  model_path="$model_dir/model ' quote \$(touch $marker) ;.gguf"
  switches="--jinja --alias \$(touch $marker) --verbose"
  kwargs="{\"key\":\"quote ' ; \$(touch $marker)\"}"
  hf_repo="org/repo:' \$(touch $marker) ;"
  quoted_model_dir="$(printf '%q' "$model_dir")"
  quoted_model="$(printf '%q' "$model_path")"
  quoted_switches="$(printf '%q' "$switches")"
  quoted_kwargs="$(printf '%q' "$kwargs")"
  quoted_hf="$(printf '%q' "$hf_repo")"

  output="$(LLAMA_MANAGER_PACKAGED=1 DISTROBOX_CONTAINER=operator-container \
    LLAMA_SERVER_BIN=/tmp/operator-llama MODELS_DIR="$model_dir" MODEL_PATH="$model_path" \
    CONTEXT=32768 EXTRA_SWITCHES="$switches" CHAT_TEMPLATE_KWARGS="$kwargs" \
    bash "$REPO_ROOT/start-preset.sh" --print-cmd 2>&1)"
  assert_contains "packaged preset pins ROCm container" "$output" "container=llama-rocm-7.2.4"
  assert_contains "packaged preset pins container binary" "$output" "binary=/usr/local/bin/llama-server"
  assert_contains "preset keeps model directory as one argument" "$output" "arg=$quoted_model_dir"
  assert_contains "preset keeps local model as one argument" "$output" "arg=$quoted_model"
  assert_contains "preset keeps context as a literal argument" "$output" "arg=32768"
  assert_contains "preset reports extra switches without evaluating them" "$output" "extra_switches=$quoted_switches"
  assert_contains "preset keeps chat kwargs as one argument" "$output" "arg=$quoted_kwargs"

  hf_output="$(LLAMA_MANAGER_PACKAGED=1 MODELS_DIR="$model_dir" HF_REPO="$hf_repo" \
    bash "$REPO_ROOT/start-preset.sh" --print-cmd 2>&1)"
  assert_contains "preset keeps Hugging Face reference as one argument" "$hf_output" "arg=$quoted_hf"
  source_output="$(DISTROBOX_CONTAINER=source-container LLAMA_SERVER_BIN=/source/llama-server \
    MODELS_DIR="$model_dir" MODEL_PATH="$model_path" \
    bash "$REPO_ROOT/start-preset.sh" --print-cmd 2>&1)"
  assert_contains "source preset preserves configured container" "$source_output" "container=source-container"
  assert_contains "source preset preserves configured binary" "$source_output" "binary=/source/llama-server"
  if [ -e "$marker" ]; then
    printf '  FAIL preset configuration executed shell content\n'
    failures=$((failures + 1))
  else
    printf '  ok   preset configuration remains inert data\n'
  fi
  rm -rf "$sandbox"
}

test_embed_launcher_pins_packaged_runtime_and_preserves_source_configuration() {
  printf 'test_embed_launcher_pins_packaged_runtime_and_preserves_source_configuration\n'
  local sandbox marker model quoted_model output source_output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-embed-runtime.XXXXXX")"
  marker="$sandbox/injected"
  model="$sandbox/model with spaces ; \$(touch $marker).gguf"
  quoted_model="$(printf '%q' "$model")"

  output="$(LLAMA_MANAGER_PACKAGED=1 DISTROBOX_CONTAINER=operator-container \
    LLAMA_SERVER_BIN=/tmp/operator-server PATH="/tmp/operator-path:$PATH" \
    EMBED_MODEL="$model" bash "$REPO_ROOT/start-embed.sh" --print-cmd 2>&1)"
  assert_contains "packaged embed pins ROCm container" "$output" "container=llama-rocm-7.2.4"
  assert_contains "packaged embed pins container binary" "$output" "binary=/usr/local/bin/llama-server"
  assert_contains "packaged embed keeps model as one inert argument" "$output" "arg=$quoted_model"
  if [[ "$output" == *"operator-container"* || "$output" == *"operator-server"* ]]; then
    printf '  FAIL packaged embed accepted an operator runtime override\n'
    failures=$((failures + 1))
  else
    printf '  ok   packaged embed ignores operator runtime overrides\n'
  fi

  source_output="$(DISTROBOX_CONTAINER=source-container LLAMA_SERVER_BIN=/source/llama-server \
    EMBED_MODEL="$model" bash "$REPO_ROOT/start-embed.sh" --print-cmd 2>&1)"
  assert_contains "source embed preserves configured container" "$source_output" "container=source-container"
  assert_contains "source embed preserves configured binary" "$source_output" "binary=/source/llama-server"
  if [ -e "$marker" ]; then
    printf '  FAIL embed model configuration executed shell content\n'
    failures=$((failures + 1))
  else
    printf '  ok   embed model configuration remains inert data\n'
  fi
  rm -rf "$sandbox"
}

test_router_launcher_preserves_paths_as_single_arguments() {
  printf 'test_router_launcher_preserves_paths_as_single_arguments\n'
  local sandbox marker model_dir slot_dir capture output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-router-argv.XXXXXX")"
  marker="$sandbox/injected"
  model_dir="$sandbox/models with spaces [literal]"
  slot_dir="$sandbox/slots ; \$(touch $marker)"
  capture="$sandbox/argv"
  mkdir -p "$model_dir"
  cat > "$sandbox/capture-server" <<'EOF'
#!/bin/bash
printf '<%s>\n' "$@" > "$CAPTURE_PATH"
EOF
  chmod +x "$sandbox/capture-server"

  CAPTURE_PATH="$capture" LLAMA_SERVER_BIN="$sandbox/capture-server" \
    MODELS_DIR="$model_dir" SLOT_SAVE_PATH="$slot_dir" MODELS_MAX=3 CONTEXT=16384 \
    PORT=8181 GPU_LAYERS=42 NO_WARMUP=1 FLASH_ATTN=1 \
    bash "$REPO_ROOT/container-start.sh" >/dev/null 2>"$sandbox/container-start.stderr"
  output="$(cat "$capture")"
  assert_contains "router keeps model path as one argument" "$output" "<$model_dir>"
  assert_contains "router keeps slot path as one argument" "$output" "<$slot_dir>"
  assert_contains "router retains model limit" "$output" "<3>"
  assert_contains "router retains context" "$output" "<16384>"
  if [ -e "$marker" ]; then
    printf '  FAIL router path executed shell content\n'
    failures=$((failures + 1))
  else
    printf '  ok   router path remains inert data\n'
  fi
  rm -rf "$sandbox"
}

test_packaged_service_uses_declared_offline_node_runtime() {
  printf 'test_packaged_service_uses_declared_offline_node_runtime\n'
  local service contract
  service="$(cat "$REPO_ROOT/llama-manager.service")"
  contract="$(cat "$REPO_ROOT/packaging/runtime-contract.env" 2>/dev/null || true)"
  assert_contains "service executes only through clean environment launcher" "$service" "ExecStart=/usr/bin/env -i /usr/lib/llama-manager/scripts/run-packaged-service"
  assert_contains "service validates package-owned Node before startup" "$service" "/usr/lib/llama-manager/node/bin/node /usr/lib/llama-manager/scripts/check-node-runtime.mjs"
  # distrobox-enter reads $USER directly and aborts with
  # "distrobox-enter: 341: USER: parameter not set" when it is absent. The
  # launcher rebuilds the environment with `env -i`, and a system service has no
  # login session to supply it, so every engine start failed with podman exit
  # 125 on a booted appliance -- the kiosk sat with no engine and the error
  # never reached the manager's log. Verified on hardware: adding USER alone
  # takes the router from exit 125 to listening on 8080.
  local launcher
  launcher="$(cat "$REPO_ROOT/scripts/run-packaged-service")"
  assert_contains "launcher passes USER through for distrobox" "$launcher" "[USER]=llama-manager"
  assert_contains "launcher passes LOGNAME through for distrobox" "$launcher" "[LOGNAME]=llama-manager"
  # The slot cache must resolve INSIDE the engine container, where /var/cache is
  # the container's own filesystem. Only $HOME is mounted through.
  assert_contains "slot cache lives under the mounted service home" "$launcher" "[SLOT_SAVE_PATH]=/var/lib/llama-manager/.cache/llama-slots"
  # A restart must not SIGTERM the engine container that shares this cgroup.
  assert_contains "service restart leaves the engine container alive" "$service" "KillMode=process"
  assert_contains "manifest declares minimum Node" "$contract" "LLAMA_MANAGER_NODE_VERSION_MIN=20.18.1"
  assert_contains "manifest declares bundled Node path" "$contract" "LLAMA_MANAGER_NODE_BIN=/usr/lib/llama-manager/node/bin/node"
  assert_contains "manifest declares sanitized launcher" "$contract" "LLAMA_MANAGER_SERVICE_LAUNCHER=/usr/lib/llama-manager/scripts/run-packaged-service"
  assert_contains "manifest declares the real llama launcher" "$contract" "LLAMA_MANAGER_LLAMA_LAUNCHER=/usr/lib/llama-manager/start-llama.sh"
  assert_contains "manifest declares the embedding launcher" "$contract" "LLAMA_MANAGER_EMBED_LAUNCHER=/usr/lib/llama-manager/start-embed.sh"
  assert_contains "manifest declares the preset launcher" "$contract" "LLAMA_MANAGER_PRESET_LAUNCHER=/usr/lib/llama-manager/start-preset.sh"
  assert_contains "manifest requires the inner container launcher" "$contract" "LLAMA_MANAGER_CONTAINER_START=/usr/lib/llama-manager/container-start.sh"
  assert_contains "manifest declares the DS4 launcher" "$contract" "LLAMA_MANAGER_DS4_LAUNCHER=/usr/lib/llama-manager/start-ds4.sh"
  assert_contains "manifest declares container-visible app root" "$contract" "LLAMA_MANAGER_CONTAINER_APP_ROOT=/run/host/usr/lib/llama-manager"
  assert_contains "manifest declares DS4 package path" "$contract" "LLAMA_MANAGER_DS4_BIN=/usr/lib/llama-manager-ds4/bin/ds4-server"
  assert_contains "manifest declares container-visible DS4 path" "$contract" "LLAMA_MANAGER_CONTAINER_DS4_BIN=/run/host/usr/lib/llama-manager-ds4/bin/ds4-server"
  assert_contains "manifest pins the ROCm distrobox" "$contract" "LLAMA_MANAGER_DISTROBOX_CONTAINER=llama-rocm-7.2.4"
  assert_contains "manifest pins the container llama binary" "$contract" "LLAMA_MANAGER_LLAMA_SERVER_BIN=/usr/local/bin/llama-server"
  assert_contains "manifest declares storage validator path" "$contract" "LLAMA_MANAGER_STORAGE_CHECK=/usr/lib/llama-manager/scripts/check-model-storage.mjs"
  if [[ "$service" == *"ExecStart=/usr/bin/node"* ]]; then
    printf '  FAIL service depends on Ubuntu system Node\n'
    failures=$((failures + 1))
  else
    printf '  ok   service does not depend on Ubuntu system Node\n'
  fi
}

test_packaged_service_rejects_group_config_runtime_injection() {
  printf 'test_packaged_service_rejects_group_config_runtime_injection\n'
  local sandbox output service
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-runtime-injection.XXXXXX")"
  cat > "$sandbox/llama-manager.env" <<'EOF'
LLAMA_MANAGER_PACKAGED=0
LLAMA_MANAGER_NODE_BIN=/tmp/operator-node
DS4_SERVER_BIN=/tmp/operator-ds4
DISTROBOX_CONTAINER=operator-container
LLAMA_SERVER_BIN=/tmp/operator-llama
NODE_OPTIONS=--require=/tmp/operator-code.js
LD_PRELOAD=/tmp/operator-code.so
MODELS_DIR=/mnt/shared/models
API_PORT=4311
EOF

  output="$(bash "$REPO_ROOT/scripts/run-packaged-service" --print-env "$sandbox/llama-manager.env" 2>&1)"
  service="$(cat "$REPO_ROOT/llama-manager.service")"

  assert_contains "packaged mode remains immutable" "$output" "LLAMA_MANAGER_PACKAGED=1"
  assert_contains "Node path remains package owned" "$output" "LLAMA_MANAGER_NODE_BIN=/usr/lib/llama-manager/node/bin/node"
  assert_contains "DS4 path remains package owned" "$output" "DS4_SERVER_BIN=/usr/lib/llama-manager-ds4/bin/ds4-server"
  assert_contains "ROCm container remains package selected" "$output" "DISTROBOX_CONTAINER=llama-rocm-7.2.4"
  assert_contains "llama binary remains container owned" "$output" "LLAMA_SERVER_BIN=/usr/local/bin/llama-server"
  assert_contains "ordinary model storage remains configurable" "$output" "MODELS_DIR=/mnt/shared/models"
  assert_contains "validated API port remains configurable" "$output" "API_PORT=4311"
  if [[ "$output" == *"operator-node"* || "$output" == *"operator-ds4"* ||
        "$output" == *"operator-container"* || "$output" == *"operator-llama"* ||
        "$output" == *"NODE_OPTIONS"* || "$output" == *"LD_PRELOAD"* ]]; then
    printf '  FAIL writable configuration injected executable runtime state\n'
    failures=$((failures + 1))
  else
    printf '  ok   executable runtime injection is discarded\n'
  fi
  if [[ "$service" == *"EnvironmentFile="* ]]; then
    printf '  FAIL service loads writable configuration before its executable\n'
    failures=$((failures + 1))
  else
    printf '  ok   service does not load writable configuration directly\n'
  fi
  assert_contains "service starts through a clean environment" "$service" \
    "ExecStart=/usr/bin/env -i /usr/lib/llama-manager/scripts/run-packaged-service"
  rm -rf "$sandbox"
}

test_packaged_service_rejects_invalid_scalar_configuration() {
  printf 'test_packaged_service_rejects_invalid_scalar_configuration\n'
  local sandbox output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-invalid-scalars.XXXXXX")"
  cat > "$sandbox/llama-manager.env" <<'EOF'
API_PORT=not-a-port
LLAMA_PORT=70000
EMBED_PORT=0
MODELS_MAX=-1
CONTEXT_SIZE=lots
AUTO_START=maybe
STATS_INTERVAL=none
EOF
  output="$(bash "$REPO_ROOT/scripts/run-packaged-service" --print-env "$sandbox/llama-manager.env")"
  assert_contains "invalid API port falls back safely" "$output" "API_PORT=3001"
  assert_contains "invalid llama port falls back safely" "$output" "LLAMA_PORT=8080"
  assert_contains "invalid embedding port falls back safely" "$output" "EMBED_PORT=5252"
  assert_contains "invalid model limit falls back safely" "$output" "MODELS_MAX=2"
  assert_contains "invalid context falls back safely" "$output" "CONTEXT_SIZE=8192"
  assert_contains "invalid autostart falls back safely" "$output" "AUTO_START=true"
  assert_contains "invalid stats interval falls back safely" "$output" "STATS_INTERVAL=1000"
  rm -rf "$sandbox"
}

test_packaged_service_normalizes_autostart_boolean() {
  printf 'test_packaged_service_normalizes_autostart_boolean\n'
  local sandbox disabled enabled
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llama-autostart-bool.XXXXXX")"
  printf 'AUTO_START=0\n' > "$sandbox/llama-manager.env"
  disabled="$(bash "$REPO_ROOT/scripts/run-packaged-service" --print-env "$sandbox/llama-manager.env")"
  assert_contains "numeric zero disables server autostart" "$disabled" "AUTO_START=false"
  printf 'AUTO_START=1\n' > "$sandbox/llama-manager.env"
  enabled="$(bash "$REPO_ROOT/scripts/run-packaged-service" --print-env "$sandbox/llama-manager.env")"
  assert_contains "numeric one enables server autostart" "$enabled" "AUTO_START=true"
  rm -rf "$sandbox"
}

test_packaged_install_helper_is_sourceable
test_packaged_install_exits_with_apt_guidance
test_ctl_reports_overridden_runtime_paths
test_ctl_manages_json_config_without_root
test_ctl_only_targets_llama_manager_service
test_ctl_selects_persistent_model_storage
test_ctl_reads_path_overrides_from_package_configuration_file
test_ctl_rejects_model_storage_unusable_by_service_identity
test_canonical_service_assets_are_package_safe
test_packaged_ds4_uses_root_owned_binary
test_source_ds4_keeps_managed_state_binary
test_llama_launcher_maps_package_scripts_into_distrobox
test_preset_launcher_preserves_adversarial_values_as_arguments
test_embed_launcher_pins_packaged_runtime_and_preserves_source_configuration
test_router_launcher_preserves_paths_as_single_arguments
test_packaged_service_uses_declared_offline_node_runtime
test_packaged_service_rejects_group_config_runtime_injection
test_packaged_service_rejects_invalid_scalar_configuration
test_packaged_service_normalizes_autostart_boolean

if [ "$failures" -ne 0 ]; then
  printf '\n%d failed\n' "$failures"
  exit 1
fi
printf '\nall package-core shell tests passed\n'
