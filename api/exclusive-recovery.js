// Llama Manager — exclusive-engine `exhausted` self-recovery policy.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// An exclusive engine (Strata) whose activation ladder failed sits in runtime status
// `exhausted`, answering 503 to every local request. That status used to be sticky
// until a human re-activated the preset: drakemore stayed down 2026-10-19 -> 10-31.
// This pure policy turns it into a bounded retry loop: the first retry one minute after
// the failure, each later wait doubling up to a 30-minute cap, forever, so the engine
// comes back on its own once memory or the GPU frees up. `ready` clears the state;
// loading/swapping (a retry in flight) and `stop-unconfirmed` (a wedged process a new
// spawn cannot fix) never retry. The caller owns the timer and the activation call.

const BASE_MS = 60_000;
const MAX_MS = 30 * 60_000;

/**
 * @param {{status:(string|undefined), state:(object|null), now:number, reason?:string}} p the
 *   engine runtime status, the previous recovery state (null when healthy), the clock, and
 *   the runtime's failure reason.
 * @returns {{action:'wait'|'retry'|'reset'|'idle', state:(object|null)}} what to do and the
 *   next state `{since, attempts, nextAt, lastReason}`.
 */
export function exclusiveRecoveryDecision({ status, state, now, reason = null }) {
  if (status === 'ready') return { action: 'reset', state: null };
  if (status !== 'exhausted') return { action: 'idle', state };
  if (!state) return { action: 'wait', state: { since: now, attempts: 0, nextAt: now + BASE_MS, lastReason: reason } };
  if (now < state.nextAt) return { action: 'wait', state };
  const attempts = state.attempts + 1;
  return {
    action: 'retry',
    state: { ...state, attempts, nextAt: now + Math.min(BASE_MS * 2 ** attempts, MAX_MS), lastReason: reason ?? state.lastReason },
  };
}
