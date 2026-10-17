<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Operator guide for the Strata engine: what Strata is, how to set it up on the host
(ROCm/HIP and CUDA builds), the config.strata block and preset shape, how to activate
it, how the manager moves it between the RTX 3090 (CUDA) and the Strix Halo iGPU (HIP)
with hysteresis, how to test that swap with a priority-80 GPU lock, measured performance
on drakemore, and troubleshooting. The design record lives in Designs/StrataEngine.md.
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
    "expertCache": 6000,
    "residentGb": 100
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
| `hip.expertCache` | **required** | Explicit slot count. `auto` is rejected: it is greedy on unified memory. |
| `hip.residentGb` | `100` | Reclaim target before a HIP spawn (measured ~95 GB). |
| `policy.returnToCudaAfterMin` | `15` | Hysteresis before moving back to CUDA. |
| `policy.drainMaxWaitSec` | `120` | Bounded drain of in-flight requests before cancelling. |
| `policy.idleBaselineMb` / `yieldGrowthMb` | `1536` / `512` | Other VRAM above baseline+growth counts as a busy 3090. |

GB/MB values become bytes, durations become ms, env values are stringified. If `hip`
has a missing or `auto` `expertCache` it is disabled with a warning. There are no
`STRATA_*` env overrides on the manager: that prefix belongs to Strata's own variables.

### Expert cache and VRAM

`--expert-cache N` is a count of expert slots (~1.94 MiB each).

- **CUDA `auto`** takes ~6594 slots (~12.5 GiB) and leaves only **~0.3 GB** of the
  3090 free. That is a risk to any Pods job that expects VRAM on the same card. Until
  Pods takes GPU reservations (T31e32fa602834), consider an explicit slot count that
  leaves at least 8 GB free.
- **HIP `auto`** is greedy: it leaves just 12.9 GB free on the unified-memory iGPU, so
  HIP requires an explicit slot count.
- HIP allocations do not show in `VmRSS` (12.9 GB RES vs 168 GB VIRT). Look at
  `MemAvailable`, not RSS.

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
clears it. Set `"exclusiveBootReactivate": false` at the top level of the config to turn
it off.

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
  config uses an explicit `cuda.expertCache` of **2400 slots** (~1.94 MiB each), which leaves
  ~7.5 GB of the 3090 free so a Pods job can start allocating and be seen by the yield
  heuristic: 4000 slots measured 81.0 tok/s, 2400 slots 73.7 tok/s.

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
| Status `exhausted` / 503 on local requests | Both backends failed. Read `<dataDir>/engine-<backend>.log`; re-activate via the activate route. If the engine was brought back some other way, the next local request probes its health (at most every 5 s) and clears the status itself. |
| Status `stop-unconfirmed` | A `strata` process survived the stop. Kill it (`pkill -x strata` as the service user's root) and re-activate. |
| Engine logs mlock / pinned allocation failure | Add a `LimitMEMLOCK=infinity` drop-in to the unit. |
| **Pods busy-poll CPU contention** | Pods busy-polls and competes with Strata for CPU, hurting decode and prefill (the CPU-share prefill assist especially). Cap Pods' CPU use, or accept lower numbers while it runs. |
| **Pods ignores reservations** | Pods does not take GPU reservations yet (T31e32fa602834), so the manager only sees it through the VRAM heuristic (other VRAM over baseline+growth). Until then, CUDA `auto` can starve Pods of VRAM: use an explicit `cuda.expertCache`. |
| Over-long prompt gets 400 | Strata rejects, never truncates; keep prompts under the preset `context`. |
| Mem-watchdog logs but does not restart Strata | By design: a restart reloads the same weights, and HIP memory does not show in RSS. |

## Related

- [`Designs/StrataEngine.md`](Designs/StrataEngine.md) - full design
- [`Designs/EngineAbstraction.md`](Designs/EngineAbstraction.md) - exclusive-engine handle
- [`features/gpu-reservations.md`](features/gpu-reservations.md) - reservation API and priorities
- [`ds4-engine.md`](ds4-engine.md) - the DS4 engine
