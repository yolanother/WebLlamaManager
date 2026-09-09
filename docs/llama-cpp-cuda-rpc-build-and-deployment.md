# llama.cpp CUDA engine: building and deploying the NVIDIA `ggml-rpc-server`

How a discrete NVIDIA card is made usable by an appliance whose inference engine
is a **ROCm/HIP** build of `llama-server`. Sibling of
[llama.cpp ROCm engine](llama-cpp-rocm-build-and-deployment.md), which covers the
AMD half; read that one first for how the engine directory and the router work.

> **TL;DR:** the HIP router does not get a CUDA backend. It borrows the NVIDIA card
> over llama.cpp's **RPC backend**: a separate, CUDA-built `ggml-rpc-server` process
> owns the card, and the router attaches to it with `--rpc host:port`.
> `scripts/build-llama-cpp-cuda.sh` builds that server inside a
> `nvidia/cuda:*-devel` container from the **same commit pinned in
> `.llama-cpp-version`** as the ROCm build, so the two halves speak the same wire
> protocol. The appliance needs **no CUDA toolkit** — only `libcuda.so.1`, which the
> driver already installs.

## Why RPC and not a second engine

`api/duo-accelerator.js` sets the policy and explains the intent: the card's normal
job usually belongs to something else (on the appliance with the 3090 it is the pods
agent, resident at ~1.45 GB between jobs and bursting hard during them). Running the
card through a *separate process* makes llama's use of it **startable and stoppable**,
which is what makes the card shareable rather than claimed. A second CUDA-linked
`llama-server` would instead hold the card for the router's whole lifetime, and would
double the engine build.

```
   llama-manager (api/server.js)
        │ spawns
        ▼
   llama-server  (HIP / ROCm, gfx1151, in the ROCm distrobox)
        │  --rpc 127.0.0.1:50052        ← RPC *client* backend, compile-time
        ▼
   ggml-rpc-server  (CUDA, on the host, needs only libcuda.so.1)
        │
        ▼
   NVIDIA card
```

Port `50052` is llama.cpp's own default and is what `DEFAULT_RPC_PORT` in
`api/duo-accelerator.js` uses.

## Two prerequisites, both easy to get wrong

### 1. The router must be COMPILED with `-DGGML_RPC=ON`

The RPC backend is registered at **compile time**, in
`ggml/src/ggml-backend-reg.cpp`:

```c
#ifdef GGML_USE_RPC
    register_backend(ggml_backend_rpc_reg());
#endif
```

`GGML_BACKEND_DL` is OFF in our builds, so backends are linked in statically rather
than discovered by scanning for `libggml-*.so`. **Dropping a `libggml-rpc.so` beside
an engine built without the flag does nothing.** This is worth stating plainly
because the opposite is very plausible and costs an afternoon: the shared-library
layout of the engine directory *looks* like a plugin directory, and it is not.

The symptom is quiet. `--rpc` still parses — the string lives in
`libllama-common.so`, which is built regardless — so the router starts, accepts the
flag, and simply never offloads anything. Check with `--list-devices`, not with
whether the process survived.

`scripts/build-llama-cpp.sh` now passes `-DGGML_RPC=ON`. The engine deployed as
**b10752 predates that change and does not have it**; it must be rebuilt and
redeployed before any `--rpc` wiring can work. Adding the flag changes no HIP
codegen — it only adds the socket client backend.

To tell a given engine apart without rebuilding it:

```bash
# Present  => built with -DGGML_RPC=ON.  Absent => not.
ls /var/lib/llama-manager/engine/current/libggml-rpc.so*
```

### 2. Both halves must come from the SAME llama.cpp commit

The RPC wire protocol is versioned by compile-time constants in
`ggml/include/ggml-rpc.h`, and the client refuses a server whose major version
differs or whose minor version is newer:

```c
#define RPC_PROTO_MAJOR_VERSION    6      // at the currently pinned commit
#define RPC_PROTO_MINOR_VERSION    0
#define RPC_PROTO_PATCH_VERSION    0
```

Both build scripts therefore read `LLAMA_CPP_REF` out of the single
`.llama-cpp-version` file rather than taking a ref argument. Keep it that way — a ref
parameter is exactly how the two halves drift apart.

Read the version of a checkout at any time with:

```bash
grep 'define RPC_PROTO' ~/llama.cpp/ggml/include/ggml-rpc.h
```

**The `rpc-server` inside the podman engine image is not a usable peer.** It is
`libggml-rpc.so.0.15.3` — a far older ggml than the 0.22.0 engine — and it is
HIP-built (`readelf -d` shows `NEEDED libggml-hip.so.0`), so it targets an AMD card
anyway. Do not reach for it.

## Naming: `ggml-rpc-server`, not `rpc-server`

Upstream renamed both the CMake target and the executable. At the pinned commit
`tools/rpc/CMakeLists.txt` sets `TARGET ggml-rpc-server`, and building `rpc-server`
fails with `No rule to make target 'rpc-server'`. The old short name survives only
in the stale container image, so grepping for it finds the wrong artifact.

## Building

```bash
scripts/build-llama-cpp-cuda.sh
```

That is the whole procedure. It:

1. Reads `LLAMA_CPP_REPO` / `LLAMA_CPP_REF` from `.llama-cpp-version` and checks that
   commit out into `~/llama.cpp` (override with `LLAMA_CPP_DIR`).
2. Derives a small toolchain image from `nvidia/cuda:*-devel-*` — the stock NVIDIA
   image has `nvcc` but **no cmake**, and the build runs as the invoking user so it
   cannot `apt-get` at run time. The derived image is cached by tag; only the first
   run pays for it.
3. Configures and builds the `ggml-rpc-server` target in `~/llama.cpp/build-cuda`.
4. Stages `ggml-rpc-server`, every `libggml*.so*`, and a `BUILD-INFO` provenance
   stamp into `dist/llama-cpp-cuda/`.

Useful knobs (all env vars):

| Var | Default | Why you would change it |
|---|---|---|
| `CUDA_ARCHS` | `86` | Compute capability. `86` = Ampere GA102 = RTX 3090. Semicolon-separate to support several cards in one binary (bigger, slower to build). |
| `CUDA_IMAGE` | `nvidia/cuda:13.0.1-devel-ubuntu24.04` | Must be **≤ the CUDA version the target driver accepts** — `nvidia-smi` prints it as "CUDA UMD Version". |
| `LLAMA_CUDA_CLEAN` | `0` | `1` wipes the build dir first. |
| `JOBS` | `nproc` | Parallelism. |
| `STAGE_DIR` | `dist/llama-cpp-cuda` | Where the artifact set lands. |

### Two things the build deliberately does

- **`build-cuda`, never `build`.** The ROCm build directory is **not disposable**:
  the installed HIP `llama-server` resolves its shared libraries through a RUNPATH
  that points into it. Reusing that directory breaks the AMD engine.
- **`GGML_NATIVE=OFF`.** The build host and the appliance are not guaranteed to be
  the same microarchitecture, and `-march=native` emits instructions that fault on a
  different one. The ROCm build can afford `NATIVE=ON` because it compiles on the
  machine it runs on; this one is cross-built in a container.

No GPU is needed to build. `nvcc` compiles for `sm_86` on any machine.

## Deploying

Follow the engine directory convention the ROCm side already uses — a versioned
directory plus a `current` symlink, so an upgrade is a symlink swap and a rollback is
the reverse:

```bash
# on the build host
rsync -a dist/llama-cpp-cuda/ <appliance>:/tmp/engine-cuda-<ref>/

# on the appliance, as root
install -d -o llama-manager -g llama-manager /var/lib/llama-manager/engine-cuda
mv /tmp/engine-cuda-<ref> /var/lib/llama-manager/engine-cuda/<ref>
chown -R llama-manager:llama-manager /var/lib/llama-manager/engine-cuda/<ref>
ln -sfn <ref> /var/lib/llama-manager/engine-cuda/current
```

`engine-cuda`, not `engine`: the CUDA artifacts must not be mixed into the HIP
engine directory, whose contents are all on the router's `LD_LIBRARY_PATH`.

The rpc-server runs **on the host**, not inside the ROCm distrobox — it needs
`libcuda.so.1` and the `/dev/nvidia*` nodes, which is what the host has and the ROCm
toolbox does not.

```bash
LD_LIBRARY_PATH=/var/lib/llama-manager/engine-cuda/current \
  /var/lib/llama-manager/engine-cuda/current/ggml-rpc-server \
    --host 127.0.0.1 --port 50052
```

Bind to `127.0.0.1`. The RPC protocol is unauthenticated and lets a peer allocate
buffers and run graphs; upstream says as much. Anything wider needs a deliberate
decision, not a default.

### Selecting the card

Bind by **GPU UUID or PCI bus id, never by positional index** — indices reorder,
which is the entire premise of the epic this work belongs to:

```bash
CUDA_VISIBLE_DEVICES=GPU-83ea6d1c-5aea-9c47-7afa-05cd30c66f27   # UUID form
CUDA_VISIBLE_DEVICES=0000:65:00.0                               # PCI form
```

Get the UUID with `nvidia-smi --query-gpu=uuid,pci.bus_id --format=csv`.

## Packaging: how this should reach an installed box

The standing rule is that a fix which does not land in the ISO/installer is lost at
the next install. The precedent already exists in the respin repo:
`debian/llama-manager-cuda-gb10.*` packages a CUDA engine for the arm64 DGX Spark by
staging a pinned archive and importing it in `postinst`.

Recommended shape — **a new binary package, `llama-manager-cuda-rpc`** (amd64):

- **Contents:** the staged `dist/llama-cpp-cuda/` tree, installed to
  `/usr/lib/llama-manager/engine-cuda/<llama.cpp-ref>/`, with `postinst` creating the
  `/var/lib/llama-manager/engine-cuda/current` symlink. Mirrors how
  `llama-manager-rocm-gfx1151` relates to the ROCm engine.
- **Not in the base meta-package.** It is useless on a box with no NVIDIA card and it
  carries a large CUDA-fat binary. Pull it in from an
  `llama-manager-appliance-nvidia-*` meta-package, alongside the existing
  `llama-manager-nvidia-runtime`, exactly as `-gb10` is pulled in for the Spark.
- **Depends:** the NVIDIA driver package providing `libcuda.so.1`. Nothing else — no
  CUDA toolkit, no runtime libraries; the build statically carries what it needs.
- **Do NOT ship a systemd unit for it.** The manager starts and stops the rpc-server
  itself, because a card that is only usable while a unit is enabled is not shareable
  — that is the whole point of `acceleratorPlan()` in `api/duo-accelerator.js`. The
  package installs a binary and nothing that runs it.
- **The ROCm engine package must be rebuilt too**, with the `-DGGML_RPC=ON` engine
  from `scripts/build-llama-cpp.sh`, or the router on the installed box still cannot
  attach. These two ship together or not at all.

## Verifying

The honest test is a **CPU-only** client: built with `GGML_CUDA=OFF` and
`GGML_RPC=ON`, it cannot reach the NVIDIA card by any route except RPC, so VRAM
movement proves the path rather than merely being consistent with it. A CUDA-linked
client would have used the card directly and told you nothing.

```bash
docker run --rm -v ~/llama.cpp:/src -u "$(id -u):$(id -g)" -e HOME=/tmp \
  llama-cpp-cuda-build:nvidia-cuda-13.0.1-devel-ubuntu24.04 bash -c '
    cmake -S /src -B /src/build-rpcclient -DCMAKE_BUILD_TYPE=Release \
      -DGGML_CUDA=OFF -DGGML_RPC=ON -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=ON \
      -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_CURL=OFF
    cmake --build /src/build-rpcclient --target llama-server -j 8'
```

Then, with the rpc-server running on the appliance:

```bash
llama-server -m Qwen3-8B-Q4_K_M.gguf --rpc 127.0.0.1:50052 -ngl 99 --port 8099
```

Baseline the card first (`nvidia-smi --query-gpu=memory.used --format=csv`), then
watch it during load and generation. What counts as proof:

- `--list-devices` on the client lists an `RPC0` device.
- VRAM climbs by roughly the model's size above the idle baseline, and the
  rpc-server's PID appears in `nvidia-smi`'s process table.
- Generation returns coherent text, and GPU utilisation is non-zero while it does.

A completion alone is **not** evidence: llama.cpp falls back to CPU silently, which
is exactly the failure this whole document is about.
