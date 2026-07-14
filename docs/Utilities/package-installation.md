# Operating a packaged Llama Manager installation

Packaged installations run continuously as `llama-manager.service` under the
dedicated `llama-manager` account. Application operators join the matching group;
software installation and upgrades still require normal administrator approval.

## Add an operator

```bash
sudo usermod -aG llama-manager "$USER"
```

Log out and back in so the new group membership applies. Then use:

```bash
llama-managerctl status
llama-managerctl restart
llama-managerctl logs -f
llama-managerctl paths
```

The command cannot manage unrelated services or run arbitrary commands as root.

## Configuration

The dashboard remains the normal configuration interface. For recovery and
automation, the CLI can change one dotted JSON key at a time:

```bash
llama-managerctl config get guard.enabled
llama-managerctl config set guard.enabled true
llama-managerctl config set modelsMax 2
llama-managerctl config delete backends.directory
llama-managerctl restart
```

Reads of keys whose names look sensitive are masked. The configuration file is
`/etc/llama-manager/config.json` by default. Allowlisted service path and scalar
settings live in `/etc/llama-manager/llama-manager.env`; do not put private
signing keys there. Supported scalars are `API_PORT`, `LLAMA_PORT`, `EMBED_PORT`,
`MODELS_MAX`, `CONTEXT_SIZE`, `AUTO_START`, and `STATS_INTERVAL`; invalid ports,
numbers, or booleans fall back to package defaults. `AUTO_START=0` and `1` are
normalized to `false` and `true`, respectively.

Persisted JSON settings override these defaults key by key. Missing keys still
inherit the validated service values, including when tmpfiles has created the
initial empty `{}` config. This makes first boot auto-start the bundled model
while preserving an explicit dashboard choice such as `autoStart: false`.

The service does not source that file or load it as a systemd environment file.
A root-owned launcher reads literal values for documented path keys only and
starts Node from an empty environment. Entries such as `NODE_OPTIONS`,
`LD_PRELOAD`, `PATH`, `LLAMA_MANAGER_PACKAGED`, `LLAMA_MANAGER_NODE_BIN`, and
`DS4_SERVER_BIN` are ignored and cannot change the package runtime. The ROCm
Distrobox is fixed at `llama-rocm-7.2.4`, and its llama binary is fixed at
`/usr/local/bin/llama-server`.

## Select model storage

The default model location is `/var/lib/llama-manager/models`. A local disk,
partition, or already-mounted NAS directory can be selected without changing
package-owned code:

```bash
llama-managerctl models set-directory /mnt/ai-models
llama-managerctl restart
llama-managerctl models path
llama-managerctl models list
```

The directory must already exist, be absolute, and be writable by the invoking
operator. The command also validates the full canonical path as the
`llama-manager` service identity before saving it: ancestors need traverse
permission and the target needs read/write/execute. A failure preserves the old
model path. For example, on locally owned storage an administrator can use a
setgid group directory:

```bash
sudo chgrp llama-manager /mnt/ai-models
sudo chmod 2770 /mnt/ai-models
```

For NFS, configure the mount in `/etc/fstab` or a systemd mount unit first and
match server-side ownership/ACLs to the service account. Test the mount after a
reboot before changing `MODELS_DIR`. `llama-managerctl` deliberately does not
edit mounts or request NAS credentials; a future setup UI may guide that
administrator-owned step.

The validator intentionally uses conservative POSIX ownership/mode semantics.
If an NFSv4 ACL grants access that the mode bits do not express, expose an
equivalent `llama-manager` group permission or choose another mountpoint.

## Upgrade safely

Do not run `install.sh` over a packaged installation. It detects the installed
package and exits with the supported commands:

```bash
sudo apt update
sudo apt install --only-upgrade llama-manager llama-manager-rocm-gfx1151 llama-manager-ds4
```

APT verifies repository metadata and package signatures and preserves the
root-owned application tree. `install.sh` remains supported for source-checkout
deployments and continues to create the historical per-user service there.

DS4 follows the same rule. In a package installation, its git self-builder,
manual check/apply operations, and scheduler are disabled; the API returns the
signed-APT command instead. The service never executes DS4 binaries from writable
state.

The dashboard's llama.cpp updater is also source-only. A packaged dashboard
shows the signed-APT command for `llama-manager-rocm-gfx1151` instead of an
update button, and the API rejects attempts to invoke the source updater before
it can stop inference or launch a build.

## Bundled offline Node runtime

The package includes Node 20.18.1 or newer at
`/usr/lib/llama-manager/node/bin/node`. It does not depend on Ubuntu Noble's
`/usr/bin/node`, and service startup validates the bundled version. The private
package/ISO repository must consume `packaging/runtime-contract.env`, stage all
declared files as root-owned/non-group-writable content, and cache the runtime
artifact during the release build so installation works offline.

The contract names `start-llama.sh`, `start-preset.sh`, `start-embed.sh`,
`container-start.sh`, and `start-ds4.sh` explicitly so the package builder can
fail when a required launcher is missing. Inside Distrobox, host `/usr/lib`
content is addressed through `/run/host`; the contract exports both host and
container-visible paths for validation.

Preset, embedding, and router configuration is passed to llama-server as argv,
not evaluated as shell. Model/NAS paths containing whitespace or shell
metacharacters remain a single path argument, while preset switches are
tokenized without `eval`. Package embedding launches always use
`/usr/local/bin/llama-server` inside `llama-rocm-7.2.4`; source installations may
still configure the container and binary.

## Path overrides

Advanced deployments can override `LLAMA_MANAGER_CONFIG_DIR`,
`LLAMA_MANAGER_DATA_DIR`, `LLAMA_MANAGER_CACHE_DIR`, `MODELS_DIR`,
`DS4_GGUF_DIR`, `DS4_STATE_DIR`, and `SLOT_SAVE_PATH` in the package environment
file, along with the validated scalar settings listed above. See
[Package-safe runtime architecture](../Designs/PackageSafeRuntime.md) for
precedence, defaults, and the complete trust-boundary rationale. Unknown keys
and executable/runtime settings in that file are deliberately ignored.
