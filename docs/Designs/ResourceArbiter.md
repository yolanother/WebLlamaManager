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

1. It waits a short settle (30 s) for llama's memory to come back.
2. It picks the cache size (`sizeStrataHipCache` in `server.js`, built on
   `strataHipExpertCache` in `strata-engine.js`). The size is
   `slots = min(configured, floor((MemAvailable - headroom - baseGb) / 1.94 MiB))`,
   rounded down to 100.
   - At least `hip.minExpertCache` (default 4000): Strata starts at that size.
   - Below the floor: it asks Pods to release idle workers (section 2) and waits up to
     180 s for the floor. Only if that still fails does the attempt fail with
     `reclaim-timeout`, and exclusive recovery retries with backoff.
   - Restart of an engine that was serving (grow-back or prefill-wedge restart): the
     restart passes `keepAtLeast`, the size the engine already had. The attempt waits up
     to 180 s for that size instead of coming back smaller, or being refused, because a
     tenant took the memory during the stop. If the memory is still gone after the wait,
     the attempt sizes to what fits. That keeps Strata serving; the alternative is an
     exhausted engine whose recovery would start at the same smaller size after a minute
     or more.
3. The chosen size and the reason are logged and kept on
   `strataRuntime.expertCache = {configured, effective, reason, at}`. The size travels in
   the supervisor's launch override, so a crash restart reuses it.

At 87 GiB available, base 65 GiB and headroom 8 GiB, this gives ~7300 slots instead of
a refusal.

**Grow back** (`strataGrowDecision`, checked every 5 s from `strataBackendTick`). Strata
must be ready on HIP below its configured cache, with nothing in flight or queued in the
exclusive lane for 60 s, and `hip.growCooldownMin` (default 10) must have passed since
the last settle. The decision predicts the size a restart would get: the current
MemAvailable plus the current footprint estimate, through the same chooser. The grown size
must still leave `hip.growMarginGb` (default 16 GiB) free on top of the 8 GiB headroom.
Freed memory usually belongs to a Pods worker that restarts on its next job (6-36 GiB).
Growing into all of it would put MemAvailable under the 6 GiB critical stop mid-request
and start a loop: grow, critical stop, smaller restart, grow again.

It grows only when the gain is at least 2000 slots, about 3.8 GiB (hysteresis). The
restart is the existing swap path, `strataSwapBackend('hip', ...)`: bounded drain,
verified stop, HIP load, with `keepAtLeast` set to the current size. A request that
arrives mid-restart is held by the swap gate and replayed. Grow-back never asks Pods to
release workers. It only uses memory that is already free.

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

`config.podsRelease = {enabled: false, minIdleSec: 600}` (`api/pods-release.js`). The
coordinator URL, node id and key come only from the environment
(`PODS_COORDINATOR_URL`, `PODS_NODE_ID`, `PODS_API_KEY`, a root-owned systemd drop-in
`EnvironmentFile`), never from config.json, and the key is never logged, so no config
write can send the key elsewhere. `POST /api/config` accepts only `enabled` and
`minIdleSec` there, only from loopback, and, for both `strata` and `podsRelease`, only
with a local Host and no foreign Origin (`api/config-write-guard.js`: blocks CSRF and DNS
rebinding from a browser on the host). Requests are
rate-limited to one per 5 minutes and time out after 10 s. A failure is logged and
ignored, so adaptive sizing still runs. The only call site is a HIP start whose floor
does not fit, that is, a start that would otherwise be refused. A start that would only
shrink does not ask, and neither does grow-back. This is deliberately narrower than "reclaim
when upscale is idle": releasing workers to grow fed the critical-stop loop described in
section 1.

**Flag scope (review note).** The flag lives in the llama-manager client. The coordinator
route itself has no separate switch. It answers only the principal that owns the node,
and it releases only workers the coordinator and the node agent both consider idle. A
coordinator-side kill switch was left out to avoid a second deploy step; it can be added
if the operator wants one.

The reverse direction already exists: Pods takes a priority-80 `rtx3090` reservation
before a job, and Strata leaves the card. RAM for a Pods job is not reserved. This task
does not add RAM reservations.

**CPU-only workers.** The node agent's `metrics.workerProcesses` report covers every
worker container: `{workerId, endpointId, containerId, busy, idleSeconds, hostMemMb}`, with
the agent change in T323255ff4b83c. The coordinator merges it with `gpu_processes` per
worker. If either report says busy the worker stays, and the shorter idle time counts.

**Claims in flight.** Once a worker is chosen, its release is checked again under three
guards:
- the coordinator refuses `/job-take` for a worker it has marked as releasing;
- the heartbeat drops a worker that has since been handed a job before it ships the
  release;
- the node agent counts a claim still in flight as busy, and never claims for a worker it
  has already unregistered.

See `docs/Features/release-idle-workers.md` in local-runpod.

## 3. Batch the queue per model

`PriorityRequestQueue` remembers the model of the last activated item. Within the
priority class it picks, it prefers the oldest pending item for that model over an older
item for another model, so a mixed queue switches models at most once per model. The
preference is bounded. The request being skipped can be jumped at most `maxModelBatch`
times (default 16), and then it runs. The budget belongs to that request, so picks
served from other priority classes in between do not reset it. A steady stream for one
model cannot starve another. Priority ordering, realtime preemption and the
background fairness budget are unchanged.

`/api/stats` adds `queue.byModel: {<model>: {active, pending}}` across the llama lane and
the exclusive (DS4/Strata) lane.

## 4. Strata prefill-hang watchdog

Strata's `GET /metrics` reports `live.state` (`reading` while it reads the prompt) and
`live.prompt_read` / `live.prompt_total` (one update per prefill chunk). Every 5 s, while
a Strata request holds the exclusive slot, the manager polls it. `strataPrefillVerdict`
in `strata-policy.js` keeps one clock per prompt. A different slot-holding request id, or
a different `prompt_total`, starts a fresh clock, so a request never inherits another
request's stall time. When the state is `reading` and nothing has moved for
`strata.policy.prefillStallSec` (default 180), the manager does two things.

1. **It holds the lane** (`holdStrataLane`). It arms the swap gate, so new requests wait.
   It also reserves the single generation slot at realtime priority, so requests already
   queued are not sent into a possibly wedged engine.
2. **It aborts the slot holder** and logs `strata prefill stalled: ...`.

What happens next depends on the engine:
- **Recovered:** the engine leaves `reading`, or a prompt makes progress. The hold is
  released and the queue resumes.
- **Wedged:** after 30 s the engine is still `reading` with no progress, or `/metrics`
  stops answering. The queued requests, which have sent nothing yet, are aborted first so
  they are replayed. The slot is then freed, and the engine is restarted on the same
  backend under the same gate. The drain is skipped (0 s) because the engine cannot
  finish anything, and `keepAtLeast` keeps the current cache size.

The existing 900 s zero-token ceiling stays as the backstop when `/metrics` never answers
and nothing was cancelled. A healthy
prefill emits a chunk well inside 180 s: 16384-token chunks at the measured HIP prefill
rate take about a minute.

## Config summary

| Key | Default | Meaning |
|---|---|---|
| `strata.hip.minExpertCache` | 4000 | Floor for the adaptive cache. Below it, the attempt fails and recovery retries. |
| `strata.hip.growCooldownMin` | 10 | Minimum time between a settle and a grow-back restart. |
| `strata.hip.growMarginGb` | 16 | Extra free memory a grow-back must leave on top of the 8 GiB headroom. |
| `strata.policy.prefillStallSec` | 180 | No prefill progress for this long cancels the request. |
| `podsRelease.enabled` | false | Ask the Pods coordinator to release idle workers. |
| env `PODS_COORDINATOR_URL` / `PODS_NODE_ID` | none | Coordinator base URL and this host's Pods node id (environment only). |
| `podsRelease.minIdleSec` | 600 | Only workers idle at least this long are released. |
| env `PODS_API_KEY` | none | Key of the principal that owns the node. |
