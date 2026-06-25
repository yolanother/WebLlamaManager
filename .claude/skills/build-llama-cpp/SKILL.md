---
name: build-llama-cpp
description: Build or update the ROCm llama.cpp `llama-server` engine that the llama-manager router runs on the AMD Strix Halo iGPU. Use when asked to "update llama.cpp", "rebuild llama-server", "bump the llama.cpp version", add support for a new model architecture (e.g. a new Gemma/Qwen that needs newer upstream), or fix engine-level inference/build issues. Covers the pinned checkout, the distrobox ROCm build, install, and the gotchas.
---

# Build / update the ROCm llama.cpp engine

The manager's router runs llama.cpp `llama-server` on the iGPU. It is built from a
**pinned commit** and is NOT built by `install.sh` (that's the Node manager/UI). Full
context: `docs/llama-cpp-rocm-build-and-deployment.md`.

## To build / update

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
5. **Deploy:** `systemctl --user restart llama-manager.service` (or `./install.sh` to also
   rebuild the UI). Verify per the `deploy-llama-manager` skill.

## What the script does

- Manages `~/llama.cpp` (clone if missing → fetch → checkout `LLAMA_CPP_REF`).
- Configures + compiles **inside the `llama-rocm-7rc-rocwmma` distrobox** (ROCm 7 + rocwmma)
  with the known-good flags: `GGML_HIP=ON`, `AMDGPU_TARGETS=gfx1151`, shared libs,
  server+tools, native, Release, HIP compiler `/opt/rocm-7.0/llvm/bin/clang++`.
- Copies `build/bin/llama-server` → `~/.local/bin/llama-server`.

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
distrobox enter llama-rocm-7rc-rocwmma -- ~/.local/bin/llama-server --version
```
Then load a model through the router and confirm it's on the GPU (`-ngl 99`, GTT usage),
not CPU.
