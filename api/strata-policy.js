// Llama Manager — Strata backend policy: pure CUDA <-> HIP decision functions.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure, dependency-free helpers that decide where the Strata exclusive engine should run:
// parse and total the foreign compute processes on the NVIDIA card, judge whether CUDA is
// idle, detect a competing GPU reservation, admit a CUDA attempt at activation, and choose
// stay / yield-to-hip / return-to-cuda at runtime with hysteresis so the engine never flaps
// on a transient reading. No I/O and no clock: callers pass `now` and every sampled value.

/** Reservation holder id Strata uses on the GPU reservation state machine. */
export const STRATA_HOLDER = 'llama-manager/strata';

const MIB = 1024 * 1024;
const DEFAULT_OWN_NAMES = Object.freeze(['strata', 'ggml-rpc-server', 'rpc-server']);
const ACTIVE_STATES = Object.freeze(['pending', 'held']);

/**
 * Parse `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`.
 * @param {string} csv Raw command output (memory in MiB).
 * @returns {Array<{pid:number,name:string,usedBytes:number}>} Parsed rows; malformed and
 *   `[N/A]` rows are skipped, empty input yields `[]`.
 */
export function parseComputeApps(csv) {
  const apps = [];
  for (const line of String(csv ?? '').split('\n')) {
    const parts = line.split(',').map(part => part.trim());
    if (parts.length < 3 || !parts[1]) continue;
    const pid = Number(parts[0]);
    const used = Number(parts[parts.length - 1]);
    if (!/^\d+$/.test(parts[0]) || !/^\d+(\.\d+)?$/.test(parts[parts.length - 1])) continue;
    // Process names may themselves contain commas; keep the middle fields together.
    apps.push({ pid, name: parts.slice(1, -1).join(','), usedBytes: Math.round(used * MIB) });
  }
  return apps;
}

/**
 * Sum VRAM used by compute processes that are not Strata's own.
 * @param {Array<{name:string,usedBytes:number}>|null} apps Output of parseComputeApps.
 * @param {string[]} [ownNames] Process basenames that count as ours.
 * @returns {number|null} Foreign VRAM in bytes, or null when the sample is unavailable (blind).
 */
export function otherComputeVramBytes(apps, ownNames = DEFAULT_OWN_NAMES) {
  if (!Array.isArray(apps)) return null;
  let total = 0;
  for (const app of apps) {
    const base = String(app.name ?? '').split('/').pop();
    if (!ownNames.includes(base)) total += app.usedBytes;
  }
  return total;
}

/**
 * Whether the CUDA card looks idle of foreign work.
 * @param {{otherVramBytes:number|null,baselineBytes:number,growthBytes:number}} sample
 * @returns {boolean} False when blind (null) or foreign usage exceeds baseline + growth.
 */
export function cudaIdle({ otherVramBytes, baselineBytes, growthBytes }) {
  if (otherVramBytes == null) return false;
  return otherVramBytes <= baselineBytes + growthBytes;
}

/**
 * Whether another active claim on the pool would not yield to Strata.
 * @param {Array<{id:string,state:string,priority:number}>} reservations Reservations on the pool.
 * @param {number} priority Strata's priority.
 * @param {string} [ownId] Strata's own reservation id, ignored.
 * @returns {boolean} True when a different pending/held reservation has priority >= ours.
 */
export function blockingClaim(reservations, priority, ownId) {
  return (reservations ?? []).some(r =>
    r.id !== ownId && ACTIVE_STATES.includes(r.state) && r.priority >= priority);
}

/**
 * Decide at first activation whether a CUDA attempt is worth making (HIP rules 1-3 and 5,
 * no hysteresis).
 * @param {object} input See strataBackendDecision for the shared fields.
 * @returns {{admit:boolean,reason:string}}
 */
export function cudaAdmission({ cudaConfigured, blocking, otherVramBytes, baselineBytes, growthBytes, cudaFailedAt, now, returnAfterMs }) {
  if (!cudaConfigured) return { admit: false, reason: 'cuda-not-configured' };
  if (blocking) return { admit: false, reason: 'cuda-claimed' };
  if (!cudaIdle({ otherVramBytes, baselineBytes, growthBytes })) return { admit: false, reason: 'cuda-busy' };
  if (cudaFailedAt && now - cudaFailedAt < returnAfterMs) return { admit: false, reason: 'cuda-recently-failed' };
  return { admit: true, reason: 'cuda-idle' };
}

/**
 * Runtime backend decision.
 * @param {{backend:'cuda'|'hip',cudaConfigured:boolean,leaseState:string,blocking:boolean,
 *   otherVramBytes:number|null,baselineBytes:number,growthBytes:number,idleSinceMs:number|null,
 *   cudaFailedAt:number|null,busy:boolean,now:number,returnAfterMs:number}} input
 * @returns {{action:'stay'|'yield-to-hip'|'return-to-cuda',idleSinceMs:number|null,reason:string}}
 *   `idleSinceMs` is the idle-streak start the caller should persist for the next tick.
 */
export function strataBackendDecision(input) {
  const { backend, cudaConfigured, leaseState, blocking, otherVramBytes, baselineBytes, growthBytes,
    idleSinceMs, cudaFailedAt, busy, now, returnAfterMs } = input;
  if (backend === 'cuda') {
    if (leaseState !== 'held') return { action: 'yield-to-hip', idleSinceMs: null, reason: `lease-${leaseState}` };
    if (otherVramBytes != null && otherVramBytes > baselineBytes + growthBytes) {
      return { action: 'yield-to-hip', idleSinceMs: null, reason: 'cuda-contended' };
    }
    return { action: 'stay', idleSinceMs: null, reason: 'cuda-ok' };
  }
  if (!cudaConfigured) return { action: 'stay', idleSinceMs: null, reason: 'cuda-not-configured' };
  if (blocking) return { action: 'stay', idleSinceMs: null, reason: 'cuda-claimed' };
  if (!cudaIdle({ otherVramBytes, baselineBytes, growthBytes })) return { action: 'stay', idleSinceMs: null, reason: 'cuda-busy' };
  const idleSince = idleSinceMs ?? now;
  if (cudaFailedAt && now - cudaFailedAt < returnAfterMs) return { action: 'stay', idleSinceMs: idleSince, reason: 'cuda-recently-failed' };
  if (now - idleSince < returnAfterMs) return { action: 'stay', idleSinceMs: idleSince, reason: 'cuda-idle-settling' };
  if (busy) return { action: 'stay', idleSinceMs: idleSince, reason: 'engine-busy' };
  return { action: 'return-to-cuda', idleSinceMs: idleSince, reason: 'cuda-idle' };
}

/**
 * Wait until Strata's CUDA lease is released. If a swap is already in flight the lease is
 * released by that swap's verified stop, so only poll; otherwise call `leave` once.
 * @param {{isHeld: function(): boolean, swapInFlight: function(): boolean, leave: function(): Promise<void>,
 *   sleep: function(number): Promise<void>, now: function(): number, timeoutMs: number, pollMs?: number}} opts
 *   Injected probes (no I/O here); `isHeld` is true while the lease is still held on the card.
 * @returns {Promise<void>} Resolves once the lease is gone.
 * @throws {Error} 'strata cuda lease release timed out' when still held after `timeoutMs`.
 */
export async function waitForCudaLeaseRelease({ isHeld, swapInFlight, leave, sleep, now, timeoutMs, pollMs = 500 }) {
  const deadline = now() + timeoutMs;
  while (isHeld()) {
    if (!swapInFlight()) { await leave(); return; }
    if (now() >= deadline) throw new Error('strata cuda lease release timed out');
    await sleep(pollMs);
  }
}
