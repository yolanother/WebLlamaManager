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
`/usr/bin/node`: both `ExecStartPre` and `ExecStart` use the bundled executable,
and the preflight script rejects an undersized runtime.

The same manifest fixes the signed DS4 executable at
`/usr/lib/llama-manager-ds4/bin/ds4-server` plus the package locations of the
runtime and model-storage validators. Everything named by the manifest is
root-owned and non-group-writable. The package/ISO build must acquire these
artifacts while building the release so installation and first boot need no
network access.

## DS4 update boundary

Source installations retain the git fetch/build/smoke/atomic-swap updater and
may execute `DS4_STATE_DIR/current/ds4-server`. Package mode disables its check,
apply, API mutation, and scheduler surfaces. Status instead reports signed APT
as the update manager. `start-ds4.sh` ignores the writable state symlink and
uses only the root-owned DS4 package binary.

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

## Service hardening

`llama-manager.service` is the canonical package system unit. It uses systemd
`ConfigurationDirectory`, `StateDirectory`, `CacheDirectory`, and
`RuntimeDirectory` ownership, clears ambient/bounding capabilities, enables
`NoNewPrivileges`, and makes the operating-system and package trees read-only,
with a narrow exception for `/etc/llama-manager`. GPU device isolation,
home-directory protection, and a globally read-only filesystem are intentionally
not enabled because ROCm and operator-selected local/NAS model storage may live
outside the default state directories and must remain writable.

## Alternatives considered

- **Install and run as the interactive desktop user:** compatible with the old
  installer, but ownership and service lifetime depend on that user and package
  files can be overwritten accidentally.
- **Make `/usr/lib/llama-manager` group-writable:** convenient for in-place
  updates, but bypasses package integrity and turns application configuration
  access into executable-code replacement. Rejected.
- **Grant group members passwordless sudo:** broader than the operational need.
  Unit-scoped polkit plus group-owned mutable files is the narrower boundary.
- **Clone the working machine's filesystem:** not reproducible and captures
  personal state. The package and image instead materialize declared paths and
  services.
