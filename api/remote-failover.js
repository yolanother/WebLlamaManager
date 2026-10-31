// Llama Manager — remote-backend failover decision.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Decides what a forwarded request does after a remote backend answers with a
// non-ok status before any byte reached the client: try the next alias member,
// fall back to the local target, or pass the error through. A 503/502/504/429
// means "this backend cannot serve right now" (exclusive engine exhausted,
// proxy gateway error, queue full) — another member may well serve it. Other
// statuses (4xx, 500) would be answered the same way anywhere, so they pass
// through. Pure; the caller re-resolves routing with the failed backend excluded
// and hands the result in as `next`. See remote-failover.test.js.

const FAILOVER_STATUSES = new Set([429, 502, 503, 504]);

/**
 * @param {{status:number, next:(object|null), exclusiveActive?:boolean}} p `status` is the
 *   remote's HTTP status; `next` is resolveBackend()'s routing with the failed backend(s)
 *   excluded (null when not computed); `exclusiveActive` is true while a DS4/Strata engine
 *   owns this box, so there is no llama to fall back to.
 * @returns {{action:'remote'|'local', routing:object}|{action:'pass-through'}} what to do.
 */
export function remoteFailoverDecision({ status, next, exclusiveActive = false }) {
  if (!FAILOVER_STATUSES.has(status) || !next || next.blocked) return { action: 'pass-through' };
  if (next.remote) return { action: 'remote', routing: next };
  if (exclusiveActive) return { action: 'pass-through' };
  return { action: 'local', routing: next };
}
