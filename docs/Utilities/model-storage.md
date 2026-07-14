# Model Storage Setup

`scripts/configure-model-storage.sh` selects the model directory used by the
packaged `llama-manager.service`. It supports a normal local directory, an
already-formatted local partition, or a credential-free NFS export. The utility
validates every input, mounts when necessary, verifies that the `llama-manager`
service account can write, and only then publishes:

```text
/etc/llama-manager/model-storage.conf
```

The package service consumes this file as a systemd `EnvironmentFile`; its
`MODELS_DIR` value is therefore used by the API, downloads, and llama.cpp model
discovery. Paths containing whitespace are intentionally unsupported in this
first version so the same generated file remains portable between systemd and
shell tooling.

## First-boot choices

For storage on the Ubuntu root filesystem:

```bash
sudo scripts/configure-model-storage.sh local --path /var/lib/llama-manager/models
```

The directory is created with setgid group access (`2775`). Members of the
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
permissions on the NAS so the appliance's `llama-manager` account can write.

After a successful selection, restart the manager:

```bash
sudo systemctl restart llama-manager.service
```

## Safety and rollback

- `/`, `/etc`, `/usr`, `/boot`, `/proc`, `/sys`, `/run`, and `/dev` are rejected
  as model directories.
- Existing non-Llama-Manager systemd mount units are never overwritten.
- Non-empty mountpoints are rejected so a new mount cannot hide existing model
  files.
- A mount unit is rolled back when activation or the write check fails.
- The active service configuration is not written until verification passes.
- No command formats a disk or deletes model contents.

To remove the generated service configuration and mount unit while preserving
the directory and all model files:

```bash
sudo scripts/configure-model-storage.sh reset
```

## Portable recovery data

For a local path, `model-storage.conf` records the logical model directory. NFS
and partition modes additionally leave a self-contained systemd `.mount` unit
under `/etc/systemd/system`. A host backup should capture both
`/etc/llama-manager/model-storage.conf` and the referenced mount unit. On a new
machine, inspect the restored values and rerun the corresponding setup command;
for partitions, device names may change but the generated unit uses the stable
filesystem UUID. Never restore an NFS or partition configuration blindly until
the target is reachable and its identity has been confirmed.

## Tests

```bash
bash tests/model-storage/run-tests.sh
```

The integration suite uses relocated temporary roots, generates the same
portable files, and never mounts a host device or export.
