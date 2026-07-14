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
`/etc/llama-manager/config.json` by default. Service environment overrides live
in `/etc/llama-manager/llama-manager.env`; do not put private signing keys there.

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
operator. Ensure the `llama-manager` service account/group can traverse and write
it as well. For example, on locally owned storage an administrator can use a
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

## Path overrides

Advanced deployments can override `LLAMA_MANAGER_CONFIG_DIR`,
`LLAMA_MANAGER_DATA_DIR`, `LLAMA_MANAGER_CACHE_DIR`, `MODELS_DIR`,
`DS4_GGUF_DIR`, `DS4_STATE_DIR`, and `SLOT_SAVE_PATH` in the package environment
file. See [Package-safe runtime architecture](../Designs/PackageSafeRuntime.md)
for precedence and defaults.
