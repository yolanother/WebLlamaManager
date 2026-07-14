# Portable Llama Manager Host Recovery

`llama-manager-recovery` captures the small, allowlisted configuration needed to
rebuild a Llama Manager appliance after a system disk failure. A bundle is both a
machine-readable input to the restore command and an operator-readable handoff for
Codex or Claude when hardware, users, paths, or NAS addresses have changed.

It is deliberately not a full-system backup. Models, container image blobs,
credentials, browser data, signing keys, and arbitrary home directories are never
copied.

## Commands

Create a backup with the NAS-backed default location:

```bash
sudo scripts/llama-manager-recovery backup
```

The command prints the created bundle path. By default it is:

```text
/volumes/llama-manager/private/system-backups/<host>/<UTC timestamp>/
```

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
| `storage` | Model directory plus NFS source, mountpoint, type, and options as a portable manifest. The mount is reconstructed only from explicit mappings. |
| `platform` | Relevant GRUB defaults and `amdxdna` module blacklist, plus OS, kernel, hardware product, selected firmware/kernel/ROCm package versions, and packaged runtime pins. |

The tool writes sanitized files under `files/`, metadata to `manifest.json`, a
`SHA256SUMS` integrity list, and a self-contained `RECONFIGURE.md`. Inspection,
planning, and restore reject unsupported schemas; planning and restore also reject
bundles whose checksums do not match.

Keys whose names resemble tokens, secrets, passwords, credentials, API keys, or
private keys are replaced with `[REDACTED]`. Restore never writes that marker over a
working secret: it preserves the target host's existing value when one exists and
otherwise omits the setting. Enter missing credentials later through the owning
setup tool.

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

Every selected target is recorded. Existing files are copied under `original/`;
files that did not exist are marked as such. `ROLLBACK.md` explains which originals
to restore and which newly created targets to remove. This preparation happens for
all targets before any configuration is changed.

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
host.
