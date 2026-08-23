// Llama Manager — optional low-port mirror listener for appliance installs.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// On an appliance the dashboard must answer on plain http://localhost (port 80)
// in addition to the primary API port. This module resolves that mirror port
// from the ALT_PORT environment variable (default 80, disabled with 0/off/empty
// or when it would collide with the primary port) and binds a listener to it on
// a strictly best-effort basis: a bind failure — typically EACCES for an
// unprivileged dev or container run — is logged and swallowed so the primary
// listener always starts and serves normally.

const DISABLED_VALUES = new Set(['', '0', 'off', 'false', 'no', 'none', 'disabled']);

/**
 * Resolve the mirror HTTP port from environment configuration.
 *
 * @param {object} options
 * @param {Record<string, string|undefined>} options.env Environment to read `ALT_PORT` from.
 * @param {number|string} options.primaryPort Port the primary listener already uses.
 * @returns {number|null} Port to mirror on, or `null` when mirroring is disabled.
 */
export function resolveAltPort({ env = {}, primaryPort }) {
  const raw = env.ALT_PORT === undefined ? '80' : String(env.ALT_PORT).trim().toLowerCase();
  if (DISABLED_VALUES.has(raw)) return null;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (port === Number(primaryPort)) return null;

  return port;
}

/**
 * Start a listener that must never take the process down if it cannot bind.
 *
 * @param {object} options
 * @param {import('http').Server} options.server Server to bind.
 * @param {number} options.port Port to bind.
 * @param {string} [options.host] Interface to bind (default all interfaces).
 * @param {(message: string) => void} [options.log] Success logger.
 * @param {(message: string) => void} [options.warn] Failure logger.
 * @returns {void}
 */
export function listenBestEffort({ server, port, host = '0.0.0.0', log = console.log, warn = console.warn }) {
  server.on('error', (err) => {
    warn(`Skipping port ${port}: ${err.code || 'error'} — ${err.message}`);
  });
  server.listen(port, host, () => {
    log(`Llama Manager also listening on http://${host}:${port}`);
  });
}
