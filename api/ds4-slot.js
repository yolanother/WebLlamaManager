// Llama Manager — ds4-server single-generation admission slot.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// ds4-server serializes to one concurrent generation on the shared GPU, but the
// chat/completions, completions, and responses proxy handlers in server.js each
// fired straight at it with no admission control — concurrent requests piled up
// and starved each other, matching the reported symptom (requests stuck at zero
// reported tokens, disappearing and retrying, while /api/queue showed multiple
// "active" ds4 items at once). ds4Queue and acquireDs4Slot gate every ds4 proxy
// call through the same PriorityRequestQueue used for the local llama.cpp lane,
// and guarantee the slot is released exactly once no matter how the response
// ends (normal completion, upstream error, client disconnect, or a
// swap-recovery retry re-acquiring for a fresh attempt). A grant observer marks
// the exact transition from queue waiting to generation so watchdog accounting
// never mistakes another request's slot time for this request's stall time.

import { PriorityRequestQueue } from './request-queue.js';

/** Single-generation admission queue for the local ds4-server engine. */
export const ds4Queue = new PriorityRequestQueue(1);

/** Observer notified the moment a request is granted the ds4 slot. */
let slotGrantedObserver = null;

/**
 * Register a callback fired when a request is GRANTED the ds4 slot (not when it
 * starts waiting for one).
 *
 * The server uses this to stamp `slotAcquiredAt` / reset the stall clock on the
 * activeRequests entry, exactly as acquireLocalSlot does for the llama.cpp lane.
 * Registering it here rather than at each call site means a future ds4 proxy
 * endpoint cannot forget to do it and silently reintroduce "queue wait counts
 * as generation time".
 *
 * @param {((info:{slotId:number, activeReqId:(number|string|null|undefined), model:(string|undefined), endpoint:(string|undefined)}) => void)|null} fn
 */
export function setDs4SlotGrantedObserver(fn) {
  slotGrantedObserver = typeof fn === 'function' ? fn : null;
}

/**
 * Acquire the ds4-server generation slot for the lifetime of one response.
 *
 * Mirrors acquireLocalSlot's release-guarantee: release fires on the
 * response's 'finish' or 'close' event (or immediately if it has already
 * ended by the time we attach), so the slot is freed even if the caller's own
 * cleanup path is skipped — e.g. an exception thrown before a bespoke
 * try/finally, or a client disconnect that happens after headers were sent
 * but before the handler notices.
 *
 * @param {import('express').Response} res Response whose lifecycle releases the slot.
 * @param {{model?:string, endpoint?:string, activeReqId?:number, priority?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<{slotId:number, release:Function}>} Acquired slot id and an idempotent release function.
 * @throws {Error} With `name: 'AbortError'` if `opts.signal` fires while still queued.
 */
export async function acquireDs4Slot(res, { model, endpoint, activeReqId, priority = 'interactive', signal } = {}) {
  const slotId = await ds4Queue.acquire({ model, endpoint, activeReqId, priority, signal });
  // The wait is over and generation is about to start: tell the observer so the
  // request's "active" clock starts here, not when it arrived.
  try { slotGrantedObserver?.({ slotId, activeReqId, model, endpoint }); } catch { /* never fail an acquire on bookkeeping */ }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    ds4Queue.release(slotId);
  };
  res.on('finish', release);
  res.on('close', release);
  if (res.destroyed || res.writableEnded) release();
  return { slotId, release };
}
