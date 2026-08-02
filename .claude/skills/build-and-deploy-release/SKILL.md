---
name: build-and-deploy-release
description: Build and publish a NEW Llama Manager appliance release — fresh signed .deb packages + APT repo + ISO from current `main` — then sync it to the live download site (llama-manager.doubtech.ai on thromgar) and verify. Use when asked to "cut a release", "rebuild the packages/ISO", "publish a new appliance build", "update the downloads", "push the latest app into the ISO/APT repo", or "ship the respin". Covers the unattended release runner, the local-only iterate loop (--no-sync + serve-local.sh), the app build, the standalone respin build repo sequence (per its docs/BUILDING.md), when signing needs a human vs. runs unattended, staging pinned inputs from the asset mirror, the atomic publish, the two-pass thromgar rsync, and the public-URL verification. NOT for restarting the dev server (use deploy-llama-manager) or rebuilding llama.cpp (use build-llama-cpp).
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
`docs/BUILDING.md`, `docs/SIGNING.md`, and `docs/CI.md`. This skill is the operational
runbook layered on top.

## Which path should you take?

| You want to… | Use |
|---|---|
| Ship a real signed release to the live site | `release-runner.sh --force` (below) — unattended, signs, publishes, syncs |
| Iterate on an image without touching production | `release-runner.sh --force --no-sync` + `serve-local.sh` |
| Prove a change builds, without a release | `release-runner.sh --dry-run`, or DoubTech CI |
| Rehearse/validate the pipeline on any node | DoubTech CI (`.doubtech-ci.yml` in the respin repo) |
| Understand or repair a single step | The manual steps in this runbook |

**DoubTech CI** now builds the ISO too, from the respin repo's `.doubtech-ci.yml`
(test → build → package). It is the right place to prove that a commit produces a
bootable image on a clean checkout. It is **not** a release path: CI signs with a
per-build **ephemeral** key, so its ISO boots and its `sha256` manifest verifies, but
`SHA256SUMS.asc` does not verify against the published archive key and a machine
installed from it cannot `apt update` against the production repository. Read
`docs/CI.md` in the respin repo before reaching for it. Anything that goes to
`llama-manager.doubtech.ai` is built here, with the real release key.

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
  (or `--dry-run` for an unsigned rehearsal). `--force` rebuilds even when the current
  commit was already released; without it the runner exits as a no-op.

**Iterate on an image without touching production** — `--no-sync` publishes the signed
release to the NAS and stops, leaving the live download host alone. Serve that tree to
the flasher over the LAN instead:

```bash
distribution/release-service/release-runner.sh --force --no-sync
distribution/release-service/serve-local.sh            # defaults to 0.0.0.0:8710
# then point the flasher at it (it already honours these):
#   LMF_AMD_BASE_URL=http://<this-host>:8710/images
#   LMF_SPARK_BASE_URL=http://<this-host>:8710/images-nvidia-spark
```

`serve-local.sh` serves the public tree read-only and refuses to start on the NAS root
or anything inside the private tree — public and private share a filesystem, so that
guard matters. Flash and validate locally, and only then run a normal (syncing) release.

> `--no-sync`, `serve-local.sh`, the builder-image freshness check, and the two-pass
> live sync landed in commit `7d58f53` on branch **`release-hardening`, not yet merged
> to `main`**. If `distribution/release-service/serve-local.sh` does not exist in your
> checkout, you are on `main` and do not have them — see the live-sync warning in Step 5.

**The builder image is now managed for you.** `release-runner.sh` binds the image to
`Containerfile.builder` by hashing the file into an `org.doubtech.containerfile-sha256`
label and rebuilds whenever they diverge, the image is missing, or its architecture is
not amd64 (`--check` reports staleness instead of rebuilding, so preflight stays
side-effect free). This exists because a stale image caused a real release failure:
`Containerfile.builder` gained `squashfs-tools`/`cpio`/`fakeroot` and the run died at
the contract gate with `FAIL: mksquashfs is required by this contract`. If you build by
hand (Step 0), you own that freshness check yourself.

**How unattended signing works** (removes the operator-pinentry gate described just
below): `enable-auto-signing.sh` configures the signing GnuPG home's gpg-agent for
`allow-preset-passphrase`, resolves the signing subkey keygrip, and presets the
passphrase (streamed from the 0600 file into `gpg-preset-passphrase`, never printed)
into a **container-local gpg-agent**. reprepro's `InRelease` and the ISO's
`gpg --detach-sign SHA256SUMS.asc` then sign from the agent cache with no prompt. The
respin fingerprint gates are unchanged. The rest of this skill remains the reference
for the manual/interactive path and for understanding each step.

## Signing: who can sign depends on the passphrase file

The two publish steps — `build-apt-repository.sh` (signs `InRelease`) and
`build-iso.sh` (signs `SHA256SUMS.asc`) — sign with the NAS-backed release key
`Llama Manager Release <releases@doubtech.com>`
(fingerprint `D544…A8`, in `build.env` as `SIGNING_KEY_FINGERPRINT`).

That key's signing subkey is passphrase-protected, and the passphrase is **not** in
`build.env` or in any repo (deliberately, per `docs/SIGNING.md`). It reaches the agent
one of two ways, and which one is provisioned decides whether an agent session can sign:

**Provisioned (the state of this host today).** `write-passphrase.sh` has stored the
passphrase in a mode-0600 file under the private signing root, and
`enable-auto-signing.sh` presets it into a **container-local** gpg-agent
(`allow-preset-passphrase` + loopback, keygrips resolved from the configured
fingerprint, streamed from the file into `gpg-preset-passphrase` — never printed, never
on a command line). reprepro and the ISO's detached signature then sign with no prompt.
**An automated/agent session CAN sign in this state**, and
`release-runner.sh --force` does exactly that end to end. That is the normal path.

**Not provisioned (passphrase file absent).** The dedicated GPG agent is pinned to
`pinentry-curses` with no loopback and no cached-passphrase TTL, so signing blocks on an
interactive prompt (or fails under `--batch`). Only then is the old rule in force: a
**human operator must run the two signing steps in a real terminal**. Everything before
signing (app build, tests, unsigned `dpkg-buildpackage -us -uc -b`) is safe to automate
either way.

Determine which state you are in before assuming — neither check prompts:

```bash
# 1. Is unattended signing PROVISIONED? This is the question that matters.
#    Presence and mode only — never read the file's contents.
ls -l /volumes/llama-manager/private/signing/passphrase   # expect -rw------- ; absent => interactive

# 2. Is an agent primed RIGHT NOW? (a different question — see the warning below)
"$RESPIN"/scripts/enable-auto-signing.sh verify
GNUPGHOME=/volumes/llama-manager/private/signing/gnupg \
  gpg-connect-agent 'keyinfo --list' /bye
# In each S KEYINFO line, field 6 is the cache flag: `-` = not cached, `1` = cached.
```

⚠️ **Do not use check 2 to answer question 1.** The agent `enable-auto-signing.sh` primes
is **container-local** — its socket lives under the builder container's `/run/user/<uid>`
— so a preset made inside a build is invisible to the host and vice versa. Run on the
host outside a build, `verify` reports `No configured keygrip is cached; signing would
prompt` and exits 1 **even when provisioning is complete and `release-runner.sh` would
sign perfectly well**. The passphrase file is the provisioning signal; `verify` only
tells you whether the agent you are talking to has been primed yet.

If the passphrase file is absent and you are an agent: **do the non-signing steps, then
STOP and hand the two signing commands to the operator.** Never work around it with
`--batch` and never put the passphrase in `build.env`.

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
# --platform matters: an arm64 image built under qemu would xz-compress multi-GB
# layers under emulation for hours. Label it so staleness is detectable later.
podman build --platform linux/amd64 \
  --label "org.doubtech.containerfile-sha256=$(sha256sum Containerfile.builder | awk '{print $1}')" \
  -f Containerfile.builder -t localhost/llama-manager-builder:24.04 .
# then run Steps 2–4 inside it with this repo at /workspace, the app checkout
# read-only at /source, inputs read-only at /inputs, and the NAS trees mounted.
# NEVER bake the signing home or .env into the image — signing still runs on the host.
```

⚠️ **A stale builder image is a real failure mode, not a theoretical one.** An image that
merely *exists* is not an image that matches the Containerfile: when
`Containerfile.builder` gained `squashfs-tools`/`cpio`/`fakeroot`, a release died at the
contract gate with `FAIL: mksquashfs is required by this contract`. The silent inverse is
worse — a tool no contract test pins lets a stale image satisfy the whole suite while
building artifacts with tooling the Containerfile does not declare. `release-runner.sh`
handles this for you (see above); if you build by hand, rebuild whenever the
Containerfile changes:

```bash
podman image inspect localhost/llama-manager-builder:24.04 \
  --format '{{index .Labels "org.doubtech.containerfile-sha256"}} {{.Architecture}}'
sha256sum "$RESPIN"/Containerfile.builder     # must match the label; arch must be amd64
```

Heavy inputs (base ISO, ROCm 7.2.4 OCI, Qwen3-8B GGUF, DS4 binary, Node tar, kernel
debs, ubuntu-dependency debs) are staged under
`/volumes/llama-manager/private/inputs/<snapshot>/`. They are pinned in
`config/assets.lock` and re-verified by `scripts/verify-asset-locks.sh` — reuse them, and
only refetch on a lock mismatch.

```bash
INPUTS=/volumes/llama-manager/private/inputs/20260714T235007Z-production   # newest staged set
ls -la "$INPUTS"
```

**If the inputs are missing** (new machine, pruned snapshot, a lock bump), do not hand-
download them — `scripts/fetch-assets.sh` bootstraps the whole set, mirror first with
upstream fallback, staging through a partial file and refusing to leave anything in place
that fails its locked size/SHA-256:

```bash
export LLAMA_ASSET_MIRROR=/volumes/llama-manager/assets  # the seeded NAS asset mirror
"$RESPIN"/scripts/fetch-assets.sh status --dest "$INPUTS"    # present / missing / corrupt
"$RESPIN"/scripts/fetch-assets.sh mirror-layout              # <id>/<revision>/<filename>

# Scope `ensure` to the amd build. A bare `ensure --dest` stages the WHOLE manifest,
# including the experimental arm64/CUDA rows an amd release cannot use — and then fails,
# because llama-cuda-gb10 is mirror-only. (`status` likewise reports those three rows as
# `missing` on a perfectly complete amd inputs tree; that is expected, not a problem.)
"$RESPIN"/scripts/fetch-assets.sh ensure --dest "$INPUTS" \
  --asset ubuntu-desktop-24.04.4 --asset nodejs-22.23.1-linux-x64 \
  --asset qwen3-8b --asset ds4-server-gfx1151 --asset llama-rocm-7.2.4-oci \
  --asset ubuntu-mainline-kernel-headers-all-6.18.36 \
  --asset ubuntu-mainline-kernel-headers-amd64-6.18.36 \
  --asset ubuntu-mainline-kernel-image-6.18.36 \
  --asset ubuntu-mainline-kernel-modules-6.18.36
```

Assets already present and verified are reported `ok … (already verified)` and are not
re-transferred, so re-running is cheap and safe. Stage **real files, not symlinks**: the
lock verifier stats the path it is given without following links, so a symlinked asset
reads as `corrupt`. The respin repo's `ci/fetch-inputs.sh` keeps the same nine-asset list
if you would rather run one command.

🔴 **Three assets are mirror-only and have NO upstream recovery path.** The mirror is the
**system of record** for them, not a cache — if it is lost, they cannot be re-fetched:

| Asset | Why it cannot be re-downloaded |
|---|---|
| `ds4-server-gfx1151` | The locked URL is a **source tree**, not an artifact; the binary was built locally. |
| `llama-rocm-7.2.4-oci` | Repacking the registry image does not reproduce the archive tar byte for byte, so a rebuild fails its locked digest. |
| `llama-cuda-gb10` | Same, plus it is a config-only derivative that was never pushed to a registry. |

`--allow-oci-repack` exists to help re-pin a lost archive (rebuild, then record the new
digest in `config/assets.lock`) — it is **not** a way to feed a pinned build. Treat the
mirror as backed-up production data. Note also that the `ubuntu-dependencies/*.deb`
bundle is generated by `bundle-ubuntu-dependencies.sh` from Canonical's Desktop manifest
and is **not** in the lock, so `fetch-assets.sh` will not stage it either. It is carried
on the mirror at `ubuntu-dependencies/24.04.4/` — 66 debs **plus** a `SHA256SUMS` and a
`PACKAGES` file, so restore that directory wholesale rather than by a `*.deb` glob, which
silently drops the checksum manifest. Regenerating it needs `apt-rdepends`/`apt-get`
resolving Noble **with network**, so a disconnected machine cannot rebuild it.

### Rehearse the recovery (do this before you need it)

The mirror is only a backup if restoring from it has been proven. This rehearsal
reconstructs the three irreplaceable assets into a throwaway directory with the network
clients disabled, so nothing can quietly rescue it from upstream — if it passes, a
machine with no inputs and no internet can still build:

```bash
SCRATCH=$(mktemp -d)
export LLAMA_ASSET_MIRROR=/volumes/llama-manager/assets
export CURL=/bin/false SKOPEO=/bin/false        # any upstream reach is a hard failure

"$RESPIN"/scripts/fetch-assets.sh status --dest "$SCRATCH" \
  --asset ds4-server-gfx1151 --asset llama-rocm-7.2.4-oci --asset llama-cuda-gb10
# expect: all three `missing`

"$RESPIN"/scripts/fetch-assets.sh ensure --dest "$SCRATCH" \
  --asset ds4-server-gfx1151 --asset llama-rocm-7.2.4-oci --asset llama-cuda-gb10
# expect: `fetched … from mirror` x3, then
#         "All requested assets are present and verified"

rm -rf "$SCRATCH"        # ~7.3 GB — do not leave it lying around
```

`ensure` verifies every recovered file against its locked size and SHA-256, so a green
run proves the mirror holds the real bytes and not just files of the right name. Last
rehearsed 2026-08-02: all three recovered in ~30 s. Unsetting `CURL`/`SKOPEO` is what
turns this from a recovery proof back into an ordinary fetch — keep them set.

To rehearse the **whole** amd input set the same way, `ci/fetch-inputs.sh` in the respin
repo does it in one command (~15 GB, ~80 s) with `RESPIN_CI_INPUTS_DIR` pointed at the
scratch directory. It additionally requires the `ubuntu-dependencies` bundle, which it
verifies for presence only.

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

## Step 4 — Publish the signed APT repo + ISO (signing step)

If unattended signing is provisioned, run `enable-auto-signing.sh all` first and these
three commands sign from the agent cache with no prompt — an agent session may run them.
If it is not, run them **in a real terminal**: each prompts for the release-key
passphrase via `pinentry-curses`. See the signing section above for how to tell which
state you are in. They publish **atomically**: work happens under
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

> **Disk headroom:** thromgar's release volume runs close to full and an ISO is now
> **~14 GB** (not the ~7 GB earlier revisions of this runbook assumed). Confirm free
> space before syncing (`ssh root@65.181.123.88 df -h /volumes/llama-manager.doubtech.ai`)
> and prune stale `releases/{apt,images}/<old-snapshot>` dirs on the target if needed —
> the manifest only needs the current + one rollback snapshot.

🔴 **Do not sync in one pass.** The NAS publish is atomic, but a single `rsync` throws
that guarantee away: the top-level `apt`/`images` symlinks are tiny and transfer almost
immediately, while the snapshot they point at is tens of GB — so the live site gets
repointed at a directory whose payload has not arrived. Observed: **~2.5 hours of 404s**
on a 291 GB tree. Worse, in the C locale `SHA256SUMS` sorts before
`llama-manager-*.iso`, so the manifest lands first and the site advertises a checksum
whose image is still the previous one; the flasher does not resume after a hash
mismatch, making every retry a full multi-GB re-download.

Sync payload first, pointers second:

```bash
LIVE=root@65.181.123.88:/volumes/llama-manager.doubtech.ai/public/

# Pass 1 — payload only (--no-links leaves apt/images pointing at the OLD snapshot).
# --delay-updates means a partially-written file is never served.
rsync -a --info=progress2 --delay-updates --chmod=Da+rx,Fa+r --no-links --exclude='/.*' \
  /volumes/llama-manager/public/ "$LIVE"

# Pass 2 — repoint. Moves bytes only for the symlinks, so the inconsistent window is a
# single rename rather than hours.
rsync -a --info=progress2 --delay-updates --chmod=Da+rx,Fa+r --links --exclude='/.*' \
  /volumes/llama-manager/public/ "$LIVE"

ssh root@65.181.123.88 'chmod -R a+rX /volumes/llama-manager.doubtech.ai/public'
```

`release-runner.sh` does this for you on `release-hardening` (commit `7d58f53`). Until
that merges, the two passes above are the manual equivalent — and a `release-runner.sh`
run from `main` still has the one-pass bug. If pass 1 fails, the live site is untouched
and you can simply re-run; if pass 2 fails, the payload is already there and only the
repoint needs retrying.

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

- **Signing is a human gate only when the passphrase file is absent.** With unattended
  signing provisioned (the state of this host), `release-runner.sh --force` signs and
  publishes with no human. Without it, a "hang" in Step 4 is almost certainly the
  `pinentry-curses` prompt. Never `--batch` your way around it and never put the
  passphrase in `build.env` — that defeats the release-key model.
- **Rebuild the builder image when `Containerfile.builder` changes.** An image that
  exists is not an image that matches. `release-runner.sh` enforces this by label;
  a hand-run build does not.
- **The asset mirror is production data.** `ds4-server-gfx1151`,
  `llama-rocm-7.2.4-oci`, and `llama-cuda-gb10` cannot be recovered from upstream.
  It lives at `/volumes/llama-manager/assets` on the same NAS as the inputs it backs
  up, so it survives this box dying but not the NAS dying. Rehearse the restore
  (Step 0) rather than assuming it works.
- **Never one-pass the live rsync** — pointers must never precede their payload
  (Step 5).
- **A CI-built ISO is not a release.** It is signed by a per-build ephemeral key;
  it boots and its `sha256` manifest verifies, but it must never reach the download
  host.
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
- **Check thromgar's headroom before pushing** — the ISO is ~14 GB and the release
  volume runs close to full; prune old snapshots on the target if the sync would
  overrun.
