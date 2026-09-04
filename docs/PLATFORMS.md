# Build platforms

Copyright (c) 2026 DoubTech. Use of this document is governed by the LICENSE
file in the repository root.

The Llama Manager appliance is built from **one** source tree that is
parameterized by a build `PLATFORM`, rather than forked per target. Today two
platforms are defined:

| PLATFORM       | Status         | Arch  | Engine                      | Branding | Base image                          |
| -------------- | -------------- | ----- | --------------------------- | -------- | ----------------------------------- |
| `amd`          | Stable (default) | amd64 | `llama-manager-rocm-gfx1151` (ROCm) + DS4 | AMD ember | `ubuntu-desktop-24.04.4` (amd64)    |
| `nvidia-spark` | **EXPERIMENTAL** | arm64 | `llama-manager-cuda-gb10` (CUDA)          | NVIDIA green | `ubuntu-desktop-24.04.4-arm64`      |

`amd` reproduces today's exact stable output byte-for-byte; `nvidia-spark`
targets the NVIDIA DGX Spark (GB10 Grace‑Blackwell, arm64, CUDA) and is clearly
marked EXPERIMENTAL everywhere a user or operator could see it. Apple Silicon is
explicitly out of scope.

## Selecting a platform

`PLATFORM` is a first-class release-config key (default `amd`), resolved through
the same built-in-default → `.env` → process-environment precedence as every
other setting. All platform-derived values come from a single resolver so the
build scripts never branch on a hard-coded platform name:

```bash
scripts/release-config.sh get PLATFORM                       # -> amd
scripts/release-config.sh platform arch                      # -> amd64
PLATFORM=nvidia-spark scripts/release-config.sh platform arch # -> arm64
scripts/release-config.sh platform artifact --platform nvidia-spark
#   -> llama-manager-ubuntu-24.04.4-nvidia-spark-arm64-EXPERIMENTAL.iso
```

Resolvable fields: `name arch branding channel experimental label
base_iso_asset node_asset engine_package appliance_package version artifact
images_link publish_subdir volid`. An unsupported `PLATFORM` is rejected at
`release-config.sh validate`.

## Respin build version (`RESPIN_BUILD_NUMBER`)

`version` is the Ubuntu base version (`24.04.4`) and is therefore identical for
every build. That is not enough to identify a published image: the automatic
release runner can publish several images in a single day, and they would all
advertise the same version on the download page.

`RESPIN_BUILD_NUMBER` is an optional **process-environment** variable (it is not
a `.env` key) carrying a monotonic respin build number. When set, it suffixes
both `version` and `artifact` on every platform:

```bash
scripts/release-config.sh platform version                    # -> 24.04.4
RESPIN_BUILD_NUMBER=37 scripts/release-config.sh platform version
#   -> 24.04.4.37
RESPIN_BUILD_NUMBER=37 scripts/release-config.sh platform artifact
#   -> llama-manager-ubuntu-24.04.4.37-amd64.iso
```

Rules:

- **Unset or empty → no suffix.** Every output is byte-identical to a build
  without the variable, so manual builds (including the published
  `nvidia-spark` EXPERIMENTAL image) keep their existing names.
- **Must be a positive decimal integer with no leading zeros.** Anything else
  (`0`, `007`, `1.2`, `abc`) is rejected by `release-config.sh validate` and by
  every `platform` field lookup. A malformed value is a hard error rather than a
  silent fallback, because dropping it would publish an image whose version
  collides with an earlier release.
- **The number is allocated by the release runner, not by this repo.** The
  app-side `distribution/release-service/release-runner.sh` keeps the counter in
  `state/build-number` and increments it only after a successful signed publish,
  so a failed build never burns a number.
- **`tests/run.sh` unsets it.** The runner exports it for the whole build, and
  `dh_auto_test` re-runs the suite inside `dpkg-buildpackage`; without that unset
  the artifact-name contract checks would see a versioned filename.

Because the number is part of the artifact filename, the public download URL
changes on every release. The marketing site derives its download link and its
verification commands from the artifact actually present in the published
snapshot, so it follows automatically; anything that hardcodes an ISO filename
does not.

## Offline assets — TODO-STAGE placeholders

The offline invariant is preserved: nothing is fetched at build or install time.
The arm64/CUDA inputs are **not** committed (they are large and, at the time of
writing, not yet published), so `config/assets.lock` carries them as documented
**placeholders**:

| Asset id                        | What the operator stages                          |
| ------------------------------- | ------------------------------------------------- |
| `ubuntu-desktop-24.04.4-arm64`  | Ubuntu 24.04.4 arm64 base image for the DGX Spark |
| `nodejs-22.23.1-linux-arm64`    | Pinned Node.js 22 arm64 runtime tarball           |
| `llama-cuda-gb10`               | Pre-built CUDA `llama.cpp`/GB10 engine OCI archive |

Each placeholder row pins its provenance (repo, revision, URL, license) but sets
the byte size and SHA-256 to the sentinel `TODO-STAGE`. `verify-asset-locks.sh
metadata` accepts these rows, but `verify-asset-locks.sh verify <id> <file>`
hard-fails with a staging message — so an unstaged asset can never enter a build.
**To stage:** download the real artifact, then replace both `TODO-STAGE` fields
in the row with the real size and digest (the same way the stable amd rows are
pinned). No compilation happens at build time; the CUDA engine, like the ROCm
engine, ships as a pre-built archive.

## Packaging

`nvidia-spark` adds two arm64 packages and reuses the shared ones:

- **`llama-manager-cuda-gb10`** — GB10 CUDA engine integration, mirroring
  `llama-manager-rocm-gfx1151`: an offline engine image imported into the service
  account's rootless Podman store plus GB10 host policy (`sysctl`, `modprobe`,
  `grub.d`). Nothing is pulled or compiled at install time.
- **`llama-manager-appliance-nvidia-spark`** — the EXPERIMENTAL meta-package. It
  depends on the CUDA engine and `llama-manager-branding-nvidia` (**not** the AMD
  branding, ROCm, or DS4) and ships the `/etc/llama-manager/platform` marker.

To let one source build both architectures without forking, `llama-manager`
became `Architecture: any` (it builds for the native arch; the amd64 output is
unchanged) and the arch-neutral `llama-manager-archive-keyring` became
`Architecture: all`. On an amd64 builder the arm64 packages are simply not built;
on an arm64 builder the amd64 ROCm/DS4/appliance packages are not built.
`debian/rules` copies only the roots `build-package-payload.sh` assembled for the
configured `PLATFORM`.

## EXPERIMENTAL marking (everywhere it is visible)

- **Artifact name** — `llama-manager-ubuntu-24.04.4-nvidia-spark-arm64-EXPERIMENTAL.iso`.
- **GRUB menu** — every entry title is suffixed `(EXPERIMENTAL)`
  (`generate-grub-config.sh --experimental`).
- **Plymouth / greeter** — the NVIDIA (green) branded boot chain.
- **`/etc/llama-manager/platform`** — contains `nvidia-spark experimental=true`,
  readable by the running appliance.
- **Publish layout** — a per-platform snapshot tree with an `EXPERIMENTAL` marker
  file and a machine-readable `release.json` (below).

### Why `.iso`, not a raw `.img`

The DGX Spark is a standard arm64 UEFI machine that boots a USB image the same way
the AMD appliance does. Keeping the artifact a hybrid **ISO** lets `nvidia-spark`
reuse the entire existing pipeline unchanged — `build-iso.sh`'s xorriso boot
replay, the generated GRUB menu, the atomic signed-snapshot publish, and the
`SHA256SUMS`/detached-signature flow. A raw `.img` would require a separate
partition/ESP imaging path and a parallel signing/publish flow for no boot
benefit on UEFI hardware, so it was deliberately **not** chosen.

## Publish layout

The stable AMD layout is untouched: `releases/images/<timestamp>/` behind the
atomic `images` symlink. An experimental platform is **scoped** so it lands
alongside without ever touching `images`:

```
public/
  images                                   -> releases/images/<ts>/            (AMD, unchanged)
  images-nvidia-spark                      -> releases/images/nvidia-spark/<ts>/
  releases/images/nvidia-spark/<ts>/
    llama-manager-ubuntu-24.04.4-nvidia-spark-arm64-EXPERIMENTAL.iso
    SHA256SUMS
    SHA256SUMS.asc
    EXPERIMENTAL                            (operator-visible marker)
    release.json                           (machine-readable manifest)
```

`publish-snapshot.sh --kind images --platform nvidia-spark` performs the scoped,
atomic switch of the `images-nvidia-spark` link; without `--platform` (or with
`amd`) it behaves exactly as before.

### `release.json`

The marketing site's manifest builder will consume this later:

```json
{
  "platform": "nvidia-spark",
  "arch": "arm64",
  "channel": "experimental",
  "version": "24.04.4",
  "artifacts": [
    { "file": "llama-manager-ubuntu-24.04.4-nvidia-spark-arm64-EXPERIMENTAL.iso",
      "sha256": "<digest>", "size": <bytes> }
  ]
}
```

## Building the experimental image

Stage the three arm64/CUDA assets (update their `TODO-STAGE` rows with real
size/digest), then run the standard sequence with `PLATFORM=nvidia-spark` and the
arm64 inputs:

```bash
export PLATFORM=nvidia-spark
export LLAMA_MANAGER_SOURCE_DIR=/path/to/llama-manager        # built for arm64
export NODE_ARCHIVE=/path/to/node-v22.23.1-linux-arm64.tar.xz
export CUDA_ENGINE_ARCHIVE=/path/to/llama-cuda-gb10.tar
export ARCHIVE_KEY_GPG=/volumes/llama-manager/private/signing/public/llama-manager-archive-key.gpg

tests/run.sh
dpkg-buildpackage -us -uc -b                                  # on an arm64 builder
scripts/build-apt-repository.sh --packages-dir /path/to/built-arm64-debs \
  --output /path/to/nvidia-spark-apt
scripts/assemble-iso-payload.sh --apt-repository /path/to/nvidia-spark-apt \
  --packages-dir /path/to/built-arm64-debs \
  --qwen-model .../Qwen3-8B-Q4_K_M.gguf --output /path/to/iso-payload
scripts/build-iso.sh --base-iso /path/to/ubuntu-24.04.4-desktop-arm64.iso \
  --payload-dir /path/to/iso-payload
```

The experimental channel is **images-only** on the public tree: the stable
shared `apt` link is never rotated, so `build-apt-repository.sh` requires
`--output` for an experimental platform and emits the signed repository solely
for the ISO payload. Otherwise the signing and publish flow is identical to the
stable build; only the artifact name, GRUB tagging, and scoped publish link
differ.

## Secure Boot and the GB10 kernel (documented, not implemented)

These are **notes for a future hardware-validation pass**, not implemented in
this change:

- **Secure Boot.** Like the AMD appliance (which runs an unsigned mainline
  kernel), the experimental GB10 stack uses provisional, unsigned kernel
  configuration. `llama-manager-cuda-gb10`'s `preinst` refuses to install while
  Secure Boot is enabled rather than producing an unbootable setup. A production
  DGX Spark image would instead need either a signed kernel + signed NVIDIA
  modules enrolled via MOK, or a documented Secure-Boot-off requirement.
- **GB10 kernel.** The DGX Spark's GB10 (Grace‑Blackwell) SoC needs an
  NVIDIA/vendor arm64 kernel with the CUDA/`nvidia` driver stack and unified
  memory support; the mainline amd64 kernel pinned for gfx1151 does **not**
  apply. `llama-manager-cuda-gb10` therefore does **not** pin the amd64 mainline
  kernel packages, and the `grub.d` command-line additions
  (`90-llama-manager-gb10.cfg`) are provisional and must be validated on real
  hardware. Pinning the correct GB10 kernel + module packages (as new
  `assets.lock` rows) is follow-up work.

## Out of scope

Actually staging the arm64/CUDA assets, building/flashing an image, hardware
validation, GB10 kernel/module pinning, marketing-site changes, and Apple
Silicon are all out of scope for this change. The acceptance bar here is
script/config-level correctness proven by `tests/run.sh`.
