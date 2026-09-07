// Llama Manager — "exclusive duo mode" decision helpers (two-model budget + mutual eviction with ds4).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Duo mode runs a Qwen3.8-Flash-Next planner (81.96 GB) beside a Qwen3.6-35B-A3B worker
// (22.36 GB) and keeps BOTH resident, so a plan -> execute -> review handoff costs a
// request rather than a model reload. That is the whole point of the mode: the technique
// it reproduces pays roughly 25 s per handoff precisely because its author cannot hold
// the pair in memory at once.
//
// The consequence is that duo is exclusive in the same way ds4 is, and for the same
// reason: ~104 GB of weights plus KV on a 124 GB box leaves no room for anything else.
// Duo and ds4 are therefore peers that evict each other — selecting duo stops ds4,
// selecting ds4 stops duo — and neither is privileged over the other.
//
// This module differs from ds4-exclusive.js in exactly one substantive way: the memory
// budget sums a PAIR of models, not one. Everything else it can share, so the reclaim
// poll (pollForReclaim), the satisfaction check (reclaimSatisfied) and the tolerant name
// matcher (ds4ModelMatches) are reused from that module rather than duplicated here.
//
// Pure and side-effect-free; the caller supplies live memory figures and performs the
// stopping and spawning. Unit-tested in duo-exclusive.test.js.

import { ds4ModelMatches, reclaimTargetBytes } from './ds4-exclusive.js';

/** OpenAI-style error `type`/`code` returned when the box is in exclusive duo mode. */
export const DUO_EXCLUSIVE_ERROR = 'exclusive_duo_mode';

/** Model directory id of the planner/reviewer half — the slow one that thinks. */
export const DUO_PLANNER_ID = 'unsloth_Qwen3.8-Flash-Next-GGUF';

/** Model directory id of the worker half — the fast one that follows exact steps. */
export const DUO_WORKER_ID = 'unsloth_Qwen3.6-35B-A3B-GGUF';

/**
 * The model ids duo serves locally. Both halves stay resident, so both are "ours".
 * @returns {string[]} Planner and worker ids.
 */
export function duoModelIds() {
  return [DUO_PLANNER_ID, DUO_WORKER_ID];
}

/**
 * MemAvailable (bytes) the box must reach before duo may be spawned.
 *
 * This is the one place duo genuinely differs from single-model exclusivity: it must
 * account for BOTH sets of weights plus both KV caches, because the mode is defined by
 * keeping them resident together. Delegates the clamp/round to reclaimTargetBytes so the
 * arithmetic matches ds4's exactly and the two modes cannot drift apart.
 *
 * @param {object} params
 * @param {number} [params.plannerBytes=0]  On-disk size of the planner weights (summed shards).
 * @param {number} [params.workerBytes=0]   On-disk size of the worker weights.
 * @param {number} [params.kvBytes=0]       Combined KV cache allowance for both models.
 * @param {number} [params.headroomBytes=0] Guard headroom to keep free above all of it.
 * @returns {number} Bytes that must be available, never negative.
 */
export function duoBudgetBytes({
  plannerBytes = 0, workerBytes = 0, kvBytes = 0, headroomBytes = 0,
} = {}) {
  return reclaimTargetBytes({
    ds4ModelBytes: plannerBytes + workerBytes,
    headroomBytes: kvBytes + headroomBytes,
  });
}

/**
 * Where a request should go while duo mode is active.
 *
 * Either half of the pair is served locally. Anything else is offloaded to a remote
 * backend when one can serve it, and otherwise rejected with a clear error — never
 * queued indefinitely and never loaded locally beside duo, which would evict one of the
 * two models the mode exists to keep hot.
 *
 * @param {object} params
 * @param {string} params.requestedModel        Resolved model name from the request.
 * @param {string[]} [params.duoModelIds]       Names mapping to the local duo pair.
 * @param {boolean} [params.hasViableRemote]    Whether a remote backend can serve it.
 * @returns {{target:'local-duo'|'remote'|'reject', reason:string}} Routing decision.
 */
export function duoRequestTarget({
  requestedModel, duoModelIds: ids = duoModelIds(), hasViableRemote = false,
} = {}) {
  if (ds4ModelMatches(requestedModel, ids)) return { target: 'local-duo', reason: 'duo-model' };
  if (hasViableRemote) return { target: 'remote', reason: 'offload' };
  return { target: 'reject', reason: 'exclusive-duo-no-backend' };
}

/**
 * Resolve the mutual exclusion between duo and ds4 when one of them is selected.
 *
 * They are peers, not a hierarchy: each evicts the other, and selecting whichever is
 * already active is a no-op rather than a needless stop/start of an 80 GB model.
 *
 * @param {object} params
 * @param {'duo'|'ds4'} params.selecting   The mode being switched to.
 * @param {boolean} [params.ds4Active]     Whether ds4 is resident now.
 * @param {boolean} [params.duoActive]     Whether duo is resident now.
 * @returns {{evict:'duo'|'ds4'|null, reason:string}} What to stop before spawning.
 */
export function duoVsDs4Decision({ selecting, ds4Active = false, duoActive = false } = {}) {
  if (selecting === 'duo') {
    if (duoActive) return { evict: null, reason: 'duo-already-active' };
    return ds4Active
      ? { evict: 'ds4', reason: 'duo-selected-evicts-ds4' }
      : { evict: null, reason: 'nothing-resident' };
  }
  if (selecting === 'ds4') {
    if (ds4Active) return { evict: null, reason: 'ds4-already-active' };
    return duoActive
      ? { evict: 'duo', reason: 'ds4-selected-evicts-duo' }
      : { evict: null, reason: 'nothing-resident' };
  }
  return { evict: null, reason: 'unknown-selection' };
}
