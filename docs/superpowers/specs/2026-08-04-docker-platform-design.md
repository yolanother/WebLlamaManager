# Docker platform — CUDA container images and the `/docker` marketing flow

**Status:** approved design
**Date:** 2026-08-04
**Orch epic:** `7p4eqpCCH11Ce5UcECdWb`

## Summary

Add Docker as a first-class Llama Manager platform. Three deliverables:

1. `llama-manager-cuda-x86` — an amd64 CUDA engine binding Debian package, so
   Intel/x86 servers with discrete NVIDIA GPUs get the same apt install path
   that AMD Strix Halo boxes have today.
2. Two published container images — `yolan/llama-manager:cuda` (self-hosted)
   and `yolan/llama-manager:runpod` (RunPod serverless worker) — both built on
   that package.
3. A `/docker` flow on the marketing site with an interactive configuration
   builder that emits a `.env`, a `docker-compose.yml`, and a `docker run`
   line.

## Motivation

Both existing platforms assume the user owns and boots the hardware: AMD ships
a Strix Halo appliance ISO, NVIDIA an ISO in progress. Neither serves someone
who rents an H100 by the hour or already runs a CUDA server they will not
reimage.

A container removes that constraint. It also closes a real gap in the package
set — `debian/control` has an arm64 CUDA binding for DGX Spark
(`llama-manager-cuda-gb10`) but nothing for the far more common case of an
x86 server with a discrete NVIDIA GPU.

## Repository boundaries

WebLlamaManager stays focused on the application. Packaging lives in separate
projects. No new submodules.

| Repository | Owns |
| --- | --- |
| `yolanother/llama-manager-ubuntu-respin` | `llama-manager-cuda-x86` (new engine binding package) |
| `yolanother/llama-manager-docker` (new, standalone) | Dockerfiles, entrypoint, RunPod handler, compose reference, build/publish scripts, CI |
| `yolanother/llama-manager-web` (`site` submodule) | `/docker` flow, picker card, Docker theme, config builder |
| `yolanother/WebLlamaManager` | Two application changes only (see [Application changes](#application-changes)) |

`llama-manager-docker` is deliberately standalone rather than a submodule.
Nothing in the main repo needs to reference it at build time, and an
independent repository keeps its CI simple.

## Engine package: `llama-manager-cuda-x86`

A new binary package in the respin packaging repository, alongside
`llama-manager-rocm-gfx1151` and `llama-manager-cuda-gb10`.

```
Package: llama-manager-cuda-x86
Architecture: amd64
Depends: ${misc:Depends}, ${shlibs:Depends}, llama-manager (= ${binary:Version})
Description: NVIDIA CUDA runtime integration for Llama Manager (x86-64)
```

### Contents

Installs a self-contained tree under `/usr/lib/llama-manager-cuda/`:

- `bin/llama-server` — built from the llama.cpp commit pinned in
  `.llama-cpp-version`, the same pin the ROCm engine uses.
- `lib/` — the CUDA runtime shared libraries the binary links against, so the
  package does not depend on a host CUDA toolkit installation.
- `bin/start-llama-cuda.sh` — the engine launcher, registered through
  `LLAMA_MANAGER_LLAMA_LAUNCHER`.

### Build flags

```
-DGGML_CUDA=ON
-DCMAKE_CUDA_ARCHITECTURES="80;86;89;90;100;120"
-DGGML_NATIVE=OFF
```

`sm_80` (A100), `86` (A10, RTX 3090), `89` (L40S, RTX 4090), `90` (H100,
H200), `100` (B200), `120` (RTX 50-series). `sm_100` and `sm_120` require CUDA
12.8 or newer, which sets the toolchain floor for the build environment.
`GGML_NATIVE=OFF` keeps the binary portable across build and target hosts.

### Divergence from the GB10 binding

`llama-manager-cuda-gb10` imports a pre-staged distrobox/podman engine image
from its package payload. That is the wrong shape for a container — running
podman inside Docker to reach the GPU is an unnecessary layer.

`llama-manager-cuda-x86` therefore installs a plain binary tree and launches it
directly. No distrobox, no podman. The only host requirement is an NVIDIA
driver new enough for CUDA 12.8; `preinst` checks for `libcuda.so.1` and fails
with an actionable message when it is absent.

The consequence is that a bare-metal Intel/NVIDIA server and the container run
byte-identical engines, because both install this package.

### Cost

The respin build environment gains a CUDA 12.8+ toolchain requirement. This is
the main cost of building the engine as a package rather than inside the
Dockerfile, and it is accepted deliberately: one engine build, one source of
truth.

### Runtime contract additions

`packaging/runtime-contract.env` gains:

```
LLAMA_MANAGER_CUDA_ROOT=/usr/lib/llama-manager-cuda
LLAMA_MANAGER_CUDA_LLAMA_SERVER_BIN=/usr/lib/llama-manager-cuda/bin/llama-server
LLAMA_MANAGER_CUDA_LAUNCHER=/usr/lib/llama-manager-cuda/bin/start-llama-cuda.sh
```

## Application changes

Two changes in WebLlamaManager. Both are small, and both are load-bearing for
bare metal as well as for the container.

### 1. Honor `LLAMA_MANAGER_LLAMA_LAUNCHER`

`api/server.js:5699` and `api/server.js:6311` both hard-code
`join(PROJECT_ROOT, 'start-llama.sh')`. That script is wired to distrobox: it
selects a container name and execs `container-start.sh` inside it.

`packaging/runtime-contract.env` already declares
`LLAMA_MANAGER_LLAMA_LAUNCHER`; the application simply never reads it. Resolve
the launcher through that variable, falling back to
`join(PROJECT_ROOT, 'start-llama.sh')` when unset.

This lets each engine binding supply its own launcher. Without it the
non-distrobox CUDA binding cannot start on bare metal either — this is not a
container-only concern.

### 2. Opt-in inbound authentication

The API server has no inbound auth today, which is correct for a LAN
appliance and unacceptable for a container on a public IP.

Add middleware gated on `LLAMA_MANAGER_REQUIRE_AUTH`:

- **Unset** — current behaviour exactly. The appliance, the dev server, and
  every existing installation are untouched. This is the default and must stay
  the default.
- **Set** — `Authorization: Bearer <LLAMA_MANAGER_API_KEY>` is required on
  `/v1/*` and `/api/*`. A login form exchanges the key for an httpOnly,
  `SameSite=Strict` cookie; the cookie is accepted as an alternative
  credential. Browsers cannot set headers on the `/ws` upgrade request, so the
  cookie is what carries the UI and the WebSocket.
- **Always open** — static assets and `/api/health`. Health must not require a
  credential or container orchestrators cannot probe it.

Requests failing both credential checks get `401` with a `WWW-Authenticate:
Bearer` header. The key is compared with a timing-safe comparison.

## Image: `yolan/llama-manager:cuda`

### Structure

Two stages. The engine is installed, not compiled, so the Dockerfile carries no
build toolchain.

1. **app** — `nvidia/cuda:12.8.1-runtime-ubuntu24.04`. Installs the archive
   keyring, adds
   `deb [signed-by=…] https://llama-manager.doubtech.ai/apt noble main`, then
   `apt install llama-manager llama-manager-cuda-x86`.
   Deliberately **not** `llama-manager-appliance`, which depends on `gdm3`,
   `cage`, the ROCm binding, and a pinned kernel — all meaningless in a
   container.
2. **runtime** — the installed trees plus `tini`, `python3`, `ca-certificates`,
   and the entrypoint. The `llama-manager` package supplies its own Node
   runtime at `/usr/lib/llama-manager/node`, so no distro Node is installed.

Built with `--platform=linux/amd64` pinned, so `Architecture: any` resolves to
the amd64 core package regardless of builder host.

### Volume and path contract

Maps directly onto `api/runtime-paths.js`; no application change is required to
relocate state.

| Env | Path | Holds |
| --- | --- | --- |
| `MODELS_DIR` | `/models` | GGUF files |
| `LLAMA_MANAGER_CONFIG_DIR` | `/config` | `config.json`, generated API key |
| `LLAMA_MANAGER_DATA_DIR` | `/data` | Application state |
| `LLAMA_MANAGER_CACHE_DIR` | `/cache` | Slot KV cache |

`LLAMA_MANAGER_PACKAGED=1` selects the packaged path defaults.
`LLAMA_MANAGER_LLAMA_LAUNCHER=/usr/lib/llama-manager-cuda/bin/start-llama-cuda.sh`
selects the CUDA engine.

### Ports

`3001` — the manager API and the React UI. Published.
`8080` — the llama.cpp router. Internal; not exposed.

### GPU access

Run with `--gpus all`. The image sets `NVIDIA_VISIBLE_DEVICES=all` and
`NVIDIA_DRIVER_CAPABILITIES=compute,utility`.

### Entrypoint

`/usr/local/bin/llama-manager-entrypoint.sh`, owned by the Docker repo:

1. Create the four volume directories if absent.
2. Seed `/config/config.json` with container defaults when missing.
3. **Enforce authentication.** If `LLAMA_MANAGER_API_KEY` is unset, generate
   one, persist it to `/config/api-key` (mode `0600`), and print it once to
   stdout with a clear "save this" banner. Then export
   `LLAMA_MANAGER_REQUIRE_AUTH=1` unconditionally.
4. `exec` the packaged service launcher under `tini`.

The container is therefore always authenticated, while nothing outside the
container sets `LLAMA_MANAGER_REQUIRE_AUTH` and the LAN appliance keeps its
current behaviour. A user who wants an unauthenticated container must remove
the variable explicitly.

`HEALTHCHECK` probes `/api/health`.

### Known constraint

The `llama-manager` package depends on `systemd`. It installs cleanly in a
container; systemd simply is not PID 1. The entrypoint invokes the packaged
launcher directly rather than going through the unit.

## Image: `yolan/llama-manager:runpod`

`FROM yolan/llama-manager:cuda`, plus `pip install runpod` and `handler.py`.

Boot sequence: start the manager in the background, poll `/api/health` until
ready, then `runpod.serverless.start(...)`.

### Job contracts

Both are supported.

**OpenAI-compatible.** RunPod's OpenAI bridge delivers jobs carrying
`input.openai_route` and `input.openai_input`. The handler forwards these to
the local `/v1` endpoints, so standard OpenAI SDKs work against the RunPod base
URL with no bespoke client code. Streaming uses a generator handler with
`return_aggregate_stream` enabled.

**Raw passthrough.** `{"input": {"method", "path", "body"}}` is proxied to the
manager API against a path allowlist, making model listing, preset switching,
and status reachable for power users. The allowlist is explicit — the handler
is not an open proxy into the container.

### Model resolution

1. `/runpod-volume/models` when a network volume is attached — the intended
   production configuration, and the one that keeps warm starts fast.
2. `/models` otherwise.
3. If the requested model is absent from either, download it from Hugging Face
   on cold start, honoring `HF_TOKEN`.

## Site: the `/docker` flow

In the `llama-manager-web` repository.

### Theme and shared-code changes

New `(docker)` route group scoped by `data-theme="docker"` — Docker blue
(`#2496ED`, `#1D63ED`) over near-black, following the token set that
`[data-theme="amd"]` and `[data-theme="nvidia"]` already define in
`globals.css`.

Three shared-code changes:

- `PlatformContent.key` gains `"docker"`.
- `LlamaMarkPalette` gains `"docker"`.
- `PlatformContent.flasherImage` becomes optional, and `PlatformLanding`
  renders `FlasherSection` only when it is present. USB flashing has no meaning
  for a container image.

### Pages

**`/docker`** — `PlatformLanding` with the standard structure: hero, spec band
(CUDA 12.8, `sm_80`–`sm_120`, any NVIDIA GPU, OCI runtime), six feature cards,
the configurator in the `#downloads` slot, closing CTA.

**`/docker/runpod`** — a step-by-step walkthrough in the idiom the `/apt` page
established: `CodeBlock` cards with per-block copy buttons. Covers creating the
endpoint, setting the image, attaching and populating a network volume, and the
environment block.

**`/` (picker)** — a fourth card, "Available now". `.portal-grid` uses
`repeat(auto-fit, minmax(320px, 1fr))`, so it reflows to 2×2 with no CSS
change.

### Scroll video

The supplied source (`~/docker-scroll-background.mp4`) is 1920×1080 h264, 5.04s,
121 frames, with an audio track. The existing scrub videos are all-intra (every
frame a keyframe), 24fps, no audio, published at 1080 and 720 with a
first-frame JPEG poster.

`ScrollVideo` seeks rather than plays. A source that is not all-intra will
judder under scrub. Transcode to match the existing assets exactly and extract
the poster from frame 0.

### Configuration builder

`DockerConfigurator.tsx`, a client island. All generation logic lives in pure
functions under `src/lib/` so it is unit-testable without a browser.

**Flow**

1. **GPU tier** — 24 / 48 / 80 / 141 / 192 GB, or custom.
2. **Proposed bundle** — a curated bundle for that tier (a chat model, a coder,
   an embedding model) with `MODELS_MAX` and context pre-tuned. Bundle
   definitions live in `src/lib/docker-presets.ts` and are fully editable by
   the user after selection. Which specific GGUFs fill each bundle is an
   implementation-time choice, made against models the catalog can verify exist
   at their stated quant and size — this spec fixes the shape of a bundle, not
   its membership.
3. **Add models** — live Hugging Face GGUF search for anything outside the
   curated set, including quant and file-size selection.
4. **Options** — published port, context size, `MODELS_MAX`, API key, HF token.

A running VRAM meter sums the selection and warns when it exceeds the chosen
tier.

**Output tabs**

- `.env` — download and copy.
- `docker-compose.yml` — references the `.env` via `env_file`.
- `docker run` — a single copyable line.
- RunPod — network-volume layout, the environment block, and the one-click
  template link.

**Two decisions worth recording.**

Hugging Face search is proxied through a Next route handler rather than called
from the browser. The site builds with `output: "standalone"`, so route
handlers are available; proxying sidesteps CORS and third-party rate limits on
a marketing page and allows response caching.

The API key is generated in-browser with `crypto.getRandomValues`. The HF token
field is never transmitted anywhere — it is written only into the file the user
downloads. Neither value reaches the site's server.

The RunPod one-click template link depends on a URL contract we do not own. The
manual environment block is therefore always rendered beside it, never hidden
behind a disclosure, so the page stays correct if that contract changes.

## Build and publish

`llama-manager-docker` owns `scripts/build.sh` and `scripts/publish.sh`
(buildx, both images, `--platform=linux/amd64`, tag and push). Two callers
invoke the same scripts:

- The repository's own GitHub Actions workflow.
- The local release-runner, so cutting a release also refreshes the images.

**Tags:** `:cuda`, `:cuda-<appver>`, `:runpod`, `:runpod-<appver>`, `:latest`.
Image versions track the APT package version, which is what actually determines
the application inside them.

## Verification

**Engine package** — installs cleanly on a stock noble host;
`llama-server --version` runs; install fails with an actionable message when
`libcuda.so.1` is absent; `nvidia-smi` shows the process on the GPU during
inference.

**Base image** — `docker compose up` with a builder-generated `.env` loads a
GGUF from the mounted volume and answers an authenticated
`/v1/chat/completions`; the same request without a credential returns `401`;
`/api/health` answers without one; a container started with no
`LLAMA_MANAGER_API_KEY` prints a generated key and still requires it.

**RunPod image** — a live serverless endpoint answers an OpenAI-SDK request and
a raw job request; a cold start with the model absent from the network volume
recovers via the Hugging Face fallback.

**Application** — unit tests for the auth middleware (unset default, bearer,
cookie, health exemption, timing-safe compare) and for launcher resolution
through `LLAMA_MANAGER_LLAMA_LAUNCHER`.

**Site** — tests for `.env`, compose, and `docker run` generation and for the
preset VRAM arithmetic, alongside the existing `tests/*.test.ts`; all four
affected pages render.

## Out of scope

- arm64 images. DGX Spark / GB10 is served by the existing arm64 binding and
  would need its own image; RunPod inventory is amd64.
- Kiosk or desktop layers in the container.
- Replacing the existing distrobox-based ROCm or GB10 bindings.
- Publishing `llama-manager-cuda-x86` into the ISO or appliance metapackages.
- Multi-GPU tensor-split configuration in the builder; single-GPU only in this
  iteration.
