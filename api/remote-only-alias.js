// Llama Manager — fallback for a remote-only alias that no free remote member can take.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// An alias with no local member (e.g. `default-big` -> Drakemore / Dahaka) has nothing
// the local llama.cpp router can serve: forwarding it locally sends the raw alias name,
// which llama.cpp rejects as 400 "model not found". Callers read that 400 as a permanent
// config error, when the real condition is "every member is busy or tripped right now".
//
// resolveBackend() skips remote members whose queue is full or whose circuit is open and
// falls back to local. For a remote-only alias this decides what happens instead:
//   - some member is reachable but at capacity -> queue on it (its backend queue waits);
//   - no member is reachable                   -> 503 model_unavailable (retryable);
//   - the caller demanded local_only           -> 409 ALIAS_REMOTE_ONLY (never servable).
// Aliases with a local member, and non-alias names, keep the local routing unchanged.
//
// Pure, side-effect-free; unit-tested in remote-only-alias.test.js. server.js supplies the
// reachable members (enabled, tested, circuit closed, endpoint supported, named by the
// alias's ranked tier) with their live queue depth.

/**
 * Decide the routing for a request resolveBackend() was about to serve locally.
 *
 * @param {object} params
 * @param {{name:string, localTarget:(string|null)}|null} params.alias  Resolved alias routing, or null for a literal model.
 * @param {boolean} [params.localOnly]  Caller requires the local lane.
 * @param {Array<{id:string, priority:number, active:number, pending:number}>} params.members
 *   Reachable remote members of the alias, capacity ignored.
 * @returns {{action:'local'}|{action:'queue', backendId:string}|{action:'reject', status:number, code:string, message:string}}
 *   `local` keeps the caller's local routing; `queue` routes to that member even though it
 *   is full; `reject` is the HTTP error to return instead of forwarding the alias locally.
 */
export function remoteOnlyAliasFallback({ alias, localOnly = false, members = [] }) {
  if (!alias || alias.localTarget) return { action: 'local' };
  if (localOnly) {
    return {
      action: 'reject',
      status: 409,
      code: 'ALIAS_REMOTE_ONLY',
      message: `Alias '${alias.name}' has no local member, so it cannot be served with local_only`,
    };
  }
  if (members.length) {
    const load = m => (m.active || 0) + (m.pending || 0);
    const best = [...members].sort((a, b) => load(a) - load(b) || (a.priority ?? 50) - (b.priority ?? 50))[0];
    return { action: 'queue', backendId: best.id };
  }
  return {
    action: 'reject',
    status: 503,
    code: 'model_unavailable',
    message: `No member of alias '${alias.name}' is available right now (all remote members down or tripped); retry later`,
  };
}
