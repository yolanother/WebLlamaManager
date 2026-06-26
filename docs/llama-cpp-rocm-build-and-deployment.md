# llama.cpp ROCm engine: toolbox, deployment & build (AMD Strix Halo)

How the `llama-server` binary that the manager's router runs on the GPU is
provisioned, wired in, deployed, and (only if you need a custom build) compiled.
This is the missing-from-`install.sh` half of the stack: `install.sh` installs the
**Node manager + UI**; this document covers the **llama.cpp engine** it drives.

> **TL;DR (current setup):** the engine runs inside the **ROCm 7.2.4** distrobox
> toolbox `llama-rocm-7.2.4`, which **ships a prebuilt `/usr/local/bin/llama-server`
> (v9820)**. There is **no build step** for normal operation — the manager just
> execs that binary inside the toolbox. The old ROCm-7.0-RC toolbox emitted
> gfx1151-incompatible kernels that hard-froze the box under gpt-oss-120b; 7.2.4
> fixed it. See [Why ROCm 7.2.4](#why-rocm-724-illegal-opcode-lockup-history).

## The two halves of the stack

| Layer | What | Provided by |
|---|---|---|
| **Manager + UI** | `api/server.js` (router/proxy, OpenAI API, web UI) | `./install.sh` (Node deps, `vite build`, systemd `--user` unit `llama-manager.service`) |
| **Engine** | llama.cpp `llama-server` (the actual GGUF inference, on the iGPU) | the **ROCm 7.2.4 distrobox toolbox** ships it prebuilt (this doc); a custom rebuild via `scripts/build-llama-cpp.sh` is optional |

The manager spawns the engine via `start-llama.sh` → enters the
`llama-rocm-7.2.4` distrobox → runs `container-start.sh`, which execs
`llama-server` (the toolbox's `/usr/local/bin/llama-server`) in **router mode**.

## Hardware / container context

- **GPU:** AMD Strix Halo iGPU, `gfx1151`, 1 GB dedicated VRAM + 128 GB GTT (system RAM).
- **Runtime:** ROCm **7.2.4** inside distrobox `llama-rocm-7.2.4`
  (image `docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4`). The distrobox
  shares `$HOME`, so the host `~/.local/bin` and `~/llama.cpp` are visible inside it.
- **Runtime-only toolbox:** the 7.2.4 image is ~7 GB and ships **no compiler** — it is
  a runtime toolbox. It includes a working **prebuilt `/usr/local/bin/llama-server`
  (v9820)**, which is what the manager runs. (The previous `rocm-7rc-rocwmma` image
  carried a full toolchain because we built llama.cpp ourselves; with 7.2.4 we don't
  need to.)
- **Kernel note:** the toolbox README suggests kernel 6.18.4+, but the prebuilt binary
  detects and drives the GPU fine on **kernel 6.17** here
  (`llama-server --list-devices` → `ROCm0: AMD Radeon 8060S Graphics`).
- **Strix Halo unified memory:** `container-start.sh` exports `GGML_HIP_UMA=1` and
  `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` plus `HSA_OVERRIDE_GFX_VERSION=11.5.1` so the HIP
  backend places buffers in GTT instead of the tiny VRAM partition. Without these,
  large models silently fall back to CPU.

## Provisioning the toolbox (one-time)

If the `llama-rocm-7.2.4` distrobox does not exist yet, create it:

```bash
podman pull docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4
distrobox create --name llama-rocm-7.2.4 \
  --image docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4 --yes
```

Verify the prebuilt engine sees the GPU:

```bash
distrobox enter llama-rocm-7.2.4 -- /usr/local/bin/llama-server --version
distrobox enter llama-rocm-7.2.4 -- /usr/local/bin/llama-server --list-devices
# Expect: ROCm0: AMD Radeon 8060S Graphics
```

No build, no `~/.local/bin` install — the toolbox binary is ready to run.

## How the manager picks the toolbox and binary (wiring)

Two knobs select what the manager runs:

| Env var | Value (current) | Meaning |
|---|---|---|
| `DISTROBOX_CONTAINER` | `llama-rocm-7.2.4` | which distrobox the engine runs inside |
| `LLAMA_SERVER_BIN` | `/usr/local/bin/llama-server` | which binary `container-start.sh` execs |

Both are pinned in **two** places, and both matter:

1. **The systemd user service** — `~/.config/systemd/user/llama-manager.service`
   sets them in its `Environment=`.
2. **`install.sh`** — defaults `DISTROBOX_CONTAINER=llama-rocm-7.2.4` and
   `LLAMA_SERVER_BIN=/usr/local/bin/llama-server`, so a fresh install writes the
   correct service env.

### Gotcha: `.env` alone is NOT enough

Setting `DISTROBOX_CONTAINER` / `LLAMA_SERVER_BIN` only in `.env` does **not** take
effect when the manager runs under systemd. The systemd **user environment** already
pins these vars (from the service unit / an older value), and `dotenv` will **not
override an already-set process env var**. So the values baked into the
`llama-manager.service` unit win. To change the toolbox or binary, update the service
file's `Environment=` lines (and `install.sh`'s defaults), then
`systemctl --user daemon-reload && systemctl --user restart llama-manager.service` —
editing `.env` is not sufficient.

## Why ROCm 7.2.4 (illegal-opcode lockup history)

The engine used to run in a ROCm **7.0-RC** toolbox (`llama-rocm-7rc-rocwmma`,
image `…:rocm-7rc-rocwmma`) with a llama.cpp we compiled ourselves. Under
**gpt-oss-120b** inference on the gfx1151 iGPU that toolchain produced
**gfx1151-incompatible GPU kernels**: every ~20–35 s the kernel logged

```
amdgpu: gfx_v11_0_bad_op_irq *ERROR* Illegal opcode in command stream
```

and the box **hard-froze**, requiring a power cycle.

**Two leads were ruled out by direct test** (so we don't chase them again):

- **`amdgpu.cwsr_enable=0`** — a red herring. It did not stop the illegal-opcode
  faults; worse, it caused illegal-opcode faults of its own, so it was removed from
  the kernel cmdline.
- **The `GGML_HIP_ROCWMMA_FATTN` build flag** — rebuilding llama.cpp with it changed
  nothing; the faults persisted.

The real cause was the **ROCm 7.0-RC toolchain version** itself. Switching to the
**ROCm 7.2.4** toolbox fixed it: gpt-oss-120b now runs with **flash-attention ON and
zero illegal opcodes** — verified across 15+ sustained inferences with real output
and **0 GPU resets**.

> Safety-model note: the SP5100 TCO hardware watchdog on this mini-PC is
> **non-functional** (present but never fires — confirmed by a 6 h freeze with
> `RuntimeWatchdogSec=60s` armed), so there is no auto-recovery from a wedge.
> Prevention is the safety model: stay on a known-good toolchain (7.2.4), keep the
> MES-`0x86` firmware update and `amdgpu.runpm=0` in place, and **do not** re-add
> `amdgpu.cwsr_enable=0`.

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

## Deploy / restart

The engine is (re)started by restarting the manager:

```bash
systemctl --user restart llama-manager.service     # restart manager → respawns the engine
# or
./install.sh                                        # also rebuilds the UI
```

See the `deploy-llama-manager` skill for verification (PID changed, `/api/v1/models` → 200).

## Custom builds (optional — not needed for normal operation)

**You do not need to build anything** to run the engine — the 7.2.4 toolbox ships a
working `llama-server`. `scripts/build-llama-cpp.sh` exists only for **custom builds**
(e.g. testing a newer upstream commit for a brand-new model architecture before a
prebuilt toolbox carries it).

The build script was updated to **auto-detect the ROCm directory and HIP compiler**, so
it works across toolbox versions (it no longer hard-codes `/opt/rocm-7.0/...`), and it
keeps `-DGGML_HIP_ROCWMMA_FATTN=ON`. It still needs a toolbox **with a compiler** — the
runtime-only 7.2.4 image cannot build; point `DISTROBOX_CONTAINER` at a toolchain image
for a custom build.

```bash
scripts/build-llama-cpp.sh                      # build the pinned commit, install binary
LLAMA_CPP_CLEAN=1 scripts/build-llama-cpp.sh    # wipe build dir first (clean build)
```

What it does:
1. **Checkout** — clones `~/llama.cpp` if absent, fetches, checks out `LLAMA_CPP_REF`
   from `.llama-cpp-version` (repo root), so a custom build is reproducible.
2. **Configure + build** inside the distrobox with the known-good ROCm flags
   (`-DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1151 -DGGML_HIP_ROCWMMA_FATTN=ON` …, auto-detected
   HIP compiler), Release.
3. **Install** — copies `build/bin/llama-server` → `~/.local/bin/llama-server`.

Env overrides: `LLAMA_CPP_DIR`, `DISTROBOX_CONTAINER`, `INSTALL_BIN`, `JOBS`, `LLAMA_CPP_CLEAN`.

It is a ~30-minute, all-core compile that heavily loads the APU; build it when the box
isn't already thermally stressed (see the `system-health-monitor` skill / the
2026-06-23 lockup learning). To actually **use** a custom binary you must also point
`LLAMA_SERVER_BIN` at it (e.g. `~/.local/bin/llama-server`) in the service env — see
[the wiring section](#how-the-manager-picks-the-toolbox-and-binary-wiring).

### How a custom binary finds its libs (important)

A locally built `llama-server` is built with **RUNPATH → `~/llama.cpp/build/bin`**,
where the shared libs (`libggml-hip.so`, `libllama.so`, `libmtmd.so`, …) live. The
"install" is just a copy of the binary to `~/.local/bin`; **the build directory must be
kept** — deleting it breaks the installed binary. A clean rebuild refreshes both
together. (This applies only to custom builds — the toolbox's `/usr/local/bin/llama-server`
is self-contained.)

## Related

- `container-start.sh` — execs `LLAMA_SERVER_BIN` inside `DISTROBOX_CONTAINER` in router mode.
- `install.sh` — defaults `DISTROBOX_CONTAINER=llama-rocm-7.2.4`, `LLAMA_SERVER_BIN=/usr/local/bin/llama-server`.
- `scripts/build-llama-cpp.sh` — optional custom build.
- `.llama-cpp-version` — the pinned commit for custom builds.
- Skills: `build-llama-cpp` (custom build/update the engine), `deploy-llama-manager`
  (deploy/restart), `system-health-monitor` (don't compile while the box is redlining).
