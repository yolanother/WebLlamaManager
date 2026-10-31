// Llama Manager — trust check for writes to the loopback-only config keys.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// POST /api/config accepts `strata` (executables the manager spawns) and
// `podsRelease` only from this machine. A loopback socket is not enough on its own:
// a web page open in a browser on the host can POST cross-origin (CSRF), and a
// DNS-rebinding page reaches 127.0.0.1 under its own host name. configWriteTrusted
// requires a Host that is a local name or an IP literal, and an Origin (when a
// browser sends one) for that same host and port. configUpdateRefusal is the whole
// refusal the route applies (loopback, trust, podsRelease field allowlist). Pure, so it
// is unit-tested.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * @param {string} hostHeader a Host header value (`name[:port]` or `[v6][:port]`).
 * @returns {string} the lowercased host name or IP without port or brackets.
 */
function hostName(hostHeader) {
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.split(':')[0];
}

/**
 * Whether a request may write a loopback-only config key.
 * @param {{host?: string, origin?: string, localNames: string[]}} p the Host and Origin headers,
 *   and the names this machine answers to (localhost, its hostname, hostname.local).
 * @returns {{ok: boolean, reason: string}} the verdict and, when refused, why.
 */
export function configWriteTrusted({ host, origin, localNames }) {
  if (!host) return { ok: false, reason: 'missing Host header' };
  const name = hostName(host);
  const local = localNames.map((n) => n.toLowerCase()).includes(name) || IPV4.test(name) || name.includes(':');
  if (!local) return { ok: false, reason: `Host '${name}' is not a name of this machine` };
  if (origin === undefined) return { ok: true, reason: 'no Origin (not a browser)' };
  let originHost;
  try { originHost = new URL(origin).host; } catch { return { ok: false, reason: 'unparseable or opaque Origin' }; }
  if (originHost !== host.toLowerCase()) return { ok: false, reason: `Origin ${origin} is not this manager` };
  return { ok: true, reason: 'same-origin' };
}

/** The only `config.podsRelease` keys a config write may set (the target and key live in the environment). */
export const PODS_RELEASE_FIELDS = Object.freeze(['enabled', 'minIdleSec']);

/**
 * What POST /api/config must refuse for the arbiter's keys, before anything is applied:
 * `podsRelease` from off-box (403 NOT_LOOPBACK), `strata` or `podsRelease` from an untrusted
 * Host/Origin (403 UNTRUSTED_ORIGIN, see configWriteTrusted), and a `podsRelease` with any key
 * but enabled/minIdleSec (400 PODS_RELEASE_FIELD). Other settings are not this guard's concern.
 * @param {{updates: object, loopback: boolean, host?: string, origin?: string, localNames: string[]}} p
 *   the request body, whether it came over loopback, its Host and Origin, and this machine's names.
 * @returns {?{status: number, body: {error: string, code: string}}} the refusal, or null to proceed.
 */
export function configUpdateRefusal({ updates, loopback, host, origin, localNames }) {
  const pods = 'podsRelease' in updates;
  if (pods && !loopback) {
    return { status: 403, body: { error: 'The podsRelease config may only be changed from this machine.', code: 'NOT_LOOPBACK' } };
  }
  if (pods || 'strata' in updates) {
    const trust = configWriteTrusted({ host, origin, localNames });
    if (!trust.ok) return { status: 403, body: { error: `Refused: ${trust.reason}`, code: 'UNTRUSTED_ORIGIN' } };
  }
  if (pods) {
    const pr = updates.podsRelease;
    const extra = pr && typeof pr === 'object' && !Array.isArray(pr) ? Object.keys(pr).filter((k) => !PODS_RELEASE_FIELDS.includes(k)) : ['(not an object)'];
    if (extra.length) {
      return {
        status: 400,
        body: {
          error: `podsRelease accepts only ${PODS_RELEASE_FIELDS.join(', ')}; the coordinator URL, node id and key come from the environment (PODS_COORDINATOR_URL, PODS_NODE_ID, PODS_API_KEY). Refused: ${extra.join(', ')}`,
          code: 'PODS_RELEASE_FIELD',
        },
      };
    }
  }
  return null;
}
