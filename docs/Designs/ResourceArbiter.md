<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Design note for llama-manager as the memory owner of its host (task T323255fe0c83b):
an adaptive Strata HIP expert cache that shrinks to fit a starved box and grows back
when it is idle, a request to the Pods coordinator to release idle worker containers,
per-model batching of the request queue, and a prefill-hang watchdog for Strata.
-->

# Resource arbiter: shrink, reclaim, batch, unwedge

Task T323255fe0c83b. On 2026-10-31 drakemore (Strix Halo, 124 GiB unified RAM) had two
global OOMs that killed Strata, and afterwards the HIP gate refused Strata for hours
(`reclaim-timeout`: MemAvailable 87-99.6 GiB against ~103 GiB for 16000 expert slots).
Idle Pods workers held the gap (upscale-detail 36 GiB, flux2-klein 18 GiB,
image-classification 6 GiB, all with no job). Strata also hung 540 s in prefill on a
1282-token prompt. This note covers the four fixes.

## 1. Adaptive HIP expert cache

`hip.expertCache` is now the **target**, not a requirement. The HIP attempt
(`startStrataAttempt`) evicts llama as before, then:

1. If the configured cache does not fit and the Pods release is enabled (section 2), it asks
   the coordinator to release idle workers and waits up to the normal reclaim timeout
   (180 s) for the configured target. Otherwise it waits a short settle (30 s) for
   llama's memory to come back.
2. It picks the largest cache that fits what is available now, `strataHipExpertCache` in
   `strata-engine.js`:
   `slots = min(configured, floor((MemAvailable - headroom - baseGb) / 1.94 MiB))`,
   rounded down to 100. When that is at least `hip.minExpertCache` (default 4000), Strata
   starts at that size. When it is not, the attempt fails with `reclaim-timeout` as
   before, and exclusive recovery retries with backoff.
3. The chosen size and the reason are logged and kept on
   `strataRuntime.expertCache = {configured, effective, reason, at}`. The size travels in
   the supervisor's launch override, so a crash restart reuses it.

At 87 GiB available, base 65 GiB and headroom 8 GiB, this gives ~7300 slots instead of
a refusal.

**Grow back** (`strataGrowDecision`, checked every 5 s from `strataBackendTick`). Strata
must be ready on HIP below its configured cache, with nothing in flight or queued in the
exclusive lane for 60 s, and `hip.growCooldownMin` (default 10) must have passed since
the last settle. The decision predicts the size a restart would get: the current
MemAvailable plus the current footprint estimate, through the same chooser. It grows only
when that is at least 2000 slots (~3.8 GiB) larger (hysteresis). The restart is the
existing swap path, `strataSwapBackend('hip', ...)`: bounded drain, verified stop, HIP
load. A request arriving mid-restart is held by the swap gate and replayed. If memory
vanished in between, the restart lands at whatever fits, or fails into exclusive
recovery.

Shrinking a *running* Strata is not separate code. The existing memory governor stops
Strata below `guard.memCriticalBelowGb` (6 GiB), and recovery re-activates it through the
adaptive chooser, which then picks a smaller cache.

CUDA is unchanged. There the expert cache lives in VRAM and `cuda.expertCache` is fixed.

## 2. Release idle Pods workers (feature-flagged, off by default)

### Coordinator contract (local-runpod)

`POST /api/nodes/{node_id}/release-idle-workers`, JSON body
`{"min_idle_seconds": 600, "reason": "<free text, logged>"}`.

- **Auth:** the same `require_api_key` + node-owner check as the node heartbeat
  (`_authorize_node`). Only a key whose principal owns the node may ask, and the call
  only ever touches that node.
- **Candidates:** the per-container entries the node agent last reported for this node
  (`gpu_processes`: `workerId`, `endpointId`, `busy`, `idleSeconds`). A worker is released
  only when every one of these holds:
  - the node says it is not busy;
  - it has been idle for at least `min_idle_seconds` (floor 60);
  - the coordinator holds no IN_PROGRESS job for it;
  - its endpoint queue (`queue:{slug}` and `queue:{slug}:low`) is empty;
  - its endpoint is not pinned and does not hold the GPU warm hold.

  A worker the node did not report is never released.
- **Effect:** the chosen ids go to the existing `node:{id}:evict_workers` set, which the next
  heartbeat ships as `evict_workers`. The node agent (4c1fe41) re-checks busy, then stops
  the container without removing it, so the next job lazily restarts it with the same id.
  The response is 200 with
  `{"released": [ids], "skipped": [{"worker_id", "reason"}]}`. It does not wait for the
  stop.

### llama-manager client

`config.podsRelease = {enabled: false, coordinatorUrl, nodeId, minIdleSec: 600}`
(`api/pods-release.js`). The key comes from the `PODS_API_KEY` environment variable (a
systemd drop-in `EnvironmentFile`). It is never stored in config.json and never logged.
`POST /api/config` accepts `podsRelease` only from loopback, because `coordinatorUrl`
receives the key. Requests are
rate-limited to one per 5 minutes and time out after 10 s. A failure is logged and
ignored, so adaptive sizing still runs. Calls are made from:

- the HIP attempt, when the configured cache does not fit;
- the grow-back tick, when Strata is shrunk, idle and past the cooldown, but short of
  memory (`strataGrowDecision` returns `needMemory`).

The reverse direction already exists: Pods takes a priority-80 `rtx3090` reservation
before a job, and Strata leaves the card. RAM for a Pods job is not reserved. This task
does not add RAM reservations.

**Coverage gap:** idle workers that hold only host RAM and have no GPU process (for
example image-classification) are absent from `gpu_processes`. Covering them needs the
node agent to report per-container host memory and activity for every worker. That work
belongs to sibling task T323255ff4b83c, and the coordinator would read the extra entries
with the same rules.

## 3. Batch the queue per model

`PriorityRequestQueue` remembers the model of the last activated item. Within the
priority class it picks, it prefers the oldest pending item for that model over an older
item for another model, so a mixed queue switches models at most once per model. The
preference is bounded: after `maxModelBatch` (default 16) consecutive picks that jumped
ahead of an older item for another model, it serves strict FIFO once, so a steady stream
for one model cannot starve another. Priority ordering, realtime preemption and the
background fairness budget are unchanged.

`/api/stats` adds `queue.byModel: {<model>: {active, pending}}` across the llama lane and
the exclusive (DS4/Strata) lane.

## 4. Strata prefill-hang watchdog

Strata's `GET /metrics` reports `live.state` (`reading` while it reads the prompt) and
`live.prompt_read` / `live.prompt_total` (one update per prefill chunk). Every 5 s, while
a Strata request holds the exclusive slot, the manager polls it. `strataPrefillVerdict`
in `strata-policy.js` tracks the last `prompt_read` value and when it last changed. When
the state is `reading` and nothing has moved for `strata.policy.prefillStallSec` (default
180), it aborts the slot holder and logs `strata prefill stalled: read R/T, no progress
for Ns`. The abort closes the upstream connection.

If Strata is still `reading` with no progress 30 s after that abort, the engine is
wedged. The manager logs it and does a clean restart on the same backend through the
swap path. The existing 900 s zero-token ceiling stays as the backstop. A healthy
prefill emits a chunk well inside 180 s: 16384-token chunks at the measured HIP prefill
rate take about a minute.

## Config summary

| Key | Default | Meaning |
|---|---|---|
| `strata.hip.minExpertCache` | 4000 | Floor for the adaptive cache. Below it, the attempt fails and recovery retries. |
| `strata.hip.growCooldownMin` | 10 | Minimum time between a settle and a grow-back restart. |
| `strata.policy.prefillStallSec` | 180 | No prefill progress for this long cancels the request. |
| `podsRelease.enabled` | false | Ask the Pods coordinator to release idle workers. |
| `podsRelease.coordinatorUrl` / `nodeId` | none | Coordinator base URL and this host's Pods node id. |
| `podsRelease.minIdleSec` | 600 | Only workers idle at least this long are released. |
| env `PODS_API_KEY` | none | Key of the principal that owns the node. |
