# Build and publish the Llama Manager appliance

Copyright (c) 2026 DoubTech. Use of this document is governed by the LICENSE
file in the repository root.

## Host prerequisites

The builder is Ubuntu 24.04 amd64 with working Podman and enough space for an
approximately 3.1 GB ROCm archive, 5.0 GB Qwen model, 6.7 GB base ISO, package
worktrees, and the final ISO. Install build-only tools:

```bash
sudo apt-get install apt-rdepends build-essential debhelper devscripts reprepro xorriso \
  cloud-init gnupg podman xz-utils squashfs-tools cpio zstd fakeroot
```

The default NAS path must be read-write. If it was mounted read-only:

```bash
sudo mount -o remount,rw /mnt/nas
findmnt -T /volumes/llama-manager
```

Initialize configuration without directly editing `.env`:

```bash
.orchestrator/scripts/dev-config.sh env init \
  /volumes/llama-manager/private/build.env
.orchestrator/scripts/dev-config.sh env list
scripts/release-config.sh validate
```

If the checkout already has a local regular `.env`, migrate it instead of
discarding or manually copying it:

```bash
.orchestrator/scripts/dev-config.sh env migrate \
  /volumes/llama-manager/private/build.env
```

Migration copies the active configuration without printing values, preserves a
mode-0600 timestamped source backup beside the target, and atomically replaces
the repository file with a symlink. It refuses non-empty or symbolic-link
targets so an existing recovery configuration cannot be overwritten silently.
After a disk reimage, clone the private repository and use `env init` to recreate
the local symlink to the preserved NAS target.

Configuration precedence is built-in defaults, then the selected `.env` file,
then explicit process environment values. This lets release automation and tests
override individual NAS-backed settings without editing or accidentally targeting
the persistent production configuration.

Alternatively, keep host packages unchanged and build the pinned disposable
environment:

```bash
podman build -f Containerfile.builder -t localhost/llama-manager-builder:24.04 .
```

Mount this repository at `/workspace`, the manager checkout read-only at
`/source`, verified assets read-only at `/inputs`, and the NAS public/private
trees at their configured paths. Never bake the signing home or `.env` into the
builder image. The container runs the build as root (in the rootless podman
user namespace): package-extraction scratch trees live on build-local disk and
staged copies drop ownership preservation, because the NAS-backed staging tree
refuses `chown` and would otherwise fail the build.

## Build platforms

This document describes the default stable **`amd`** build (AMD Ryzen AI Max
gfx1151, amd64). The build is parameterized by `PLATFORM`; an EXPERIMENTAL
**`nvidia-spark`** platform (NVIDIA DGX Spark, GB10, arm64, CUDA) is also
defined. `PLATFORM=amd` (the default, and an unset value) reproduces the exact
stable output described here. For the experimental arm64/CUDA build — the
`PLATFORM=nvidia-spark` inputs, `TODO-STAGE` asset staging, EXPERIMENTAL
artifact naming, and the scoped `images-nvidia-spark` publish layout — see
[PLATFORMS.md](PLATFORMS.md). The steps below assume `PLATFORM=amd`.

## Inputs and verification

`config/assets.lock` pins the Ubuntu Desktop ISO, Node runtime, four mainline
kernel packages, Qwen model, DS4 binary, and restorable ROCm OCI archive. Every
input must pass `scripts/verify-asset-locks.sh verify` before use. (The lock also
carries `TODO-STAGE` placeholder rows for the experimental arm64/CUDA assets;
those are documented in [PLATFORMS.md](PLATFORMS.md) and are inert for the amd
build.) The ROCm archive also must pass the isolated load test:

```bash
scripts/verify-rocm-archive.sh /path/to/llama-rocm-7.2.4.oci.tar
```

The Llama Manager source checkout must have a current `ui/dist`, production
`api/node_modules`, and the package contract exported at
`packaging/runtime-contract.env`.

`scripts/fetch-assets.sh` populates those inputs on a machine that does not
already hold them — see the next section.

## Bootstrapping inputs on a fresh machine

The build consumes roughly 30 GB of pinned inputs. `scripts/fetch-assets.sh`
stages them into an inputs directory and verifies every one against its
`config/assets.lock` row, so a new builder, a rebuilt host, or a remote CI node
can repopulate without a manual scavenger hunt:

```bash
export LLAMA_ASSET_MIRROR=/volumes/llama-manager/assets   # the seeded NAS mirror
scripts/fetch-assets.sh status --dest /inputs   # what is present/missing/corrupt
scripts/fetch-assets.sh ensure --dest /inputs   # fetch what is missing, verify all
scripts/fetch-assets.sh ensure --dest /inputs --asset qwen3-8b   # one asset
```

Assets are staged in the layout the build already expects: flat at the root of
the inputs directory, except kernel packages, which go in `<dest>/kernel/`
because `container-build.sh` globs them from `"$INPUTS/kernel"/*.deb`. The
grouping comes from the manifest's `kind` column, so `config/assets.lock` stays
the single source of truth and an existing production inputs tree reads as
clean without being rearranged.

`ensure` is idempotent and cheap to re-run: an asset already present and
verified is skipped. Every fetch is staged in `<dest>/.partial/<id>.part` and
only renamed to its final name after `verify-asset-locks.sh verify` passes on
the exact locked byte size and SHA-256, so a partial or corrupted transfer can
never be mistaken for a complete input. Bytes that fail verification are
discarded; a transfer interrupted by a network failure is kept so the next run
resumes it. `status` reports each asset as `present`, `missing`, `corrupt`, or
`placeholder`.

### The mirror

The mirror is seeded on the NAS at **`/volumes/llama-manager/assets`**, a
sibling of `public/` and `private/`. It deliberately sits outside both: `private/`
holds signing material and recovery data, and `public/` is rsynced to the public
download host, where the base ISO and model must not appear. All 12 locked
assets are staged there and verified against `config/assets.lock`.

Every source is tried **mirror first, upstream second**. The mirror is an
absolute path (including a CNFS or NFS mount), a `file://` URL, or an
`http(s)://` base URL, given by `--mirror` or `LLAMA_ASSET_MIRROR`. Its layout
is one immutable path per locked artifact:

```
<mirror>/<asset-id>/<revision>/<filename>
```

Revision scoping keeps an entry immutable even if a lock row is later re-pinned
under the same asset id, which is what lets a lazily-caching client hold a path
cached indefinitely. `scripts/fetch-assets.sh mirror-layout` prints the full
expected path list, which is the checklist for seeding or auditing a mirror.

Upstream is only the fallback for a cold or unreachable mirror. Three assets
have no usable upstream at all and are **mirror-only**:

| Asset | Why upstream cannot serve it |
| --- | --- |
| `ds4-server-gfx1151` | Its locked URL is a GitHub **source tree** at a pinned commit, not a downloadable artifact. The locked 8.9 MB `ds4-server` is a compiled binary whose bytes depend on the toolchain that produced it, so a fresh build from that commit will not reproduce the locked SHA-256. |
| `llama-rocm-7.2.4-oci` | The registry serves the pinned image, but the OCI archive tar is assembled locally and is not byte-reproducible, so a repack will not match the locked digest. |
| `llama-cuda-gb10` | Its `docker://` reference pins **no digest and no tag**, and the image is a locally staged derivative that was never pushed to a registry (see [PLATFORMS.md](PLATFORMS.md)). The digest in its revision column identifies the upstream `ggml-org/llama.cpp` image it was derived from, not this archive. |

For these, `ensure` fails with a message naming the asset, the reason, and the
mirror path that would satisfy it — it never silently half-populates. **Losing
the mirror copy of any of the three means re-creating the artifact and re-pinning
its lock row**, so the mirror is the system of record for them, not a cache.
They are seeded first for that reason, and the mirror must be included in
whatever backs up the NAS.

For a digest-pinned OCI row, `--allow-oci-repack` will pull the pinned manifest
and repack it locally. This exists to help an operator rebuild and **re-pin** a
lost archive, not to feed a pinned build: the repacked tar will normally fail
the locked digest, and `ensure` reports exactly that rather than accepting it.
Pass `--oci-tag` so the restored archive carries the tag the loader expects —
`scripts/verify-rocm-archive.sh` looks for
`docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4`:

```bash
scripts/fetch-assets.sh ensure --dest /inputs --asset llama-rocm-7.2.4-oci \
  --allow-oci-repack --oci-tag docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4
```

The remaining nine assets — the Qwen model, both base ISOs, both Node runtimes,
and the four mainline kernel packages — are plain HTTPS downloads that reproduce
their locked bytes exactly, so they are fully recoverable from upstream with no
mirror at all. Note that the arm64 base ISO lives on `cdimage.ubuntu.com`, not
`releases.ubuntu.com`.

### Per-platform inputs directories

`--dest` is an arbitrary directory, so the `amd` and `nvidia-spark` inputs trees
are staged separately by pointing it at each one. The lock has no platform
column, so `status` and `ensure` cover **every** locked asset regardless of
which platform's tree they are pointed at: against the amd tree the three
arm64/CUDA rows read `missing`, and against the nvidia-spark tree the amd rows
do. Scope the command with `--asset` when that matters:

```bash
scripts/fetch-assets.sh status --dest /path/to/nvidia-spark-inputs \
  --asset qwen3-8b --asset ubuntu-desktop-24.04.4-arm64 \
  --asset nodejs-22.23.1-linux-arm64 --asset llama-cuda-gb10
```

Scoping matters most for `ensure`: run unscoped against an `nvidia-spark` tree
it would download the 6.7 GB amd64 base ISO into it.

`ensure` requires `curl`; `--allow-oci-repack` additionally requires `skopeo`.
Both are overridable with the `CURL` and `SKOPEO` environment variables.
`TODO-STAGE` placeholder rows are skipped with a note and never fetched, since
there is nothing to verify against until an operator stages them.

## Build sequence

After signing is configured, export the required input paths and build:

```bash
export LLAMA_MANAGER_SOURCE_DIR=/path/to/llama-manager
export NODE_ARCHIVE=/path/to/node-v22.23.1-linux-x64.tar.xz
export ROCM_OCI_ARCHIVE=/path/to/llama-rocm-7.2.4.oci.tar
export DS4_SERVER_BIN=/path/to/ds4-server
export ARCHIVE_KEY_GPG=/volumes/llama-manager/private/signing/public/llama-manager-archive-key.gpg

tests/run.sh
dpkg-buildpackage -us -uc -b
scripts/build-apt-repository.sh --packages-dir /path/to/built-debs
scripts/assemble-iso-payload.sh \
  --apt-repository /volumes/llama-manager/public/apt \
  --packages-dir /path/to/built-debs \
  --qwen-model /path/to/Qwen3-8B-Q4_K_M.gguf \
  --output /path/to/iso-payload
scripts/build-iso.sh \
  --base-iso /path/to/ubuntu-24.04.4-desktop-amd64.iso \
  --payload-dir /path/to/iso-payload
```

`build-iso.sh` injects a generated GRUB menu (`scripts/generate-grub-config.sh`)
whose **default** entry boots a live appliance session; installation is the
explicit secondary **"Install Llama Manager (guided)"** entry. The autoinstall
seed and the live-session customization travel inside the `/llama-manager`
payload (assembled by `assemble-iso-payload.sh`), so autoinstall is no longer
mapped to the ISO root where it would auto-launch the installer. See
[LIVE-USB.md](LIVE-USB.md) for the boot flow, the live autostart mechanism, the
install-to-disk entry point, the dashboard hooks, and how to VM-test live mode.

## Live media branding

Overlaying files onto the ISO cannot brand the live boot. The Plymouth splash
and the live session's own filesystem come from the casper layers inside the
image, which `build-iso.sh`'s file-map replay never opens, so a live USB built
without this stage boots Ubuntu's splash no matter what the branding packages
contain.

Ubuntu 24.04.4 Desktop ships a **layered** casper set — `minimal.squashfs`,
`minimal.standard.squashfs`, `minimal.standard.live.squashfs`, per-language and
`enhanced-secureboot` variants — stacked into one root at boot. Only
`minimal.standard.live.squashfs` carries casper itself (`etc/casper.conf`,
`usr/lib/casper/`, `casper.service`), which is why it is the live session layer
and the right place for live branding. The Plymouth plugins live in the
`minimal.squashfs` base layer and appear in no layer above it.

`build-iso.sh` runs this stage itself, on every build, right after it assembles
the platform branding payload — no flag, no operator opt-in. It used to be a
manual step documented here and nowhere else, which the release pipeline never
performed: that is why every image shipped with Ubuntu's splash and Ubuntu's
wallpaper while the GRUB menu and product identity were correctly branded.

A failure in this stage **fails the build**. That is deliberate and differs from
the GRUB overlay, which degrades to an unthemed menu: unbranded live media looks
like a successful build and is only discovered by flashing a USB stick.

Run it by hand only to iterate on the stage itself:

```bash
scripts/build-branding-payload.sh amd /path/to/branding-root
scripts/customize-live-filesystem.sh \
  --base-iso /path/to/ubuntu-24.04.4-desktop-amd64.iso \
  --branding-dir /path/to/branding-root \
  --output /path/to/live-media
```

It emits a tree `build-iso.sh` maps onto the ISO file by file (never as a whole
`/casper` directory — the base image carries per-language and secureboot layers
this stage does not rebuild):

```
live-media/casper/minimal.standard.live.squashfs
live-media/casper/minimal.standard.live.size
live-media/casper/initrd
live-media/md5sum.txt
```

What it does: unpacks the live layer, installs the branding payload into it,
writes `/etc/plymouth/plymouthd.conf` and the `default.plymouth` alternative (the
state `plymouth-set-default-theme` leaves behind, set declaratively so no binary
from the target filesystem is executed — this is what keeps the stage working for
a foreign architecture), provisions `/etc/dconf/profile/user` and compiles
`/etc/dconf/db/local` (see below), repacks with the compressor and block size
read from the source superblock, and regenerates the `.size` sidecar.

## The appliance stack is baked into the live layer

The same stage that brands the live layer also **installs the appliance into
it**, which is what makes the live USB an appliance rather than a demo that
installs itself.

It did not always. Live mode used to apt-install a lean package set into the
running live session on every boot, deliberately skipping the appliance
meta-package because its ROCm/kernel/podman dependencies "cannot work in a RAM
overlay". That reasoning is right about **installing at boot** and does not apply
to **pre-baking at build time**: squashfs pages are read from the USB, not held
in RAM, so putting the stack in the live layer sidesteps the RAM problem instead
of working around it — and removes every way a boot-time package operation can
fail. One did, in the field: the dependency bundle's `curl` could not be
installed over the live layer's `libcurl4t64`, the offline install aborted,
nothing listened on 3001 or 80, and the kiosk sat on "Setting up from the boot
media" indefinitely.

`scripts/prebake-appliance-stack.sh` does the work, from
`customize-live-filesystem.sh`, while the layer is unpacked:

- **Appliance packages** come out of the pool of the signed media APT repository
  passed as `--appliance-repository` — the *same* repository the disk installer
  reads, so live media and an installed disk carry identical bytes. Required:
  `llama-manager`, `llama-manager-archive-keyring`, and the platform runtime
  (`llama-manager-rocm-gfx1151` on amd, `llama-manager-cuda-gb10` on
  nvidia-spark). A missing one fails the build.
- **Offline Ubuntu dependencies** are added by comparing the bundle against the
  layer's own `dpkg` status database, **by name and by version**: a bundle
  package is unpacked when the layer has none, or when the bundle's version is
  newer. That is what apt would do, and the version half is not optional — see
  the skew note below. It needs no hand-maintained list, and the bundle is
  ~130 MB, so the few packages this leaves inert in the layer cost less than the
  list would.
- **First-install steps are replayed by hand**, because no maintainer script can
  run against an unpacked squashfs and a chroot would need privileges the
  rootless release builder does not have: the `llama-manager` account and group,
  the rootless-Podman subordinate ID range from the ROCm postinst, and the
  `multi-user.target.wants` link that `systemctl enable` would have written.
- **The model is not copied, and the engine is not told where it is.**
  `/etc/llama-manager/llama-manager.env` sets `MODELS_DIR=/volumes/models`, an
  allowlisted setting the packaged launcher honours. `/volumes` is where the
  appliance mounts attached storage (NFS on a real deployment), so that path is
  the stable, source-agnostic location the engine always reads; the live session
  bind-mounts the medium's model directory onto it at boot, and the mountpoint is
  created in the layer because a squashfs is read-only. A raw `/cdrom` path in
  the engine's config would hardcode the boot medium — the exact coupling this
  indirection prevents.

### Packages still ship into usrmerge paths, and that shadows the base layer

A second way the layering bites, and the more dangerous one. `/lib`, `/sbin`,
`/bin` and `/lib64` are **symlinks into `/usr`** in `minimal.squashfs` and exist
in no layer above it. Debian packages still ship `./lib/systemd/system/...` and
`./sbin/...` — the real `llama-manager_1.2.0` deb does — and `dpkg-deb --extract`
materialises those as **real directories**. Measured, not assumed: pre-creating
the symlink does not help, tar replaces it either way (dpkg 1.22.6).

overlayfs lets an upper-layer *directory* replace a lower-layer *symlink*
outright, so a `/lib` directory in the live layer makes
`/lib/x86_64-linux-gnu/libc.so.6` vanish at boot and the image never comes up.
A real build produced exactly that — directories at `/lib` and `/sbin` — and it
would have built green, published, and flashed.

Everything the packages drop into a usrmerge path is therefore folded into its
`/usr` counterpart and the shadowing directory removed, after all extraction and
before anything resolves the unit path. `tests/test-live-filesystem.sh` gives the
base-layer fixture its usrmerge symlinks and asserts no shadowing directory
survives.

### Size, measured

Running the stage against the pinned base image and the real 1.2.0 packages:

| | Bytes | |
|---|---:|---|
| `minimal.standard.live.squashfs`, stock | 991,940,608 | 946 MiB |
| the same layer, appliance baked in | 4,223,184,896 | 3.93 GiB |
| **growth** | **+3,231,244,288** | **+3.01 GiB** |

Almost all of it is the ROCm package's OCI archive, which is already gzip-
compressed and so barely shrinks again under squashfs xz. 71 offline dependency
packages and the manager itself account for the rest.

The published ISO was 15.0 GB before this change, so expect roughly 18 GB. The
ROCm bytes are on the media **twice** until the disk installer is repointed at
the squashfs — once in the live layer, once in the media APT repository, which
the disk install still reads.

### The pinned kernel dependency is not satisfied in the live layer

`llama-manager-rocm-gfx1151` declares a hard, version-exact dependency:

```
Depends: linux-image-unsigned-6.18.36-061836-generic (= 6.18.36-061836.202606191408),
         linux-modules-6.18.36-061836-generic (= ...)
```

The live media boots **casper's own kernel** — `6.17.0-14-generic` on today's
base image — so that dependency cannot be satisfied on the live path without
baking a second kernel into the layer and changing what casper boots.

It does not need to be. Measured on a booted appliance, on the live kernel,
running `llama-cli -m /volumes/models/Qwen3-8B-Q4_K_M.gguf -ngl 99` with
`HSA_OVERRIDE_GFX_VERSION=11.5.1` and `/dev/kfd` + `/dev/dri`:

```
Prompt: 185.5 t/s | Generation: 49.4 t/s
```

That is full-offload GPU speed (a CPU fallback gives ~10–15 t/s), so **ROCm 7.2.4
drives gfx1151 on the live kernel**. The 6.18.36 pin is for the installed system
and is untouched there; the live layer takes the runtime and not the kernel.

Nothing is force-installed to achieve this — `dpkg-deb --extract` is
dependency-blind, which is what makes the relaxation free. `tests/test-live-filesystem.sh`
stages the pinned kernel package in the fixture pool, has the fixture ROCm
package declare the dependency on it, and asserts no kernel artifact reaches the
layer, so switching to a resolving installer fails the suite rather than silently
adding ~180 MB and a second kernel.

### The live engine uses a pre-populated image store

The inference engine runs inside the `llama-rocm-7.2.4` Distrobox container.
Live media does not import the 3.11 GB OCI archive into its writable overlay:
the resulting rootless store measured 31 GB on hardware and exhausted casper's
32 GB RAM overlay. The customization stage instead builds a read-only Podman
`additionalimagestores` tree in the squashfs, maps its ownership to the
`llama-manager` service account, and removes the source archive from the live
layer. `iso/live/start-live-appliance.sh` creates only the small writable
container metadata around that pinned image.

This live-only optimization is intentionally separate from an installed
system. The signed ROCm package still owns the OCI archive for disk installs,
and its first-real-boot setup unit loads that archive into the installed service
account's ordinary rootless store. Because the archive is absent from the live
squashfs, the same package-owned unit is skipped there by `ConditionPathExists`;
the live orchestrator continues to use the pre-populated image store.

### The wallpaper needs a dconf profile, not just a drop-in

The branding payload ships the desktop background default as a keyfile under
`/etc/dconf/db/local.d/`. That file is inert on its own **twice over**: dconf
reads only compiled databases, and it consults the `local` system database only
when the `user` profile names it. dconf's built-in fallback reads the per-user
database alone, and stock Ubuntu ships no `/etc/dconf/profile/user` at all — so
for the installed system *and* the live session the branded background was
written, compiled, and then never read.

So both halves are provisioned. On an installed system the branding package's
postinst writes the profile (extending an existing one rather than replacing it)
and runs `dconf update`. In the live session no branding package is installed —
the live package set is deliberately lean — so this stage writes the profile and
runs `dconf compile` into the unpacked layer itself. `dconf-cli` is therefore a
builder-image dependency.

The initrd is a **separate artifact** from the squashfs: rebuilding an initramfs
inside the live filesystem would not change `/casper/initrd`, so the splash would
still be Ubuntu's. Instead the stage appends one compressed cpio segment carrying
the theme, the Plymouth plugin the theme declares (`ModuleName=`, lifted from the
base layer because the stock initrd ships only `two-step`, `text`, `details`, and
`ubuntu-text`), and the theme selection. The kernel unpacks concatenated cpio
archives in order and later entries win, so Canonical's microcode and main
segments are preserved byte for byte and no chroot, kernel match, or foreign-arch
emulation is needed.

`casper/*.manifest` is **not** rewritten. A layered manifest is a diff of package
changes against the layer below; installing files changes no packages, so
regenerating it from an absent dpkg database would replace a correct file with an
empty one. `md5sum.txt` at the ISO root **is** rewritten, for exactly the files
the stage replaced — casper validates it during "Check disc for defects" and it
drifts silently otherwise.

**Root or fakeroot is required.** `unsquashfs` and `mksquashfs` cannot preserve
ownership as an ordinary user, and the live layer is not uniformly root-owned
(`man/man`, `root/syslog`), so a flattened repack corrupts it. The stage
re-executes itself under a **single** `fakeroot` session — one session, because
fakeroot's ownership map only lives for the life of a process — and fails with
that requirement rather than producing a mis-owned filesystem. Inside the builder
container it already runs as root and skips this. The live layer contains no
device nodes, so rootless podman needs no `mknod` privilege.

**The `trusted.` xattr namespace is dropped, and only that one.** Canonical builds
the casper layers through overlayfs, so they carry residual `trusted.overlay.*`
xattrs. Writing them back requires `CAP_SYS_ADMIN`, which the rootless release
builder does not have and `fakeroot` does not fake — unpacking aborts with
`write_xattr: failed to write xattr trusted.overlay.origin ... Operation not
permitted`. The stage passes `-xattrs-exclude '^trusted\.'`.

This is safe, and was checked rather than assumed against the pinned image: the
live layer carries `trusted.overlay.origin` — build-time provenance, meaningless
once the layer is a read-only casper lowerdir — and **zero**
`trusted.overlay.opaque` markers, which are the ones that would change how the
layers union at boot. Every other namespace is preserved. Do **not** "fix" a
future xattr error with `-no-xattrs`: that silently strips `security.capability`
from setuid helpers in the live filesystem, and the contract test fails if you try.
If the stage is ever pointed at a different layer, re-run the check — extract with
`-xattrs-include '^trusted\.overlay\.opaque$' -ignore-errors` and confirm no
opaque write errors appear.

Known gap: the payload's `etc/dconf/db/*.d` keyfiles are installed but not
compiled, because `dconf update` would mean executing a binary inside the target
filesystem. The GNOME/GDM background defaults therefore do not apply to the live
session from this stage; the live kiosk sets its own background.

`SIGNING_KEY_FINGERPRINT` must be configured before the package payload is
assembled. The binary archive key is parsed and must identify that primary key;
the APT builder then verifies the same identity through its secret key,
fingerprint record, armored export, and generated `InRelease` signature.

APT and ISO work directories are always created below
`PRIVATE_STATE_DIR/publication-staging`. The private and public roots must be on
the same filesystem. Completed directories move to immutable
`PUBLIC_OUTPUT_DIR/releases/{apt,images}/...` snapshots and the stable `apt` or
`images` symbolic link changes atomically. Never create an `apt` or `images`
directory manually at the stable path; a legacy non-symlink path is rejected.

Each image snapshot contains the ISO, `SHA256SUMS`, and `SHA256SUMS.asc`.
`SHA256SUMS` records only the ISO basename, so verification is portable:

```bash
cd /volumes/llama-manager/public/images
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
```

The build must also add the pinned Ubuntu kernel packages and all Ubuntu package
dependencies not present in the installed target to the signed media repository.
The target installed by the pinned ISO is the union of its `minimal` and
`minimal.standard` casper layers. Extract and combine those two package
inventories before generating the bundle:

```bash
set -euo pipefail
work="$(mktemp -d)"
xorriso -osirrox on -indev /path/to/ubuntu-24.04.4-desktop-amd64.iso \
  -extract /casper/minimal.manifest "$work/minimal.manifest" \
  -extract /casper/minimal.standard.manifest "$work/minimal.standard.manifest" \
  -extract /casper/minimal.standard.squashfs "$work/minimal.standard.squashfs"

# Casper manifests are unified diffs. Normalize only valid added package rows.
LC_ALL=C awk '
  /^\+\+\+/ { next }
  /^\+snap:/ { next }
  /^\+/ {
    record = substr($0, 2)
    fields = split(record, value, /[[:space:]]+/)
    if (fields != 2 || value[1] !~ /^[A-Za-z0-9][A-Za-z0-9.+-]*(:[A-Za-z0-9]+)?$/ || value[2] == "") {
      print "Malformed added package record: " $0 > "/dev/stderr"
      invalid = 1
      next
    }
    print value[1] "\t" value[2]
  }
  END { exit invalid }
' "$work/minimal.manifest" "$work/minimal.standard.manifest" \
  | LC_ALL=C sort -u > "$work/target.candidates"

# Reject a package that the two layers claim at conflicting versions.
LC_ALL=C awk '
  !($1 in version) { version[$1] = $2; print; next }
  version[$1] != $2 {
    print "Conflicting target versions for " $1 ": " version[$1] " and " $2 > "/dev/stderr"
    invalid = 1
  }
  END { exit invalid }
' "$work/target.candidates" > "$work/target.manifest"

unsquashfs -no-progress -no-xattrs -d "$work/target-root" \
  "$work/minimal.standard.squashfs" var/lib/dpkg/status

scripts/bundle-ubuntu-dependencies.sh \
  --target-manifest "$work/target.manifest" \
  --target-status "$work/target-root/var/lib/dpkg/status" \
  --output /path/to/ubuntu-dependency-debs
rm -rf "$work"
```

Run the generator on an **amd64 Noble** host or container. The resolved package
set is architecture-specific, and a bundle built on an arm64 machine is
silently the wrong one. Both `--target-manifest` and `--target-status` are
mandatory. `--desktop-manifest` is deliberately rejected so an old build
recipe cannot silently restore the wrong source of truth.

Do not substitute `minimal.standard.live.manifest`, a `*.manifest.full` file,
or the Desktop manifest published beside the ISO. The `minimal.standard.live`
inventory describes packages added only to the live session, while the full
filesystem/Desktop inventories include packages that are not installed on the
appliance target. Subtracting either broader inventory can falsely classify a
live-only package as already installed. That is how `keyutils` disappeared from
the bundle even though the installed target needed it to satisfy `nfs-common`.
The two casper manifests are raw unified diffs, not ready-to-use inventories:
only normalized `+` dpkg package/version records describe APT additions, while
`+++` headers, removed rows, and context rows must be discarded. Canonical also
places explicitly prefixed three-field `+snap:<name> <channel> <revision>`
metadata in these files; those rows are excluded because they are not dpkg
packages, while any other malformed added record remains a build error.

The normalized inventory answers which package names and versions the closure
may subtract. It is not a replacement for the authoritative
`var/lib/dpkg/status` extracted from `minimal.standard.squashfs`. The independent
verifier copies that status database byte-for-byte into its isolated APT root so
metadata absent from the manifests—especially versioned `Provides` from t64
packages—continues to participate in resolution. It validates complete installed
package records and rejects missing, empty, or malformed status before invoking
APT's resolver. `-no-xattrs` is required for rootless container builds because
the source image can carry `trusted.overlay.origin`, which cannot be restored
through the host bind mount; the status-file contents do not depend on xattrs.

The bundle lives on the asset mirror at `<mirror>/ubuntu-dependencies/<revision>/`
and is verified against the `SHA256SUMS` it carries rather than a row in
`config/assets.lock`. **Never overwrite a published revision**: an image that has
already been built is reproducible only from the exact bytes it was built from.
CI treats `SHA256SUMS` as a closed inventory, not merely a list of files to
spot-check: every payload must be listed exactly once under a safe top-level
path, with only CI's generated `.revision` marker permitted outside the
manifest. Extra, missing, nested, duplicate, absolute, or traversing entries
fail input staging before the media-only APT simulation runs.
Publish a regenerated bundle under a new revision beside the old one and bump
`CI_DEPENDENCY_BUNDLE_REVISION` in `ci/ci-env.sh`. The current immutable
revision, `24.04.4-r5`, is generated from the installed target inventory and
adds the corrected NFS closure, including `keyutils`. It also carries a
version-compatible `curl`/`libcurl4t64` pair at
`8.5.0-2ubuntu10.13` and retains `openssh-server` — installed on every image,
but enabled only on CI images; see
[CI.md](CI.md#ssh-installed-everywhere-enabled-only-on-ci-images) — plus
`fuse-overlayfs` and `slirp4netns`, which rootless Podman needs on live media.
The unavailable `cog` package is not a seed: generation now fails when any seed
has no candidate in the configured Noble archive. This does not change the
kiosk launcher's existing browser preference and fallback behavior.

The generator resolves the closure by package name **and version**, and proves
it co-installable before publishing the output directory. Matching on the name
alone treated a package the target manifest listed as already present even when
the archive had moved it forward, so the bundled curl demanded a newer exact
`libcurl4t64` than the target supplied and the whole offline install aborted
with `E: Unable to correct problems, you have held broken packages` — a kiosk
with nothing listening on 3001 or 80. Every bundled package's
`Depends`/`Pre-Depends` is resolved against the target's versions plus the
bundle's own. If neither set can satisfy a clause, the generator names the
unsatisfied package, fails, and leaves no publishable output directory. That
class of failure stops the **build** rather than the appliance.

Installation is equally strict about the media boundary. The target installer
uses the signed media as its only package source. When the installed target has
a newer security-update version than the coherent version carried on the
media, a temporary media-only preference makes the media version selectable
with `Pin-Priority: 1001`, and the install uses `--allow-downgrades` so the
complete appliance set can be installed. Both the regular APT source-parts and
preference-parts directories are disabled, so it never consults a network
Ubuntu source. When the target already matches the media, installation follows
the same offline path without changing versions. Successful installation
removes both the temporary APT source and preference in either case.

### The pinned mainline kernel needs a run-parts compatibility shim

The checksum-pinned Ubuntu mainline
`linux-image-unsigned-6.18.36-061836-generic` package generates each of its
`preinst`, `postinst`, `prerm`, and `postrm` maintainer scripts with a call that
ends in two hook directories:

```text
run-parts <flags and --arg values> /etc/kernel/<phase>.d /usr/share/kernel/<phase>.d
```

Debian's `run-parts` accepts one `DIRECTORY`. The image package therefore fails
while dpkg is unpacking it, before the appliance packages can finish, and APT's
outer diagnostic is only exit status 100. This is a defect in these exact
mainline package bytes, not a missing dependency and not permission to relax
maintainer-script failures generally.

`install-offline.sh` creates one temporary directory containing a `run-parts`
compatibility wrapper and a dpkg launcher. APT sanitizes `PATH` before it runs
package maintainer scripts, so prepending the wrapper to APT's environment is
not sufficient. The media-only install instead sets APT's `Dir::Bin::dpkg` to
the temporary launcher. Immediately before executing the real dpkg, that
launcher restores the shim directory at the front of `PATH` and exports the
already-resolved system `run-parts` path. No system binary or dpkg diversion is
created or modified.

The wrapper splits a call only when its final two operands are the matching
`/etc/kernel/<phase>.d` and `/usr/share/kernel/<phase>.d` pair for one of those
four kernel phases. It calls the system `run-parts` for each directory that
exists, in that order, preserving every preceding flag and `--arg`. Any other
invocation is executed by the system binary unchanged, and a failure from
either split call still fails dpkg and APT with its original diagnostic.

The temporary directory owns both the launcher and wrapper and is covered by
the same EXIT cleanup as the media source and preference, so success, failure,
and a second installer run leave none of them behind. For rapid iteration on an
already-failed Subiquity target, replace only the staged script at
`/target/var/lib/llama-manager-installer/install-offline.sh`, then use the
installer environment's own `curtin in-target` entry point to run this command
inside `/target`:

```bash
env LLAMA_MANAGER_TARGET_CHROOT=1 \
  /var/lib/llama-manager-installer/install-offline.sh
```

On desktop media, curtin is supplied by the installer snap and may not exist as
a bare host-shell command; use the same snap entry point shown in Subiquity's
late-command log.

This reruns the same signed, media-only transaction and lets APT finish the
half-installed kernel; it does not add a network source or persist the launcher
or wrapper in the target. Treat this as an iteration and recovery path. A
published ISO must still carry the corrected script and pass the release gates
below.

### Disk installs stage models at the canonical volume path

The installed engine reads `/volumes/models` regardless of whether `/volumes`
is a local filesystem or a deployment mount. Package configuration creates
`/volumes` as `root:root` mode `0755` and `/volumes/models` as
`llama-manager:llama-manager` mode `0770`; this is the mountpoint the ROCm setup
unit names in `RequiresMountsFor=/volumes`. After the media-only APT transaction,
`install-offline.sh` copies the already lock-verified bundled model to
`/volumes/models/Qwen3-8B-Q4_K_M.gguf`, applies mode `0660`, and assigns it to
the service account before enabling or restarting the manager.

The old bundled-model location was
`/var/lib/llama-manager/models/Qwen3-8B-Q4_K_M.gguf`. The installer removes only
that exact file, and only after the canonical copy has been installed and
chowned successfully. It retains the legacy file when it is the same inode as
the canonical target and never deletes other models or configuration below
`/var/lib/llama-manager`. A failed stage therefore leaves the previous copy
available, while a successful rerun does not recreate the duplicate.

### ROCm container setup belongs to the first real boot

Package configuration must not run rootless Podman inside Subiquity's curtin
target. The target inherits the live environment's `/run`; the live and target
`llama-manager` accounts can have different numeric UIDs, leaving the inherited
`/run/llama-manager` unusable by the target account. The target chroot also is
not a complete user-namespace environment, and Podman's namespace clone can
fail before it reaches the local archive. Retrying the same command in another
generic container does not make those assumptions valid.

`llama-manager-rocm-gfx1151` therefore keeps archive presence validation,
subordinate-ID allocation, manager tmpfiles creation, initramfs generation, and
GRUB policy in its maintainer script, but performs no `podman` or `distrobox`
command there. It installs:

- `/usr/lib/llama-manager/scripts/setup-rocm-gfx1151`, the offline idempotent
  setup helper;
- `/usr/lib/systemd/system/llama-manager-rocm-setup.service`, a oneshot running
  as `llama-manager` with `HOME=/var/lib/llama-manager`,
  `XDG_RUNTIME_DIR=/run/llama-manager`, and
  `RuntimeDirectory=llama-manager`. It also declares
  `RequiresMountsFor=/var/lib/llama-manager /volumes`, so both service state and
  the model-volume path are mounted before initialization;
- `/usr/lib/systemd/system/llama-manager.service.d/50-rocm-setup.conf`, the
  vendor drop-in that gives the manager `Requires=` and `After=` ordering on
  the setup unit.

On first real boot the helper loads the packaged archive only if the pinned
image reference is absent, verifies the resulting image ID, and creates
`llama-rocm-7.2.4` with `/volumes:/volumes` only if that container is absent.
Failures remain fatal and no step may use the network. A second run validates
the image ID and exact container name without loading or recreating either
object. The helper accepts no positional arguments. Its test and recovery
overrides are `LLAMA_MANAGER_ROCM_IMAGE`,
`LLAMA_MANAGER_ROCM_EXPECTED_IMAGE_ID`, `LLAMA_MANAGER_ROCM_ARCHIVE`, and
`LLAMA_MANAGER_ROCM_CONTAINER`; their defaults remain the signed package's
pinned image reference, image ID, archive path, and container name.

The unit sets `USER` and `LOGNAME` as well as `HOME`, uses
`RuntimeDirectoryMode=0700`, and remains active after a successful run so
manager restarts do not repeat setup within the same boot. It has
`ConditionPathExists=/usr/lib/llama-manager/offline/llama-rocm-7.2.4.oci.tar`;
it is therefore skipped successfully on the live squashfs, where customization
removed the archive in favor of the pre-populated image store described above.
During package removal, prerm stops `llama-manager.service`, removes the managed
Distrobox and then its Podman image while the setup unit still owns
`/run/llama-manager`, and stops the `RemainAfterExit` setup unit last. The last
step clears completed state so a same-boot reinstall executes setup again;
stopping it before cleanup would remove the runtime directory rootless tooling
needs. A curtin target chroot skips all of those live-system operations.

For the fast package-lifecycle regression, run:

```bash
bash tests/test-rocm-first-boot.sh
```

This fixture targets maintainer-script declarations, systemd ordering and
environment, first-boot mutations, rerun idempotence, retained runtime failure
diagnostics, and chroot-safe removal behavior for the AMD package. It uses the
helper's environment overrides to keep the fixture deterministic. It is distinct
from `tests/test-offline-kernel-container.sh`, which executes the exact mainline
kernel `.deb` and its malformed `run-parts` calls in the builder container.

Copy the resulting `.deb` files and the four checksum-pinned kernel `.deb` files
into the package directory passed to `build-apt-repository.sh`. No maintainer
script may fetch or compile anything.

## Release gates

Before publishing, require all of the following:

- `tests/run.sh` passes.
- the generated Ubuntu dependency bundle passes a media-only APT simulation
  against both the normalized `minimal + minimal.standard` target package
  inventory and the authoritative `minimal.standard.squashfs` dpkg status; the
  portable contract suite alone is necessary but not sufficient.
- the real ROCm archive load/digest check passes.
- `dpkg-buildpackage` and `lintian` pass.
- package-root systemd verification resolves the bundled Node and DS4 paths.
- the signed repository contains `InRelease` and installs in a network-disabled VM.
- target-chroot installation enables first-boot startup without invoking
  `daemon-reload`, `start`, or `restart` against the inactive target systemd,
  and `bash tests/test-rocm-first-boot.sh` proves that it invokes neither Podman
  nor Distrobox before the first real boot.
- live install, upgrade, remove, and purge lifecycle tests prove that managed
  kiosk/ROCm state is unwound while models and configuration remain preserved.
- the `InRelease` and ISO `SHA256SUMS.asc` primary signer fingerprints match the
  configured release fingerprint, and checksum entries contain no host paths.
- failed APT/ISO builds leave the active snapshot link unchanged and no staging
  directory exists under the public tree.
- the ISO boots in UEFI and legacy mode, completes interactive installation
  offline, starts the kiosk, exposes System Login locally only, and serves Qwen.
- an EVO-X2 or EVO-X3 smoke test validates gfx1151 inference, reboot persistence,
  model-storage reconfiguration, and rollback.

Publish only `/volumes/llama-manager/public`. Preserve build inputs, `.env`,
signing state, repository snapshots, and recovery bundles under the private tree.
