// Llama Manager — Pods idle-worker release client.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Asks the Pods (Local Runpod Provider) coordinator to stop the idle worker
// containers on this host's node, so their RAM can go to the LLM engine. Idle Pods
// workers held 6-36 GiB each on drakemore on 2026-10-31 while Strata could not
// load. Off unless config.podsRelease is enabled and complete and the coordinator
// key is in the PODS_API_KEY environment variable (never in config.json). One
// request per 5 minutes; a failed or refused call is reported, never thrown, and
// the key never appears in the result. The coordinator only releases workers it
// and the node agree are idle (docs/Designs/ResourceArbiter.md section 2).

const COOLDOWN_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/**
 * Request the release of this node's idle Pods workers.
 * @param {object} p
 * @param {object} p.config manager config; reads `podsRelease {enabled, coordinatorUrl, nodeId, minIdleSec}`.
 * @param {object} p.env environment; reads `PODS_API_KEY`.
 * @param {string} p.reason why the memory is needed (sent to the coordinator log).
 * @param {typeof fetch} p.fetchFn fetch implementation.
 * @param {{lastAt?: number}} p.state caller-owned rate-limit state, updated in place.
 * @param {number} p.now clock (ms).
 * @returns {Promise<{sent: boolean, released: string[], detail: string}>} whether a request went out,
 *   the worker ids the coordinator queued for release, and a log-safe description.
 */
export async function requestPodsIdleRelease({ config, env, reason, fetchFn, state, now }) {
  const c = config?.podsRelease ?? {};
  const key = env?.PODS_API_KEY;
  if (!c.enabled || !c.coordinatorUrl || !c.nodeId || !key) {
    return { sent: false, released: [], detail: 'podsRelease disabled or incomplete' };
  }
  if (state.lastAt != null && now - state.lastAt < COOLDOWN_MS) {
    return { sent: false, released: [], detail: 'cooldown' };
  }
  state.lastAt = now;
  const url = `${String(c.coordinatorUrl).replace(/\/+$/, '')}/api/v1/nodes/${encodeURIComponent(c.nodeId)}/release-idle-workers`;
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ min_idle_seconds: c.minIdleSec ?? 600, reason: String(reason).slice(0, 200) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return { sent: true, released: [], detail: `coordinator answered ${r.status}` };
    const released = (await r.json())?.released ?? [];
    return { sent: true, released, detail: released.length ? `released ${released.join(', ')}` : 'no idle workers to release' };
  } catch (err) {
    return { sent: true, released: [], detail: `request failed: ${err.name}` };
  }
}
