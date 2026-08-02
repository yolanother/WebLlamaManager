---
name: build-and-deploy-release
description: Build and publish a NEW Llama Manager appliance release — fresh signed .deb packages + APT repo + ISO from current `main` — then sync it to the live download site (llama-manager.doubtech.ai on thromgar) and verify. Use when asked to "cut a release", "rebuild the packages/ISO", "publish a new appliance build", "update the downloads", "push the latest app into the ISO/APT repo", or "ship the respin". Covers the app build, the standalone respin build repo sequence (per its docs/BUILDING.md), the GPG signing pinentry caveat, the atomic publish, the thromgar rsync, and the public-URL verification. NOT for restarting the dev server (use deploy-llama-manager) or rebuilding llama.cpp (use build-llama-cpp).
---

# Build & deploy a Llama Manager appliance release

This ships the **distribution** (installable .deb packages, a signed APT repo, and a
bootable ISO) — not the dev server. It pulls the current `main` app into fresh release
artifacts, publishes them atomically to the NAS public tree, syncs to the live site on
thromgar, and verifies the public URLs.

Two repos are involved:

| Role | Path | Branch |
|---|---|---|
| App (UI + API) | `/home/yolan/workspace/ai/llama-server` | `main` |
| Respin / build infra (standalone repo) | `/home/yolan/workspace/ai/llama-server/.claude/worktrees/llama-manager-ubuntu-respin-src` | `main` |

The respin repo is the authority for the build sequence — see its
`docs/BUILDING.md` and `docs/SIGNING.md`. This skill is the operational runbook layered
on top.

## Prefer the automatic release service (unattended, signed)

There is now a **fully-automatic** signed release pipeline that does everything this
skill describes — build, **sign**, publish, sync to thromgar, and verify — with no
human in the loop, triggered on every new commit to app `main`. It runs as `yolan`
via rootless podman. Use it instead of the manual steps below whenever it is
provisioned.

- Orchestration, watcher, systemd `--user` units, docs:
  `distribution/release-service/` (see its `README.md`).
- Build-step scripts in the respin repo: `scripts/enable-auto-signing.sh`
  (preset passphrase → gpg-agent), `scripts/write-passphrase.sh` (one-time operator
  helper), `scripts/container-build.sh` (BUILDING.md sequence inside the builder).
- One-time operator provisioning (then it is hands-off):
  ```bash
  RESPIN=/home/yolan/workspace/ai/llama-server/.claude/worktrees/llama-manager-ubuntu-respin-src
  "$RESPIN"/scripts/write-passphrase.sh                       # writes the 0600 passphrase file
  distribution/release-service/release-runner.sh --check       # validate (no passphrase)
  distribution/release-service/install-units.sh install        # enable the timer
  loginctl enable-linger yolan
  ```
- Manual one-off through the same machinery:
  `distribution/release-service/release-runner.sh [--force]`
  (or `--dry-run` for an unsigned rehearsal).

**How unattended signing works** (removes the operator-pinentry gate described just
below): `enable-auto-signing.sh` configures the signing GnuPG home's gpg-agent for
`allow-preset-passphrase`, resolves the signing subkey keygrip, and presets the
passphrase (streamed from the 0600 file into `gpg-preset-passphrase`, never printed)
into a **container-local gpg-agent**. reprepro's `InRelease` and the ISO's
`gpg --detach-sign SHA256SUMS.asc` then sign from the agent cache with no prompt. The
respin fingerprint gates are unchanged. The rest of this skill remains the reference
for the manual/interactive path and for understanding each step.

## ⚠️ Manual/interactive path: signing needs an operator passphrase

The two publish steps — `build-apt-repository.sh` (signs `InRelease`) and
`build-iso.sh` (signs `SHA256SUMS.asc`) — sign with the NAS-backed release key
`Llama Manager Release <releases@doubtech.com>`
(fingerprint `D544…A8`, in `build.env` as `SIGNING_KEY_FINGERPRINT`).

That key's signing subkey is **passphrase-protected and the passphrase is NOT stored
anywhere** (not in `build.env`, not in the repo — deliberately, per `docs/SIGNING.md`;
it lives only in the operator's password manager). The dedicated GPG agent
(`/volumes/llama-manager/private/signing/gnupg/gpg-agent.conf`) is pinned to
`pinentry-curses` with no loopback and no cached-passphrase TTL. So:

- **An automated/agent session CANNOT sign** — reprepro / gpg will block on an
  interactive `pinentry-curses` passphrase prompt (or fail under `--batch`).
- **A human operator MUST run the two signing steps in a real terminal** and type the
  passphrase at the curses prompt. Everything before signing (app build, tests,
  unsigned `dpkg-buildpackage -us -uc -b`) is safe to automate.

Check cache state before assuming (does NOT prompt):

```bash
GNUPGHOME=/volumes/llama-manager/private/signing/gnupg \
  gpg-connect-agent 'keyinfo --list' /bye
# In each S KEYINFO line, field 6 is the cache flag: `-` = not cached (will prompt),
# `1` = cached (an operator recently entered it; short window to sign unattended).
```

If you are an agent and the key is not cached: **do the non-signing steps, then STOP and
hand the two signing commands to the operator.**

---

## Step 0 — Preconditions

```bash
APP=/home/yolan/workspace/ai/llama-server
RESPIN=$APP/.claude/worktrees/llama-manager-ubuntu-respin-src

# NAS must be mounted read-write (public + private on the same filesystem).
findmnt -T /volumes/llama-manager

# Signing status must show "configured" with the expected fingerprint.
"$RESPIN"/scripts/setup-signing.sh status

# Release config must validate (reads the NAS build.env via the .env symlink).
"$RESPIN"/scripts/release-config.sh validate

# Build tooling on the host.
for t in dpkg-buildpackage dh reprepro xorriso podman gpg lintian; do command -v $t; done
```

**If `dh`/`reprepro`/`xorriso`/`lintian` are missing** (the Strix Halo box is not always
provisioned for Debian builds), either install them —
`sudo apt-get install apt-rdepends build-essential debhelper devscripts reprepro xorriso cloud-init gnupg podman xz-utils`
— or run the whole build inside the pinned disposable builder container (podman is
present), per `docs/BUILDING.md`:

```bash
cd "$RESPIN"
podman build -f Containerfile.builder -t localhost/llama-manager-builder:24.04 .
# then run Steps 2–4 inside it with this repo at /workspace, the app checkout
# read-only at /source, inputs read-only at /inputs, and the NAS trees mounted.
# NEVER bake the signing home or .env into the image — signing still runs on the host.
```

Heavy inputs (base ISO, ROCm 7.2.4 OCI, Qwen3-8B GGUF, DS4 binary, Node tar, kernel
debs, ubuntu-dependency debs) are already staged under
`/volumes/llama-manager/private/inputs/<snapshot>/` from a prior build. **Reuse them** —
they are pinned in `config/assets.lock` and re-verified by
`scripts/verify-asset-locks.sh`. Do NOT re-download unless an asset-lock check reports a
mismatch.

```bash
INPUTS=/volumes/llama-manager/private/inputs/20260714T235007Z-production   # newest staged set
ls -la "$INPUTS"
```

## Step 1 — Build the app from current `main` (isolated checkout)

Build `ui/dist` and production `api/node_modules` in a **throwaway worktree** so the
live `main` working tree (which runs the dev server) is never dirtied.

```bash
cd "$APP"
# --detach: `main` is already checked out in the primary tree, so grab its commit
# detached rather than re-checking-out the branch.
git worktree add --detach .claude/worktrees/release-appbuild main
SRC="$APP/.claude/worktrees/release-appbuild"

# UI: produces ui/dist (vite build).
cd "$SRC/ui" && npm ci && npm run build

# API: production deps only.
cd "$SRC/api" && npm ci --omit=dev

# Sanity — the payload builder requires these three.
test -f "$SRC/ui/dist/index.html"
test -d "$SRC/api/node_modules"
test -f "$SRC/packaging/runtime-contract.env"
```

`$SRC` is the `LLAMA_MANAGER_SOURCE_DIR` the build consumes.

Clean up the worktree after the release is published:
`git -C "$APP" worktree remove .claude/worktrees/release-appbuild`.

## Step 2 — Export the build environment

```bash
export LLAMA_MANAGER_SOURCE_DIR="$SRC"
export NODE_ARCHIVE="$INPUTS/node-v22.23.1-linux-x64.tar.xz"
export ROCM_OCI_ARCHIVE="$INPUTS/llama-rocm-7.2.4.oci.tar"
export DS4_SERVER_BIN="$INPUTS/ds4-server"
export ARCHIVE_KEY_GPG=/volumes/llama-manager/private/signing/public/llama-manager-archive-key.gpg
```

## Step 3 — Tests, then build the packages (UNSIGNED — safe to automate)

```bash
cd "$RESPIN"
tests/run.sh                       # fast unit/contract suite (uses fake GPG — no prompt)
dpkg-buildpackage -us -uc -b       # -us -uc => unsigned; builds the 5 split .debs into ..
```

The `.deb` files land in the parent dir of `$RESPIN` (i.e. `$APP/.claude/worktrees/`).
Collect them into a clean packages dir for the APT step:

```bash
PKGDIR=/volumes/llama-manager/private/publication-staging/debs-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$PKGDIR"
cp "$APP"/.claude/worktrees/llama-manager*_*.deb "$PKGDIR"/
# Add the 4 pinned kernel debs + all ubuntu-dependency debs to the same dir
# (they must be in the signed media repo — see BUILDING.md):
cp "$INPUTS"/kernel/*.deb "$PKGDIR"/
cp "$INPUTS"/ubuntu-dependencies/*.deb "$PKGDIR"/
ls "$PKGDIR"
```

Debian binary packages are not individually signed — trust comes from the signed
`InRelease` in Step 4. So Steps 1–3 are fully automatable; only Steps 4–5 need the
passphrase.

## Step 4 — Publish the signed APT repo + ISO (⚠️ OPERATOR, interactive pinentry)

Run these **in a real terminal**; each prompts for the release-key passphrase via
`pinentry-curses`. They publish **atomically**: work happens under
`PRIVATE_STATE_DIR/publication-staging`, then completed trees move to immutable
`PUBLIC_OUTPUT_DIR/releases/{apt,images}/<snapshot>` and the stable `apt` / `images`
symlink flips in one rename. A failed build never touches the live link.

```bash
cd "$RESPIN"

# 4a. Signed APT repository (signs dists/noble/InRelease).
scripts/build-apt-repository.sh --packages-dir "$PKGDIR"

# 4b. ISO payload (embeds the freshly published APT repo + Qwen model).
scripts/assemble-iso-payload.sh \
  --apt-repository /volumes/llama-manager/public/apt \
  --packages-dir "$PKGDIR" \
  --qwen-model "$INPUTS/Qwen3-8B-Q4_K_M.gguf" \
  --output /volumes/llama-manager/private/publication-staging/iso-payload

# 4c. Bootable ISO (signs SHA256SUMS.asc).
scripts/build-iso.sh \
  --base-iso "$INPUTS/ubuntu-24.04.4-desktop-amd64.iso" \
  --payload-dir /volumes/llama-manager/private/publication-staging/iso-payload
```

Confirm the new snapshots and that signer fingerprints match the configured key:

```bash
ls -l /volumes/llama-manager/public/apt /volumes/llama-manager/public/images
cd /volumes/llama-manager/public/images && gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS
```

## Step 5 — Sync to the live site (thromgar) + verify

The live site serves from thromgar `root@65.181.123.88:/volumes/llama-manager.doubtech.ai/public`
(nginx in the `llama-manager` container, managed via `csm-admin`). Mirror the whole
public tree, then make it world-readable so nginx can serve it.

> **Disk headroom:** thromgar's release volume is ~88% full. An ISO is ~7 GB. Confirm
> free space before syncing (`ssh root@65.181.123.88 df -h /volumes/llama-manager.doubtech.ai`)
> and prune stale `releases/{apt,images}/<old-snapshot>` dirs on the target if needed —
> the manifest only needs the current + one rollback snapshot.

```bash
rsync -a --info=progress2 \
  /volumes/llama-manager/public/ \
  root@65.181.123.88:/volumes/llama-manager.doubtech.ai/public/

ssh root@65.181.123.88 'chmod -R a+rX /volumes/llama-manager.doubtech.ai/public'
```

Refresh the site. The downloads page is manifest-driven and auto-detects new snapshots
on the next request, and nginx serves the ISO directly off the mount — so a redeploy is
usually optional, but run it to be safe:

```bash
csm-admin deploy llama-manager
```

Verify the public URLs:

```bash
BASE=https://llama-manager.doubtech.ai

# Pages resolve.
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/"
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/downloads"

# APT repo metadata is present and signed.
curl -fsS "$BASE/apt/dists/noble/InRelease" | gpg --verify - 2>&1 | grep -i 'good signature'

# ISO supports range requests (206) so the browser/apt can resume — find the ISO URL
# from the downloads manifest, then:
ISO_URL="$BASE/images/<iso-name>.iso"           # from the manifest / images snapshot
curl -sS -o /dev/null -w '%{http_code}\n' -r 0-1023 "$ISO_URL"    # expect 206

# Checksums verify end to end.
curl -fsSO "$BASE/images/SHA256SUMS"
curl -fsSO "$BASE/images/SHA256SUMS.asc"
gpg --verify SHA256SUMS.asc SHA256SUMS
```

## Cleanup

```bash
git -C "$APP" worktree remove .claude/worktrees/release-appbuild
# publication-staging is auto-cleared by the publish scripts on success; remove leftover
# debs dir if you no longer need it:  rm -rf "$PKGDIR"
```

## Gotchas

- **Signing is the only human gate.** If a run "hangs", it is almost certainly waiting on
  the `pinentry-curses` passphrase in Step 4. Never `--batch` your way around it and never
  put the passphrase in `build.env` — that defeats the release-key model.
- **Never create `apt`/`images` as a real directory** at the stable public path — the
  publisher rejects a legacy non-symlink there. Only the atomic snapshot flip may write it.
- **Public and private roots must be on the same filesystem** (both under
  `/volumes/llama-manager`) or the atomic move is rejected.
- **`ui/dist` must be built** before packaging — `build-package-payload.sh` hard-fails on a
  missing `ui/dist/index.html`. A stale/empty dist silently ships old UI; always rebuild in
  the isolated checkout from current `main`.
- **Kernel + ubuntu-dependency debs must be in the packages dir** passed to the APT builder,
  not just the 5 Llama Manager debs — otherwise the offline media repo is incomplete.
- **Asset reuse:** don't re-download the multi-GB inputs; they're pinned in
  `config/assets.lock` and re-verified each build. Only refetch on a lock mismatch.
- **thromgar is ~88% full** — check headroom before pushing a ~7 GB ISO; prune old
  snapshots on the target if the sync would overrun.
