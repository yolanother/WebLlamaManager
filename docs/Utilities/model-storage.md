# Model Storage Setup

`scripts/configure-model-storage.sh` selects the model directory used by the
packaged `llama-manager.service`. It supports a normal local directory, an
already-formatted local partition, or a credential-free NFS export. The utility
validates every input, mounts when necessary, verifies that the `llama-manager`
service account can write, and only then updates the canonical package environment:

```text
/etc/llama-manager/llama-manager.env
```

Only `MODELS_DIR` is replaced; unrelated settings are preserved. Root-only
transaction state lives in `/etc/llama-manager/model-storage.state`, and a
generated `llama-manager.service` drop-in adds the required mount dependency.
Paths containing whitespace are intentionally unsupported in this first version.

## First-boot choices

For storage on the Ubuntu root filesystem:

```bash
sudo scripts/configure-model-storage.sh local --path /var/lib/llama-manager/models
```

The package-created `llama-manager` service account and group must already
exist. The directory is created with setgid group access (`2775`). Members of the
`llama-manager` group can add, remove, and organize models without owning the
installed application files.

For an existing data partition:

```bash
sudo scripts/configure-model-storage.sh partition \
  --device /dev/nvme1n1p1 \
  --mountpoint /var/lib/llama-manager/models \
  --fs-type ext4
```

Partition mode never formats a device. It requires an existing ext4, XFS, or
Btrfs filesystem, resolves its UUID with `blkid`, and creates a systemd `.mount`
unit using `/dev/disk/by-uuid/...`. Choose and format partitions with Ubuntu's
disk tools before running this command. Confirm the device carefully: mounting
the wrong existing filesystem may expose unrelated data at the selected path.

For NFS:

```bash
sudo scripts/configure-model-storage.sh nfs \
  --server nas.home \
  --export /volume/models \
  --mountpoint /var/lib/llama-manager/models
```

The default options are `rw,nosuid,nodev,noexec,_netdev`. Common NFS version,
timeout, retransmit, and buffer options may be supplied with `--options`; unsafe
options such as `suid`, `dev`, and `exec` are rejected. The first release stores
no NAS credentials and supports DNS names or IPv4 literals. Configure export
permissions on the NAS so the appliance can change the export root to group
`llama-manager` and mode `2775`. Setup fails and rolls back if that operator
access contract or a service-user write/remove probe fails.

After a successful selection, an already-running manager is restarted onto the
new verified directory before the previous mount is retired. An inactive
manager remains inactive and uses the new configuration on its next start.
Append `--dry-run` to any setup or reset command to preview the operation;
preview mode does not create directories, units, state, or environment changes.

## Safety and rollback

- `/`, `/etc`, `/usr`, `/boot`, `/proc`, `/sys`, `/run`, and `/dev` are rejected
  as model directories, including after resolving final or parent symlinks.
  Relocated-root validation also rejects symlink paths that escape that root.
- Existing non-Llama-Manager systemd mount units are never overwritten.
- Non-empty mountpoints are rejected so a new mount cannot hide existing model
  files.
- A mount unit is rolled back when activation or the write check fails.
- The active service configuration is not written until verification passes.
- Mount-backed modes install explicit `Requires=` and `After=` dependencies so
  the manager cannot fall through to an unmounted underlying directory.
- Reconfiguration preserves prior environment, state, dependency, and mount
  until the candidate is verified. Commit, restart, and old-unit cleanup
  failures restore the prior contract, including manager-env group access, and
  remove the candidate.
- Reset is also transactional: manager environment/state/dependencies are
  restored if the old mount cannot be stopped and removed.
- Write probes are created and removed as `llama-manager`, never as root.
- No command formats a disk or deletes model contents.

To remove the generated service configuration and mount unit while preserving
the directory and all model files:

```bash
sudo scripts/configure-model-storage.sh reset
```

## Portable recovery data

For a local path, `llama-manager.env` records the logical model directory. NFS
and partition modes additionally leave a self-contained systemd `.mount` unit
and service drop-in under `/etc/systemd/system`. A host backup should capture
the canonical environment, root-only state, drop-in, and referenced mount unit.
On a new machine, inspect the restored values and rerun the corresponding setup
command;
for partitions, device names may change but the generated unit uses the stable
filesystem UUID. Never restore an NFS or partition configuration blindly until
the target is reachable and its identity has been confirmed.

## Tests

```bash
bash tests/model-storage/run-tests.sh
```

The integration suite uses relocated temporary roots, generates the same
portable files, and never mounts a host device or export.
