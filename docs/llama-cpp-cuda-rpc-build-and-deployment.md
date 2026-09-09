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
> protocol. The appliance needs **no CUDA compiler**, but it does need the CUDA
> *runtime* libraries — see [What the target actually needs](#what-the-target-actually-needs),
> which is the one place the obvious assumption is wrong.

**Status (2026-09-09):** proven, wired, and packaged. A CUDA `ggml-rpc-server` built by
this procedure loaded Qwen3-8B-Q4_K_M onto drakemore's RTX 3090 and served a completion at
132 tok/s — see [Verifying](#verifying) for the measurements. The ROCm engine was rebuilt
with `-DGGML_RPC=ON` and promoted on both dev servers, and the manager now starts, stops and
probes the rpc-server itself — see
[Supervision](#supervision-who-starts-and-stops-it-and-why-nothing-else-can). It also ships
as two Debian packages built by `scripts/package-cuda-rpc.sh`, installed and verified on
drakemore — see [Packaging](#packaging-how-this-reaches-an-installed-box) — so the packaged
path the supervisor resolves is real on that box.

What is NOT done is the *release* integration: the private respin repo does not yet build
these packages, so an ISO built today still does not carry them. The exact remaining changes
are listed in the Packaging section.

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
   ggml-rpc-server  (CUDA, on the host: no nvcc, but needs the CUDA runtime libs)
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

`--list-devices` answers *this* question — whether the backend exists at all — and
only this one. It is necessary, not sufficient: an engine can list `RPC0`, having
reached the server perfectly well, and still serve every token from the CPU. For
whether work actually lands on the card, use the three-signal bar in
[Verifying](#verifying).

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

## What the target actually needs

It is very natural to assume — and the original investigation into this did assume —
that because `libcuda.so.1` comes from the driver, a prebuilt CUDA binary needs
nothing else. **That is wrong**, and it is the single fact that decides how this gets
packaged. `readelf -d libggml-cuda.so.0.22.0` on the built artifact:

```
NEEDED  libcudart.so.13     ← CUDA runtime   — from the TOOLKIT, not the driver
NEEDED  libcublas.so.13     ← BLAS           — from the TOOLKIT, not the driver
NEEDED  libcuda.so.1        ← driver         — the only one already on the box
```

`libcublas` in turn needs `libcublasLt.so.13`. So three toolkit libraries have to
reach the appliance one way or another, totalling **~595 MB** — of which ~540 MB is
`libcublasLt` alone, a fatbinary carrying every architecture NVIDIA ships.

`nvprune` is the normal answer to that and **does not work here**:

```
nvprune fatal : Input file 'libcublas.so.13.0.2.14' not relocatable
```

CUDA 13's redistributable shared objects are not prunable fatbinaries; nvprune
operates on relocatable objects and static libraries. There is no trimming to be had.

`GGML_STATIC=ON` would link `cudart_static` / `cublas_static` and remove the
dependency, but it also does `add_link_options(-static)` globally
(`ggml/src/CMakeLists.txt`), which is incompatible with `BUILD_SHARED_LIBS` and with
dlopening the driver. Not usable.

One dependency *was* removable: **`GGML_CUDA_NCCL` defaults to `ON`**, and a build
that finds NCCL picks up a `libnccl.so.2` dependency worth another ~200 MB. A
single-card appliance has no use for collective communication, so the build passes
`-DGGML_CUDA_NCCL=OFF`.

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
4. Stages `ggml-rpc-server`, every `libggml*.so*`, the three CUDA runtime libraries,
   and a `BUILD-INFO` provenance stamp into `dist/llama-cpp-cuda/` — one flat
   directory, ~647 MB, complete enough to run by itself.

`dist/` is gitignored; the artifact set is far too large to commit.

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

- **`libcuda` is only a stub at link time.** The NVIDIA devel image ships
  `lib64/stubs/libcuda.so` with no `libcuda.so.1` name, because the real library
  belongs to the driver on the target. `libggml-cuda.so` links anyway (shared
  libraries tolerate undefined symbols), and then the *executable* link fails with a
  wall of `undefined reference to cuMemCreate`. The toolchain image gives the stub
  its SONAME and the build passes `-Wl,-rpath-link` for it — **`-rpath-link`, not
  `-rpath`**, so the stub's path is used at link time and never recorded in the
  binary. A recorded rpath here would risk loading the stub instead of the driver at
  run time.

No GPU is needed to build. `nvcc` compiles for `sm_86` on any machine.

## Deploying

### The normal route: install the packages

`scripts/package-cuda-rpc.sh` builds them from a staged `dist/llama-cpp-cuda/` tree
(see [Packaging](#packaging-how-this-reaches-an-installed-box)):

```bash
scripts/package-cuda-rpc.sh
# on the appliance
sudo dpkg -i llama-manager-cuda-runtime-13_<v>_amd64.deb \
             llama-manager-cuda-rpc_<v>_amd64.deb
```

That lands the binary at the path llama-manager resolves:

```
/usr/lib/llama-manager/engine-cuda/current/ggml-rpc-server
```

`/usr/lib`, not `/var/lib`: this is package-owned, immutable content, unlike the ROCm
engine directory, which the manager itself writes to. `current` is a `postinst`
symlink to a revision-named directory, so an upgrade is a symlink swap and a rollback
is the reverse — and a hand-staged engine can be tested by repointing `current`
without dpkg fighting you for it (`postrm` leaves a repointed link alone).

### Hand-staging, before a package exists for a new build

`engine-cuda`, not `engine`: the CUDA artifacts must not be mixed into the HIP engine
directory, whose contents are all on the router's `LD_LIBRARY_PATH`.

```bash
# on the build host
rsync -a dist/llama-cpp-cuda/ <appliance>:/tmp/engine-cuda-<ref>/
# on the appliance, as root
mv /tmp/engine-cuda-<ref> /usr/lib/llama-manager/engine-cuda/<ref>
ln -sfn <ref> /usr/lib/llama-manager/engine-cuda/current
```

### Running it

The rpc-server runs **on the host**, not inside the ROCm distrobox — it needs
`libcuda.so.1` and the `/dev/nvidia*` nodes, which is what the host has and the ROCm
toolbox does not.

```bash
/usr/lib/llama-manager/engine-cuda/current/ggml-rpc-server --host 127.0.0.1 --port 50052
```

**No `LD_LIBRARY_PATH` is needed.** Every artifact is built with `RUNPATH = $ORIGIN`,
which covers the `libggml*` siblings *and* — through the symlinks the engine package
ships — the CUDA runtime libraries in the sibling `cuda-runtime-13` directory.
Measured on drakemore against the installed tree with no environment set: `ldd`
resolves `libcudart.so.13`, `libcublas.so.13` and `libcublasLt.so.13` out of
`engine-cuda/current/`, and only `libcuda.so.1` comes from the system, which is
correct — it belongs to the driver. (An earlier draft of this document said
`LD_LIBRARY_PATH` was required. It is not; corrected against the measurement.)

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

## Supervision: who starts and stops it, and why nothing else can

The manager runs the rpc-server itself — `api/rpc-supervisor.js` for the decisions,
`gpuAcceleratorEnv()` in `api/server.js` for the process I/O. There is deliberately
**no systemd unit**: a card that is only usable while a unit is enabled is not
shareable, which is the whole reason the accelerator goes through a separate process
at all.

**Which binary**, in order (`resolveRpcServerBin`):

1. `LLAMA_RPC_SERVER_BIN`, if set. This is how a source checkout or a test points at
   one.
2. On a packaged install, `/usr/lib/llama-manager/engine-cuda/current/ggml-rpc-server`.
3. Otherwise **none** — and the accelerator then behaves exactly as if it were
   switched off, logged, never an error. A settings file copied from an appliance onto
   a developer box degrades rather than failing.

Step 2 is where `llama-manager-cuda-rpc` installs the engine (`<ref>/` plus a `current`
symlink); the hand-rolled [Deploying](#deploying) recipe above stages the same tree
under `/var/lib/` instead, which is why a hand-staged tree needs
`LLAMA_RPC_SERVER_BIN`.

The binary's directory goes on the child's `LD_LIBRARY_PATH`, and it is bound to
`127.0.0.1` unconditionally. The packaged tree does not *need* the former — every
artifact has `RUNPATH $ORIGIN` and the CUDA runtime reaches it through relative
symlinks into the sibling `cuda-runtime-13/` directory — but a hand-staged
`dist/llama-cpp-cuda/` tree does, and setting it changes nothing for the packaged
one: with it set, `ldd` still resolves `libcudart`, `libcublas` and `libcublasLt` out
of `engine-cuda/current/` and only `libcuda.so.1` from the driver.

### llama.cpp does not degrade at either end — measured, 2026-09-08

This is the fact the whole design bends around. Both halves were measured on the
promoted b10752 RPC engine:

| Event | What llama.cpp does |
|---|---|
| `--rpc` at an endpoint nothing is listening on | **SIGABRT while PARSING argv** — exit 134 from `rpc_dispatcher::start` via `common_params_parse`, before any model is touched. `llama-server --rpc 127.0.0.1:59999 --list-devices` is enough to reproduce it. |
| rpc-server dies while an engine is attached | The engine survives the death itself and keeps answering `/health`, then **aborts on its next request**: `ggml-rpc.cpp:566 "Remote RPC server crashed or returned malformed response"` → `ggml_abort` in `rpc_dispatcher::work`. The request that triggers it returns an empty body. |

Neither falls back to local execution. So:

- **The endpoint is proved before it is emitted.** Every engine start does a real TCP
  connect, and anything short of a completed connection — refused, timed out,
  unprobed — means no `--rpc`, a log line saying so, and an engine that serves
  locally. Having just started the server does not count as proof.
- **The rpc-server is never stopped while an engine is attached.** The engine stops
  first, always. This is why a reservation that outranks duo is handled explicitly in
  `drainForReservation()` rather than by `drainPlan()`: the engine runs on the APU and
  only *borrows* the NVIDIA card, so `engineBoundCard()` never matches the accelerator
  card and the generic drain would have handed the holder a card the rpc-server was
  still sitting on.
- **An rpc-server that dies on its own is logged and NOT restarted.** Any attached
  engine is already doomed and a fresh server does not heal its connection; the
  engine's own restart brings both halves back up together. Restarting only the
  rpc-server would produce a card-holding process behind a dead engine and make the
  restart governor's crash loop harder to explain, not easier.

### Lifecycle in one line each

| Trigger | Effect |
|---|---|
| `acceleratorPlan()` says the card may be borrowed, at engine start | Start the rpc-server, wait for it to accept a connection (20s ceiling), then emit `--rpc`. |
| Operator switches `duo.useAccelerator` off | Stop it. |
| The plan stops wanting the card (agent burst, reservation, no NVIDIA card) | Stop it. |
| A reservation outranking duo is granted on that card | Stop the **engine**, then the rpc-server. Releasing the reservation restarts the engine, which starts the rpc-server again. |
| Manager shutdown | Stop the engine, then the rpc-server. |

Verified end to end on drakemore against a throwaway manager instance (its own config,
data and ports; a stub `start-llama.sh` that only records its environment): with no
binary and with a binary that exits without listening, `LLAMA_RPC_ENDPOINT` is unset
and the engine starts; with the real CUDA `ggml-rpc-server` it is started, waited for,
emitted, preempted by a priority-80 reservation on `rtx3090`, restored on release, and
stopped by manager shutdown.

## Packaging: how this should reach an installed box

## Packaging: how this reaches an installed box

The standing rule is that a fix which does not land in the ISO/installer is lost at
the next install. This is **implemented**, not merely recommended:
`scripts/package-cuda-rpc.sh` turns a staged `dist/llama-cpp-cuda/` tree into two
installable `.deb`s, and `packaging/llama-manager-cuda-rpc.{postinst,postrm}` are the
maintainer scripts they carry.

### Two packages, split at the runtime boundary

| Package | Arch | Size | Contents |
|---|---|---|---|
| `llama-manager-cuda-rpc` | amd64 | ~38 MB | `ggml-rpc-server` + the `libggml*` shared libraries, in `/usr/lib/llama-manager/engine-cuda/<ref>/` |
| `llama-manager-cuda-runtime-13` | amd64 | ~394 MB | `libcudart` / `libcublas` / `libcublasLt` `.so.13`, in `/usr/lib/llama-manager/engine-cuda/cuda-runtime-13/` |

`llama-manager-cuda-rpc` depends on `llama-manager` and on the exact version of
`llama-manager-cuda-runtime-13`; the runtime package declares
`Provides: llama-manager-cuda-runtime`.

**Why split rather than one package.** "Depend on the CUDA runtime, do not vendor it"
is the right instinct, but there is no repository an appliance can reach that
provides these libraries. Ubuntu 24.04 `multiverse` ships only the CUDA **12**
runtime (`libcudart12`, `libcublas12`, `libcublaslt12`); CUDA 13 lives in NVIDIA's own
apt repository, which this appliance does not configure — `llama-manager-nvidia-runtime`
pre-bakes driver **debs** and builds the kernel module with `dkms` at boot, and never
performs a package operation against a network. (An earlier draft of this document
claimed the NVIDIA appliance variant configures NVIDIA apt sources. It does not.
Corrected.) And the libraries cannot be trimmed — see
[What the target actually needs](#what-the-target-actually-needs).

So the bytes ship either way. Splitting them buys the thing that actually matters:
the engine follows `.llama-cpp-version` and turns over often, the CUDA runtime turns
over almost never, so an engine bump is a **38 MB** APT update instead of a 633 MB
one. That is the same "independently updatable" reasoning the rest of the package set
is built on. A future box that does have NVIDIA's own packages can satisfy the
dependency through the `Provides` instead.

### How the CUDA libraries are found — no `LD_LIBRARY_PATH`, no `ld.so.conf`

The engine package ships **relative symlinks** in the engine directory:

```
<ref>/libcudart.so.13   -> ../cuda-runtime-13/libcudart.so.13
<ref>/libcublas.so.13   -> ../cuda-runtime-13/libcublas.so.13
<ref>/libcublasLt.so.13 -> ../cuda-runtime-13/libcublasLt.so.13
```

`ggml-rpc-server` and every `libggml*.so` are built with `RUNPATH = $ORIGIN`, so the
installed directory is self-contained and the launcher needs to set nothing. Only
`libcuda.so.1` comes from outside, and that is the driver, already on the box.

All **three** symlinks are shipped even though only `libcudart` and `libcublas` are
direct `NEEDED`s of `libggml-cuda.so`. `libcublas` pulls `libcublasLt` in through its
*own* `$ORIGIN` RUNPATH, and whether glibc expands that `$ORIGIN` to the directory the
object was opened through or to its real location is not worth betting on; shipping
all three makes it resolve either way. Verified on drakemore with `ldd` against the
installed tree, with no environment set.

### Where each piece belongs

- **In this repo:** `scripts/build-llama-cpp-cuda.sh` (produces the artifacts),
  `scripts/package-cuda-rpc.sh` (produces the `.deb`s), and
  `packaging/llama-manager-cuda-rpc.{postinst,postrm}`. The maintainer scripts live
  here on purpose: the respin packager already copies `$source_dir/packaging/*` out of
  this repo for the sysusers, tmpfiles, polkit and service-environment policies, so
  this follows the existing pattern rather than inventing one.
- **In the private respin repo** (`.claude/worktrees/llama-manager-ubuntu-respin-src`
  — note that `distribution/ubuntu-respin` is a stale decoy), to make a *release* carry
  it. Nothing below has been done yet:
  1. `config/assets.lock` — a pinned entry for the staged engine tarball, id
     `llama-cuda-rpc-<ref>`, alongside `llama-rocm-7.2.4-oci` and `ds4-server-gfx1151`.
     Packaging must never compile.
  2. `debian/control` — the two stanzas above, with `Depends: llama-manager
     (= ${binary:Version})` in place of the plain `llama-manager` the standalone script
     emits.
  3. `debian/rules` — two more `if [ -d build/package-root/<pkg> ]` copy lines.
  4. `scripts/build-package-payload.sh` — stage both roots from the pinned tarball, in
     the `amd` branch (a discrete card on an amd64 appliance; the arm64 Spark keeps
     `llama-manager-cuda-gb10`).
  5. `debian/llama-manager-cuda-rpc.postinst` / `.postrm` — copied from this repo's
     `packaging/`. They are static and need no build-time substitution: the postinst
     reads the ref from the `packaged-ref` file the package ships.
  6. **Not** in `llama-manager-appliance`, and **not** in the live-layer pre-bake
     (`CORE_PACKAGES` / `runtime_package` in `scripts/prebake-appliance-stack.sh`).
     Keeping it out of the pre-bake means the ISO does not grow for the boxes that
     have no NVIDIA card; a box that has one pulls it from the APT repo, or a future
     `llama-manager-appliance-nvidia` meta-package depends on it the way
     `-nvidia-spark` depends on `-gb10`.

### Two things the packaging deliberately does not do

- **No systemd unit.** The manager starts and stops the rpc-server itself as it
  schedules work onto the card — see `acceleratorPlan()` in `api/duo-accelerator.js`.
  A card usable only while a unit is enabled is not a shareable card, and shareability
  is the entire reason this is an RPC server rather than a second linked engine. The
  packages install files and nothing that runs them.
- **No global linker configuration.** The CUDA 13 libraries stay in a private
  directory under `/usr/lib/llama-manager` and never reach `/etc/ld.so.conf.d`, so they
  cannot shadow anything else on the box.

### The ROCm engine has to move with it

The router on the installed box still cannot attach unless its engine was built with
`-DGGML_RPC=ON` (`scripts/build-llama-cpp.sh` now passes it). These two ship together
or not at all. Check any engine with:

```bash
ls /var/lib/llama-manager/engine/current/libggml-rpc.so*
```

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

1. `--list-devices` on the client lists an `RPC0` device. **Put `--rpc` BEFORE
   `--list-devices` on the command line.** Arguments are processed in order and
   the device list is produced where the flag appears, so
   `--list-devices --rpc host:port` prints the local backends only and looks
   exactly like a build with no RPC backend at all. Verified on Frostburn against
   drakemore: the same binary printed `ROCm0` alone in that order and
   `ROCm0` + `RPC0: 192.168.1.79:50052 (24123 MiB, 23135 MiB free)` with the flags
   reversed. This is the most likely way to conclude a good build is broken.
2. **The load-bearing one:** VRAM climbs by roughly the model's size above the idle
   baseline **and the rpc-server's own PID is the process holding it** in
   `nvidia-smi --query-compute-apps`. A CPU fallback cannot fake this; signals 1 and
   3 it can survive.
3. Generation returns coherent text at a throughput in the right order of magnitude
   for the card, and GPU utilisation is non-zero while it does.

A completion alone is **not** evidence: llama.cpp falls back to CPU silently, which
is exactly the failure this whole document is about. Neither is VRAM alone — check
all three, because each one has a plausible innocent explanation on its own.

### Measured result, drakemore, 2026-09-08

Idle baseline `1475 MiB, 0 %` — the pods agent's two resident processes (344 MiB and
1108 MiB), matching the ~1.45 GB figure `api/duo-accelerator.js` documents.

```
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 24123 MiB):
  Device 0: NVIDIA GeForce RTX 3090, compute capability 8.6, VMM: yes

client --list-devices:
  RPC0: 127.0.0.1:50052 (24123 MiB, 22387 MiB free)

Qwen3-8B-Q4_K_M.gguf, -ngl 99:   VRAM 1475 -> 6192 -> 12128 MiB

nvidia-smi --query-compute-apps:
  2109229  /opt/speech/.venv/bin/python    344 MiB   ← pods agent, untouched
  2110020  python3                        1108 MiB   ← pods agent, untouched
  3536986  ./ggml-rpc-server             10648 MiB   ← ours

completion:  prompt 275.7 tok/s, generate 132.2 tok/s
             system_fingerprint b10752-b96806d96
GPU util sampled at 2 Hz:  0, 0, 92, 93, 0 %   ← spike aligns with generation
```

132 tok/s on an 8B Q4 is discrete-GPU throughput and nothing like this box's CPU
path, so the timing corroborates the VRAM and utilisation readings instead of the
conclusion resting on any single one.

On teardown the card returned to exactly `1475 MiB, 0 %` with both pods-agent
processes still resident and never signalled — which is also the first direct
demonstration that the card is **borrowed and released**, the property the whole
rpc-server design exists to get.

### Measured result, packaged install on drakemore, 2026-09-09

The above proved the *binary*; this proves the *packaged path*. Both packages were
installed with `dpkg -i` onto drakemore while its llama-manager service stayed up and
the pods agent stayed on the card.

```
dpkg -l | grep cuda
  ii  llama-manager-cuda-rpc         0.0+b96806d9-1
  ii  llama-manager-cuda-runtime-13  13.0.2.14-1

/usr/lib/llama-manager/engine-cuda/
  b96806d9/            cuda-runtime-13/     current -> b96806d9     packaged-ref

ldd /usr/lib/llama-manager/engine-cuda/current/ggml-rpc-server      # no env set
  libcudart.so.13   => .../engine-cuda/current/libcudart.so.13
  libcublas.so.13   => .../engine-cuda/current/libcublas.so.13
  libcublasLt.so.13 => .../engine-cuda/current/libcublasLt.so.13
  libcuda.so.1      => /lib/x86_64-linux-gnu/libcuda.so.1      ← the driver, correctly
```

Run straight from the installed path with no `LD_LIBRARY_PATH`:

```
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 24123 MiB):
  Device 0: NVIDIA GeForce RTX 3090, compute capability 8.6, VMM: yes

nvidia-smi --query-compute-apps:
  3588616  /opt/speech/.venv/bin/python                              352 MiB  ← pods agent
  3589311  python3                                                   352 MiB  ← pods agent
  3738956  /usr/lib/llama-manager/engine-cuda/current/ggml-rpc-server 256 MiB  ← ours
listening: 127.0.0.1:50053
```

Teardown returned the card to its exact `727 MiB, 0 %` baseline with both pods-agent
processes untouched. `dpkg -V` on both packages is clean.

Both `postrm` branches were exercised: removing the package deleted a `current` left
dangling by the removal, and left a `current` that had been hand-repointed at another
engine directory alone. `/var/lib/llama-manager/engine/current` and the running
service were not touched at any point.
