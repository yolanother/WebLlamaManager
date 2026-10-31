<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Operator guide for the Strata engine: what Strata is, how to set it up on the host
(ROCm/HIP and CUDA builds), the config.strata block and preset shape, how to activate
it, how the manager moves it between the RTX 3090 (CUDA) and the Strix Halo iGPU (HIP)
with hysteresis, how to test that swap with a priority-80 GPU lock, the adaptive HIP expert
cache (start smaller when memory is short, grow back when idle), releasing idle Pods workers,
the prefill-hang watchdog, measured performance on drakemore, and troubleshooting. The design record lives in Designs/StrataEngine.md.
-->

# Strata Engine - Qwen3.8 Flash Next

Llama Manager can run a third engine behind the same exclusive-engine seam as DS4:
**Strata** ([Niko1221/Strata](https://github.com/Niko1221/Strata), v0.1.44.1) serving
**Qwen3.8-Flash-Next**. Strata prefers the RTX 3090 over OCuLink (CUDA, ~86 tok/s) and
falls back to the Strix Halo iGPU (HIP, ~52 tok/s) when a higher-priority user needs
the card.

> Status: the design is approved and the implementation is in progress (epic
> T31e2f9680b80b). Names, defaults and fields below follow
> [`Designs/StrataEngine.md`](Designs/StrataEngine.md); anything marked
> *(implementation-dependent)* may shift when the code lands. Sections here are
> updated after integration if names drift.

For the DS4 equivalent see [`ds4-engine.md`](ds4-engine.md); for the shared
abstraction see [`Designs/EngineAbstraction.md`](Designs/EngineAbstraction.md).

---

## What Strata is

- A Python front (`serve/server.py --engine strata --config <json> --port <port>`)
  that spawns a C++ engine (`exe` in the config). The process name (comm) of the engine
  is `strata` for both backends.
- OpenAI/Anthropic compatible: `/v1/chat/completions`, `/v1/completions`,
  `/v1/messages`, `/v1/responses`, `/v1/models`, `/v1/status`, `/health`, `POST /unload`.
- **One sequence at a time** (FIFO). A request over the context window gets a 400; it
  is never truncated. Responses carry llama.cpp-named `timings`.
- `/health` returns `{status:'ok'}` *before* the model loads. The manager treats it as
  ready only when `loaded === true` and `max_context > 0`.
- Like DS4 it is **exclusive**: while active, local llama requests are served beside it
  only when they fit measured free memory, otherwise they offload or get a 503. DS4 and
  Strata are mutually exclusive; activating one deactivates the other.

## Host setup (drakemore)

Layout on the host:

| Path | Contents |
|---|---|
| `/opt/strata/src` | HIP engine, `serve/server.py`, `.venv` (the `pythonPath`) |
| `/opt/strata/cuda` | CUDA engine + cu13 libs |
| `/opt/strata/rocm/install` | TheRock ROCm 7.14.1 SDK |
| `/volumes/models/strata` | packs (`packs/iq3_s`, `mtp/rt`, ...) |
| `/volumes/models/IQ3_S` | IQ3_S GGUFs |
| `/opt/strata/bench` | bench harness |

1. **HIP engine and venv.** Run Strata's `setup.sh` in `/opt/strata/src` with
   `ROCM_PATH` pointing at the TheRock SDK (`/opt/strata/rocm/install`). It builds the
   engine and creates `/opt/strata/src/.venv`.
2. **CUDA engine.** Build with the upstream Dockerfile using
   `CUDA_ARCHITECTURES=86` (RTX 3090), then `docker cp` the engine binary out to
   `/opt/strata/cuda/engine/strata`.
3. **CUDA libs.** `pip install` the cu13 wheels into a venv under `/opt/strata/cuda`; the
   directory `.../site-packages/nvidia/cu13/lib` goes in `cuda.libDirs`.
4. **Permissions.** Everything under `/opt/strata/**`, `/volumes/models/IQ3_S` and
   `/volumes/models/strata/**` must be readable by the `llama-manager` service user;
   `/var/lib/llama-manager/strata` must be writable (covered by `StateDirectory`).
   `nvidia-smi` must run as that user.
5. **memlock.** Strata runs fine under the unit's default 8 MiB `LimitMEMLOCK`
   (measured 85-99 tok/s via `runuser -u llama-manager -- prlimit --memlock=8388608`).
   Only add a `LimitMEMLOCK=infinity` drop-in if the engine logs mlock/pinned
   allocation failures.
6. **Orphans.** The unit uses `KillMode=process`, so an engine can outlive a manager
   restart. Activation reaps stray `strata` processes first.

## Config: `config.strata`

```json
"strata": {
  "root": "/opt/strata/src",
  "pythonPath": "/opt/strata/src/.venv/bin/python",
  "port": 18090,
  "dataDir": "/var/lib/llama-manager/strata",
  "cuda": {
    "exe": "/opt/strata/cuda/engine/strata",
    "libDirs": ["/opt/strata/cuda/venv/lib/python3.12/site-packages/nvidia/cu13/lib"],
    "env": { "STRATA_PREFILL_CPU_SHARE": "auto", "STRATA_PREFILL_CPU_SHARE_MAX": "3072" },
    "expertCache": "auto",
    "gpuPool": "rtx3090",
    "reservationPriority": 50,
    "hostResidentGb": 56
  },
  "hip": {
    "exe": "/opt/strata/src/engine/strata",
    "libDirs": ["/opt/strata/rocm/install/lib"],
    "env": { "STRATA_HIPBLASLT_TUNING": "/opt/strata/src/tools/hip/gfx1151-hipblaslt-100401.txt",
             "STRATA_PF_FUSED": "1", "STRATA_PF_GEMM": "1", "STRATA_HC_UPMIX": "1",
             "STRATA_PA_FAST": "1", "STRATA_HIP_WMMA": "1", "STRATA_SELECT_WMMA": "1",
             "STRATA_HC_Q8": "1", "STRATA_PF_SWITCH_MIN_T": "4096", "STRATA_PREFILL_STREAM_MIN": "128" },
    "expertCache": 16000
  },
  "policy": {
    "returnToCudaAfterMin": 15,
    "drainMaxWaitSec": 120,
    "idleBaselineMb": 1536,
    "yieldGrowthMb": 512
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Directory holding `serve/server.py`; the engine cwd. Absolute. |
| `pythonPath` | required | Python of Strata's venv. Absolute, no default. |
| `port` | `18090` | Passed as both config `port` and `--port`. |
| `dataDir` | `<dataDir>/strata` | Generated `strata-<backend>.json` and `engine-<backend>.log`. |
| `cuda` | omitted = HIP only | CUDA backend block. |
| `cuda.expertCache` | `auto` | See "Expert cache and VRAM" below. |
| `cuda.gpuPool` | `rtx3090` | Pool the manager reserves before a CUDA spawn. |
| `cuda.reservationPriority` | `50` | Above the model pin (25), below Pods (80). |
| `cuda.hostResidentGb` | `56` | Free-RAM target before a CUDA spawn (measured ~50 GB). |
| `hip.expertCache` | **required** | Explicit slot count, the **target**. `auto` is rejected: it is greedy on unified memory. When the target does not fit what is available at spawn, Strata starts at the largest cache that does (see "Adaptive HIP expert cache"). |
| `hip.minExpertCache` | `4000` | Floor for the adaptive cache; below it the attempt fails (`reclaim-timeout`) and recovery retries. Never above `expertCache`. |
| `hip.growCooldownMin` | `10` | Minimum time since the last settle before a shrunk, idle HIP engine restarts larger. |
| `hip.growMarginGb` | `16` | Extra free memory a grow-back must leave above the 8 GiB headroom, so a Pods worker restarting on its next job does not hit the 6 GiB critical stop. |
| `hip.baseGb` | `65` | HIP footprint beside the expert cache (weights, KV, MTP). The reclaim target before a HIP spawn is `baseGb` + `expertCache` x 1.94 MiB (~95 GiB at 16000), plus `guard.ds4ReclaimHeadroomGb` (8). Measured on drakemore 2026-10-31: strata RSS ~49 GiB + iGPU GTT ~46 GiB at 16000 slots. |
| `hip.residentGb` | ignored | Retired: a hand-set reclaim target went stale twice (106 blocked every spawn; 84 let 48000 slots swap the box). Logged as a warning when present. |
| `policy.returnToCudaAfterMin` | `15` | Hysteresis before moving back to CUDA. |
| `policy.drainMaxWaitSec` | `120` | Bounded drain of in-flight requests before cancelling. |
| `policy.idleBaselineMb` / `yieldGrowthMb` | `1536` / `512` | Other VRAM above baseline+growth counts as a busy 3090. |
| `policy.prefillStallSec` | `180` | A prompt read with no progress (Strata `/metrics` `live.prompt_read`, per request) for this long is cancelled, and the lane is held. If the engine recovers, the lane is released. If it is still stuck, or `/metrics` is silent, 30 s later the engine is restarted and the held requests are replayed. |

GB/MB values become bytes, durations become ms, env values are stringified. If `hip`
has a missing or `auto` `expertCache` it is disabled with a warning. There are no
`STRATA_*` env overrides on the manager: that prefix belongs to Strata's own variables.

### Expert cache and VRAM

`--expert-cache N` is a count of expert slots (~1.94 MiB each).

- **CUDA `auto`** takes ~6594 slots (~12.5 GiB) and leaves only **~0.3 GB** of the
  3090 free. Pods now takes a priority-80 reservation before each asset job (local-runpod
  node agent, 2026-10-17), which drains Strata first, but a worker container still takes
  ~352 MiB of CUDA context when it *starts*, with no reservation. drakemore therefore runs
  **`cuda.expertCache` 4000**: ~2.5 GiB free with 13 idle workers, 81 tok/s raw, **84.5 tok/s
  median through `default-big`** (12-request gate, 2026-10-17; 75.6 at 2400).
- **HIP `auto`** is greedy: it leaves just 12.9 GB free on the unified-memory iGPU, so
  HIP requires an explicit slot count.
- **HIP sizing is computed, not hand-set.** A HIP block whose footprint (`baseGb` +
  slots x 1.94 MiB) plus 8 GiB headroom exceeds MemTotal is refused: `POST /api/config`
  answers 400 `STRATA_HIP_TOO_LARGE`, and an existing config disables HIP with a warning
  that activation errors repeat. drakemore (124.4 GiB) runs 16000 slots (~95 GiB, leaves
  ~16 GiB available); the 48000-slot attempt (~156 GiB) that drove it to 122/124 GB + full
  swap on 2026-10-31 is now refused. After each HIP settle the manager logs the measured
  footprint (MemAvailable drop since spawn) beside the estimate and exposes it as
  `strataRuntime.hipFootprint`; recalibrate `baseGb` from that if they drift apart.
- HIP allocations do not show in `VmRSS` (12.9 GB RES vs 168 GB VIRT). Look at
  `MemAvailable`, not RSS.

### Adaptive HIP expert cache

Design: [`Designs/ResourceArbiter.md`](Designs/ResourceArbiter.md).

**Starting smaller instead of refusing.** After evicting llama, the HIP attempt waits up to
30 s for the configured footprint. It then starts at
`min(expertCache, floor((MemAvailable - 8 GiB - baseGb) / 1.94 MiB))` slots, rounded down
to 100.
- **Below the floor** (`hip.minExpertCache`), with `podsRelease` enabled: it asks Pods to
  release idle workers and waits up to 180 s for the floor.
- **Still short after that:** the attempt fails as `reclaim-timeout`, and recovery
  retries it.
- **Restart of an engine that was serving** (grow-back or prefill-wedge restart): it
  first waits up to 180 s to keep the size it already had.

- The `presets` log shows the outcome: `strata: hip expert cache <N> (<reason>)`.
- `GET /api/stats` shows it as
  `strataRuntime.expertCache = {configured, effective, reason, at}`.
- A crash restart reuses the same size.

**Growing back.** Every 5 s the backend tick checks a Strata running on HIP below its
target. It grows the cache back when all of these hold:

- nothing has been in flight or queued in the exclusive lane for 60 s;
- `hip.growCooldownMin` has passed since the last settle;
- a restart would gain at least 2000 slots while still leaving `hip.growMarginGb` free
  beyond the headroom.

The restart goes through the normal swap path: bounded drain, verified stop, HIP load.
It keeps at least the current size. Grow-back never asks Pods to release workers.

**Shrinking.** A running engine is not resized in place. Below
`guard.memCriticalBelowGb`, the memory governor stops it, and recovery starts it again
at whatever then fits.

### Releasing idle Pods workers (`podsRelease`, off by default)

```json
"podsRelease": { "enabled": true, "minIdleSec": 600 }
```

Where the request goes and the credential come only from the environment: a root-owned
systemd drop-in `EnvironmentFile` sets `PODS_COORDINATOR_URL` (http/https),
`PODS_NODE_ID` (drakemore's Pods node id) and `PODS_API_KEY`. The key must belong to the
principal that owns the node. They are never read from config.json, so a config write
cannot redirect the key. `POST /api/config` accepts only `enabled` and `minIdleSec` in
`podsRelease` (400 `PODS_RELEASE_FIELD` otherwise), only from loopback, and, like
`strata`, only with a Host that is a name of this machine or an IP literal and no
foreign Origin (403 `UNTRUSTED_ORIGIN`). That blocks a cross-origin page or a
DNS-rebinding page in a browser on the host.

The manager calls
`POST /api/v1/nodes/{nodeId}/release-idle-workers` (local-runpod
`docs/Features/release-idle-workers.md`) only when a HIP start would otherwise be refused,
and at most once per 5 minutes. The coordinator
releases only workers that meet all of these:

- the node reports them idle for at least `minIdleSec`;
- the coordinator holds no job for them;
- their endpoint has nothing queued;
- their endpoint is not pinned and holds no warm GPU hold.

The node agent stops those containers, and the next job restarts them. Results appear
in the `presets` log as `pods: asked the coordinator to release idle workers ...`.

## Presets

The model id is the preset id. The manager owns `--expert-cache` (per backend),
`--max-context` (from `context`, default 262144) and `--port`; the preset carries only
model and tuning flags. Binary, env and lib dirs come from config, so a preset cannot
choose what gets executed. Args are passed as argv (no shell).

```json
{
  "id": "strata-qwen38-flash-iq3s",
  "name": "Qwen3.8 Flash Next (Strata IQ3_S)",
  "engine": "strata",
  "context": 262144,
  "strata": {
    "args": ["--pack","/volumes/models/strata/packs/iq3_s","--native","<G>","--ple-gguf","<G2>",
             "--expert-profile","<F>","--prefill","16384","--spec","5","--spec-min-p","0.5",
             "--mtp","/volumes/models/strata/mtp/rt","--kv","int8","--kv-resident","32768",
             "--mtp-window","8192","--lookup-chain","3","--mtp-q4","all"],
    "tokenizer": "/abs/path/tokenizer",
    "modelName": "Qwen3.8-Flash-Next"
  }
}
```

Validation: `strata.args` is 1..200 non-empty strings and must not contain
`--expert-cache`, `--max-context` or `--port`; `tokenizer` is a required absolute path
that must exist (404 otherwise); `context` is a positive integer up to 1048576.
Replace `<G>`, `<G2>`, `<F>` with the real GGUF / expert-profile paths for the install.

## Activating

```console
$ curl -s -X POST http://127.0.0.1:5250/api/presets/strata-qwen38-flash-iq3s/activate
```

Or send a request naming the preset id: the manager activates it on demand and holds
the request during the swap. Activation tries CUDA first (if configured, admitted and
the 3090 is free), then HIP. Load takes 27-40 s; there is no request needed to trigger
the load. Status is visible at `GET /api/stats` under `strata` and `strataRuntime`
(backend, the last 20 attempts, lease state, last policy decision).

**Boot re-activation.** When a Strata (or DS4) preset settles `ready`, the manager
records it as `config.lastExclusivePreset`. After a restart it re-activates that preset
in the background as soon as the server is listening (log line
`boot: re-activating strata preset <id>`), so the first request no longer pays the
28-52 s cold load. Deactivating the engine deliberately (or switching to a llama preset)
clears it. A planned boot re-activation replaces the llama `autoStart` (which would
otherwise deactivate the exclusive engine a second after boot), and an activation that is
superseded mid-load stops its CUDA/HIP ladder instead of starting an orphan engine. Set
`"exclusiveBootReactivate": false` at the top level of the config to turn it off. Measured on
drakemore: CUDA ready 27 s after a restart with no request sent.

**Packaged defaults.** When `config.strata` is absent or empty, the manager uses
`/usr/share/llama-manager/strata/defaults.json` (installed by the `llama-manager-strata`
package; override the path with `LLAMA_MANAGER_STRATA_DEFAULTS`). The file is read once
and never written into `config.json`; any operator `config.strata` block wins outright.

## CUDA and HIP swap, with hysteresis

Strata holds the `rtx3090` pool as `llama-manager/strata` at **priority 50**, with no
TTL (internal only, like the model pin). Every 5 s the existing GPU sweep evaluates a
pure decision (`api/strata-policy.js`):

- **On CUDA**: yield to HIP when the lease is no longer held (preempted, expired,
  released), or when other processes' VRAM on the card exceeds
  `idleBaselineMb + yieldGrowthMb`. An unreadable `nvidia-smi` means stay (never flap).
- **On HIP**: return to CUDA only when no equal-or-higher claim is pending or held on
  the pool, the card has been idle (other VRAM at baseline) continuously for
  `returnToCudaAfterMin`, a recent failed CUDA load is older than that same window, and
  no request is in flight. Yielding is urgent; returning never is.

A swap drains in-flight requests (up to `drainMaxWaitSec`), cancels the rest, stops the
engine with verified reclaim, then relaunches on the target backend. Requests that
arrive mid-swap are held and replayed; an in-flight request that had sent no bytes is
re-served, a committed stream ends. A failed return to CUDA lands on HIP and delays the
next attempt by the hysteresis window.

### Testing the swap with a priority-80 lock

Pods is the intended preemptor but does not take reservations yet, so test with a manual
lock at Pods' priority (80 > 50):

```console
$ curl -s -X POST http://127.0.0.1:5250/api/gpus/rtx3090/lock \
    -H 'Content-Type: application/json' \
    -d '{"holder":"swap-test","priority":80,"ttlSeconds":600}'
```

Expected, while Strata is running on CUDA:

1. Strata's lease is preempted; the drain hook (`drainForReservation` calls
   `strataLeaveCuda` first) stops Strata *before* the lock is reported held.
2. Strata reloads on HIP (`strataRuntime.backend` becomes `hip`; ~27-40 s).
3. Release the lock (`DELETE /api/gpus/reservations/<id>` with the returned id; loopback only). After
   `returnToCudaAfterMin` of idle card and no in-flight request, the manager swaps back
   to CUDA. Lower `returnToCudaAfterMin` for the test.

Held requests during step 2 should complete after the reload, not fail.

## Measured performance (drakemore, 2026-10-15, Strata v0.1.44.1 = 296b59d)

| Backend / quant | Decode tok/s | Notes |
|---|---|---|
| CUDA RTX 3090 + GSQ-RCO IQ3_S | **86-87** (median) | ~50 GB host RAM, load 27-40 s |
| CUDA + UD-IQ4_XS | ~54 | |
| HIP iGPU + IQ3_S | ~52 | exclusive, ~95 GB |
| HIP + UD-IQ4_XS | ~46 | |

- Recall was correct out to **254K tokens** on CUDA IQ3_S: 58.8 tok/s decode at 254K,
  prompt processing 1,757 tok/s.
- `STRATA_PREFILL_CPU_SHARE=auto` with `STRATA_PREFILL_CPU_SHARE_MAX=3072` cut TTFT for
  1-2K-token prompts from ~6.3 s to 2.6-3.5 s on OCuLink x4.
- The rows above are the raw engine with `--expert-cache auto` (the whole 3090). The deployed
  config uses an explicit `cuda.expertCache`: 2400 slots (~7.5 GB free) until 2026-10-17, now
  **4000 slots** (~2.5 GB free) since Pods takes reservations. Raw engine: 4000 slots 81.0 tok/s,
  2400 slots 73.7 tok/s.

A re-run of the same gate on 2026-10-17 (main c555716, `expertCache` 4000, Pods reserving):
**median 84.5 tok/s** (min 74.6, max 112.4, n 12), structured JSON 3/3 strict, long-record facts
3/3, TTFT 0.27-0.48 s short / 3.1-3.4 s at ~1.35K tokens.

### Live qualification through llama-manager (deployed `main` 362b328)

The Oct-8 canonical 12-request gate (3 novel prompts x2, 3 exact-JSON arithmetic, 3 long-record
JSON; seed 421, temp 0.2, thinking off, streamed) sent to the **`default-big` alias** on
drakemore while Strata ran on CUDA with `expertCache` 2400:

| Metric | Result |
|---|---|
| Median decode | **75.6 tok/s** (min 61.0, max 92.3; every request > 60). An earlier run on the integration branch gave 69.5 |
| Previous `default-big` (llama.cpp Qwen3.6-35B-A3B) | 52.07 tok/s median on the same fixtures |
| Structured JSON | 3/3 strict exact |
| Long-record JSON | 3/3 facts correct (field types such as `"046"` / `true` vary, as on Oct 8) |
| TTFT | 0.32-0.50 s short prompts, ~3.3-3.5 s for ~1.35K-token prompts (higher when other clients are queued: Strata serves one sequence at a time) |
| Cold activation from a request | 28-52 s |
| Pods-priority (80) lock while serving | in-flight request drained, then the lock was held once Strata left the card (4.3 s idle; 40.9 s with a live request draining); HIP ready ~39-66 s, HIP decode 45-57 tok/s |
| Return to CUDA after release | ~15 min (`returnToCudaAfterMin` 15), ready ~20 s later |

### Parallel slots (`--batch N`), measured 2026-10-17

Strata can decode several conversations at once (`--batch N`, docs/BATCHING.md upstream).
On the 3090 with IQ3_S at 262144 context and `cuda.expertCache` 2400 it costs too much
single-stream speed, so the preset stays at one sequence at a time. Bench: manager
stopped, 256-token greedy-ish completions, `/opt/strata/bench/par_bench.py`, results in
`/opt/strata/bench/par.jsonl`.

| Config | Solo median tok/s | 2 clients: aggregate tok/s, per stream, 2nd TTFT | 3 clients: aggregate tok/s, per stream |
|---|---|---|---|
| 1 slot (current) | **65.9** | 48-54, 42-72, 4.5-6.0 s | 58-68, 55-77 (3rd TTFT 9.6 s) |
| `--batch 2` | 45.0 | 41-49, 22-26, 0.5-1.5 s | 45-47 |
| `--batch 2 --batch-mtp` | 43.5 | 46-53, 26-29, 0.7-0.9 s | 47-48 |
| `--batch 3` | 48.1 | 45-51, 24-27, 0.5-1.4 s | 51, 17-19 each |

Slots cut queueing latency (the second client starts within ~1 s instead of 4.5-6 s) but
every slotted stream drops to 17-29 tok/s and a lone request falls below the 60 tok/s
target, matching upstream's note that IQ3_S needs 32 GB for slots to pay. Revisit with a
larger card or once `expertCache` can return to `auto`.

Since 2026-10-15 both `default-big` and `default-small` on drakemore target the
`strata-qwen38-flash-iq3s` preset; Frostburn's `default-big` and `default-small` forward to them.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Activation 503 `Strata is not configured: <reason>` | `config.strata` missing `root`/`pythonPath`, non-absolute paths, or neither backend usable. |
| Always lands on HIP | CUDA not configured, lease not grantable (another claim at >= 50), other VRAM busy on the card, or a recent CUDA failure inside the hysteresis window. Check `strataRuntime.cuda.lastDecision`. |
| HIP backend disabled with warning | `hip.expertCache` missing or `auto`; set an explicit slot count. |
| Status `exhausted` / 503 on local requests | Both backends failed. The manager re-activates the preset by itself: first retry 1 min after the failure, then every 2, 4, 8, 16 and 30 min (capped, never gives up), logging each attempt in the `presets` log; `GET /api/stats` shows `strataRecovery` (`since`, `attempts`, `nextAt`, `lastReason`) while it is down. Read `<dataDir>/engine-<backend>.log` for the cause, or re-activate via the activate route to retry at once. If the engine was brought back some other way, the next local request probes its health (at most every 5 s) and clears the status itself. A `stop-unconfirmed` runtime (wedged process) is never retried automatically. |
| Manager `GET /health` said `down` (503) while Strata served | Fixed: `/health` counted only llama. It now reports `healthy` while the exclusive engine is `ready` (`degraded` while loading/swapping, `down` when exhausted), plus `exclusive: {engine, status}`. Frostburn's router never probed `/health`; its alias trips came from the circuit breaker (see model-alias-groups.md). |
| `strata prefill stalled: no prefill progress for Ns (read R/T)` in the `presets` log | The prefill watchdog cancelled a request whose prompt read stopped moving for `policy.prefillStallSec`. A following `restarting on <backend>` line means Strata stayed stuck after the cancel and was restarted. If Strata's `/metrics` does not answer, the watchdog cannot see progress, and only the 900 s zero-token ceiling ends the request. |
| Strata serving with fewer expert slots than configured | Adaptive cache: memory was short at spawn. `strataRuntime.expertCache.reason` says why. It grows back once memory frees and Strata has been idle past `hip.growCooldownMin`. Check `ps` and the Pods containers for what holds the memory. |
| Status `stop-unconfirmed` | A `strata` process survived the stop. Kill it (`pkill -x strata` as the service user's root) and re-activate. |
| Engine logs mlock / pinned allocation failure | Add a `LimitMEMLOCK=infinity` drop-in to the unit. |
| **Pods busy-poll CPU contention** | Fixed in the node agent (2026-10-17): idle job-take long-polls for 25 s, so idle workers use ~0.5% CPU instead of ~1-2 cores, and RunPod SDK logging is INFO. Workers created before that still poll until redeployed. |
| **Asset job preempts Strata** | Expected. The Pods node agent locks `rtx3090` at priority 80 before handing a job to an NVIDIA worker (renewed every 30 s, released at job-done, worker exit or a 2 h cap); Strata leaves CUDA in ~2 s, reloads on HIP, and returns to CUDA after 15 idle minutes. Lock state: `GET /api/gpus`; agent side: `journalctl -u doubtech-pods-node \| grep GpuReservation`. |
| **Always on HIP although the 3090 is idle** | Idle Pods workers hold ~352 MiB of CUDA context each; if their total exceeds `policy.idleBaselineMb`, Strata treats the card as busy. drakemore uses 6144 (13 workers = ~4.6 GB). |
| Over-long prompt gets 400 | Strata rejects, never truncates; keep prompts under the preset `context`. |
| Strata stopped with reason `memory-critical` | MemAvailable fell below `guard.memCriticalBelowGb` (default 6). The memory governor stopped Strata cleanly, because the kernel's global OOM killer had already done it messily: on 2026-10-31 that killed strata, desktop dbus and a root python3, and left systemd (PID 1) unresponsive for ~2.6 h, so no ssh session could open. The preset stays remembered and auto re-activation retries it with backoff under the HIP gate. Find what else grew (`ps`, Pods containers) before raising the floor. |
| Mem-watchdog logs but does not restart Strata | By design: a restart reloads the same weights, and HIP memory does not show in RSS. |

## Related

- [`Designs/StrataEngine.md`](Designs/StrataEngine.md) - full design
- [`Designs/EngineAbstraction.md`](Designs/EngineAbstraction.md) - exclusive-engine handle
- [`features/gpu-reservations.md`](features/gpu-reservations.md) - reservation API and priorities
- [`ds4-engine.md`](ds4-engine.md) - the DS4 engine
