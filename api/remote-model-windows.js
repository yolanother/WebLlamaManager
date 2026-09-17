/**
 * @file remote-model-windows.js
 * @copyright Use of this file is governed by the LICENSE file in the repository root.
 *
 * Reads the context window each model on a remote backend advertises, so an alias
 * whose target lives on another host can state a window it has actually been told.
 * The probe that fetches a backend's catalogue keeps only model names, and an alias
 * pointing at a remote target is then permanently unbounded: the caller falls back
 * to a stale local default and can under-use a model several times over.
 */

/**
 * Extract the advertised window of every model in a backend's catalogue response.
 *
 * A window is kept only when the backend states a usable positive number. Absent,
 * null, zero and non-numeric all mean "unknown", and they are omitted rather than
 * coerced: an alias that treated unknown as a number would advertise a bound it
 * cannot honour, which is worse for a caller than having no bound at all.
 *
 * @param {{data?: unknown, models?: unknown}|null|undefined} payload an OpenAI-style
 *   `/v1/models` body, in either the `data` or `models` shape backends use.
 * @returns {Object<string, number>} model id to window, containing only known windows.
 */
export function remoteModelWindows(payload) {
  const rows = payload && typeof payload === 'object'
    ? (Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [])
    : [];
  const windows = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = row.id || row.name;
    const window = row.n_ctx;
    if (typeof id !== 'string' || !id) continue;
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) continue;
    windows[id] = window;
  }
  return windows;
}
