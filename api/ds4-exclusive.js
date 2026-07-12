// Llama Manager — exclusive-DS4-mode decision helpers (pre-eviction budget + offload routing).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free decision logic for "exclusive DS4 mode": when a DeepSeek V4
// Flash (ds4) preset is active, the ~81GB model owns nearly all of the box's 124GB
// unified RAM, so nothing else may load locally. This module encodes the two policies
// that make that safe, kept out of server.js so they are unit-testable without a GPU:
//
//   1. Pre-eviction budget — how much MemAvailable must be reclaimed BEFORE ds4-server
//      is spawned (model size + guard headroom), whether the reclaim has been verified,
//      a poll loop that waits for the kernel to actually release the pages (injectable
//      clock/sleep/meminfo reader so it is deterministically testable), and whether the
//      small embed server may stay resident within the budget.
//   2. Offload routing table — while ds4 is active, a request naming the ds4 model is
//      served locally, a request for any other model is offloaded to a configured remote
//      backend, and a request for a model no backend can serve is rejected with a clear
//      503 (never queued forever, never loaded locally beside ds4).
//
// The server (server.js) supplies the live numbers (MemAvailable/MemTotal, on-disk model
// size, whether a viable remote exists) and performs the side effects (stop llama, spawn
// ds4, forward to remote); this module only decides.

/** OpenAI-style error `type`/`code` returned when the box is in exclusive DS4 mode. */
export const DS4_EXCLUSIVE_ERROR = 'exclusive_ds4_mode';

/** Normalize a model name for tolerant, punctuation-insensitive comparison. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when `requestedModel` refers to the currently-active ds4 model. Comparison is
 * normalized (lowercase, alphanumerics only) and tolerant of substring relationships so
 * a preset id, its display name, or the GGUF basename all match the same ds4 engine.
 * @param {string} requestedModel The resolved model name from the request.
 * @param {string[]} ds4ModelIds  Names that map to the local ds4 engine (preset id, basename, …).
 * @returns {boolean}
 */
export function ds4ModelMatches(requestedModel, ds4ModelIds = []) {
  const t = norm(requestedModel);
  if (!t) return false;
  return ds4ModelIds.some((id) => {
    const n = norm(id);
    return !!n && (n === t || n.includes(t) || t.includes(n));
  });
}

/**
 * Decide where a chat/completions (or sibling) request goes while ds4 owns the box.
 *   - ds4 model      → serve locally on ds4-server.
 *   - any other model + a viable remote backend exists → offload to remote.
 *   - any other model + no viable remote → reject (clean 503; never load locally).
 * @param {object} params
 * @param {string} params.requestedModel        Resolved model name from the request.
 * @param {string[]} [params.ds4ModelIds=[]]     Names that map to the local ds4 engine.
 * @param {boolean} [params.hasViableRemote=false] Whether some remote backend can serve requestedModel.
 * @returns {{target:'local-ds4'|'remote'|'reject', reason:string}}
 */
export function ds4RequestTarget({ requestedModel, ds4ModelIds = [], hasViableRemote = false } = {}) {
  if (ds4ModelMatches(requestedModel, ds4ModelIds)) return { target: 'local-ds4', reason: 'ds4-model' };
  if (hasViableRemote) return { target: 'remote', reason: 'offload' };
  return { target: 'reject', reason: 'exclusive-ds4-no-backend' };
}

/**
 * MemAvailable (bytes) the box must reach BEFORE ds4-server is spawned: the model's
 * on-disk weights plus the guard's headroom. Measured against live MemAvailable, which
 * already reflects anything still resident (e.g. a kept embed server), so no double count.
 * @param {object} params
 * @param {number} [params.ds4ModelBytes=0] On-disk size of the ds4 GGUF (summed splits).
 * @param {number} [params.headroomBytes=0] Guard headroom to keep free above the weights.
 * @returns {number}
 */
export function reclaimTargetBytes({ ds4ModelBytes = 0, headroomBytes = 0 } = {}) {
  return Math.max(0, Math.round(ds4ModelBytes + headroomBytes));
}

/**
 * Whether the box has reclaimed enough RAM to safely spawn ds4.
 * @param {object} params
 * @param {number} [params.memAvailableBytes=0] Current MemAvailable.
 * @param {number} [params.targetBytes=0]        Result of reclaimTargetBytes().
 * @returns {boolean}
 */
export function reclaimSatisfied({ memAvailableBytes = 0, targetBytes = 0 } = {}) {
  return memAvailableBytes >= targetBytes;
}

/**
 * Poll MemAvailable until it reaches `targetBytes` or a timeout elapses. Side-effect free
 * except for the injected `readMemAvailable`/`sleep`; the clock is injectable so the loop is
 * deterministically testable. NEVER spawns ds4 itself — the caller only proceeds on { ok:true }.
 * @param {object} params
 * @param {() => (number|Promise<number>)} params.readMemAvailable Reads current MemAvailable (bytes).
 * @param {number} params.targetBytes        Bytes that must be free (reclaimTargetBytes()).
 * @param {number} [params.timeoutMs=120000] Give up after this long.
 * @param {number} [params.intervalMs=1000]  Delay between polls.
 * @param {(ms:number)=>Promise<void>} [params.sleep] Delay function (injectable for tests).
 * @param {() => number} [params.now]         Clock (injectable for tests).
 * @returns {Promise<{ok:boolean, memAvailableBytes:number, waitedMs:number, polls:number}>}
 */
export async function pollForReclaim({
  readMemAvailable,
  targetBytes,
  timeoutMs = 120000,
  intervalMs = 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const start = now();
  let mem = await readMemAvailable();
  let polls = 1;
  while (!reclaimSatisfied({ memAvailableBytes: mem, targetBytes })) {
    const waited = now() - start;
    if (waited >= timeoutMs) return { ok: false, memAvailableBytes: mem, waitedMs: waited, polls };
    await sleep(intervalMs);
    mem = await readMemAvailable();
    polls++;
  }
  return { ok: true, memAvailableBytes: mem, waitedMs: now() - start, polls };
}

/**
 * Whether the small embedding server (~5GB) may stay resident alongside ds4. Only when the
 * operator allows it AND its footprint fits the memory budget (ds4 weights + embed + headroom
 * within total RAM). Unknown total RAM falls back to honoring the flag.
 * @param {object} params
 * @param {boolean} [params.allowEmbedServer=true] Operator flag (config.ds4.allowEmbedServer).
 * @param {number} [params.ds4ModelBytes=0]        On-disk ds4 weights.
 * @param {number} [params.embedServerBytes=0]     Approx resident footprint of the embed server.
 * @param {number} [params.totalBytes=0]           MemTotal (0 = unknown).
 * @param {number} [params.headroomBytes=0]        Guard headroom.
 * @returns {boolean}
 */
export function shouldKeepEmbedServer({
  allowEmbedServer = true,
  ds4ModelBytes = 0,
  embedServerBytes = 0,
  totalBytes = 0,
  headroomBytes = 0,
} = {}) {
  if (!allowEmbedServer) return false;
  if (!totalBytes) return true; // unknown total -> honor the flag
  return ds4ModelBytes + embedServerBytes + headroomBytes <= totalBytes;
}

/**
 * OpenAI-style error body for a request rejected because the box is in exclusive DS4 mode
 * and no offload backend can serve the requested model. Returned with HTTP 503.
 * @param {string} requestedModel The model the client asked for.
 * @param {string} [ds4ModelName] The ds4 model currently served (for the message).
 * @returns {{error:{message:string,type:string,code:string,param:string}}}
 */
export function ds4Exclusive503Body(requestedModel, ds4ModelName) {
  return {
    error: {
      message:
        `This host is in exclusive DS4 mode (serving '${ds4ModelName || 'ds4'}'). ` +
        `The requested model '${requestedModel}' is not served locally and no remote ` +
        `offload backend can serve it. Configure a remote backend (config.backends) that ` +
        `maps '${requestedModel}', or switch the host off DS4 mode.`,
      type: DS4_EXCLUSIVE_ERROR,
      code: DS4_EXCLUSIVE_ERROR,
      param: 'model',
    },
  };
}
