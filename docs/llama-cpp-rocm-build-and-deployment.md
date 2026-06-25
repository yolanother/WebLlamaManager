# llama.cpp ROCm build & deployment (AMD Strix Halo)

How the `llama-server` binary that the manager's router runs on the GPU is built,
versioned, installed, and deployed. This is the missing-from-`install.sh` half of
the stack: `install.sh` installs the **Node manager + UI**; this document covers the
**llama.cpp engine** it drives.

## The two halves of the stack

| Layer | What | Built/installed by |
|---|---|---|
| **Manager + UI** | `api/server.js` (router/proxy, OpenAI API, web UI) | `./install.sh` (Node deps, `vite build`, systemd `--user` unit `llama-manager.service`) |
| **Engine** | llama.cpp `llama-server` (the actual GGUF inference, on the iGPU) | `scripts/build-llama-cpp.sh` (this doc) |

The manager spawns the engine via `start-llama.sh` → enters the
`llama-rocm-7rc-rocwmma` distrobox → runs `container-start.sh`, which execs
`llama-server` (found on the container PATH at `~/.local/bin/llama-server`) in
**router mode**.

## Hardware / container context

- **GPU:** AMD Strix Halo iGPU, `gfx1151`, 1 GB dedicated VRAM + 128 GB GTT (system RAM).
- **Runtime:** ROCm 7 RC + rocwmma inside distrobox `llama-rocm-7rc-rocwmma`
  (image `docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7rc-rocwmma`). The distrobox
  shares `$HOME`, so the host `~/.local/bin` and `~/llama.cpp` are visible inside it.
- **Strix Halo unified memory:** `container-start.sh` exports `GGML_HIP_UMA=1` and
  `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` plus `HSA_OVERRIDE_GFX_VERSION=11.5.1` so the HIP
  backend places buffers in GTT instead of the tiny VRAM partition. Without these,
  large models silently fall back to CPU.

## Pinned version

The llama.cpp commit is pinned in **`.llama-cpp-version`** (repo root):

```
LLAMA_CPP_REPO=https://github.com/ggerganov/llama.cpp.git
LLAMA_CPP_REF=<commit sha>
```

Builds check out exactly this commit, so they're reproducible. **To adopt new
upstream model support, bump `LLAMA_CPP_REF` deliberately and rebuild.** The current
pin was chosen for **Gemma 4** (`gemma4` arch + multimodal `mmproj`) and the
re-architected `--models-preset` router (per-model mmproj).

## Building

```bash
scripts/build-llama-cpp.sh                      # build the pinned commit, install binary
LLAMA_CPP_CLEAN=1 scripts/build-llama-cpp.sh    # wipe build dir first (clean build)
```

What it does:
1. **Checkout** — clones `~/llama.cpp` if absent, fetches, checks out `LLAMA_CPP_REF`.
2. **Configure + build** inside the distrobox with the known-good ROCm flags:
   `-DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1151 -DGGML_HIP_NO_VMM=ON -DGGML_HIP_MMQ_MFMA=ON`
   `-DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_TOOLS_INSTALL=ON`
   `-DCMAKE_HIP_COMPILER=/opt/rocm-7.0/llvm/bin/clang++` (Release, Unix Makefiles).
3. **Install** — copies `build/bin/llama-server` → `~/.local/bin/llama-server`.

Env overrides: `LLAMA_CPP_DIR`, `DISTROBOX_CONTAINER`, `INSTALL_BIN`, `JOBS`, `LLAMA_CPP_CLEAN`.

It is a ~30-minute, all-core compile — **not** run by `install.sh`. It heavily loads the
APU; build it when the box isn't already thermally stressed (see the
`system-health-monitor` skill / the 2026-06-23 lockup learning).

### How the binary finds its libs (important)

`llama-server` is built with **RUNPATH → `~/llama.cpp/build/bin`**, where the shared
libs (`libggml-hip.so`, `libllama.so`, `libmtmd.so`, …) live. The "install" is just a
copy of the binary to `~/.local/bin`; **the build directory must be kept** — deleting
it breaks the installed binary. A clean rebuild refreshes both together.

## Router & model loading

`container-start.sh` runs the engine in **router mode**. Two router styles:

- **`--models-dir <dir>`** (current default) — llama.cpp scans `MODELS_DIR` for
  `.gguf` and loads/evicts models on demand (`--models-max N`). No per-model options.
- **`--models-preset <INI>`** (newer upstream) — an INI registry where each model can
  carry its own options, including **`LLAMA_ARG_MMPROJ`** (a vision projector),
  `-ngl`, ctx, etc. The router spawns a per-model child server. **This is required for
  multimodal models** (e.g. Gemma 4 12B's `mmproj`), which `--models-dir` can't do.

GPU layers: `-ngl 99` (offload everything). On Strix Halo the model lives in GTT, so a
12B fits comfortably.

## Multimodal (Gemma 4 example)

Gemma 4 12B ships a main GGUF + an `mmproj-*.gguf` vision projector
(`~/models/google_gemma-4-12B-it-qat-q4_0-gguf/`). To serve it on the GPU through the
swappable router, register it in a `--models-preset` INI with its `LLAMA_ARG_MMPROJ`
pointing at the projector, then point `container-start.sh` at that INI. Running it via
CPU `llama-cpp-python` instead (`--n_gpu_layers 0`) pegs the CPU and redlines the APU —
always prefer the GPU router path.

## Deploy / restart after a rebuild

The new binary is picked up by restarting the engine:

```bash
systemctl --user restart llama-manager.service     # restart manager → respawns the engine
# or
./install.sh                                        # also rebuilds the UI
```

See the `deploy-llama-manager` skill for verification (PID changed, `/api/v1/models` → 200).
When rebuilding the engine, **stop `llama-manager` first** so it doesn't auto-restart
`llama-server` mid-build (`systemctl --user stop llama-manager.service`).

## Related

- `scripts/build-llama-cpp.sh` — the build script.
- `.llama-cpp-version` — the pin.
- Skills: `build-llama-cpp` (build/update the engine), `deploy-llama-manager` (deploy/restart),
  `system-health-monitor` (don't compile while the box is redlining).
