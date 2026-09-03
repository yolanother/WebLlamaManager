// Llama Manager — router-side "is my forwarded request merely queued?" logic.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// A router node (Frostburn) that offloads `default-big` to a provider node
// (Drakemore) sees exactly one thing while the provider serializes ds4 work
// through its single generation slot: silence. Zero tokens. Both of the
// router's give-up clocks — the stall watchdog's remote ceiling and
// fetchRemoteBackend's per-attempt deadline — read that silence as "the remote
// is wedged" and tear the request down, after which the client retries and
// lands at the BACK of the provider's ds4 queue. Repeat often enough and a
// perfectly healthy dispatch starves: observed live as a TTS request whose
// downstream id walked 15 -> 18 -> 21 with no agent progress in between.
//
// Silence is not evidence of a wedge, and the provider already knows the
// difference: its /api/queue reports our request as `pending` while it waits
// for the ds4 slot and `active` once it owns it (see activeRequestHoldsSlot in
// slot-reaper.js). This module carries a request id across the hop so the
// router can ASK, and turns the answer into a decision:
//
//   - provider says `pending`  -> the request is queued, not stalled: extend.
//   - provider says `active`   -> it owns the slot; the normal ceiling applies
//                                from here (the provider's own zero-token
//                                ceiling bounds it on that side).
//   - unreachable / not found  -> no evidence: keep the existing behaviour.
//
// Extension is capped (DOWNSTREAM_QUEUE_WAIT_CAP_MS) so a provider that reports
// `pending` forever — its queue wedged rather than draining — cannot pin a
// router request open indefinitely.

/** Header carrying the fleet-wide id of a relayed request across one hop. */
export const RELAY_REQUEST_ID_HEADER = 'x-llama-manager-request-id';

/**
 * Longest total time a router will keep extending a request purely because the
 * provider reports it as queued.
 *
 * The provider's ds4 slot holder is itself bounded (DS4_ZERO_TOKEN_STALL_MS,
 * 8 min) and ds4 concurrency is 1, so a queue a few deep drains well inside
 * this. 30 minutes therefore only trips when the provider's queue is not
 * draining at all — the one case where believing its "pending" answer would be
 * wrong.
 */
export const DOWNSTREAM_QUEUE_WAIT_CAP_MS = 1_800_000;

/** Timeout for the provider queue probe itself — a status read, not inference. */
export const QUEUE_PROBE_TIMEOUT_MS = 5_000;

/** Strip characters that cannot legally travel in an HTTP header value. */
function headerSafe(value) {
  return String(value == null ? '' : value).replace(/[^\x21-\x7e]/g, '').slice(0, 200);
}

/**
 * Stable id for one request as it crosses manager hops.
 *
 * Derived from the node that minted it, that node's activeRequests key, and the
 * mint time: unique per fleet request without a random source, reproducible
 * from the router's own logs when correlating with the provider's queue, and
 * not reusable by a later request after the router restarts and its
 * activeRequests counter starts over.
 *
 * @param {string} nodeId Minting node's id.
 * @param {number|string} activeReqId Its activeRequests key for this request.
 * @param {number} [mintedAt] Epoch ms the id was minted.
 * @returns {string} Header-safe relay request id.
 */
export function relayRequestIdFor(nodeId, activeReqId, mintedAt = Date.now()) {
  return `${headerSafe(nodeId) || 'node'}:${headerSafe(activeReqId)}:${Number(mintedAt).toString(36)}`;
}

/**
 * Read the relay request id off an inbound request's headers.
 *
 * A provider stores this on its activeRequests entry and echoes it in
 * /api/queue, which is what lets the router find its own request over there.
 *
 * @param {object} headers Inbound headers (lower-cased keys, as Node supplies).
 * @returns {string|null} The id, or null when the request did not come from a manager.
 */
export function readRelayRequestId(headers = {}) {
  const raw = headers?.[RELAY_REQUEST_ID_HEADER];
  const id = headerSafe(Array.isArray(raw) ? raw[0] : raw).trim();
  return id || null;
}

/**
 * Manager queue URL for a configured backend.
 *
 * `backend.url` points at the OpenAI-compatible base (…/v1 on a manager, or
 * some third-party host). /api/queue is served from the origin root of a
 * manager, so derive it from the origin and let a non-manager backend simply
 * fail the probe — an unparseable or non-HTTP url yields null rather than a
 * guess.
 *
 * @param {string} backendUrl Configured backend base url.
 * @returns {string|null} Absolute /api/queue url, or null when it cannot be derived.
 */
export function downstreamQueueUrl(backendUrl) {
  try {
    const parsed = new URL(String(backendUrl));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/api/queue`;
  } catch {
    return null;
  }
}

/**
 * Find our forwarded request in a provider's /api/queue payload.
 *
 * A provider that re-served the request internally (its ds4 swap-recovery
 * retry) can briefly report two entries carrying the same id. The newest one is
 * the live attempt, so break ties on enqueue time rather than reading a stale
 * entry's status.
 *
 * @param {{items?:Array<object>}} payload Parsed /api/queue body.
 * @param {string} relayRequestId Id we sent on the forwarded request.
 * @returns {object|null} The matching queue item, or null.
 */
export function findRelayedQueueItem(payload, relayRequestId) {
  if (!relayRequestId) return null;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const matches = items.filter((item) => item?.relayRequestId === relayRequestId);
  if (matches.length <= 1) return matches[0] || null;
  return matches.reduce((newest, item) => (
    (item.enqueuedAt || 0) >= (newest.enqueuedAt || 0) ? item : newest
  ));
}

/**
 * Decide whether a silent forwarded request should be kept alive.
 *
 * @param {object} p
 * @param {object|null} p.item Provider queue item for our request, if found.
 * @param {number|null} [p.waitingSince] When we FIRST saw it queued (epoch ms); null on the first look.
 * @param {number} p.now Epoch ms.
 * @param {number} [p.capMs] Ceiling on total queued-wait extension.
 * @returns {{extend:boolean, reason:string}}
 */
export function downstreamWaitDecision({ item, waitingSince = null, now, capMs = DOWNSTREAM_QUEUE_WAIT_CAP_MS }) {
  if (!item) {
    return { extend: false, reason: 'provider does not report this request — no evidence it is queued' };
  }
  if (item.status !== 'pending') {
    return { extend: false, reason: `provider reports status=${item.status} — it owns the generation slot, so the normal ceiling applies` };
  }
  const waitedMs = waitingSince == null ? 0 : now - waitingSince;
  if (waitedMs >= capMs) {
    return {
      extend: false,
      reason: `provider has reported it queued for ${Math.round(waitedMs / 1000)}s (cap ${Math.round(capMs / 1000)}s) — its queue is not draining`,
    };
  }
  const behind = item.queuePosition ? ` (position ${item.queuePosition})` : '';
  return { extend: true, reason: `provider reports it still queued${behind}, not generating` };
}

/**
 * Ask a provider whether it currently holds our forwarded request queued.
 *
 * Never throws: an unreachable, slow, or non-manager backend resolves to
 * `{ reachable: false }`, which callers treat as "no evidence" and fall back to
 * their existing timeout behaviour.
 *
 * @param {object} p
 * @param {string} p.backendUrl Configured backend base url.
 * @param {string} p.relayRequestId Id we sent on the forwarded request.
 * @param {Function} [p.fetchImpl] Injectable fetch.
 * @param {number} [p.timeoutMs] Probe timeout.
 * @returns {Promise<{reachable:boolean, item:object|null, error?:string}>}
 */
export async function probeDownstreamQueue({ backendUrl, relayRequestId, fetchImpl = fetch, timeoutMs = QUEUE_PROBE_TIMEOUT_MS }) {
  const url = downstreamQueueUrl(backendUrl);
  if (!url || !relayRequestId) return { reachable: false, item: null, error: 'no queue url or relay id' };
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { reachable: false, item: null, error: `HTTP ${response.status}` };
    const payload = await response.json();
    return { reachable: true, item: findRelayedQueueItem(payload, relayRequestId) };
  } catch (err) {
    return { reachable: false, item: null, error: err?.message || String(err) };
  }
}

/**
 * A timeout that can be renewed instead of firing, for a deadline that should
 * only apply to time the far side is actually working.
 *
 * `onExpire` runs when the window elapses and may be async; resolving true arms
 * another full window, false fires `onTimeout`. Cancelling is idempotent and
 * suppresses a decision that is already in flight, so a response that arrives
 * while we are mid-probe cannot be aborted from under the caller.
 *
 * @param {object} p
 * @param {number} p.timeoutMs Length of each window.
 * @param {() => (boolean|Promise<boolean>)} p.onExpire Renew decision.
 * @param {Function} p.onTimeout Called once when a window expires without renewal.
 * @param {Function} [p.setTimeoutFn] Injectable timer (tests).
 * @param {Function} [p.clearTimeoutFn] Injectable timer clear (tests).
 * @returns {{cancel:Function, renewals:() => number}}
 */
export function createExtendableDeadline({
  timeoutMs, onExpire, onTimeout, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) {
  let cancelled = false;
  let renewals = 0;
  let timer = null;
  const arm = () => {
    timer = setTimeoutFn(async () => {
      if (cancelled) return;
      let renew = false;
      try {
        renew = await onExpire();
      } catch {
        renew = false; // a failed check is not evidence; fall back to timing out
      }
      if (cancelled) return;
      if (renew) {
        renewals++;
        arm();
        return;
      }
      onTimeout();
    }, timeoutMs);
  };
  arm();
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeoutFn(timer);
    },
    renewals: () => renewals,
  };
}
