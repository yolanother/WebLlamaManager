// Llama Manager — adaptive DS4 memory/context planner + activation controller.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free logic for making DS4 (DeepSeek V4 Flash) activation
// self-fitting on any box. The ~80GB ds4 weights fit at full context on a
// dedicated machine but OOM at the load tail on a shared/contended box even at
// modest context. Rather than pin one static context in config, this module
// computes an ORDERED list of load attempts:
//
//   1. planDs4Attempts() — from live MemAvailable, the on-disk weight size, and
//      per-token KV/safety estimates, size the largest context that should fit
//      NON-streaming, then build a descending (halving) ladder down to a
//      minContext floor. When SSD expert-streaming is allowed, append a STREAMING
//      ladder (streaming frees ~30G of resident weight RAM, so high context fits
//      again). Modes: 'off' never streams, 'on' streams from the first attempt,
//      'auto' streams only after the non-streaming ladder bottoms out (or when the
//      weights don't fit at all). The numbers are ESTIMATES — the plan is a fallback
//      ladder the controller walks; it never trusts the estimate alone and always
//      steps down on an ACTUAL load failure.
//   2. runDs4AdaptivePlan() — walk the plan: spawn each attempt, wait for readiness
//      OR a load failure (injected I/O), advance on failure, stop on ready recording
//      the settled {context, ssdStreaming, cacheExperts}, and abort after exhausting
//      the ladder. All I/O (spawn/health/stop) is injected so it is unit-testable
//      without booting the server or loading the 81GB model.
//
// The server (server.js) supplies the live memory numbers and the real spawn/health/
// stop side effects via the ds4 supervisor; this module only plans and sequences.

const GB = 1024 * 1024 * 1024;

/**
 * Default per-token KV-cache cost (bytes) used to estimate how much context fits in
 * the RAM left after the weights. DeepSeek V4 Flash is a large MoE model; this is a
 * deliberately middle-of-the-road estimate (≈128 KiB/token) — overridable via
 * config.ds4.kvBytesPerToken. The plan corrects for any error by stepping down on a
 * real OOM, so this only needs to be in the right ballpark for the FIRST attempt.
 */
export const DEFAULT_DS4_KV_BYTES_PER_TOKEN = 128 * 1024;

/** Default RAM (bytes) held back above weights+KV as runtime/allocator safety margin (~5 GiB). */
export const DEFAULT_DS4_SAFETY_BYTES = 5 * GB;

/**
 * Default estimate (bytes) of resident weight RAM WITH SSD expert-streaming enabled.
 * Streaming keeps only a cache of experts resident (~32GB by default) plus the dense
 * layers, cutting the ~80GB full-resident weights to ~45-55 GiB; ≈50 GiB is a safe
 * middle estimate. Overridable via config.ds4.streamingWeightBytes.
 */
export const DEFAULT_DS4_STREAMING_WEIGHT_BYTES = 50 * GB;

/** Default context floor: at/below this, stop shrinking ctx and switch to streaming. */
export const DEFAULT_DS4_MIN_CONTEXT = 8192;

/** Default SSD-streaming expert cache size passed to ds4-server's --ssd-streaming-cache-experts. */
export const DEFAULT_DS4_SSD_CACHE_EXPERTS = '32GB';

/** Context ladder rounding step. Fit estimates and rungs are floored to this so the
 *  ladder lands on tidy, engine-friendly context sizes. */
const DS4_CTX_STEP = 2048;

/** Normalize a streaming mode to one of 'off' | 'on' | 'auto' (default 'auto'). */
function normalizeStreamingMode(mode) {
  const s = String(mode || '').toLowerCase();
  return s === 'off' || s === 'on' ? s : 'auto';
}

/** Floor `n` to a multiple of `step`, but never below `floor`. */
function floorToStep(n, step, floor) {
  const v = Math.floor(n / step) * step;
  return Math.max(floor, v);
}

/**
 * Build a descending (halving) context ladder from `start` down to `floor`
 * (inclusive), each rung floored to DS4_CTX_STEP. Guarantees the floor rung is the
 * last entry and that the ladder always makes downward progress.
 * @param {number} start Top rung (already clamped to ≥ floor and ≤ configured max).
 * @param {number} floor minContext floor.
 * @returns {number[]} Descending context sizes, ending at `floor`.
 */
function halvingLadder(start, floor) {
  const rungs = [];
  let c = Math.max(floor, floorToStep(start, DS4_CTX_STEP, floor));
  while (true) {
    rungs.push(c);
    if (c <= floor) break;
    let next = floorToStep(Math.floor(c / 2), DS4_CTX_STEP, floor);
    if (next >= c) next = floor; // guarantee progress toward the floor
    c = next;
  }
  return rungs;
}

/**
 * Plan the ordered list of ds4 load attempts for the current box. Pure — inject all
 * numbers. See the module header for the strategy.
 *
 * @param {object} params
 * @param {number} params.configuredContext        Operator's target/max context.
 * @param {number} [params.minContext=8192]         Context floor (stop shrinking, switch to streaming).
 * @param {number} [params.availBytes=0]            Live MemAvailable (bytes) after reclaim.
 * @param {number} [params.weightBytes=0]           On-disk (≈resident) ds4 weight size, non-streaming.
 * @param {number} [params.kvBytesPerToken]         Per-token KV cost estimate.
 * @param {number} [params.safetyBytes]             Runtime/allocator safety margin.
 * @param {('off'|'on'|'auto')} [params.ssdStreamingMode='auto'] Streaming policy.
 * @param {number} [params.streamingWeightBytes]    Resident weight estimate WITH streaming.
 * @param {string} [params.ssdStreamingCacheExperts='32GB'] Expert-cache size for streaming attempts.
 * @param {boolean} [params.adaptiveContext=true]   When false, a single attempt at configuredContext.
 * @returns {Array<{context:number, ssdStreaming:boolean, cacheExperts:string}>} Ordered attempts.
 */
export function planDs4Attempts({
  configuredContext,
  minContext = DEFAULT_DS4_MIN_CONTEXT,
  availBytes = 0,
  weightBytes = 0,
  kvBytesPerToken = DEFAULT_DS4_KV_BYTES_PER_TOKEN,
  safetyBytes = DEFAULT_DS4_SAFETY_BYTES,
  ssdStreamingMode = 'auto',
  streamingWeightBytes = DEFAULT_DS4_STREAMING_WEIGHT_BYTES,
  ssdStreamingCacheExperts = DEFAULT_DS4_SSD_CACHE_EXPERTS,
  adaptiveContext = true,
} = {}) {
  const mode = normalizeStreamingMode(ssdStreamingMode);
  const cacheExperts = ssdStreamingCacheExperts || DEFAULT_DS4_SSD_CACHE_EXPERTS;
  const kv = Math.max(1, Number(kvBytesPerToken) || DEFAULT_DS4_KV_BYTES_PER_TOKEN);
  const floor = Math.max(1, Math.round(Number(minContext)) || DEFAULT_DS4_MIN_CONTEXT);
  // configuredContext is the ceiling; clamp up to the floor if a nonsensical config
  // put the max below the min.
  const configured = Math.max(floor, Math.round(Number(configuredContext)) || floor);

  const attempts = [];
  const seen = new Set();
  const push = (context, ssdStreaming) => {
    const key = `${context}:${ssdStreaming}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ context, ssdStreaming, cacheExperts });
  };

  // Non-adaptive: a single attempt at the configured context. Streaming only when
  // explicitly forced 'on' (with no ladder, 'auto' cannot "bottom out", so it stays off).
  if (!adaptiveContext) {
    push(configured, mode === 'on');
    return attempts;
  }

  // Can the weights themselves fit non-streaming, leaving room for at least the floor
  // context + safety? If not, the non-streaming ladder is pointless.
  const weightsFit = availBytes >= weightBytes + floor * kv + safetyBytes;

  // Route exclusively to streaming when forced 'on', or when weights don't fit and
  // streaming is permitted ('auto'). Otherwise build the non-streaming ladder first.
  const streamingOnly = mode === 'on' || (!weightsFit && mode !== 'off');

  if (!streamingOnly) {
    // Largest context that should fit non-streaming, capped at the configured max.
    const fit = Math.floor((availBytes - weightBytes - safetyBytes) / kv);
    const start = Math.min(configured, Math.max(floor, fit));
    for (const c of halvingLadder(start, floor)) push(c, false);
  }

  // Streaming ladder: streaming frees weight RAM (weightBytes → streamingWeightBytes),
  // so re-raise context from the configured max back down to the floor.
  if (mode !== 'off') {
    for (const c of halvingLadder(configured, floor)) push(c, true);
  }

  return attempts;
}

/**
 * Walk a ds4 attempt plan, driving the retries itself (the supervisor's own
 * auto-restart circuit breaker is suppressed during the plan and becomes the backstop
 * only after settle). For each attempt: spawn ds4 with that context + streaming
 * config, wait for readiness OR a load failure, advance on failure (stopping the dead
 * attempt first), and stop on ready — recording the settled config. Aborts (stays
 * exclusive; the caller keeps the box in ds4 offload mode) after exhausting the plan.
 *
 * All side effects are injected so this is unit-testable without a real ds4-server.
 *
 * @param {object} params
 * @param {Array<{context:number, ssdStreaming:boolean, cacheExperts:string}>} params.attempts Ordered plan.
 * @param {(attempt:object)=>void} params.startAttempt Spawn ds4 for the attempt (ctx + streaming env).
 * @param {(attempt:object)=>Promise<('ready'|'load-failure'|'timeout')>} params.waitForOutcome
 *   Resolve once ds4 is serving (`ready`) or the process exited/timed out before ever serving.
 * @param {()=>Promise<({ok:boolean}|void)>} [params.stopAttempt] Stop the current (failed) ds4
 *   before the next attempt. An explicit `{ok:false}` (kill could not confirm the old
 *   process/port is gone) aborts the ladder rather than risking a second engine spawned
 *   on top of the first; any other return (including none) advances normally.
 * @param {(attempt:object, index:number)=>void} [params.onAttempt] Per-attempt hook (logging).
 * @returns {Promise<{ok:boolean, settled:(object|null), attemptsMade:number, reason:string}>}
 */
export async function runDs4AdaptivePlan({
  attempts = [],
  startAttempt,
  waitForOutcome,
  stopAttempt = async () => {},
  onAttempt = () => {},
} = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { ok: false, settled: null, attemptsMade: 0, reason: 'no-attempts' };
  }
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    onAttempt(attempt, i);
    startAttempt(attempt);
    const outcome = await waitForOutcome(attempt);
    if (outcome === 'ready') {
      return { ok: true, settled: attempt, attemptsMade: i + 1, reason: 'ready' };
    }
    // Load failure (or timeout): stop the dead/half-started process before retrying so
    // the next attempt starts from a clean slate (freed port, unmapped weights). If the
    // stop could not CONFIRM the old process/port is actually gone ({ok:false} — a
    // wedged/D-state kill), do NOT spawn the next attempt on top of it: that is how a
    // second ds4-server ends up fighting the first for the same port and GPU. Abort the
    // ladder instead, same as exhausting every attempt.
    const stopped = await stopAttempt();
    if (stopped?.ok === false) {
      return { ok: false, settled: null, attemptsMade: i + 1, reason: 'stop-unconfirmed' };
    }
  }
  return { ok: false, settled: null, attemptsMade: attempts.length, reason: 'exhausted' };
}
