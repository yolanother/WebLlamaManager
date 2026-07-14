# Package-safe runtime architecture

## Decision

Debian installations run Llama Manager as the dedicated `llama-manager` system
user and group. Application code and built UI assets live under
`/usr/lib/llama-manager` and remain root-owned. Configuration, persistent data,
cache files, general models, DS4 models, and DS4 updater state resolve separately
through `api/runtime-paths.js`.

The package service sets `LLAMA_MANAGER_PACKAGED=1`. Source checkouts do not set
that marker and retain the existing checkout-local configuration/data plus
user-home model/cache defaults.

## Path contract

| Resource | Environment override | Package default | Source default |
|---|---|---|---|
| Configuration directory | `LLAMA_MANAGER_CONFIG_DIR` | `/etc/llama-manager` | repository root |
| Configuration file | `CONFIG_PATH` | `/etc/llama-manager/config.json` | `config.json` in repository root |
| Persistent data/analytics | `LLAMA_MANAGER_DATA_DIR` | `/var/lib/llama-manager` | `data/` in repository root |
| Cache root | `LLAMA_MANAGER_CACHE_DIR` | `/var/cache/llama-manager` | `~/.cache/llama-manager` |
| General models | `MODELS_DIR` | `/var/lib/llama-manager/models` | `~/models` |
| DS4 models | `DS4_GGUF_DIR` | `/var/lib/llama-manager/models/ds4` | `~/models-ds4/deepseek-v4-gguf` |
| DS4 state/builds | `DS4_STATE_DIR` | `/var/lib/llama-manager/ds4` | `~/.local/share/ds4` |
| Slot KV cache | `SLOT_SAVE_PATH` | `/var/cache/llama-manager/slots` | `~/.cache/llama-slots` |

Explicit resource overrides win over derived defaults. For example, an explicit
`DS4_GGUF_DIR` is not relocated when `MODELS_DIR` changes.

## Offline runtime contract

The public repository declares the private package builder interface in
`packaging/runtime-contract.env`. The package must bundle Node **20.18.1 or
newer** beneath `/usr/lib/llama-manager/node` and expose its executable at
`/usr/lib/llama-manager/node/bin/node`. The service never assumes Noble's
`/usr/bin/node`: the preflight invokes the bundled executable and the sanitized
service launcher execs that same fixed path. The preflight script rejects an
undersized runtime.

The same manifest fixes the signed DS4 executable at
`/usr/lib/llama-manager-ds4/bin/ds4-server` plus the package locations of the
runtime and model-storage validators. It also enumerates the actual required
launch files: `start-llama.sh`, `start-preset.sh`, the inner
`container-start.sh`, `start-embed.sh`, and `start-ds4.sh` (there is no package
`start.sh`).
Everything named by the manifest is root-owned and non-group-writable. The
package/ISO build must acquire these artifacts while building the release so
installation and first boot need no network access.

Distrobox exposes the host root under `/run/host`. Package launchers therefore
translate only package-owned `/usr/lib` artifacts at the boundary:
`container-start.sh` runs as
`/run/host/usr/lib/llama-manager/container-start.sh`, and the DS4 binary runs as
`/run/host/usr/lib/llama-manager-ds4/bin/ds4-server`. Source installations keep
their checkout and managed-state paths. The ROCm container
`llama-rocm-7.2.4` and its `/usr/local/bin/llama-server` are immutable package
runtime selections rather than group-managed configuration.

## DS4 update boundary

Source installations retain the git fetch/build/smoke/atomic-swap updater and
may execute `DS4_STATE_DIR/current/ds4-server`. Package mode disables its check,
apply, API mutation, and scheduler surfaces. Status instead reports signed APT
as the update manager. `start-ds4.sh` ignores the writable state symlink and
uses only the root-owned DS4 package binary.

## llama.cpp update boundary

Source installations retain the dashboard's git fetch, CMake build, and
install updater. Its checkout defaults to `$HOME/llama.cpp`, can be selected
with `LLAMA_CPP_DIR`, and crosses the shell boundary as a positional argument;
there is no developer-specific home path in the command.

Package mode rejects `POST /api/llama/update` before stopping a running server
or creating any git, CMake, or Distrobox process. The status endpoint identifies
APT as the manager, names `llama-manager-rocm-gfx1151`, and returns the signed
repository upgrade command. The dashboard renders that guidance and does not
render the source-update control.

## Authorization boundary

Members of the `llama-manager` group are trusted application operators, not host
administrators. Package-created mutable paths are owned by
`llama-manager:llama-manager` with group access. `llama-managerctl` exposes only:

- start, stop, restart, status, and logs for `llama-manager.service`;
- dotted JSON configuration get/set/delete, with sensitive reads masked;
- model path inspection, GGUF listing, and selection of an existing writable
  absolute model directory.

Before persisting model storage, `llama-managerctl` evaluates the canonical path
as the fixed service UID/groups: every ancestor must be traversable and the
target must grant read/write/execute. This conservative POSIX-mode check rejects
a directory that only the invoking desktop user can write and leaves the prior
configuration unchanged.

The polkit rule checks both group membership and the exact unit name and permits
only start/stop/restart verbs. It cannot manage other services or install
packages. Software updates remain root-authorized signed-APT operations.

### Mutable configuration is data, not process environment

The group-managed `/etc/llama-manager/llama-manager.env` file is deliberately
not a systemd `EnvironmentFile`. Systemd environment files have no schema and a
later assignment can replace an earlier `Environment=` value; loading this file
directly would let an application operator set `LLAMA_MANAGER_PACKAGED=0`,
`DS4_SERVER_BIN`, or `NODE_OPTIONS` before restarting the allowed service.

Instead, systemd starts the root-owned `run-packaged-service` launcher through
`/usr/bin/env -i`. The launcher reads the mutable file as literal data, accepts
only the documented configuration/data/model/cache paths and validated scalar
settings (`API_PORT`, `LLAMA_PORT`, `EMBED_PORT`, `MODELS_MAX`, `CONTEXT_SIZE`,
`AUTO_START`, and `STATS_INTERVAL`), and then creates a second empty environment
containing those settings plus immutable package mode, Node, DS4, Distrobox,
llama-server, `PATH`, and home values. Port ranges, positive numeric limits, and
the boolean flag are validated before use; numeric `AUTO_START=0/1` is
normalized to the server's `false/true` representation, and invalid values
retain package defaults. The launcher never sources the file. Executable
selectors, language runtime options, dynamic-loader settings, and unknown keys
are discarded. This
preserves group-managed model and configuration paths—including a non-default
dashboard/API port—without converting service restart permission into
service-account code execution.

### Engine settings remain argv, never shell source

Group-managed dashboard configuration can supply model paths, Hugging Face
references, preset switches, chat-template JSON, and slot-cache paths. The
launchers preserve these as data across the Distrobox boundary:

- `start-preset.sh` builds the llama-server argv as a host-side array, then
  passes every value as a positional argument after a fixed single-quoted inner
  script. Package mode also pins the container and binary.
- `start-embed.sh` applies the same fixed-script/positional-argv boundary.
  Package mode ignores `DISTROBOX_CONTAINER`, `LLAMA_SERVER_BIN`, and the
  operator's `PATH` for runtime selection, pinning `llama-rocm-7.2.4` and
  `/usr/local/bin/llama-server`; source mode retains configured values.
- `container-start.sh` builds router arguments in a Bash array and invokes
  `exec "${CMD[@]}"`, so spaces, quotes, semicolons, dollar expressions, and
  glob characters in model/NAS paths cannot split into new arguments or run as
  commands.

The print/test seams use shell escaping only for diagnostics; runtime execution
never reconstructs a command string.

## Service hardening

`llama-manager.service` is the canonical package system unit. It uses systemd
`ConfigurationDirectory`, `StateDirectory`, `CacheDirectory`, and
`RuntimeDirectory` ownership, clears ambient/bounding capabilities, enables
`NoNewPrivileges`, and makes the operating-system and package trees read-only,
with a narrow exception for `/etc/llama-manager`. GPU device isolation,
home-directory protection, and a globally read-only filesystem are intentionally
not enabled because ROCm and operator-selected local/NAS model storage may live
outside the default state directories and must remain writable.

The package tmpfiles declaration creates `/run/llama-manager` as mode `0700`
owned by `llama-manager:llama-manager` before post-install scripts load the
offline ROCm image with rootless Podman. The service's
`RuntimeDirectory=llama-manager` and `RuntimeDirectoryMode=0700` reuse the same
private path, so first install and later service starts share one ownership and
mode contract.

## Alternatives considered

- **Install and run as the interactive desktop user:** compatible with the old
  installer, but ownership and service lifetime depend on that user and package
  files can be overwritten accidentally.
- **Make `/usr/lib/llama-manager` group-writable:** convenient for in-place
  updates, but bypasses package integrity and turns application configuration
  access into executable-code replacement. Rejected.
- **Grant group members passwordless sudo:** broader than the operational need.
  Unit-scoped polkit plus group-owned mutable files is the narrower boundary.
- **Load the group-managed file with systemd `EnvironmentFile=`:** simpler, but
  it makes executable and runtime variables operator-controlled because systemd
  has no per-key allowlist. Rejected in favor of the clean-environment launcher.
- **Clone the working machine's filesystem:** not reproducible and captures
  personal state. The package and image instead materialize declared paths and
  services.
