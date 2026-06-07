// Llama Manager — resource guard helpers (memory fit + thermal governor).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free logic for protecting the host from the failure modes
// seen in the gpt-oss-120b incident: serving a model that does not fit in
// unified RAM (system reached 99.9% -> crash loop) and running the APU at
// thermal redline (98-99 C). `checkModelFit` estimates whether a model+context
// fits a memory budget (recommending a smaller context when it doesn't), and
// `thermalDecision` is a hysteresis state machine for throttling on temperature.

export const DEFAULTS = {
  // Conservative, operator-tunable knobs (overridable via config.guard).
  kvBytesPerToken: 262144,   // ~256 KiB/token KV-cache reserve estimate
  overheadBytes: 3 * (2 ** 30), // ~3 GiB for compute buffers / runtime
  headroomFrac: 0.12,        // keep 12% of available RAM free
  minContext: 4096,          // smallest context worth serving
  // Thermal thresholds (deg C), governed on max(GPU, CPU).
  warnC: 90,                 // pause dispatching new requests at/above this
  resumeC: 80,               // resume dispatch when cooled to/below this
  criticalC: 96              // unload the model at/above this
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
 * @param {number} [a.kvBytesPerToken]
 * @param {number} [a.overheadBytes]
 * @param {number} [a.headroomFrac] Fraction of available RAM to keep free.
 * @param {number} [a.minContext]
 * @returns {{fits:boolean, recommendedContext:number|null, requiredBytes:number, budgetBytes:number, reason:string}}
 */
export function checkModelFit({
  fileBytes, contextSize, availableBytes,
  kvBytesPerToken = DEFAULTS.kvBytesPerToken,
  overheadBytes = DEFAULTS.overheadBytes,
  headroomFrac = DEFAULTS.headroomFrac,
  minContext = DEFAULTS.minContext
}) {
  const budgetBytes = Math.floor(availableBytes * (1 - headroomFrac));
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
 * Hysteresis thermal state machine. Governs on a single temperature (the caller
 * passes max(GPU, CPU)). Once throttled, stays throttled until cooled to resumeC.
 * @param {object} a
 * @param {number} a.tempC Current temperature (max of GPU/CPU).
 * @param {string} a.prevState 'normal' | 'throttled' | 'critical'
 * @param {number} [a.warnC]
 * @param {number} [a.resumeC]
 * @param {number} [a.criticalC]
 * @returns {{state:string, pauseDispatch:boolean, unload:boolean}}
 */
export function thermalDecision({
  tempC, prevState = 'normal',
  warnC = DEFAULTS.warnC, resumeC = DEFAULTS.resumeC, criticalC = DEFAULTS.criticalC
}) {
  if (tempC >= criticalC) {
    return { state: 'critical', pauseDispatch: true, unload: true };
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
