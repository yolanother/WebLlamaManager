# DS4 Engine — DeepSeek V4 Flash

Llama Manager runs **two inference engines** behind one seam: the default
**llama.cpp** engine (router + presets) and the **DS4** engine
([antirez/ds4](https://github.com/antirez/ds4), "DwarfStar") which serves
**DeepSeek V4 Flash** — a model upstream llama.cpp cannot yet load. DS4 gives us a
much higher-quality "big model" than gpt-oss-120b while running on the same AMD
Strix Halo (gfx1151) iGPU.

This document explains what DS4 is, how it runs on this box, how the manager keeps
it alive, and — most importantly — how it fits an 80 GB model onto a 124 GB shared
box through **adaptive context scaling and SSD expert-streaming**.

For build/runtime setup see [`ds4-build.md`](ds4-build.md); for the self-updater
see [`ds4-auto-update.md`](ds4-auto-update.md); for the engine-abstraction design
see [`Designs/EngineAbstraction.md`](Designs/EngineAbstraction.md).

---

## What DS4 is

- `ds4-server` is a small, self-contained C inference engine purpose-built for
  DeepSeek V4 Flash/PRO. It is **OpenAI-compatible** (`/v1/chat/completions`,
  `/v1/completions`, `/v1/messages`, `/v1/responses`) with streaming and tool
  calls.
- It is **single-model, single-process** and has **no** `/health`, `/slots`,
  `/props`, or `/metrics`. Readiness is `GET /v1/models` returning 200.
- It runs the **DeepSeek V4 Flash IQ2XXS imatrix** GGUF (~80.8 GiB), a specially
  crafted quant that only loads in ds4 (not llama.cpp). It lives **outside**
  `~/models` at `/home/yolan/models-ds4/deepseek-v4-gguf/` so the llama router
  never scans it.
- Because it holds ~80 GB resident (~65% of the box's RAM), it runs in
  **exclusive mode**: while DS4 is active, nothing else loads locally and all
  non-DS4 requests offload to remote backends.

## How it runs on this box (the hard-won facts)

| Aspect | Value |
|---|---|
| Build container | `llama-rocm-7rc-rocwmma` — `make strix-halo -j$(nproc) DEBUG_FLAGS="-g -fPIC"` (the `-fPIC` is required) |
| **Run** container | `llama-rocm-7.2.4` — the 7rc container's HSA runtime **segfaults** on gfx1151, so we build in 7rc and run in 7.2.4 |
| Runtime env | `LD_LIBRARY_PATH=/opt/rocm/lib`, `HSA_OVERRIDE_GFX_VERSION=11.5.1`, `--rocm` |
| Binaries | `~/.local/bin/ds4{,-server,-bench,-eval,-agent}` (or the updater's `~/.local/share/ds4/current/` symlink) |
| Manager port | **5253** (`config.ds4.port`) |
| OOM behavior | ds4-server sets its own `oom_score_adj=1000` — it volunteers as the OOM victim, so a memory shortfall kills DS4 cleanly (GTT released, GPU stays healthy) rather than taking down the box |

The launcher is [`start-ds4.sh`](../start-ds4.sh); the manager spawns it via the
supervisor (below) and never runs it by hand.

## The memory reality: streaming vs full-RAM

DeepSeek V4 Flash weights are ~80.8 GiB. Whether they fit depends on the box:

- **Dedicated box** (LLM only): 80 GB weights + KV/runtime fit in 124 GB → run
  **full-RAM at max context**.
- **Shared box** (this one also runs a web app, orchestrator, docker, etc. — a
  ~30 GB persistent baseline): 80 GB + 30 GB + runtime **exceeds 124 GB** and
  OOMs at the weight-load tail. Here DS4 must **stream experts from the NVMe**
  (`--ssd-streaming`), which cuts resident weights to ~45–55 GB and fits with
  room, at the cost of some generation speed.

The manager handles both automatically — see **Adaptive management** below.

---

## How the manager runs DS4

### 1. The supervisor — `api/ds4-supervisor.js`

A dependency-injected process supervisor (modeled on the embed-server supervisor):
`start` / `stop` / `restart` / `health`. It spawns `bash start-ds4.sh` with the
launch env, probes readiness via `GET /v1/models`, and auto-restarts on unexpected
exit **through the shared restart governor** (debounce + circuit breaker + the
15-minute wedged-GPU hold).

**Load-failure circuit breaker.** DS4 OOMing at the ~80 GB weight-load tail exits
non-zero *before ever serving*. Re-loading the same 80 GB just OOMs again (a slow
restart-thrash — the precursor to the documented wedged-GPU lockup). The supervisor
tracks `sawReady`; a non-zero exit while still `!sawReady` counts a load failure,
and after `guard.ds4MaxLoadFailures` (default 2) consecutive ones it **stops
auto-restarting** and surfaces the cause. A successful serve or a fresh activation
resets the count.

### 2. Exclusive mode + verified pre-eviction — `api/ds4-exclusive.js`

Activating a DS4 preset (`POST /api/presets/<id>/activate`, or a `default-big`
request when default-big points at DS4) runs `activateDs4Exclusive()`:

1. **Flip the engine to DS4 immediately** so `ensureModelServed` early-returns and
   no new local llama load can race the eviction.
2. **Evict llama models by host PID** (`api/engine-kill.js`) — a robust SIGKILL
   that waits until the processes are actually gone (distrobox shares the host PID
   namespace). This does **not** rely on in-container `pkill`, which times out
   under load.
3. **Drop the embed server** unless it fits the budget (`shouldKeepEmbedServer`).
4. **Verify memory actually reclaimed** — poll `/proc/meminfo` `MemAvailable`
   until it reaches `model + guard.ds4ReclaimHeadroomGb` (default **8 GiB**
   absolute — *not* a percentage of total, which for an 80 GB model would demand
   an unreachable ~99 GiB) **before** spawning DS4, so we never over-commit into
   swap.
5. **Run the adaptive plan** (below), holding a swap gate (`ds4SwapPromise`) so
   requests arriving mid-swap are held and answered after readiness, never 404'd.

**Anti-rollback:** if eviction or reclaim hiccups, the box **stays exclusive**
(engine = DS4, flood offloads) and returns a clean 503 rather than rolling back to
llama — which would let the client flood reload a model that competes with DS4's
load and OOM it. This was the fix for a real field OOM. Rollback to llama happens
*only* if DS4's own spawn fails after eviction already succeeded (RAM free, no
race).

While DS4 is active, request routing (`ds4RequestTarget`) is:

- request for the DS4 model / `default-big` → **local ds4-server** (bypasses all
  llama slot/prefix/tokenize machinery via `proxyChatToDs4`);
- request for any other model → **offload to a remote backend**;
- no backend can serve it → **clean 503** (never a second local load, never an
  infinite queue).

### 3. Adaptive context + SSD-streaming — `api/ds4-adaptive.js`

This is the "smart management" that fits DS4 to whatever box it runs on.
`planDs4Attempts()` builds an ordered ladder of load attempts from **live available
memory**:

1. Estimate the largest context that fits in RAM:
   `fit = (available − weights − safety) / kvBytesPerToken`, capped at the
   configured `context`.
2. Build a **descending (halving) non-streaming context ladder** from that estimate
   down to `minContext` (default **8192**).
3. When the non-streaming ladder bottoms out at `minContext` and still can't fit,
   append an **SSD-streaming ladder** — `--ssd-streaming --ssd-streaming-cache-experts <N>`
   frees ~30 GB of resident weights, so context is re-raised back toward the max.

`runDs4AdaptivePlan()` walks the ladder: spawn an attempt → wait for `ready` /
`load-failure` / `timeout` → on failure advance to the next rung → on ready
**settle** and record the effective config. The supervisor runs in "plan mode"
during this (the controller drives retries; the circuit breaker is the backstop).
The settled config is reused by any later auto-restart.

**`ssdStreaming` modes:**

- `auto` (default) — try full-RAM context ladder first, fall back to streaming at
  the floor. **Best for a mixed fleet**: uses full RAM + max context on a
  dedicated box and only streams when it must.
- `on` — always stream. Best for a *known* contended box (like this one), where
  the non-streaming attempts are guaranteed to fail and just waste ~90 s each.
- `off` — never stream (may fail to fit → clean error).

The settled runtime is observable at `GET /api/system/stats` → `ds4Runtime`:
`{ target: {context, ssdStreamingMode, minContext}, effective: {context,
ssdStreaming, cacheExperts}, status: 'loading'|'ready'|'exhausted', attemptsMade }`.

### 4. Self-updater — `api/ds4-updater.js`

ds4's ROCm backend is young and moves fast. The updater watches the upstream repo,
rebuilds new commits **out-of-place** into `~/.local/share/ds4/builds/<commit>/`,
smoke-tests the new binary against the real model, then **atomically flips** a
`current` symlink and restarts through the supervised path — keeping the last
known-good build and refusing to serve a broken one. See
[`ds4-auto-update.md`](ds4-auto-update.md). Endpoints: `/api/ds4/update/{status,check,apply}`.

---

## When the dashboard offers DS4 (`ds4EnableGate`)

DS4 is never auto-started. The dashboard shows it as an enable-able server, and
`ds4EnableGate()` in `api/engines.js` decides which of three states it is in.
The states are kept distinct because they need different actions:

| State | Meaning | What fixes it |
|---|---|---|
| `available` | weights present, memory sufficient | nothing — pick a DS4 model in any model list and it loads (see below) |
| `insufficient-memory` | weights present, not enough free unified memory | free memory |
| `model-missing` | no `.gguf` in the configured `ggufDir` | install the weights |

**Memory alone is not sufficient, and assuming it was shipped a real bug.** The
appliance carries the `ds4-server` binary but not the ~80 GB of weights, and it
has far more RAM than the gate asks for, so a memory-only test advertised DS4 as
available on a machine that could never serve it — the dashboard offered DS4
while the chat panel correctly listed nothing. Both were right; the gate was
wrong.

`api/server.js` supplies `weightsPresent` by looking for any `.gguf` under the
resolved `ggufDir`; the gate keeps the check injectable and defaults it to
`true`, so a caller that cannot tell falls back to the old memory-only behaviour
rather than hiding a working engine. In the `model-missing` state the dashboard
card links to the Download page (`/download#ds4`, where the DeepSeek V4 Flash
chip opens the repo's file list with per-file fit verdicts — see
[download-page.md](download-page.md)), and the reason names the exact directory
the weights are expected in.

## Selecting DS4 loads it (`ds4ModelRef`)

Once the weights are present DS4 behaves like any other model: **its GGUFs appear
in `/api/v1/models`, and requesting one loads it.** "Exclusive" describes what
that load does to everything else — it evicts the resident models — not a
requirement that an operator configure something first.

Two pieces make that work, and both had to be connected:

- `handleModels()` lists the files `listDs4GgufFiles()` finds in the ds4
  `ggufDir`, marked `status: 'available'` (or `loaded` when DS4 is the active
  engine). They are not in the router's list, because DS4 is never auto-started,
  and not in the `MODELS_DIR` scan, because DS4 GGUFs live in a dedicated
  directory — that quantization only loads in `ds4-server`.
- `ds4PresetForModel()` falls back to `ds4ModelRef()`, which resolves a requested
  name against those same files. `activateDs4Exclusive()` only ever needed a
  `modelPath`, so a listed file is enough; no stored preset is required.

The activation path itself already existed: a request reaches
`ensureDs4ForModel()`, which calls `activateDs4Exclusive()`. What was missing was
purely discovery — `ds4ModelsList()` returned `null` unless DS4 was *already* the
active engine (so DS4 could only be listed once running, which is circular), and
`ds4PresetForModel()` matched only a stored preset, so a freshly downloaded GGUF
resolved to nothing. The result was a DS4 that reported itself Available and was
simultaneously absent from every model list.

`ds4ModelRef()` matches EXACTLY — the full filename, with or without the `.gguf`
suffix — and nothing else. This gates a load of roughly 87 GB that unloads every
resident model, so a prefix or fuzzy match would swap the whole box on a
near-miss name.

## Guards are DS4-aware

The stability guards ([`features-overview.md`](features-overview.md) §Guards) all
understand DS4:

- **Memory watchdog** treats DS4's ~80 GB baseline as normal — it only restarts DS4
  on a *genuine* leak (RSS above `ds4ExpectedResidentGb`×`(1+ds4MemLeakMarginFrac)`),
  never on baseline pressure.
- **Thermal governor** counts `ds4-server` CPU/iGPU heat as "the llama stack" so
  attribution is correct.
- **Slot reaper / prefix cache** cleanly no-op (DS4 has no `/slots`).
- **Kill paths** cover `ds4-server` without ever matching `llama-server`.

---

## Configuration

Per-preset (`config.presets["<id>"]`, `engine: "ds4"`):

| Field | Meaning | Default |
|---|---|---|
| `modelPath` | GGUF filename under the ds4 ggufDir (or absolute) | — |
| `context` | target/max context | — |
| `minContext` | context floor before switching to streaming | 8192 |
| `ssdStreaming` | `off` / `on` / `auto` | auto |
| `ssdStreamingCacheExperts` | `--ssd-streaming-cache-experts` size | 32GB |
| `adaptiveContext` | enable OOM-driven context scaling | true |
| `config.power` | `--power` GPU target (1–100) | — |

Global (`config.ds4`): `binPath`, `port` (5253), `ggufDir`, `container`
(`llama-rocm-7.2.4`), `runInDistrobox`, `allowEmbedServer`, `allowedRepos`
(`["antirez/deepseek-v4-gguf"]`), plus estimator defaults `kvBytesPerToken`
(128 KiB), `safetyBytes` (5 GiB), `streamingWeightBytes` (50 GiB). All overridable
via `DS4_*` env vars (see `resolveDs4Config`).

Guard (`config.guard`): `ds4MaxLoadFailures` (2), `ds4ExpectedResidentGb` (85),
`ds4MemLeakMarginFrac` (0.15), `ds4ReclaimHeadroomGb` (8).

---

## Operating DS4

**Make it the preferred big model** so clients migrate off gpt-oss-120b without
changing their requests — set `default-big` to the DS4 preset id:

```bash
curl -X POST http://localhost:5250/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"defaultBigModel":"ds4-deepseek-v4-flash"}'
```

Now any request for model `default-big` serves DeepSeek V4 Flash (activating
exclusive mode on first use if needed). `default-small` should point at a small
model your offload backends can serve, since it will be offloaded while DS4 owns
the box.

**Activate / check / deactivate:**

```bash
# activate (also triggered automatically by a default-big request)
curl -X POST http://localhost:5250/api/presets/ds4-deepseek-v4-flash/activate

# watch it settle (adaptive ladder → streaming fallback)
curl -s http://localhost:5250/api/system/stats | jq .ds4Runtime

# hand the box back to llama (router)
curl -X POST http://localhost:5250/api/server/start
```

On this shared box the preset is pinned to `ssdStreaming: "on"` because full-RAM is
known not to fit; on a dedicated box leave it `"auto"` for full context.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| UI shows "Server not running" / "Starting" while DS4 serves | Cosmetic: some UI status still keyed on llama health; DS4 health is the real signal. Fixed in recent builds — hard-refresh the browser. |
| `ds4-server exited (code 137)` repeatedly, then "failed to load Nx" | OOM at the weight-load tail; the circuit breaker stopped the thrash. Lower `minContext`, free RAM, or set `ssdStreaming: "on"`. |
| Activation returns 503 "exclusive-DS4 offload mode" | Eviction/reclaim couldn't free enough RAM, or all adaptive attempts failed. Box stays safe (offloading); check `ds4Runtime.status`. |
| `llama-server` won't die during eviction (D-state) | Possible wedged GPU. Activation refuses to spawn DS4 on top; recover per [`strix-halo-gpu-stability.md`](strix-halo-gpu-stability.md) (restart llama-manager / SIGKILL gpu-manager). |
| Build link error `recompile with -fPIC` | Add `DEBUG_FLAGS="-g -fPIC"` to `make strix-halo` (see [`ds4-build.md`](ds4-build.md)). |
