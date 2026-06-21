// Llama Manager — leaked queue-slot reaper (pure decision logic).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The local RequestQueue serializes inference to a small concurrency. A request
// that acquires a slot but never releases it (handler died, abort/disconnect
// path that didn't fire the res lifecycle release) permanently consumes a slot,
// blocking ALL local dispatch until the manager restarts. This module decides
// which held slots are leaked and should be force-released. It is pure so the
// stall watchdog can call it and unit tests can pin the policy.

/**
 * Decide which held queue slots are leaked and should be force-released.
 *
 * Two cases:
 *  - Chat slots carry an `activeReqId`. They are a DEFINITIVE leak the moment
 *    their backing activeRequest is gone (the request is over but the slot was
 *    never released). These are reaped after a short `graceMs` — just enough to
 *    avoid racing a release that is about to fire in normal completion.
 *  - Non-chat slots (completions/responses/messages) have `activeReqId == null`,
 *    so a missing activeRequest can't distinguish a leak from a legitimately long
 *    prompt-processing phase. These are only reaped at the generous `hardCapMs`.
 *
 * @param {object} a
 * @param {Array<{id:number, activeReqId?:(string|number|null), startedAt?:number, enqueuedAt?:number}>} a.items
 *        Held queue items (e.g. [...llamaQueue.activeItems.values()]).
 * @param {Set} a.liveReqIds Ids of activeRequests that still exist.
 * @param {number} a.now Current epoch ms.
 * @param {number} a.graceMs Short grace before reaping a definitive chat leak.
 * @param {number} a.hardCapMs Hard cap before reaping an ambiguous non-chat slot.
 * @returns {number[]} Slot ids to force-release.
 */
export function findLeakedSlots({ items, liveReqIds, now, graceMs, hardCapMs }) {
  const live = liveReqIds || new Set();
  const out = [];
  for (const it of (items || [])) {
    const heldFor = now - (it.startedAt || it.enqueuedAt || now);
    if (it.activeReqId != null) {
      // Chat slot: definitive leak iff its activeRequest is gone.
      if (live.has(it.activeReqId)) continue; // still tracked -> alive, keep
      if (heldFor < graceMs) continue;        // brief grace to avoid release race
    } else {
      // Ambiguous slot: only reap at the hard cap.
      if (heldFor < hardCapMs) continue;
    }
    out.push(it.id);
  }
  return out;
}
