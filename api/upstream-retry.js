// Llama Manager — upstream (llama.cpp router) failure classification + retry plan.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The llama.cpp "router" server (--models-dir) never loads a model itself; it spawns
// a child server per model on demand and proxies to it. WHILE a child is loading it
// answers requests with an HTTP 500 whose body is a proxy error
// ("proxy error: Failed to read connection" / "Could not establish connection").
//
// The crucial distinction this module encodes:
//   - A proxy-error 500 means the ROUTER RESPONDED — so the router process is UP and a
//     child is merely still loading. The correct response is to WAIT and retry; the
//     child finishes loading and stays warm. Restarting the router here is actively
//     harmful: it kills the loading child, so large models (e.g. gemma-4-12b+mmproj,
//     gpt-oss-120b) can never finish loading. This was the root cause of the
//     restart-thrash that kept local models offline after the 9784 router upgrade.
//   - A connection error (ECONNREFUSED / "fetch failed") means the router is
//     unreachable — the process may actually be down — so restarting it is correct.
//
// Pure, side-effect-free; unit-tested in upstream-retry.test.js.

const PROXY_MARKERS = [
  'could not establish connection',
  'failed to read connection',
  'failed to write connection',
  'proxy error:'
];
const CONN_MARKERS = ['connection refused', 'econnrefused', 'econnreset', 'socket hang up'];

/**
 * Classify an upstream failure as a transient router proxy error (child loading),
 * a connection error (router unreachable), or some other error (do not retry).
 *
 * @param {object} a
 * @param {number} [a.status] HTTP status of the upstream response, if any.
 * @param {string} [a.text] Response body text, if any.
 * @param {string} [a.errorCode] Node error code (err.code / err.cause.code), if a throw.
 * @param {string} [a.errorMessage] Error message, if a throw.
 * @returns {{kind:'proxy'|'connection'|'other'}}
 */
export function classifyUpstreamFailure({ status, text, errorCode, errorMessage } = {}) {
  const lower = `${text || ''} ${errorMessage || ''}`.toLowerCase();
  const code = (errorCode || '').toUpperCase();
  // A thrown connection error: can't reach the router at all.
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' ||
      errorMessage === 'fetch failed' || CONN_MARKERS.some(m => lower.includes(m))) {
    // "could not establish connection" is emitted by the router (status 500) when a
    // child isn't up yet — that's a proxy error, not a dead router. Only treat it as
    // a connection error when it came from a throw (no status), not a 500 body.
    if (status === 500 && lower.includes('could not establish connection')) return { kind: 'proxy' };
    return { kind: 'connection' };
  }
  if (status === 500 && PROXY_MARKERS.some(m => lower.includes(m))) return { kind: 'proxy' };
  return { kind: 'other' };
}

/**
 * Decide what to do on an upstream failure: wait+retry, restart the router, or fail.
 *
 * Proxy errors (router up, child loading) NEVER restart and wait with a growing,
 * capped delay so a slow first load (a big multimodal model) has time. Connection
 * errors (router down) restart after the first retry, once per request.
 *
 * @param {object} a
 * @param {'proxy'|'connection'} a.kind
 * @param {number} a.attempt Zero-based attempt index.
 * @param {number} a.retries Max retries (attempt === retries ⇒ give up).
 * @param {number} [a.baseDelayMs]
 * @param {number} [a.maxDelayMs]
 * @param {boolean} [a.alreadyRestarted] True if the router was already restarted this request.
 * @returns {{action:'retry'|'fail', restart:boolean, delayMs:number, reason:string}}
 */
export function upstreamRetryPlan({
  kind, attempt, retries,
  baseDelayMs = 2000, maxDelayMs = 12000, alreadyRestarted = false
} = {}) {
  if (attempt >= retries) {
    return { action: 'fail', restart: false, delayMs: 0, reason: 'budget-exhausted' };
  }
  if (kind === 'proxy') {
    // Router is up, a child is loading — wait and retry, never restart.
    const delayMs = Math.min(baseDelayMs * (attempt + 1), maxDelayMs);
    return { action: 'retry', restart: false, delayMs, reason: 'child-loading' };
  }
  // connection error: router unreachable.
  if (attempt >= 1 && !alreadyRestarted) {
    return { action: 'retry', restart: true, delayMs: 0, reason: 'router-down-restart' };
  }
  return { action: 'retry', restart: false, delayMs: baseDelayMs, reason: 'router-down-wait' };
}
