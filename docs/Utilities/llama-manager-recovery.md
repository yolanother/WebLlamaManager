# Portable Llama Manager Host Recovery

`llama-manager-recovery` captures the small, allowlisted configuration needed to
rebuild a Llama Manager appliance after a system disk failure. A bundle is both a
machine-readable input to the restore command and an operator-readable handoff for
Codex or Claude when hardware, users, paths, or NAS addresses have changed.

It is deliberately not a full-system backup. Models, container image blobs,
credentials, browser data, signing keys, and arbitrary home directories are never
copied.

## Trust model

Bundles are configuration inputs with the power to modify system files. The
`SHA256SUMS` file detects corruption and inconsistent payloads; it is **not a
signature** and does not prove who created a bundle. Store and retrieve bundles
only through the access-controlled private NAS path or another authenticated,
trusted channel. Do not restore a bundle received from email, a public download,
or an untrusted share even if its checksums pass.

Every manifest is treated as hostile despite that trust boundary. File entries
must exactly match the compiled category/path allowlist, with no duplicates; NFS
records accept only their fixed schema and a conservative option allowlist. Bundle
symlinks, unknown payloads, unsafe path components, and unsupported field types are
rejected. Backup sources are read through retained, fd-relative `O_NOFOLLOW`
descriptors, so a source parent cannot be swapped after validation to redirect the
read. Root-internal metadata links such as Ubuntu's `/etc/os-release` are resolved
to a canonical in-root path and then reopened through the same descriptor-safe
traversal. External links remain forbidden.

Backup output, hostname, and bundle directories are also created through retained
no-follow descriptors. Every payload, manifest, guide, and checksum write remains
fd-relative to the opened bundle inode through its final fsync. Swapping the lexical
bundle path after creation therefore cannot redirect data to another directory.

## Commands

Create a backup with the NAS-backed default location:

```bash
sudo scripts/llama-manager-recovery backup
```

The command prints the created bundle path. By default it is:

```text
/volumes/llama-manager/private/system-backups/<host>/<UTC timestamp>/
```

The configured/default backup root is canonicalized before its descriptor-safe
directory traversal. This supports a root-managed volume alias such as
`/volumes -> /mnt/nas/volumes` and the printed bundle path is the canonical mount
path. Arbitrary symbolic links supplied through a different explicit
`--output-dir` remain rejected. The backup must run with `sudo` on a production
desktop because GDM and AccountsService configuration can be root-readable only.

Set `LLAMA_MANAGER_RECOVERY_DIR` in the invoking environment or pass
`--output-dir` to relocate it. Private build infrastructure may source that value
from its `.env`, but this public tool never reads `.env` itself because the file may
also contain tokens.

Inspect a bundle without printing captured configuration values:

```bash
scripts/llama-manager-recovery inspect /path/to/bundle
```

Compare it with the current host without changing anything:

```bash
scripts/llama-manager-recovery plan /path/to/bundle
```

The plan names every host-specific mapping required before restore. Supply mappings
as repeated `--map KEY=VALUE` arguments. For example:

```bash
scripts/llama-manager-recovery plan /path/to/bundle \
  --map host.hostname=new-host \
  --map storage.models_dir=/mnt/ai-models \
  --map nfs.0.source=new-nas:/ai-models \
  --map nfs.0.mountpoint=/mnt/ai-models \
  --map kiosk.user=llama-kiosk
```

Always preview an explicitly selected set of categories:

```bash
sudo scripts/llama-manager-recovery restore /path/to/bundle \
  --dry-run \
  --categories manager,service,kiosk,storage \
  --map host.hostname=new-host \
  --map storage.models_dir=/mnt/ai-models \
  --map nfs.0.source=new-nas:/ai-models \
  --map nfs.0.mountpoint=/mnt/ai-models \
  --map kiosk.user=llama-kiosk
```

Remove `--dry-run` only after reviewing the JSON plan. Applying to the real `/`
root requires root. `--root` relocates system paths and exists for staging and the
automated replacement-host tests; it should not be used as a substitute for a
chroot-aware provisioning workflow.

## Captured categories

| Category | Captured material |
|---|---|
| `manager` | Packaged manager configuration under `/etc/llama-manager` and `/etc/default/llama-manager`. |
| `service` | The system service and its allowlisted override file. |
| `kiosk` | GDM kiosk settings, the `llama-kiosk` AccountsService record, and its Wayland session entry. |
| `storage` | Model directory plus NFS source, mountpoint, type, and options as a portable manifest. The selected mapped model directory is created as the `llama-manager` account/group with setgid `2775`; missing production identities, regular-file collisions, incorrectly owned existing directories, and protected system paths are rejected. The mount is reconstructed only from explicit mappings. |
| `platform` | Relevant GRUB defaults and `amdxdna` module blacklist, plus OS, kernel, hardware product, selected firmware/kernel/ROCm package versions, and packaged runtime pins. |

The tool writes sanitized files under `files/`, metadata to `manifest.json`, a
`SHA256SUMS` integrity list, and a self-contained `RECONFIGURE.md`. Inspection,
planning, and restore reject unsupported schemas; planning and restore also reject
bundles whose checksums do not match.

Keys whose names resemble tokens, secrets, passwords, credentials, API keys, or
private keys are replaced with `[REDACTED]`. Strings containing credential
assignments, URL userinfo, or sensitive URL query parameters are redacted as a
complete value even when the URL is embedded in arbitrary text or the secret is a
quoted multi-word assignment; safe fragments from that value are not copied. Restore never writes
the marker over a working value: it preserves the target host's complete existing
value when one exists and otherwise omits the setting. Enter missing credentials
later through the owning setup tool.

## Replacement-host procedure

1. Install the same or a compatible Llama Manager appliance/package release.
2. Copy one bundle locally and run `inspect`; stop if checksums are invalid.
3. Run `plan`. Compare OS, kernel, firmware, product, runtime, and package metadata
   with the replacement hardware rather than blindly trying to reproduce versions.
4. Verify NAS reachability outside the tool. Decide the new NFS source and local
   model mount path, then provide both mappings explicitly.
5. Choose the replacement kiosk account and model directory. Do not reuse a source
   username merely because it appears in the bundle.
6. Run `restore --dry-run --categories ...` and review every create/replace action.
7. Apply only the reviewed categories. Reload systemd after service changes; update
   GRUB only after separately reviewing platform changes.
8. Re-enter credentials, verify mounts, start the service, and exercise the kiosk
   before deleting rollback material.

A useful request to Codex or Claude is: “Inspect this recovery bundle, compare its
manifest with this replacement Ryzen AI Max host, propose explicit mappings, and
run only a dry-run. Do not apply anything until I approve the plan.”

## Rollback

Before the first target write, restore creates:

```text
/var/backups/llama-manager-recovery/<UTC timestamp>/
```

Every selected target is recorded. Existing files are copied under `original/` with
their owner, group, and mode; files that did not exist are marked as such. New
manager configuration uses a restrictive `0640` policy and AccountsService records
use `0600`. Existing targets retain their original metadata. Bundle and rollback
roots use `0700` because rollback originals may contain target-host credentials.

The rollback manifest and `ROLLBACK.md` are fsynced in `prepared` state before the
first target mutation. File replacement is atomic. A successful transaction records
`completed`; a mid-apply failure automatically restores prepared originals in
reverse order and records `rolled_back` (or `rollback_failed` if operator action is
still required). Restore file access and replacement use fd-relative `O_NOFOLLOW`
operations, rejecting every symlink ancestor and preventing a checked parent from
being swapped before the write. Replacement ownership and permissions are applied
to the temporary inode before its file fsync and atomic rename, so the renamed file
is durably synchronized with its final metadata. Directory creation and rollback
deletion fsync their parents before the durable transaction state advances. This
preparation happens for all targets before any configuration is changed.

## Explicit exclusions

- passwords, tokens, credentials, and API/private keys;
- release-signing private keys and revocation material;
- `/etc/machine-id`, SSH keys, browser profiles, and password databases;
- arbitrary home-directory data;
- GGUF/model data and container image blobs.

Signing-key recovery belongs to the private release-signing setup, not this host
configuration bundle. Keep that NAS directory access-controlled separately.

## Tests

```bash
python3 -m unittest tests.recovery.test_recovery -v
```

The tests use only temporary `--root` trees and never inspect or mutate the active
host. Deterministic race seams verify that swapping a validated source parent or a
created output bundle cannot redirect reads or writes.
