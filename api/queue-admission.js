// Llama Manager — local-queue admission policy (don't fail requests just because the queue is busy).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The local llama.cpp queue used to reject any request once its backlog reached a fixed
// depth (pending >= 8 -> 503 QUEUE_FULL). That crude cap protected against a wedged/stuck
// model accumulating an unbounded pile-up, but it also FAILED perfectly healthy requests
// during normal busy operation when the queue was simply deep and still draining.
//
// This module replaces the fixed count with a smarter, side-effect-free decision:
//   1. Below the soft cap  -> accept.
//   2. At/over the soft cap AND a viable remote exists -> OFFLOAD (route to remote instead
//      of piling onto a deep local queue). Offloading is always preferred over rejecting.
//   3. At/over the soft cap with NO remote (e.g. gpt-oss-120b, which can't offload) -> queue
//      DEEPER rather than fail. Reject only as a LAST RESORT when the model is genuinely
//      STUCK — the queue is deep AND not draining (no local completion within stallMs while
//      requests keep piling up). A deep-but-DRAINING queue is allowed to grow: requests wait,
//      they don't fail. This preserves the original anti-pile-up-on-a-wedged-model intent via
//      stall detection instead of a fixed count.
//   4. An absolute hard ceiling (a few hundred) is a final runaway backstop, well above normal
//      operation, that rejects even a draining local queue.
//
// Pure and unit-tested in queue-admission.test.js. The caller (server.js) supplies live queue
// depth/active counts, whether a viable remote exists for the request, and how long it's been
// since the last LOCAL completion (used to distinguish "draining" from "stalled/wedged").

/** Default soft queue depth: at/over this we offload (if remote) or start stall-checking. */
export const DEFAULT_MAX_QUEUE_DEPTH = 32;

/** Default absolute runaway backstop for the local queue — reject beyond this no matter what. */
export const DEFAULT_HARD_MAX = 256;

/** Default "not draining" window: no local completion within this long => the model is stalled. */
export const DEFAULT_STALL_MS = 60_000;

/**
 * Decide whether an incoming local request should be accepted onto the queue, offloaded to a
 * remote backend, or rejected.
 *
 * @param {object} params
 * @param {number} params.pending                     Current local queue depth (requests waiting).
 * @param {number} [params.active=0]                  Requests currently being served locally.
 * @param {boolean} [params.hasViableRemote=false]    True if a remote backend can serve this request.
 * @param {number} [params.maxQueueDepth]             Soft cap; at/over it we offload or stall-check.
 * @param {number} [params.hardMax]                   Absolute runaway backstop (reject beyond this).
 * @param {number} [params.msSinceLastCompletion=0]   Time since the last LOCAL completion (ms).
 * @param {number} [params.stallMs]                   No-completion window that marks the model stalled.
 * @returns {{action:'accept'|'offload'|'reject', reason:string}} action to take; reason is a short
 *          machine/log tag ('under-cap' | 'overflow-offload' | 'hard-ceiling' | 'stalled' | 'deep-draining').
 */
export function queueAdmissionDecision({
  pending,
  active = 0,
  hasViableRemote = false,
  maxQueueDepth = DEFAULT_MAX_QUEUE_DEPTH,
  hardMax = DEFAULT_HARD_MAX,
  msSinceLastCompletion = 0,
  stallMs = DEFAULT_STALL_MS,
} = {}) {
  // Below the soft cap: normal operation, always accept.
  if (pending < maxQueueDepth) {
    return { action: 'accept', reason: 'under-cap' };
  }

  // Overflow zone (pending >= soft cap).

  // Prefer offloading over queuing deep or rejecting: if a remote can serve this request we
  // never add it to an already-overflowing local queue. This takes precedence over the hard
  // ceiling because offloading doesn't grow the local queue at all.
  if (hasViableRemote) {
    return { action: 'offload', reason: 'overflow-offload' };
  }

  // No remote — the request must run locally (e.g. gpt-oss-120b). Queue deeper, don't fail…

  // …except the absolute runaway backstop: reject beyond the hard ceiling no matter what.
  if (pending >= hardMax) {
    return { action: 'reject', reason: 'hard-ceiling' };
  }

  // Stall detection (preserves the original anti-pile-up-on-a-wedged-model protection): if
  // something is actively being served but nothing has completed within stallMs, the model is
  // wedged/stuck and the growing pile-up won't drain — reject as a last resort.
  if (active > 0 && msSinceLastCompletion >= stallMs) {
    return { action: 'reject', reason: 'stalled' };
  }

  // Deep but draining (or nothing active yet) — let the queue grow; requests wait, they don't fail.
  return { action: 'accept', reason: 'deep-draining' };
}
