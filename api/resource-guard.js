// Llama Manager — resource guard helpers (memory fit + thermal governor).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free logic for protecting the host from the failure modes
// seen in the gpt-oss-120b incident: serving a model that does not fit in
// unified RAM (system reached 99.9% -> crash loop) and running the APU at
// thermal redline (98-99 C). `checkModelFit` estimates whether a model+context
// fits a memory budget (recommending a smaller context when it doesn't), and
// `thermalDecision` is a hysteresis state machine for throttling on temperature.
//
// `memoryPressureDecision` is the RUNTIME counterpart to the admission-time
// checks above: it watches a box whose model is ALREADY resident and decides
// when to shed it gracefully. This exists because on kernel 7.0.0-28 an OOM kill
// of llama-server panics the host outright (NULL deref in
// amdgpu_hmm_range_valid, KFD SVM teardown race) — so the manager must free
// memory before the kernel's OOM killer ever fires.

export const DEFAULTS = {
  // Conservative, operator-tunable knobs (overridable via config.guard).
  kvBytesPerToken: 262144,   // ~256 KiB/token KV-cache reserve estimate
  overheadBytes: 3 * (2 ** 30), // ~3 GiB for compute buffers / runtime
  headroomFrac: 0.12,        // keep 12% of total RAM free
  minContext: 4096,          // smallest context worth serving
  // Thermal thresholds (deg C), governed on the die temperature (k10temp Tctl,
  // the hotter of GPU/CPU on this shared-die APU).
  warnC: 90,                 // pause dispatching new requests at/above this
  resumeC: 80,               // resume dispatch when cooled to/below this
  criticalC: 96,             // pause + offload at/above this (never unloads — see thermalDecision)
  // Heat-attribution knobs. On a shared CPU+iGPU die the die can be driven hot by
  // EXTERNAL processes while llama's own workload is idle; throttling llama then
  // does nothing but destroy service. These let thermalDecision tell whether
  // LLAMA is actually the heat source before it throttles.
  gpuWarnC: 85,              // iGPU at/above this => llama's own compute is heating the die
  appCpuHeatPct: 25,         // llama-stack CPU share (% of total) at/above this => llama is heating the die
  // Absolute die-temperature ceiling. Because it is a shared die, at/above this we
  // pause dispatch REGARDLESS of the heat source to protect the hardware — but even
  // then we only pause/offload, we never unload (an idle model is not a heat source).
  hardCriticalC: 105,
  // Runtime memory-pressure thresholds (bytes of MemAvailable). Deliberately
  // generous: freeing ~60 GiB is not instantaneous, so the governor must win the
  // race against a build that allocates fast. At the Aug 2 panics MemAvailable had
  // reached the kernel watermark floor (~100 MiB) before anything reacted.
  memShedBelowBytes: 16 * (2 ** 30),   // shed the model below this
  memWatchBelowBytes: 24 * (2 ** 30),  // stop taking new local work below this
  memResumeAboveBytes: 32 * (2 ** 30), // only declare recovery above this (hysteresis)
  memShedCooldownMs: 60_000            // grace period for an in-flight unload to land
};

/**
 * Estimate peak memory (bytes) for a model at a given context.
 * @param {{fileBytes:number, contextSize:number, kvBytesPerToken:number, overheadBytes:number}} a
 * @returns {number}
 */
function estimateBytes({ fileBytes, contextSize, kvBytesPerToken, overheadBytes }) {
  return fileBytes + Math.max(0, contextSize) * kvBytesPerToken + overheadBytes;
}

/**
 * Decide whether a model+context fits the available-memory budget, and if not,
 * recommend the largest context that does (or null if the weights alone can't fit).
 * @param {object} a
 * @param {number} a.fileBytes Model file size in bytes.
 * @param {number} a.contextSize Requested context length.
 * @param {number} a.availableBytes Currently-available RAM (e.g. MemAvailable).
 * @param {number} [a.totalBytes] Total system RAM used to calculate reserved headroom.
 * @param {number} [a.reservedHeadroomBytes] Absolute reserved headroom; overrides the fraction.
 * @param {number} [a.kvBytesPerToken]
 * @param {number} [a.overheadBytes]
 * @param {number} [a.headroomFrac] Fraction of total RAM to keep free.
 * @param {number} [a.minContext]
 * @returns {{fits:boolean, recommendedContext:number|null, requiredBytes:number, budgetBytes:number, reason:string}}
 */
export function checkModelFit({
  fileBytes, contextSize, availableBytes, totalBytes, reservedHeadroomBytes,
  kvBytesPerToken = DEFAULTS.kvBytesPerToken,
  overheadBytes = DEFAULTS.overheadBytes,
  headroomFrac = DEFAULTS.headroomFrac,
  minContext = DEFAULTS.minContext
}) {
  const reserveBase = totalBytes > 0 ? totalBytes : availableBytes;
  const reserveBytes = Number.isFinite(reservedHeadroomBytes)
    ? Math.max(0, reservedHeadroomBytes)
    : reserveBase * headroomFrac;
  const usableAvailable = totalBytes > 0
    ? Math.min(availableBytes, totalBytes)
    : availableBytes;
  const budgetBytes = Math.max(0, Math.floor(usableAvailable - reserveBytes));
  const requiredBytes = estimateBytes({ fileBytes, contextSize, kvBytesPerToken, overheadBytes });

  if (requiredBytes <= budgetBytes) {
    return { fits: true, recommendedContext: contextSize, requiredBytes, budgetBytes, reason: 'fits' };
  }

  // Requested context doesn't fit. Can the weights + overhead + minimum context fit at all?
  const floorBytes = estimateBytes({ fileBytes, contextSize: minContext, kvBytesPerToken, overheadBytes });
  if (floorBytes > budgetBytes) {
    return {
      fits: false, recommendedContext: null, requiredBytes, budgetBytes,
      reason: 'model weights too large for available memory'
    };
  }

  // Find the largest context (multiple of minContext) that fits the budget.
  const room = budgetBytes - fileBytes - overheadBytes; // bytes available for KV
  let ctx = Math.floor(room / kvBytesPerToken);
  // Round down to a multiple of minContext, clamped to >= minContext.
  ctx = Math.max(minContext, ctx - (ctx % minContext));
  return {
    fits: false, recommendedContext: ctx, requiredBytes, budgetBytes,
    reason: 'requested context too large; capped to fit memory'
  };
}

/**
 * Decide how to recover memory so a requested model can be served, given what is
 * currently holding RAM. Pure decision logic — the caller performs the actual
 * unload/restart and re-measures, then re-runs the normal fit check.
 *
 * Returns one of three actions:
 *   - 'serve'   : serve now (already fits, the model is already loaded, or the
 *                 size is unknown so we fail open).
 *   - 'reclaim' : the model does not fit at the current MemAvailable, but the
 *                 weights would fit once `reclaimableBytes` (RAM held by other
 *                 loaded models / a stale llama stack) is freed — worth freeing
 *                 RAM (unload then restart) and retrying.
 *   - 'refuse'  : the weights cannot fit even on a fully-freed box, so freeing
 *                 RAM would not help — refuse immediately (no restart thrash).
 *
 * @param {object} a
 * @param {number} a.fileBytes Requested model weights size in bytes (0 = unknown -> serve).
 * @param {number} a.contextSize Requested context length.
 * @param {number} a.availableBytes Current MemAvailable in bytes.
 * @param {number} [a.totalBytes] Total system RAM used to calculate reserved headroom.
 * @param {number} [a.reservedHeadroomBytes] Absolute reserved headroom; overrides the fraction.
 * @param {boolean} a.alreadyLoaded Whether the requested model is already loaded.
 * @param {number} a.reclaimableBytes RAM (bytes) that freeing other models / restarting returns to MemAvailable.
 * @param {number} [a.kvBytesPerToken]
 * @param {number} [a.overheadBytes]
 * @param {number} [a.headroomFrac]
 * @param {number} [a.minContext]
 * @returns {{action:'serve'|'reclaim'|'refuse', requiredBytes:number, budgetBytes:number, reclaimableBudgetBytes:number, reason:string}}
 */
export function planMemoryRecovery({
  fileBytes, contextSize, availableBytes, totalBytes, reservedHeadroomBytes,
  alreadyLoaded = false, reclaimableBytes = 0,
  kvBytesPerToken = DEFAULTS.kvBytesPerToken,
  overheadBytes = DEFAULTS.overheadBytes,
  headroomFrac = DEFAULTS.headroomFrac,
  minContext = DEFAULTS.minContext
}) {
  const knobs = {
    kvBytesPerToken,
    overheadBytes,
    headroomFrac,
    minContext,
    ...(totalBytes > 0 ? { totalBytes } : {}),
    ...(Number.isFinite(reservedHeadroomBytes) ? { reservedHeadroomBytes } : {}),
  };
  const cur = checkModelFit({ fileBytes, contextSize, availableBytes, ...knobs });

  // Unknown size -> fail open. Already-loaded -> its memory is already committed,
  // so a low MemAvailable is expected; refusing would be a false positive.
  if (!fileBytes || alreadyLoaded) {
    return {
      action: 'serve', requiredBytes: cur.requiredBytes, budgetBytes: cur.budgetBytes,
      reclaimableBudgetBytes: cur.budgetBytes,
      reason: !fileBytes ? 'unknown size (fail open)' : 'model already loaded'
    };
  }

  if (cur.fits) {
    return {
      action: 'serve', requiredBytes: cur.requiredBytes, budgetBytes: cur.budgetBytes,
      reclaimableBudgetBytes: cur.budgetBytes, reason: 'fits at current available memory'
    };
  }

  // Would the weights fit on a box where the reclaimable RAM is freed?
  const freedAvailable = availableBytes + Math.max(0, reclaimableBytes);
  const freed = checkModelFit({ fileBytes, contextSize, availableBytes: freedAvailable, ...knobs });
  const fitsWhenFreed = freed.fits || freed.recommendedContext !== null;

  if (!fitsWhenFreed) {
    return {
      action: 'refuse', requiredBytes: cur.requiredBytes, budgetBytes: cur.budgetBytes,
      reclaimableBudgetBytes: freed.budgetBytes,
      reason: 'weights too large even after freeing all reclaimable memory'
    };
  }

  return {
    action: 'reclaim', requiredBytes: cur.requiredBytes, budgetBytes: cur.budgetBytes,
    reclaimableBudgetBytes: freed.budgetBytes,
    reason: 'fits after reclaiming memory held by other models'
  };
}

/**
 * Runtime memory-pressure state machine: decide when to GRACEFULLY shed an
 * already-resident model, before the kernel's OOM killer resolves the pressure
 * for us.
 *
 * Why this is not optional on this host: an OOM kill of `llama-server` does not
 * merely lose the model — on kernel 7.0.0-28 it panics the entire box. The dying
 * process's in-flight KFD SVM ioctl races with mmu-notifier teardown,
 * `range->notifier` goes NULL, and `amdgpu_hmm_range_valid` dereferences
 * NULL+0x50. Four hard resets (2026-07-30, and 2026-08-02 x3) share that exact
 * trace, and in every one the PID the OOM killer chose is the PID that oopsed
 * 0.4-0.8 s later. A graceful unload (`POST /models/unload`) frees the weights
 * in-process with an orderly teardown and never enters that race.
 *
 * Three bands with hysteresis, so a box hovering near the threshold neither
 * flaps nor reloads 60 GiB back into a still-strained system:
 *   - `normal` : plenty of headroom; residency restore is permitted.
 *   - `watch`  : below `watchBelowBytes` — refuse new local work (offload it),
 *                but the model stays resident because the pressure may pass.
 *   - `shed`   : below `shedBelowBytes` — free the model now. Held until
 *                MemAvailable climbs back above `resumeAboveBytes`.
 *
 * Fails OPEN: `availableBytes <= 0` means /proc/meminfo was unreadable, not that
 * the box is out of memory — shedding a healthy model on dark telemetry would be
 * a self-inflicted outage. This mirrors `thermalDecision` ignoring all-zero reads.
 *
 * @param {object} a
 * @param {number} a.availableBytes Current MemAvailable in bytes (0 = unreadable -> fail open).
 * @param {boolean} [a.modelLoaded] Whether anything is actually resident to shed.
 * @param {string} [a.prevState] 'normal' | 'watch' | 'shed' — previous tick's state.
 * @param {number} [a.lastShedAt] Epoch ms of the last shed, for cooldown accounting.
 * @param {number} [a.now] Current epoch ms (injectable for tests).
 * @param {number} [a.cooldownMs] Grace period before a repeat shed is allowed.
 * @param {number} [a.shedBelowBytes]
 * @param {number} [a.watchBelowBytes]
 * @param {number} [a.resumeAboveBytes]
 * @returns {{state:string, shed:boolean, pauseDispatch:boolean, allowResidencyRestore:boolean, reason:string}}
 */
export function memoryPressureDecision({
  availableBytes,
  modelLoaded = false,
  prevState = 'normal',
  lastShedAt = 0,
  now = Date.now(),
  cooldownMs = DEFAULTS.memShedCooldownMs,
  shedBelowBytes = DEFAULTS.memShedBelowBytes,
  watchBelowBytes = DEFAULTS.memWatchBelowBytes,
  resumeAboveBytes = DEFAULTS.memResumeAboveBytes
}) {
  // Telemetry dark -> fail open. Never shed on a reading we could not take.
  if (!(availableBytes > 0)) {
    return {
      state: 'normal', shed: false, pauseDispatch: false, allowResidencyRestore: true,
      reason: 'MemAvailable unreadable (telemetry dark) — failing open'
    };
  }

  // Band selection, with hysteresis: once shedding we hold that state until
  // memory recovers past the resume threshold, so the residency restorer cannot
  // reload the model straight back into a box that is still under pressure.
  let state;
  if (availableBytes >= resumeAboveBytes) state = 'normal';
  else if (availableBytes < shedBelowBytes) state = 'shed';
  else if (prevState === 'shed') state = 'shed';
  else if (availableBytes < watchBelowBytes) state = 'watch';
  else state = 'normal';

  const gib = (b) => (b / (2 ** 30)).toFixed(1);

  if (state === 'normal') {
    return {
      state, shed: false, pauseDispatch: false, allowResidencyRestore: true,
      reason: `MemAvailable ${gib(availableBytes)} GiB — healthy`
    };
  }

  if (state === 'watch') {
    return {
      state, shed: false, pauseDispatch: true, allowResidencyRestore: false,
      reason: `MemAvailable ${gib(availableBytes)} GiB < ${gib(watchBelowBytes)} GiB — holding new local work`
    };
  }

  // state === 'shed'. Three reasons we may still not act: nothing is resident,
  // a previous unload is still landing (MemAvailable lags), or memory is in the
  // hysteresis band above the shed threshold and we already shed.
  if (!modelLoaded) {
    return {
      state, shed: false, pauseDispatch: true, allowResidencyRestore: false,
      reason: `MemAvailable ${gib(availableBytes)} GiB — nothing resident left to shed`
    };
  }
  if (lastShedAt > 0 && now - lastShedAt < cooldownMs) {
    return {
      state, shed: false, pauseDispatch: true, allowResidencyRestore: false,
      reason: `shed cooldown — ${Math.round((cooldownMs - (now - lastShedAt)) / 1000)}s left for the previous unload to land`
    };
  }
  if (availableBytes >= shedBelowBytes) {
    return {
      state, shed: false, pauseDispatch: true, allowResidencyRestore: false,
      reason: `MemAvailable ${gib(availableBytes)} GiB recovering, below resume threshold ${gib(resumeAboveBytes)} GiB`
    };
  }

  return {
    state, shed: true, pauseDispatch: true, allowResidencyRestore: false,
    reason: `low memory: MemAvailable ${gib(availableBytes)} GiB < ${gib(shedBelowBytes)} GiB — shedding resident model before the kernel OOM-kills it`
  };
}

/**
 * Decide whether an offloadable request should try a remote backend BEFORE
 * taking the local slot. Returns tryRemoteFirst=true when either the operator
 * configured prefer-remote (preferLocal=false) OR the local APU is thermally
 * throttled. In the thermal case, routing offloadable work to a remote keeps
 * clients served and removes load from the APU so it cools faster — instead of
 * holding the request in the up-to-2-minute thermal dispatch pause. Non-
 * offloadable models (no remote mapping) are unaffected; the caller still falls
 * back to the local pause when no viable remote exists.
 * @param {{preferLocal?:boolean, thermalPaused?:boolean}} a
 * @returns {{tryRemoteFirst:boolean, reason:string}}
 */
export function dispatchPreference({ preferLocal = true, thermalPaused = false } = {}) {
  if (thermalPaused) {
    return { tryRemoteFirst: true, reason: 'thermal throttle — offload to cool the local APU' };
  }
  if (!preferLocal) {
    return { tryRemoteFirst: true, reason: 'preferLocal=false — spread offloadable work to remote' };
  }
  return { tryRemoteFirst: false, reason: 'prefer local' };
}

/**
 * Hysteresis thermal state machine with heat-source attribution.
 *
 * This APU shares ONE die between the CPU cores and the iGPU, so the die
 * temperature (`tempC`, the k10temp Tctl / hotter of GPU+CPU) can be driven to
 * redline by EXTERNAL processes (a busy CPU workload that has nothing to do with
 * llama) while llama's own iGPU sits idle. Throttling or unloading llama in that
 * case is pure harm: an idle loaded model generates ~no heat, so unloading it
 * does not cool the die, and pausing dispatch cannot cool a die that llama is not
 * heating — it only destroys service. So before throttling we ATTRIBUTE the heat:
 *
 *   - If the caller passes attribution inputs (`gpuC` and/or `appCpuPct`) and BOTH
 *     say llama is cool (iGPU below `gpuWarnC` AND llama's CPU share below
 *     `appCpuHeatPct`), the heat is external => stay 'normal', never pause, never
 *     unload. Inference keeps running; it will not make the die hotter.
 *   - Otherwise llama is (or may be) the heat source, so the normal hysteresis
 *     thresholds apply: pause new dispatch at `warnC`, and at `criticalC`
 *     pause + offload (the caller routes offloadable work to a remote to shed the
 *     iGPU load). Even here we NEVER unload for thermal reasons — the model stays
 *     loaded so inference resumes instantly once the die cools. Memory-pressure
 *     unloads are a SEPARATE path (see planMemoryRecovery) and are unaffected.
 *
 * Hard-safety backstop: at/above `hardCriticalC` (an absolute die ceiling) we
 * pause dispatch REGARDLESS of the heat source to protect the shared hardware —
 * but still only pause/offload, never unload.
 *
 * `unload` is retained in the return shape for backward compatibility but is now
 * ALWAYS false; thermal actions are limited to pausing/offloading.
 *
 * @param {object} a
 * @param {number} a.tempC Current die temperature (hotter of GPU/CPU, k10temp Tctl).
 * @param {string} a.prevState 'normal' | 'throttled' | 'critical'
 * @param {number} [a.warnC]
 * @param {number} [a.resumeC]
 * @param {number} [a.criticalC]
 * @param {number|null} [a.gpuC] iGPU temperature (llama's direct thermal contribution). null => unknown.
 * @param {number|null} [a.appCpuPct] llama-stack CPU share (% of total). null => unknown.
 * @param {number} [a.gpuWarnC] iGPU temp at/above which llama's own compute counts as heating the die.
 * @param {number} [a.appCpuHeatPct] llama CPU share at/above which llama counts as heating the die.
 * @param {number} [a.hardCriticalC] Absolute die ceiling: pause regardless of source.
 * @returns {{state:string, pauseDispatch:boolean, unload:boolean}}
 */
export function thermalDecision({
  tempC, prevState = 'normal',
  warnC = DEFAULTS.warnC, resumeC = DEFAULTS.resumeC, criticalC = DEFAULTS.criticalC,
  gpuC = null, appCpuPct = null,
  gpuWarnC = DEFAULTS.gpuWarnC, appCpuHeatPct = DEFAULTS.appCpuHeatPct,
  hardCriticalC = DEFAULTS.hardCriticalC
}) {
  // Hard-safety backstop first: at the absolute die ceiling we pause regardless of
  // who is heating the die (shared hardware) — but never unload; offload instead.
  if (tempC >= hardCriticalC) {
    return { state: 'critical', pauseDispatch: true, unload: false };
  }

  // Heat attribution: is llama actually the source of the heat? Only decide
  // "external" when we have at least one attribution signal AND every signal we
  // have says llama is cool. With no signals we conservatively assume llama could
  // be the source and fall through to the normal thresholds (backward compatible).
  const haveAttribution = gpuC !== null || appCpuPct !== null;
  const gpuHot = gpuC !== null && gpuC >= gpuWarnC;
  const appCpuHot = appCpuPct !== null && appCpuPct >= appCpuHeatPct;
  const llamaIsHeatSource = gpuHot || appCpuHot;

  if (haveAttribution && !llamaIsHeatSource) {
    // Die is hot but the heat is EXTERNAL (iGPU cool + llama CPU low). Throttling
    // llama cannot cool an externally-heated die, so keep serving.
    return { state: 'normal', pauseDispatch: false, unload: false };
  }

  // llama is (or may be) the heat source — apply the hysteresis thresholds.
  if (tempC >= criticalC) {
    return { state: 'critical', pauseDispatch: true, unload: false };
  }
  if (tempC >= warnC) {
    return { state: 'throttled', pauseDispatch: true, unload: false };
  }
  // Between resume and warn: hold the throttle if we were already hot (hysteresis).
  if ((prevState === 'throttled' || prevState === 'critical') && tempC > resumeC) {
    return { state: 'throttled', pauseDispatch: true, unload: false };
  }
  return { state: 'normal', pauseDispatch: false, unload: false };
}
