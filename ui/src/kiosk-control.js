// Llama Manager — browser client for appliance-local kiosk controls.
// Copyright (c) Llama Manager project. See the LICENSE file in the repository
// root for license terms.
//
// Keeps desktop session control out of the network-facing manager API. The
// System Login action is exposed only when this page itself was loaded on a
// loopback hostname and posts to the helper bound to that same machine.

const KIOSK_CONTROL_URL = 'http://127.0.0.1:8798/system-login';

/**
 * Return whether a dashboard hostname represents this local appliance.
 *
 * @param {string} hostname Browser location hostname.
 * @returns {boolean} True only for supported loopback hostnames.
 */
export function isLocalKioskHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * Ask the appliance-local helper to switch from kiosk mode to the GDM greeter.
 *
 * @param {{hostname: string, fetchImpl?: typeof fetch}} options Invocation dependencies.
 * @returns {Promise<void>} Resolves after the helper accepts the switch request.
 * @throws {Error} If called from a remote dashboard or the helper rejects the action.
 */
export async function requestSystemLogin({ hostname, fetchImpl = fetch }) {
  if (!isLocalKioskHost(hostname)) {
    throw new Error('System Login is available only on the appliance-local dashboard.');
  }
  const response = await fetchImpl(KIOSK_CONTROL_URL, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`System Login helper returned HTTP ${response.status || 'error'}.`);
  }
}
