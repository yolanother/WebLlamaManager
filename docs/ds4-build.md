# DS4 (DeepSeek V4 Flash) ROCm build & run on Strix Halo (gfx1151)

How to build the `ds4` / `ds4-server` native inference engine (antirez's
DwarfStar) for the AMD Strix Halo iGPU, where the binaries live, and — the
non-obvious part — which distrobox they must **run** in versus **build** in.

> **TL;DR:** Build inside distrobox **`llama-rocm-7rc-rocwmma`** (it is the only
> container with `hipcc` + a complete rocWMMA header tree) using
> `make strix-halo -j"$(nproc)" DEBUG_FLAGS="-g -fPIC"`. The stock `-fPIC` is
> required or the link fails. **Run** the resulting binaries inside the
> **`llama-rocm-7.2.4`** container — the `rocm-7rc` container's HSA runtime
> **segfaults** on gfx1151 queue creation, while 7.2.4 works. The host has no
> ROCm userspace, so the binaries can never run bare-metal. Installed to
> `/home/yolan/.local/bin/ds4*`.

## Source & model

- Repo: `/home/yolan/workspace/ai/ds4` (antirez/ds4 — "DwarfStar").
- Build target: `make strix-halo` (alias `make rocm`). Compiles `ds4_rocm.cu`
  with `hipcc --offload-arch=gfx1151`, links `-lhipblas -lhipblaslt`, backend
  headers under `rocm/*.cuh` use rocWMMA.
- Model (81 GB, downloaded):
  `/home/yolan/models-ds4/deepseek-v4-gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf`
  (also symlinked at `/home/yolan/workspace/ai/ds4/ds4flash.gguf`).

## Build container: `llama-rocm-7rc-rocwmma`

This container (image `docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7rc-rocwmma`)
ships the full toolchain under `/opt/rocm-7.0`:

- `hipcc` (HIP 7.1.25403, AMD clang 20)
- `rocwmma/` **including the `rocwmma/internal/` header tree** — so the
  STRIXHALO.md rocWMMA-internal-headers workaround (cloning ROCm/rocWMMA
  rocm-7.1.0 and copying headers) is **NOT needed here**.
- `hipblas`, `hipblaslt`, `hipcub`, `rocblas` dev headers + libs.

### Build command

```sh
distrobox enter llama-rocm-7rc-rocwmma -- bash -c \
  'cd /home/yolan/workspace/ai/ds4 && make strix-halo -j"$(nproc)" DEBUG_FLAGS="-g -fPIC"'
```

Produces `ds4`, `ds4-server`, `ds4-bench`, `ds4-eval`, `ds4-agent` (ELF PIE,
x86-64, with debug info). Build takes a few minutes; it needs little RAM
(safe to run while the live llama-manager is serving).

### Gotcha 1 — the `-fPIC` link failure (REQUIRED fix)

Out of the box `make strix-halo` compiles every object cleanly but **fails at the
link stage**:

```
ld.lld: error: relocation R_X86_64_32 cannot be used against local symbol;
        recompile with -fPIC
>>> defined in linenoise.o
```

Cause: `hipcc`/`clang++ --hip-link` produces a **PIE** executable, but the plain
C objects (`linenoise.o`, `ds4.o`, …) are compiled by `cc` **without** `-fPIC`.
Fix without patching source: inject `-fPIC` through `DEBUG_FLAGS` (a clean
injection point — it flows into `CFLAGS`/`OBJCFLAGS` and preserves the Makefile's
own `CFLAGS += -D_GNU_SOURCE -fno-finite-math-only` additions, which a wholesale
`CFLAGS=` override on the command line would drop):

```sh
make strix-halo -j"$(nproc)" DEBUG_FLAGS="-g -fPIC"
```

This is a genuine upstream Strix-Halo-target build bug; worth reporting to
antirez/ds4.

## Run container: `llama-rocm-7.2.4` (NOT the build container)

### Gotcha 2 — `rocm-7rc` HSA runtime segfaults on gfx1151

Running the freshly built binary **inside the same `llama-rocm-7rc-rocwmma`
container** segfaults during GPU init, every time:

```
ds4: ROCm backend initialized on AMD Radeon Graphics (sm_115)
Thread 1 "ds4" received signal SIGSEGV
#0 rocr::AMD::GpuAgent::ReleaseQueueMainScratch(...)  libhsa-runtime64.so.1
#5 rocr::HSA::hsa_queue_create(...)                   libhsa-runtime64.so.1
#15 hipblasCreate()                                   libhipblas.so.3
#16 ds4_gpu_init()  rocm/ds4_rocm_runtime.cuh:4389
#17 ds4_engine_open()  ds4.c:25716
```

The crash is inside ROCm's **HSA runtime**, not ds4 code — the `rocm-7rc`
(release-candidate) HSA userspace is broken for gfx1151 queue creation.

The **`llama-rocm-7.2.4`** container (image
`docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4`, ROCm 7.2.4) — the same one
that runs the live llama.cpp server — has a working HSA runtime on this iGPU. Its
library sonames match what the 7.0-built binaries were linked against
(`libhipblas.so.3`, `libhipblaslt.so.1`, `libamdhip64.so.7`,
`libhsa-runtime64.so.1`), so the binaries built in the rocwmma container run
unmodified against the 7.2.4 libs. In 7.2.4 the backend initializes on
`AMD Radeon 8060S Graphics (sm_115)` and model tensors start loading into GTT
correctly.

### Run command

The 7.2.4 container does not have `/opt/rocm/lib` on the default loader path, so
set `LD_LIBRARY_PATH`. `HSA_OVERRIDE_GFX_VERSION=11.5.1` is the standard Strix
Halo override.

```sh
distrobox enter llama-rocm-7.2.4 -- bash -c '
  cd /home/yolan/workspace/ai/ds4
  export LD_LIBRARY_PATH=/opt/rocm/lib:$LD_LIBRARY_PATH
  export HSA_OVERRIDE_GFX_VERSION=11.5.1
  /home/yolan/.local/bin/ds4-server \
    -m /home/yolan/models-ds4/deepseek-v4-gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf \
    -c 8192 --host 127.0.0.1 --port 8000 --rocm'
```

Readiness/health = `GET http://127.0.0.1:8000/v1/models` returns 200 (there is
**no** `/health` endpoint). Chat = `POST /v1/chat/completions` (OpenAI-compatible).

## Binary location & downstream wiring

- Installed to `/home/yolan/.local/bin/{ds4,ds4-server,ds4-bench,ds4-eval,ds4-agent}`
  (home is shared into every distrobox, so the same path resolves inside 7.2.4).
- Downstream manager integration should use
  `DS4_SERVER_BIN=/home/yolan/.local/bin/ds4-server`.
- **Runs in distrobox, not on the host.** The host has no ROCm userspace
  (`/opt/rocm` absent, `libhipblas.so.3` / `libamdhip64.so.7` not found), so the
  manager's start script MUST invoke ds4-server via
  `distrobox enter llama-rocm-7.2.4 -- bash -c '...'` with the `LD_LIBRARY_PATH`
  and `HSA_OVERRIDE_GFX_VERSION` exports above — exactly like the existing
  llama.cpp engine is launched.

## GTT / kernel params

Already configured on this box — no change needed:

```
/proc/cmdline: ... amd_iommu=off amdgpu.gttsize=131072 ttm.pages_limit=31457280 ...
```

That is a ~124 GB GTT aperture, enough for the 81 GB model plus KV/scratch. Do
not change kernel params (needs reboot + operator sign-off).

## Memory: coexistence with the live manager

ds4 sets `oom_score_adj=1000` on itself, so under any memory pressure the kernel
kills **ds4 first**. The 81 GB model needs ~90 GB `MemAvailable`. The live
llama-manager keeps large models resident (gpt-oss-120b ≈ 61–73 GB RSS) and
**auto-reloads them on incoming requests**, so ds4 and a resident big model
cannot coexist in 124 GB RAM.

To free memory gracefully (never `pkill` the live models):

```sh
curl -s -X POST http://localhost:5250/api/models/unload \
  -H 'Content-Type: application/json' \
  -d '{"model":"Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M"}'
# then poll: free -m   until MemAvailable >= ~90 GB
```

**Caveat (observed):** while the box is serving live traffic, the manager
reloads gpt-oss-120b within seconds of an incoming request
(`ensure_model: waiting until model ... is fully loaded`), which re-fills RAM and
OOM-kills a running ds4. A clean full ds4 smoke test therefore needs an
**operator-chosen maintenance window** with big models unloaded AND traffic
paused (or the router stopped via `POST http://localhost:5250/api/server/stop`).

## Verification status (2026-07-12)

- Build: **PASS** — all 5 binaries built, 0 errors, with the `-fPIC` fix.
- Runtime backend init on gfx1151: **PASS** in the 7.2.4 container (backend
  initialized on "AMD Radeon 8060S Graphics", began loading tensors into GTT,
  reached 32 GB before an external gpt-oss reload OOM-killed the process).
- Full completion smoke test (chat response + perf numbers): **PENDING an
  operator memory window** — blocked only by live-traffic memory contention, not
  by any ds4 defect.
