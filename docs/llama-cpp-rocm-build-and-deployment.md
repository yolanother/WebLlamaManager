# llama.cpp ROCm engine: toolbox, deployment & build (AMD Strix Halo)

How the `llama-server` binary that the manager's router runs on the GPU is
provisioned, wired in, deployed, and (only if you need a custom build) compiled.
This is the missing-from-`install.sh` half of the stack: `install.sh` installs the
**Node manager + UI**; this document covers the **llama.cpp engine** it drives.

> **TL;DR (current setup):** the engine runs inside the **ROCm 7.2.4** distrobox
> toolbox `llama-rocm-7.2.4`. Since 2026-09-01 the manager runs a **custom build,
> `~/.local/bin/llama-server` (b10752)**, compiled inside that toolbox by
> `scripts/build-llama-cpp.sh` from the commit pinned in `.llama-cpp-version` — the
> toolbox's own prebuilt `/usr/local/bin/llama-server` is v9820, too old for Muse
> Glimmer 30B (support landed in b10353). `install.sh` prefers the custom binary
> whenever `~/.local/bin/llama-server` exists and falls back to the prebuilt one.
> The old ROCm-7.0-RC toolbox emitted gfx1151-incompatible kernels that hard-froze
> the box under gpt-oss-120b; 7.2.4 fixed it. See
> [Why ROCm 7.2.4](#why-rocm-724-illegal-opcode-lockup-history).

## The two halves of the stack

| Layer | What | Provided by |
|---|---|---|
| **Manager + UI** | `api/server.js` (router/proxy, OpenAI API, web UI) | `./install.sh` (Node deps, `vite build`, systemd `--user` unit `llama-manager.service`) |
| **Engine** | llama.cpp `llama-server` (the actual GGUF inference, on the iGPU) | built by `scripts/build-llama-cpp.sh` inside the **ROCm 7.2.4 distrobox toolbox** at the commit pinned in `.llama-cpp-version` (this doc); the toolbox's prebuilt v9820 binary is the fallback |

The manager spawns the engine via `start-llama.sh` → enters the
`llama-rocm-7.2.4` distrobox → runs `container-start.sh`, which execs
`llama-server` (`$LLAMA_SERVER_BIN`, currently the custom `~/.local/bin/llama-server`) in **router mode**.

## Hardware / container context

- **GPU:** AMD Strix Halo iGPU, `gfx1151`, 1 GB dedicated VRAM + 128 GB GTT (system RAM).
- **Runtime:** ROCm **7.2.4** inside distrobox `llama-rocm-7.2.4`
  (image `docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4`). The distrobox
  shares `$HOME`, so the host `~/.local/bin` and `~/llama.cpp` are visible inside it.
- **Toolbox can build:** the 7.2.4 image ships a working **prebuilt
  `/usr/local/bin/llama-server` (v9820)** AND a usable HIP toolchain (GNU 15.3 +
  `/opt/rocm*/llvm/bin/clang++`) — `scripts/build-llama-cpp.sh` compiles b10752 inside
  it in ~25 minutes. The prebuilt binary is the fallback when no custom build exists.
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

These override instructions apply to source installations. Debian packages pin
both values in the root-owned package launcher and intentionally ignore mutable
configuration attempts to replace them. Packaged `start-llama.sh` executes
`container-start.sh` through Distrobox's host mount at
`/run/host/usr/lib/llama-manager/container-start.sh`.

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

## Custom builds (the current engine)

The manager currently runs a custom build because new model architectures land
upstream faster than the toolbox image is refreshed: **Muse Glimmer 30B** needs
llama.cpp ≥ b10353 (merged 2026-08-10) and the toolbox's prebuilt binary is v9820, so
`.llama-cpp-version` pins upstream tag **b10752** and the manager runs the build.

The build script **auto-detects the ROCm directory and HIP compiler**, so it works
across toolbox versions (it no longer hard-codes `/opt/rocm-7.0/...`), and it keeps
`-DGGML_HIP_ROCWMMA_FATTN=ON`. Build inside the runtime toolbox:

```bash
DISTROBOX_CONTAINER=llama-rocm-7.2.4 LLAMA_CPP_CLEAN=1 scripts/build-llama-cpp.sh
```

### Validation gate before switching the service to a new build

The 2026-08-22 bump was rolled back because Qwen3-8B produced question-mark-only
output on this GPU path. Every bump must pass, on a spare port, by hand, BEFORE
`./install.sh` switches the service:

1. **Qwen3-8B** (`Qwen_Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf`, `--jinja`) answers a
   chat prompt with real text (`chat_template_kwargs: {enable_thinking: false}`).
2. **Gemma-4 E2B** with `--mmproj` and the assistant MTP draft
   (`--spec-type draft-mtp --spec-draft-n-max 1`) answers text, describes an image,
   and logs `draft acceptance`.
3. **Muse Glimmer 30B** UD-Q4_K_XL with `mmproj-Muse-Glimmer-30B-BF16.gguf` and
   `--temp 1.0 --top-p 0.95 --top-k 64` answers text and describes an image
   (expect ~2 minutes to load; the `special_eot_id is not in special_eog_ids` warning
   is benign).

b10752 passed all three on 2026-09-01. When running an engine by hand inside the
toolbox, kill it by port (`pkill -f "[l]lama-server -m .* --port <port>"`) — killing
the `distrobox enter` wrapper leaves the inner `llama-server` alive.

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
- `install.sh` — defaults `DISTROBOX_CONTAINER=llama-rocm-7.2.4`; `LLAMA_SERVER_BIN` prefers `~/.local/bin/llama-server` when it exists, else `/usr/local/bin/llama-server`.
- `scripts/build-llama-cpp.sh` — builds the pinned commit (the current engine).
- `.llama-cpp-version` — the pinned commit (b10752 as of 2026-09-01).
- Skills: `build-llama-cpp` (custom build/update the engine), `deploy-llama-manager`
  (deploy/restart), `system-health-monitor` (don't compile while the box is redlining).
