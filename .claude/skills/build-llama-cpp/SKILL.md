---
name: build-llama-cpp
description: Build or update the ROCm llama.cpp `llama-server` engine that the llama-manager router runs on the AMD Strix Halo iGPU. Use when asked to "update llama.cpp", "rebuild llama-server", "bump the llama.cpp version", add support for a new model architecture (e.g. a new Gemma/Qwen that needs newer upstream), or fix engine-level inference/build issues. Covers the pinned checkout, the distrobox ROCm build, install, and the gotchas.
---

# Build / update the ROCm llama.cpp engine

The manager's router runs llama.cpp `llama-server` on the iGPU. Full context:
`docs/llama-cpp-rocm-build-and-deployment.md`.

## First: you probably don't need to build

The engine now runs inside the **ROCm 7.2.4** distrobox toolbox `llama-rocm-7.2.4`
(image `docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4`), which **ships a working
prebuilt `/usr/local/bin/llama-server` (v9820)**. That is what the manager runs
(`LLAMA_SERVER_BIN=/usr/local/bin/llama-server`, `DISTROBOX_CONTAINER=llama-rocm-7.2.4`).
For normal operation — including gpt-oss-120b with flash-attn — **no build step is
needed**.

Only build when you need a **custom binary**: testing a newer upstream commit for a
brand-new model architecture before a prebuilt toolbox carries it, or debugging an
engine-level issue. To create/refresh the runtime toolbox itself (no build):

```bash
podman pull docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4
distrobox create --name llama-rocm-7.2.4 \
  --image docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4 --yes
```

> History: the old `llama-rocm-7rc-rocwmma` (ROCm 7.0-RC) toolchain emitted
> gfx1151-incompatible kernels → `Illegal opcode in command stream` → hard freezes
> under gpt-oss-120b. `amdgpu.cwsr_enable=0` and the `GGML_HIP_ROCWMMA_FATTN` flag
> were both ruled out as causes; the real fix was moving to ROCm 7.2.4.

## To build a custom binary (optional)

1. **Pin the version** in `.llama-cpp-version` (repo root): set `LLAMA_CPP_REF` to the
   commit you want (bump it deliberately to adopt new upstream model support).
2. **Stop the manager first** so it can't auto-restart the engine mid-build:
   ```bash
   systemctl --user stop llama-manager.service
   ```
3. **Check thermals before compiling** — it's a ~30-min, all-32-core compile that heats
   the APU. Don't start it while the box is already redlining (≥97 °C sustained) or
   running other heavy load. Stop competing jobs first. (See `system-health-monitor`.)
4. **Run the build:**
   ```bash
   scripts/build-llama-cpp.sh                    # pinned commit, install to ~/.local/bin
   LLAMA_CPP_CLEAN=1 scripts/build-llama-cpp.sh  # clean build (use after a big version jump)
   ```
   For a long run, launch it in the background and tail the log.
5. **Point the manager at your custom binary:** the runtime toolbox runs
   `/usr/local/bin/llama-server` by default. To run your build instead, set
   `LLAMA_SERVER_BIN=~/.local/bin/llama-server` in the `llama-manager.service` env
   (NOT just `.env` — dotenv won't override the systemd user env). Then deploy.
6. **Deploy:** `systemctl --user restart llama-manager.service` (or `./install.sh` to also
   rebuild the UI). Verify per the `deploy-llama-manager` skill.

## What the script does

- Manages `~/llama.cpp` (clone if missing → fetch → checkout `LLAMA_CPP_REF`).
- Configures + compiles **inside a distrobox with a compiler** with the known-good
  flags: `GGML_HIP=ON`, `AMDGPU_TARGETS=gfx1151`, `GGML_HIP_ROCWMMA_FATTN=ON`, shared
  libs, server+tools, native, Release. The script **auto-detects the ROCm dir + HIP
  compiler** (works across toolbox versions — no hard-coded `/opt/rocm-7.0` path).
- Copies `build/bin/llama-server` → `~/.local/bin/llama-server`.

> **The runtime-only `llama-rocm-7.2.4` toolbox has no compiler** and cannot build.
> For a custom build, point `DISTROBOX_CONTAINER` at a toolchain image (e.g. a
> `…-rocwmma`/devel toolbox) for the build step.

## Gotchas (learned the hard way)

- **Don't delete `~/llama.cpp/build`.** The installed binary finds its shared libs via
  **RUNPATH into `build/bin`** — the install is just a binary copy; the libs stay in the
  build tree. Clean rebuilds refresh both together.
- **The distrobox uses Makefiles, not Ninja** (ninja isn't installed) — the script uses
  `cmake --build` which respects that.
- **Strix Halo needs the UMA env at *runtime*** (`GGML_HIP_UMA=1`,
  `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1`, `HSA_OVERRIDE_GFX_VERSION=11.5.1`) — set by
  `container-start.sh`, not the build. Without them models fall back to CPU.
- **Multimodal (mmproj) needs the `--models-preset` router**, not `--models-dir` — the
  latter can't attach a per-model vision projector. Update `container-start.sh` to a
  `--models-preset` INI to serve vision models (e.g. Gemma 4) on the GPU.
- **The host-path binary won't run outside the container** (`libhipblas.so.3` missing) —
  that's expected; it only runs inside the distrobox.

## Verify the build

```bash
distrobox enter llama-rocm-7.2.4 -- ~/.local/bin/llama-server --version
distrobox enter llama-rocm-7.2.4 -- ~/.local/bin/llama-server --list-devices
# Expect: ROCm0: AMD Radeon 8060S Graphics
```
Then load a model through the router and confirm it's on the GPU (`-ngl 99`, GTT usage),
not CPU.
