// Llama Manager — the decision that turns a pending GPU reservation into a held one.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// A reservation is granted the instant a card is free enough to bind, but the card is not
// the holder's yet: llama-manager may still have models resident on it and requests in
// flight against them. This module decides, for one pending reservation, what has to
// happen before the card can honestly be called held — which resident models move to a
// peer, which ones park, which engine children stop, and whether the card is clear right
// now. It performs none of that: the caller does the offloading, parking and killing and
// calls back until the plan reports ready, then marks the reservation held.
//
// The rule that matters is that a model with nowhere else to go is QUEUED, never refused.
// A request already in the system must survive a card being taken away, exactly as it
// survives an engine mode swap today; answering it with a 404 or a 503 because an
// unrelated agent wanted a GPU would make the reservation mechanism a denial of service
// against llama-manager's own callers. Offloading is therefore an optimisation available
// only when a peer can actually serve the model, and parking is the floor.
//
// Pure and I/O-free, so the drain decision is testable on a one-GPU box with no engine
// running: whether a peer can serve a model is resolved by the caller (server.js consults
// findFastestAvailableBackend) and handed in as a plain boolean.

/**
 * Decide what must happen before a pending reservation's card can be marked held.
 *
 * `hasViableRemote` is treated as false when absent rather than unknown-therefore-routable:
 * a model wrongly believed to be servable elsewhere would have its requests sent to a peer
 * that cannot answer them, whereas a model wrongly parked only waits.
 *
 * @param {object} [params]
 * @param {Array<{id?: string, hasViableRemote?: boolean, inFlight?: number}>} [params.models]
 *   Models currently resident on the card being drained. Entries without a usable id are
 *   skipped rather than throwing — a drain half-executed because of one malformed entry
 *   would leave the card in neither state.
 * @param {Array<string|{label?: string}>} [params.children] Engine processes bound to the
 *   card that must exit before the holder can use it.
 * @param {number} [params.inFlight] Requests in flight against the card that are not
 *   attributed to any one resident model, e.g. the local queue's active count.
 * @returns {{offload: string[], queue: string[], stop: Array<string|object>, ready: boolean,
 *   reason: string}} `offload` names models a peer can serve, `queue` names models that must
 *   park, `stop` names children to kill, `ready` is true only when the card is clear right
 *   now, and `reason` says why in operator-readable terms.
 */
export function drainPlan({ models = [], children = [], inFlight = 0 } = {}) {
  const resident = (Array.isArray(models) ? models : [])
    .filter((model) => model && typeof model === 'object' && typeof model.id === 'string' && model.id.trim());
  const stop = (Array.isArray(children) ? children : []).filter(Boolean);

  const offload = resident.filter((model) => model.hasViableRemote === true).map((model) => model.id);
  const queue = resident.filter((model) => model.hasViableRemote !== true).map((model) => model.id);

  const busy = resident.reduce(
    (total, model) => total + (Number.isFinite(model.inFlight) ? model.inFlight : 0),
    Number.isFinite(inFlight) ? inFlight : 0,
  );

  if (resident.length === 0 && stop.length === 0 && busy === 0) {
    return { offload, queue, stop, ready: true, reason: 'nothing of llama-manager\'s is on this card' };
  }

  // Every remaining clause is a reason the card is NOT yet the holder's. They are reported
  // together rather than first-match, because an operator watching a drain that is taking
  // too long needs to see everything still holding it, not the first thing.
  const blockers = [];
  if (offload.length) blockers.push(`offloading ${offload.join(', ')} to a peer`);
  if (queue.length) blockers.push(`parking requests for ${queue.join(', ')}`);
  if (stop.length) blockers.push(`stopping ${stop.map((child) => (typeof child === 'string' ? child : child.label ?? 'an engine child')).join(', ')}`);
  if (busy) blockers.push(`${busy} request${busy === 1 ? '' : 's'} still in flight`);

  return { offload, queue, stop, ready: false, reason: blockers.join('; ') };
}

/**
 * Which pending reservations have been handed a card but have no drain running.
 *
 * A claim granted by a route handler gets its drain started by that handler. A claim that
 * had to QUEUE is different: the state machine promotes it from the waiting list when
 * capacity frees — inside `release()`, `sweep()` or `setPools()` — binding a card to a
 * record that stays `pending`. No route observes that, so nothing starts its drain and
 * nothing ever calls `markHeld`. The claim then occupies the card, without ever becoming
 * usable, until its TTL expires; `wait` returns 408 the whole time.
 *
 * The promotion cannot start its own drain, because it happens inside a state-machine
 * transaction and re-entering `gpuReservations` from there double-books the card (observed
 * live, and recorded above the `onPreempt` callback in api/server.js). So the sweep timer
 * — already the established place for exactly this "outside any transaction" work — asks
 * this function what it missed.
 *
 * @param {?Array<object>} reservations Reservation records, as `GpuReservations#list`
 *   returns them. A nullish or ragged list yields an empty result rather than throwing:
 *   this runs on a timer, and an exception would stop TTL expiry for every pool.
 * @param {Set<string>} inFlight Ids whose drain is already running. Starting a second
 *   drain for one races the first over stopping the engine child.
 * @returns {string[]} Reservation ids needing a drain, in the order given.
 */
export function reservationsNeedingDrain(reservations, inFlight) {
  if (!Array.isArray(reservations)) return [];
  const running = inFlight instanceof Set ? inFlight : new Set();
  return reservations
    .filter((r) => r && r.state === 'pending' && r.card && !running.has(r.id))
    .map((r) => r.id);
}
