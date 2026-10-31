// Llama Manager — trust check for writes to the loopback-only config keys.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// POST /api/config accepts `strata` (executables the manager spawns) and
// `podsRelease` only from this machine. A loopback socket is not enough on its own:
// a web page open in a browser on the host can POST cross-origin (CSRF), and a
// DNS-rebinding page reaches 127.0.0.1 under its own host name. configWriteTrusted
// requires a Host that is a local name or an IP literal, and an Origin (when a
// browser sends one) for that same host and port. Pure, so it is unit-tested.

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
