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
// swap-recovery retry re-acquiring for a fresh attempt).

import { PriorityRequestQueue } from './request-queue.js';

/** Single-generation admission queue for the local ds4-server engine. */
export const ds4Queue = new PriorityRequestQueue(1);

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
