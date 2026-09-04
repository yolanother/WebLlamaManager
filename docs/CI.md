# Building the appliance on DoubTech CI

Copyright (c) 2026 DoubTech. Use of this document is governed by the LICENSE
file in the repository root.

`.doubtech-ci.yml` wires this repository into [DoubTech CI](https://github.com/yolanother/doubtech-continuous-integration)
so the bootable appliance ISO is built and hosted by CI instead of being built
by hand on the operator workstation and uploaded to the download host on every
iteration. This document explains the phases, how to run each one locally, what
a build node must provide, and the difference between a CI image and a release
image. The manual release sequence is unchanged and still documented in
[BUILDING.md](BUILDING.md) — CI drives exactly that sequence through
`scripts/container-build.sh`.

## Phases

Phases run `test` → `build` → `package`, and a failing step aborts everything
after it.

| Phase | Step | What it does |
|---|---|---|
| test | `./tests/run.sh` | The full contract suite — one test case per script in `tests/`. Portable: bash and standard tools only, no podman, no assets, ~20 s. It gates every later phase, and writes `reports/junit/respin.xml` because the step sets `RESPIN_JUNIT_OUT`. |
| test | `./ci/test-app.sh` | The Llama Manager application's own suites, run against the commit pinned in `config/app-source.lock`: its api / ui / tests node suites (JUnit XML into `reports/junit/`), its hermetic bash harnesses, and its python harnesses. Clones through the same node-local mirror the build phase uses, into its own tree so no dev dependency reaches the tree the packaging steps mount. ~2 min warm. |
| build | `./ci/preflight.sh` | Answers "can this node build an ISO at all?" — platform, rootless podman, host tools, free space, the asset mirror, the exact immutable dependency-bundle revision, and the node's ability to build the application dependency. Reports every missing capability, then fails. |
| build | `./ci/build-app-dependency.sh` | Clones the Llama Manager application pinned in `config/app-source.lock` and builds it (`npm ci && npm run build`, then `npm ci --omit=dev`). Produces the tree the package phase mounts. |
| build | `./ci/build-builder-image.sh` | Builds the pinned Ubuntu 24.04 builder image from `Containerfile.builder`. |
| build | `./ci/fetch-inputs.sh` | Stages the pinned inputs through `scripts/fetch-assets.sh`, plus the same immutable dependency-bundle revision preflight resolved; verifies checksums, uses the builder image to normalize the pinned ISO's target manifests and extract its authoritative target status, and runs the media-only APT simulation. |
| package | `./ci/build-iso.sh` | Runs `scripts/container-build.sh` inside that image over the verified inputs, then collects the ISO and its `SHA256SUMS` pair into `dist/artifacts/`. |

`testReports: ["reports/junit/*.xml"]` publishes both suites' results — the
per-test breakdown on the build page and the point on the project's test-trend
strip:

- `reports/junit/respin.xml` — one case per script in `tests/`, written by
  `tests/run.sh` when `RESPIN_JUNIT_OUT` names a path. A failing case carries
  the tail of that script's output. The report is **opt-in** because
  `debian/rules` re-runs the same runner under `dh_auto_test`, where writing
  into the build tree is not wanted; the pipeline step sets the variable, a
  package build does not.
- `reports/junit/app-*.xml` — the application's api / ui / tests node suites,
  written by `ci/test-app.sh`.

The portable `tests/run.sh` contract is the first gate, not the only one. After
the immutable Ubuntu dependency bundle is staged, CI independently simulates
the appliance package transaction with only the signed media packages and the
actual installed target available. CI normalizes the added dpkg package/version
records from the raw unified-diff `minimal.manifest` and
`minimal.standard.manifest`; explicitly prefixed `snap:` channel/revision rows
are metadata for a different package system and are excluded. CI then extracts
`var/lib/dpkg/status` from `minimal.standard.squashfs`. The latter
is copied unchanged into the isolated APT root so versioned `Provides` metadata
survives; missing, empty, or malformed status is rejected before the resolver
runs. Extraction disables xattr restoration because the source squashfs carries
`trusted.overlay.origin`, which rootless Podman cannot write through a bind
mount; xattrs are irrelevant to the dpkg metadata verification. The bundle is
not eligible for an ISO build unless that simulation
resolves every dependency, including the NFS `keyutils` closure and the coherent
`curl`/`libcurl4t64` pair, without consulting a network package source.

The suite is still fail-fast: the first failing script ends the run, and the
report describes what actually ran rather than pretending the rest passed. Never
add a glob that matches nothing — an empty summary renders as a green build.

**Why the application is tested here.** The application lives in its own
open-source repository and is deliberately kept free of CI plumbing. This
pipeline is what turns it into a `.deb` and an ISO, so this is where its suites
run — and running them first means a red application stops the build before an
hour of input staging is spent on it. The exit status gates; the XML only
reports. Never `|| true` a suite to "get the report out".

## Running the phases locally

Every step is a script, so a developer runs exactly what CI runs. Nothing has to
be pre-staged: the pipeline builds its own application dependency and stages its
own inputs, so the only value a local run needs is the asset mirror.

```bash
export LLAMA_ASSET_MIRROR=/volumes/llama-manager/assets

RESPIN_JUNIT_OUT=reports/junit/respin.xml ./tests/run.sh   # drop the variable to skip the report
./ci/test-app.sh               # the application's own suites; ~2 min warm
./ci/preflight.sh
./ci/build-app-dependency.sh   # clones + builds the app; ~50 s cold, ~8 s warm
./ci/build-builder-image.sh
./ci/fetch-inputs.sh
./ci/build-iso.sh --dry-run    # container path only: tests + unsigned packages
./ci/build-iso.sh              # the real ~14 GB image
```

To build against a checkout you already have — your working copy, say — export
`LLAMA_MANAGER_SOURCE_DIR` instead. That means "use my tree, do not clone", so
`ci/build-app-dependency.sh` verifies it is built and skips the clone entirely,
`ci/test-app.sh` runs the suites in that tree without installing into it, and
`ci/preflight.sh` checks the same markers rather than probing the remote:

```bash
export LLAMA_MANAGER_SOURCE_DIR=/path/to/llama-manager   # must already be BUILT
```

`--dry-run` stops after the unsigned `dpkg-buildpackage`, which is the cheap way
to prove the container path, the mounts, and the configuration resolution
without spending a full ISO build.

### Fast mainline-kernel installer regression

Do not build an ISO merely to iterate on the pinned mainline kernel's malformed
maintainer scripts. The portable installer contract exercises the exact
two-directory `run-parts` argument shape, ordered hook execution, underlying
hook failure, cleanup, and a successful rerun:

```bash
bash tests/test-offline-installer.sh
```

Besides the transaction-local kernel shim, this portable contract verifies the
installed model boundary: `/volumes/models/Qwen3-8B-Q4_K_M.gguf`, directory and
file modes, service-account ownership, and idempotent reruns. Its migration case
requires the canonical stage to succeed before deleting only the exact obsolete
`/var/lib/llama-manager/models/Qwen3-8B-Q4_K_M.gguf`; an adjacent
operator-owned model must survive.

Before publishing, also run the kernel-only container regression against the
exact checksum-pinned image `.deb` staged for the ISO:

```bash
KERNEL_DEB=/path/to/linux-image-unsigned-6.18.36-061836-generic_6.18.36-061836.202606191408_amd64.deb \
RESPIN_CI_BUILDER_IMAGE=localhost/llama-manager-builder:24.04 \
  ./tests/test-offline-kernel-container.sh
```

The harness runs the real amd64 package in the project builder with
`--network=none`; it exercises only the kernel transaction and therefore avoids
the multi-gigabyte ROCm and appliance payload. A generic locally cached
`ubuntu:24.04` is not an acceptable substitute because its architecture can
differ from the pinned amd64 package. On the standard build host the harness
finds the pinned `.deb` under `/volumes/llama-manager/assets` automatically, and
the builder-image variable also defaults to the value above; use the explicit
form when validating another staged input. It verifies that input against
`config/assets.lock`, has a media-only APT fixture select the temporary dpkg
launcher, and then runs the real dpkg and package hooks. `CONTAINER_RUNTIME` can
select another compatible runtime and defaults to `podman`. On failure the
harness retains the real dpkg or maintainer-script diagnostic rather than
reducing it to APT status 100.
The full media-only simulation, contract suite, and offline VM installation
remain release gates; this focused loop shortens red/green iteration and does
not replace them.

### Fast ROCm first-boot package regression

The mainline-kernel container harness above is deliberately limited to the
kernel `.deb`. Use the package lifecycle regression for the next boundary: ROCm
package configuration in a curtin-style target, followed by the installed
system's first real boot.

```bash
bash tests/test-rocm-first-boot.sh
```

The test proves that target-chroot configuration validates archive presence and
host policy without executing Podman or Distrobox; the package-owned oneshot
runs as `llama-manager` with a systemd-created runtime directory; and the
manager's `Requires=`/`After=` drop-in treats setup failures as fatal. It also
verifies offline, idempotent image/container creation, `/volumes:/volumes`, a no-op
rerun apart from image-ID and container-name validation, the unit condition that
skips live media after archive removal, fatal runtime diagnostics, and
chroot-safe removal. The running-system prerm case requires this exact order:
stop the manager, remove the Distrobox, remove its Podman image while the setup
unit still owns `/run/llama-manager`, then stop the active `RemainAfterExit`
setup unit. The helper's four `LLAMA_MANAGER_ROCM_*` overrides supply the
deterministic fixture values; production uses their pinned package defaults.
This fixture does not install the real kernel package and does not replace
`tests/test-offline-kernel-container.sh` or the complete offline installation
gates.

Everything a CI build writes stays inside the checkout:

| Variable | Default | Purpose |
|---|---|---|
| `RESPIN_CI_WORK_DIR` | `build/ci` | Root of the CI work tree. |
| `RESPIN_CI_INPUTS_DIR` | `build/ci/inputs` | Staged, verified inputs. |
| `RESPIN_CI_OUTPUT_DIR` | `build/ci/output` | The build's own `public/` and `private/` trees. |
| `RESPIN_CI_ARTIFACT_DIR` | `dist/artifacts` | What the pipeline uploads. |
| `RESPIN_CI_BUILDER_IMAGE` | `localhost/llama-manager-builder:24.04` | Builder image tag. |
| `RESPIN_CI_MIN_FREE_GB` | `70` | Free space preflight demands. |
| `RESPIN_CI_APP_BUILD_DIR` | `build/ci/app` | Where the application dependency is checked out and built. |
| `RESPIN_CI_APP_CACHE_DIR` | `~/.cache/llama-manager-respin/app-repo.git` | Node-local bare mirror of the application repository. |
| `LLAMA_MANAGER_SOURCE_DIR` | `build/ci/app` | Set it to supply your OWN built checkout and skip the clone; leave it unset to let CI build one. |
| `LLAMA_MANAGER_SOURCE_URL` | from `config/app-source.lock` | Override the application remote (a credentialed URL, or a local path). |
| `LLAMA_MANAGER_SOURCE_REF` | from `config/app-source.lock` | Override the application ref for one build. |

`ci/ci-env.sh` exports `PUBLIC_OUTPUT_DIR`, `PRIVATE_STATE_DIR`, `PLATFORM`, and
`SIGNING_IDENTITY` as process environment, which outranks any `.env` in the
checkout, and points `LLAMA_RESPIN_ENV_FILE` at an empty CI-owned file. A CI
build therefore cannot read the operator's release configuration or write into
the production NAS tree even when it runs on the release workstation.

A local non-dry-run leaves `dpkg-buildpackage` residue in `debian/` and the
built `.deb` files in the checkout's parent directory, exactly as a manual build
does. On a CI node the checkout is disposable.

## Node requirements

The test phase runs anywhere. The build and package phases do not, and
`ci/preflight.sh` refuses rather than half-building:

- **Linux x86_64.** `PLATFORM=amd` is the only CI-wired target; the
  experimental `nvidia-spark` (arm64) assets are staged by hand — see
  [PLATFORMS.md](PLATFORMS.md).
- **Rootless Podman** (`podman info` must answer). Most build-only tools —
  debhelper, reprepro, cloud-init, and lintian — live in the builder image, not
  on the node. The media-simulation exceptions are listed next.
- **`gpg`** on the node/image for the ephemeral signing identity.
- **APT/media simulation tools on the node:** `apt-get` and
  `dpkg-scanpackages`. ISO and squashfs extraction use `xorriso` and
  `unsquashfs` inside the already-built builder image, so neither extraction
  tool is a host prerequisite. This is why the builder-image step precedes
  input staging.
- **~70 GB free** on the work filesystem: the ~14 GB image, its private staging
  copy, the assembled payload, and the APT snapshot.
- **The pinned inputs**, ~15 GB. They are not held on the node: they are
  mounted lazily through the CNFS asset mirror and staged by
  `scripts/fetch-assets.sh`, which `ci/fetch-inputs.sh` calls for exactly the
  nine assets an amd build consumes — never the whole manifest, so the
  experimental arm64/CUDA rows are not pulled. Two of those nine
  (`ds4-server-gfx1151`, `llama-rocm-7.2.4-oci`) are **mirror-only**: their
  locked URLs are a source tree and a registry reference, not downloadable
  artifacts, so a node with no mirror configured cannot bootstrap them from
  upstream. **Set `LLAMA_ASSET_MIRROR`** — `ci/preflight.sh` requires it, and
  for a filesystem mirror it probes that those unrecoverable assets and the
  dependency bundle are actually there before the build starts. The seeded NAS
  mirror is `/volumes/llama-manager/assets` (see `docs/BUILDING.md`).
- **The Ubuntu dependency bundle**, carried on the mirror at
  `<mirror>/ubuntu-dependencies/<revision>/` — the same `<id>/<revision>/`
  convention the locked assets use. The revision is pinned in `ci/ci-env.sh`
  (`CI_DEPENDENCY_BUNDLE_REVISION`, currently `24.04.4-r5`) and resolved through
  the shared `ci_dependency_bundle_relpath` helper, so the preflight probe and
  the fetch stage cannot end up looking in different directories. It started out
  as the bare Ubuntu version; it is now suffixed because **a changed package set
  is published as a new directory beside the old one, never over it** — every
  image already built is reproducible only from the exact bytes of the bundle it
  was built from. `-r5` is generated from the actual installed target inventory,
  adds `keyutils` for the NFS closure, and carries a version-compatible
  `curl`/`libcurl4t64` pair at `8.5.0-2ubuntu10.13`. It retains the prior
  OpenSSH and rootless-Podman dependencies. The unavailable `cog` candidate was
  removed from the seed set; the kiosk's existing runtime browser preference
  and fallback behavior is unchanged. All earlier revisions remain immutable
  historical inputs; they must not be overwritten or silently restaged as
  `-r5`. To change the set: edit `seed_packages`, normalize the added package
  rows from `casper/minimal.manifest` and
  `casper/minimal.standard.manifest`, extract `var/lib/dpkg/status` from
  `casper/minimal.standard.squashfs` in the pinned ISO, and run
  `scripts/bundle-ubuntu-dependencies.sh` **on an amd64 Noble builder** (a
  bundle built on an arm64 host is silently the wrong architecture), publish it
  under a new revision, and bump `CI_DEPENDENCY_BUNDLE_REVISION`. The generator
  requires both `--target-manifest` and `--target-status`; the obsolete
  `--desktop-manifest` input and raw diff input are rejected. CI normalization
  rejects conflicting target versions, and the verifier rejects malformed
  authoritative status before invoking APT. The generator subtracts the target
  manifest by name **and version**, while the verifier preserves the full status
  database—including versioned `Provides`—for APT. A bundle whose dependencies
  cannot be satisfied from the target plus the bundle itself is not published,
  and the unsatisfied package is named so "held broken packages" stops the build
  instead of the appliance. Do not use
  `minimal.standard.live.manifest`, a full filesystem manifest, or Canonical's
  Desktop sidecar: those broader inventories include live-only packages and can
  wrongly hide dependencies absent from the installed target. The bundle is not
  pinned in `config/assets.lock`, so
  `scripts/fetch-assets.sh` cannot carry it;
  `ci/fetch-inputs.sh` stages it from the mirror itself and verifies it against
  the `SHA256SUMS` the bundle ships. That manifest is a closed inventory: every
  payload file must be listed exactly once under a safe top-level path, and an
  unlisted, missing, nested, duplicate, absolute, or traversing entry rejects
  the bundle. The CI-created `.revision` marker is the sole unlisted exception;
  it prevents a previously staged revision from masquerading as r5 (a `*.deb`
  glob would also miss `SHA256SUMS`, `PACKAGES`, and `SEEDS`—copy the whole
  directory). Only a **filesystem** mirror can supply it: a directory of debs
  with no index cannot be walked over HTTP, so a URL mirror fails this step with
  an explicit message.
- Stage **real files, not symlinks**. The lock verifier stats the path it is
  given without following links, so a symlinked asset reads as corrupt.
- **`git` and `npm`**, plus outbound network access to GitHub and the npm
  registry. The node no longer has to arrive with a built application checkout —
  `ci/build-app-dependency.sh` produces one. See the next section.

Because the pipeline declares a single `linux` platform and DoubTech CI
schedules one job per platform on any matching node, subscribe this repository
only while an ISO-capable node is in the pool. On a node without podman, disk,
or inputs the build phase fails loudly by design; it does not skip.

### Where `LLAMA_ASSET_MIRROR` belongs

The mirror is **node infrastructure, not project configuration**, so it is set
on the node and deliberately has no default in this repository. A path like
`/volumes/llama-manager/assets` is one machine's mount point: a second build
node may mount the same NAS elsewhere or use an HTTP mirror, and
`tests/test-ci-pipeline.sh` already fails any `ci/` script that hard-codes an
absolute NAS path. Putting it in an `env:` block in `.doubtech-ci.yml` would
bake one node's layout into the repository and would have to be edited to add a
node; a defaulted value would be worse still, because a node whose mirror is
absent would silently fall through to an upstream fetch for assets that cannot
be fetched from upstream at all.

So: **export `LLAMA_ASSET_MIRROR` in the node's environment.** `ci/preflight.sh`
requires it unconditionally and, for a filesystem mirror, probes that the
mirror-only assets and the dependency bundle are really there — a defaulted-but-
absent mirror still fails loudly, in seconds, before anything is staged.

## The application dependency

The appliance packages the Llama Manager application, which lives in its own
repository. CI builds it rather than requiring it: `ci/build-app-dependency.sh`
mirrors the release runner's app build exactly — an isolated checkout of one
resolved commit, then `npm ci && npm run build` for the UI and
`npm ci --omit=dev` for the production API dependencies — and verifies the
result carries `ui/dist/index.html`, `api/node_modules`, and
`packaging/runtime-contract.env` before the phase passes.

**Pinning.** `config/app-source.lock` pins the remote and the ref. It ships with
`ref` set to `main`, because a CI image is a test image (see below) and its job
is to prove the *current* application still builds into an ISO. The consequence
is deliberate and should be stated plainly: **rebuilding the same respin commit
can produce a different ISO**, since the application may have moved. Every build
prints and records the resolved commit to `build/ci/app-source-commit`, so any
image can be traced back to what went into it. To make a build reproducible by
commit, put a full SHA in the lock's `ref` column — no code change is needed —
or pass `LLAMA_MANAGER_SOURCE_REF` for a single build.

**Credentials.** None are required. The application repository is served
publicly over HTTPS, and the lock pins the anonymous HTTPS remote rather than
the `ssh://git@github.com/...` remote the operator's own checkout pushes
through — an SSH clone would need a deploy key installed on every node first.
`ci/preflight.sh` probes read access with `git ls-remote` in about a second, so
if the repository is ever made private the build fails at the first step with an
explicit message instead of an hour into staging. Restoring it then means either
installing a read-only deploy key on each node and setting
`LLAMA_MANAGER_SOURCE_URL` to the SSH remote, or setting that variable to an
HTTPS URL carrying a read-only token.

**Caching.** Two things are reused between builds, both safely:

- The **bare mirror** at `~/.cache/llama-manager-respin/app-repo.git`. Every
  build resolves its ref and checks out a fresh tree from it, so a stale mirror
  can only cost a fetch, never a wrong build. A corrupt or unfetchable cache is
  discarded and re-cloned automatically.
- The node's **npm cache** (`~/.npm`), used by `npm ci` with no configuration.
  It is content-addressed and integrity-checked by npm, so it cannot serve stale
  or altered packages.

`node_modules` and `ui/dist` are **not** cached: `npm ci` deletes and rebuilds
`node_modules` by design, and caching build output is how a stale artifact ends
up in a release image. On this hardware a cold build is roughly 50 s and a warm
one 8 s; the step's 3600 s timeout is sized for a cold node with no npm cache
and a slow registry, where those two `npm ci` runs, not the git clone, dominate.

## Signed releases vs. CI images

The production release key lives on the NAS and its passphrase is only in the
operator's password manager. A CI node has neither, and every signing step in
the release sequence is mandatory — `build-apt-repository.sh` signs
`dists/noble/InRelease`, `build-iso.sh` verifies that signature and signs
`SHA256SUMS.asc`. Failing the build for want of the release key would defeat the
purpose, so a CI build signs with a **per-build ephemeral identity**
(`ci/ephemeral-signing.sh`): a fresh ed25519 primary plus signing subkey,
random passphrase, generated inside the build's own private state tree and
discarded with it. `Llama Manager CI Build (EPHEMERAL KEY - NOT A RELEASE)`
names itself in every signature it makes.

A CI image is therefore **internally consistent**: its APT metadata, its
bundled archive-keyring package, and its `SHA256SUMS.asc` all belong to the same
key, so it boots, installs offline, and the flasher's `sha256` check against
`SHA256SUMS` passes — that check reads a checksum manifest and is independent of
GPG.

What a CI image **cannot** do:

- **It is not a release.** `gpg --verify SHA256SUMS.asc SHA256SUMS` fails against
  the published archive key, and its fingerprint matches no released image.
  Never publish one to the download host.
- **Its APT metadata is not trusted by installed appliances.** A machine that
  already trusts the production archive key rejects a CI-built repository.
- **A machine installed from a CI image trusts the ephemeral key**, so it
  cannot `apt update` against the production repository at
  `https://llama-manager.doubtech.ai/apt` — the signature will not verify.
  Treat such an install as throwaway.
- **It cannot be promoted to a release by re-signing.** Signing the production
  release means re-running the build with the release identity, because the
  archive key is baked into the media's keyring package and the payload's APT
  repository.

Signing a CI build with the real release identity is a separate, open piece of
work: it needs the CI server's signing-identity store to hold the release key
and the node to reach it, and it changes the trust boundary of the build farm.
Until then, tagged production releases stay on the operator workstation flow in
[BUILDING.md](BUILDING.md) and [SIGNING.md](SIGNING.md).

## SSH: installed everywhere, enabled only on CI images

`openssh-server` is a product dependency. It goes into the offline bundle and is
installed into the live layer of **every** image, release included — Ubuntu
Desktop ships only `openssh-client`, so without it there is no sshd to turn on.
What is gated is whether the image arrives with a way *in*.

### Release images: installed, inert

A release appliance ships the server present and available to an administrator,
with nothing that would put it on port 22:

- no generated host key, no `authorized_keys`, no hardening drop-in, no enabled
  unit;
- `/etc/ssh/sshd_not_to_be_run` present.

That last file is the load-bearing one. Simply *not enabling* `ssh.service`
would not be enough: `openssh-server`'s postinst runs `ssh-keygen -A` and enables
the unit, so the first `apt install openssh-server` or `dpkg-reconfigure` on the
running system would leave a shipped appliance listening with password auth.
Both `ssh.service` and `ssh.socket` declare
`ConditionPathExists=!/etc/ssh/sshd_not_to_be_run`, so the file keeps the daemon
down through all of that. It is Debian's own switch, not a local invention, and
removing it is the documented way to turn the channel on deliberately:

```bash
sudo rm /etc/ssh/sshd_not_to_be_run
sudo ssh-keygen -A                 # release images ship no host key
sudo systemctl enable --now ssh
```

### CI images: keyed and running

Debugging a booted appliance used to mean photographing the screen and reading
it back, which is how two build cycles went into guessing at kiosk startup. A
build that signs with the ephemeral identity above additionally gets:

- a **fresh ed25519 keypair minted for that one build** — public half installed
  as `/root/.ssh/authorized_keys`, private half emitted as
  `dist/artifacts/llama-manager-diagnostic-ssh-key`. No operator key is ever
  embedded, and access dies with the image.
- a host key, generated per build, so its absence stays a checkable property of
  a release image;
- `sshd_config.d/10-llama-manager-diagnostic.conf` — `PasswordAuthentication no`,
  `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`,
  `PubkeyAuthentication yes`. The key is the only credential that opens it;
- `ssh.service` enabled and `/etc/ssh/sshd_not_to_be_run` removed, so the daemon
  is up as soon as `multi-user.target` is reached — before the graphical
  session, which is usually what needs looking at.

### Connecting to a CI image

The build log prints the address. casper derives the live hostname from the
first word of `/.disk/info`, which the appliance rewrites to the product name,
so a Llama Manager image comes up as `llama` and — avahi ships in Ubuntu
Desktop — answers on the LAN as `llama.local`:

```bash
chmod 600 llama-manager-diagnostic-ssh-key
ssh -i llama-manager-diagnostic-ssh-key root@llama.local
# or, if mDNS is not available on your network:
ssh -i llama-manager-diagnostic-ssh-key root@<ip>
```

Root, because almost everything worth reading on a wedged appliance is
`journalctl` and `systemctl` state.

### The gate

The decision lives in exactly one place, `scripts/diagnostic-ssh.sh`, and keys
off exactly one signal: `ci/ephemeral-signing.sh` writes an `EPHEMERAL` marker
beside the fingerprint of the throwaway key it generates, and nothing in the
release signing path writes it. **Absence means release**, so any build that
does not come through the ephemeral path — an operator release build, the
release runner, a developer running the ISO stage by hand — produces an image
that is installed but inert.

That direction is deliberate. A release image carrying the CI key would put every
appliance in every customer's hands on port 22 behind a credential published as
a build artifact, and flashed media cannot be recalled. The existing
ephemeral-vs-release split is reused rather than a second "dev build" flag being
invented, because two independent notions of "this isn't a release" drift apart,
and the one that drifts is the one that ships a key to customers.
`tests/test-diagnostic-ssh.sh` and `tests/test-live-filesystem.sh` both assert
the release case — including that the naive "install it and let the postinst
enable it" implementation fails — and `tests/test-ci-pipeline.sh` fails any
second script that tries to re-implement the gate.

## Artifacts and retention

The package phase uploads the image and its checksum sidecars — the ISO
(~14 GB), `SHA256SUMS`, `SHA256SUMS.asc` — plus the appliance's own Debian
packages, `llama-manager-apt-<version>.tar.gz` (an archive of the signed APT
repository), and `llama-manager-diagnostic-ssh-key`, the per-build private key
that opens the image's diagnostic SSH channel. A 14 GB image is a poor way to deliver a package set: the debs and
the repository are what an operator installs, inspects, and serves, and they are
small enough to fetch on their own.

The packages are collected from the **published APT pool**, not from where
`dpkg-buildpackage` leaves them. It writes them to the parent of the source
tree, which inside the builder container is `/` — an unmounted layer discarded
with the container, so those copies do not survive the build. The pool copies
do, and they are the signed ones. Only `llama-manager*` is collected: the pool
also carries the pinned kernel and Ubuntu-dependency debs, which are inputs to
the build rather than outputs of it and are already on the asset mirror. The
`dbgsym` package is excluded by extension — it is a `.ddeb`.

**Upload size — and why a co-located node sidesteps it.** Artifact *uploads* are
capped at roughly **2 GiB** by the edge proxy in front of the CI server, well
under the ISO and under `llama-manager-rocm-gfx1151` (it wraps a 2.9 GB ROCm
asset). The cap is the edge, not the server: posting a 2 GiB body straight at
the container on `127.0.0.1:8420` is accepted, while the same body through
`https://ci.jaxns.net` comes back `413 Request Entity Too Large` from
`openresty`. That is exactly how the first ISO-producing build died — everything
built correctly and the job still failed with
`artifact upload failed (413) for llama-manager-ubuntu-24.04.4-amd64.iso`,
leaving only the two tiny `SHA256SUMS` sidecars behind.

Nothing in *this* repository works around it: a size filter here would silently
ship an incomplete package set, which is worse than a loud failure. The fix
belongs to the node, and it exists. When a build node sets `CI_ARTIFACT_ROOT`
to its own view of the server's artifact store, the node-agent stages each
artifact there — hard-linking it when the filesystems allow, copying otherwise —
and registers it with `POST /api/jobs/:jobId/artifacts/local`, so the bytes
never touch the network or the proxy. Any failure of that path falls back to the
streaming upload, so a wrong mount costs a slow publish rather than a lost build.

Frostburn runs the build agent on the same host that serves DoubTech CI and sees
the artifact store at the path the container bind-mounts, so it is configured
this way in a systemd drop-in:

```
# ~/.config/systemd/user/doubtech-ci-agent.service.d/artifact-root.conf
[Service]
Environment=CI_ARTIFACT_ROOT=/volumes/doubtech-ci/artifacts
```

A node that is *not* co-located has no such escape and is still bounded by the
proxy cap; raising it is tracked on the DoubTech CI project.

DoubTech CI's retention sweep keeps the newest `retentionKeep` successful builds
per project and platform — the default of 10 would hold roughly **140 GB** of
ISOs on the artifact NAS, before counting packages. Two consequences:

- Lower `retentionKeep` for this project (`PATCH /api/projects/:id`); 2–3 is
  usually enough to keep a known-good image and its predecessor.
- Prefer ISO-producing builds on release-worthy commits rather than on every
  push. The pipeline schema has no tag filter, so this is controlled by the
  watched `branches` list and by which branch release work lands on.

Artifact downloads are served from `GET /api/artifacts/:id/download` and require
an HMAC-signed URL when the server sets `CI_URL_SIGNING_SECRET`, unless the
project is marked `publicReleases`.
