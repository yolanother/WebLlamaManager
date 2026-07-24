<!--
Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
in the repository root.

Operator + architecture documentation for the fully-automatic, signed Llama
Manager appliance release service: what each component does, how signing is made
non-interactive, the one-time provisioning step, and how to enable, monitor,
disable, and recover it.
-->

# Automatic signed release service

Fully-automatic, no-human-in-the-loop release pipeline for the Llama Manager
appliance. On every new commit to the app's local `main`, it builds, **signs**,
publishes, syncs to the live download host, and verifies a fresh release. It runs
entirely as `yolan` using rootless podman — no root, no sudo.

## Architecture & data flow

```
                 systemd --user timer (every 2 min)
                              │
                              ▼
   watch-main.sh  ── reads app main HEAD; if it differs from the last built
        │             commit, enforces a 10-min QUIET WINDOW (commit must stay
        │             HEAD with no further commits), then fires once:
        ▼
   release-runner.sh  (single-flight lock, logs to logs/release-<ts>.log)
        │
        ├─ 1. Fresh app build in an isolated git worktree
        │       .claude/worktrees/release-appbuild  (detached at the commit)
        │       ui: npm ci && npm run build  →  ui/dist
        │       api: npm ci --omit=dev        →  api/node_modules
        │
        ├─ 2. Run docs/BUILDING.md sequence INSIDE the rootless podman builder
        │       image localhost/llama-manager-builder:24.04
        │       mounts: respin repo → /workspace,  app build → /source (ro),
        │               NAS /volumes/llama-manager → same path (rw)
        │       container-build.sh:
        │         enable-auto-signing.sh all      (preset passphrase, see below)
        │         tests/run.sh
        │         dpkg-buildpackage -us -uc -b     (unsigned .debs)
        │         collect debs + kernel + ubuntu-deps
        │         build-apt-repository.sh          → signs InRelease
        │         assemble-iso-payload.sh
        │         build-iso.sh                     → signs SHA256SUMS.asc
        │       atomic publish → /volumes/llama-manager/public/{apt,images}
        │
        ├─ 3. record last-built-commit
        │
        ├─ 4. rsync public/ → thromgar:/volumes/llama-manager.doubtech.ai/public/
        │       ssh chmod -R a+rX   (world-readable for nginx)
        │
        └─ 5. verify: curl / and /downloads (200), InRelease (200 + good sig),
                ISO Range bytes=0-1023 (206), SHA256SUMS.asc (good sig)
```

The pieces live in two repos:

| Component | Path | Repo |
|---|---|---|
| Signing enabler, passphrase helper, in-container build driver | `scripts/enable-auto-signing.sh`, `scripts/write-passphrase.sh`, `scripts/container-build.sh` | respin (`llama-manager-ubuntu-respin`) |
| Runner, watcher, systemd units, install helper | `distribution/release-service/` | main (`llama-server`) |

## How signing is made non-interactive

The release key (`Llama Manager Release <releases@doubtech.com>`) has a
passphrase-protected signing subkey in the NAS-backed GnuPG home
`/volumes/llama-manager/private/signing/gnupg`. Interactive builds prompt for it
via `pinentry-curses`. To sign unattended:

1. **Agent configuration** (`enable-auto-signing.sh configure`) — idempotently
   adds to that home's `gpg-agent.conf`:
   `allow-preset-passphrase`, `allow-loopback-pinentry`,
   `default-cache-ttl 34560000`, `max-cache-ttl 34560000` (400 days). The existing
   `pinentry-program pinentry-curses` line is left intact, so an operator's
   interactive signing still works exactly as before.
2. **Preset the passphrase** (`enable-auto-signing.sh preset`) — resolves the
   keygrip(s) for the configured 40-hex fingerprint
   (`gpg --with-keygrip --list-secret-keys`) and streams the passphrase from the
   operator's **0600 file** straight into
   `gpg-preset-passphrase --preset <keygrip>` stdin. The passphrase never lands in
   a variable, a command line, an env var, or the log. After this, the subkey is
   cached in the agent; reprepro (which signs `InRelease` via GPGME) and the ISO
   step's `gpg --detach-sign` both pull it from the cache with **no prompt**.
3. **Verify** (`enable-auto-signing.sh verify`) — confirms via
   `gpg-connect-agent 'keyinfo --list'` that a keygrip is cached before the build
   proceeds.

### Container vs host gpg-agent — decision

**The gpg-agent runs INSIDE the builder container**, as recommended. The container
mounts the NAS at `/volumes/llama-manager`, so the signing home *and* the 0600
passphrase file are already visible — no host agent socket is mounted, keeping the
whole toolchain containerized. `enable-auto-signing.sh` creates `/run/user/<uid>`
inside the container so the agent's sockets stay container-local (under the
container's ephemeral `/run`) rather than being written onto the NFS home, which
avoids any collision with a host agent using the same GnuPG home. Rootless podman
maps `yolan` → container root, so the container reads the `yolan`-owned key and
writes published artifacts back as `yolan` on the host.

The signing *identity gates* in the respin build scripts are unchanged: the APT
and ISO builders still verify the secret key, the `FINGERPRINT` metadata, the
armored public key, and the produced signatures against the configured
fingerprint, and abort (before the atomic snapshot flip) on any mismatch. Preset
signing only removes the passphrase prompt; it does not weaken those gates.

## One-time operator provisioning

Done once, by a human, on the build box. Nothing here is stored in git.

```bash
RESPIN=/home/yolan/workspace/ai/llama-server/.claude/worktrees/llama-manager-ubuntu-respin-src

# 1. Write the release-key passphrase into the 0600 file (prompts twice, hidden;
#    never echoes; nothing is passed on the command line).
"$RESPIN"/scripts/write-passphrase.sh
#    -> writes /volumes/llama-manager/private/signing/passphrase  (mode 0600)

# 2. (Optional) validate the whole machinery without the passphrase:
distribution/release-service/release-runner.sh --check     # fast preconditions
distribution/release-service/release-runner.sh --dry-run   # full build, no signed publish

# 3. Enable the automatic service:
distribution/release-service/install-units.sh install
#    (enables + starts llama-manager-release.timer as a --user unit)

# 4. So it runs without an active login session:
loginctl enable-linger yolan
```

After step 3 the service is fully automatic: any new commit on `main` triggers a
signed release ~10 minutes after the last commit in the burst.

## Enable / monitor / disable

```bash
cd /home/yolan/workspace/ai/llama-server/distribution/release-service

./install-units.sh install     # install + enable + start the timer
./install-units.sh status      # timer state + next scheduled tick
./install-units.sh disable     # stop + disable (keeps unit files)
./install-units.sh uninstall   # disable + remove unit files

# Trigger a check manually (independent of the timer):
./watch-main.sh                # one watcher tick
./release-runner.sh            # force a release evaluation now
./release-runner.sh --force    # rebuild even if HEAD == last-built
```

## Logs & state

- `distribution/release-service/logs/release-<UTC-timestamp>.log` — one file per
  release run; `logs/latest.log` symlinks the newest.
- `distribution/release-service/logs/watch.log` — watcher decisions (quiet-window
  progress, triggers).
- `distribution/release-service/state/last-built-commit` — last commit for which a
  signed release was published.
- `state/pending-commit` + `state/pending-since` — the in-flight quiet window.
- `state/runner.lock`, `state/watch.lock` — single-flight `flock` files.
- `journalctl --user -u llama-manager-release.service` — systemd view of ticks.

`logs/` and `state/` are git-ignored.

## Failure recovery

- **Build/sign failure** — the run exits non-zero; `last-built-commit` is *not*
  updated, so the next tick retries. The atomic publisher never touches the live
  `apt`/`images` symlink on a failed build. Read `logs/latest.log`.
- **Passphrase not provisioned / wrong** — `release-runner.sh` refuses to start a
  signed run without the 0600 file; a wrong passphrase makes the in-container
  `enable-auto-signing.sh verify` fail before any publish. Re-run
  `write-passphrase.sh`.
- **rsync/verify failure after a successful signed publish** — the release is
  already live locally and `last-built-commit` is recorded (so no rebuild loop).
  Re-run `./release-runner.sh --force` to re-sync, or rsync manually per the skill.
- **thromgar full (~88% used; an ISO is ~7 GB)** — the runner checks free space
  before syncing and aborts with a clear message if under
  `THROMGAR_MIN_FREE_MIB` (default 9000 MiB). Prune stale
  `releases/{apt,images}/<old-snapshot>` dirs on thromgar (keep current + one
  rollback), then re-run. This is the most common recurring operator action.
- **Builder image missing** — rebuild it:
  `podman build -f "$RESPIN"/Containerfile.builder -t localhost/llama-manager-builder:24.04 "$RESPIN"`.

## Configuration

Defaults are baked into `release-runner.sh` / `watch-main.sh`. To override, copy
`config.env.example` to `config.env` (git-ignored) and set only what differs. The
`config.env` must never contain the passphrase.

## Related

- Respin build sequence: `.../llama-manager-ubuntu-respin-src/docs/BUILDING.md`
- Signing model: `.../docs/SIGNING.md`
- Manual runbook (what this automates): the `build-and-deploy-release` skill.
