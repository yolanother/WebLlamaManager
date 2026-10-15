// Llama Manager — engine health predicate.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Single source of truth for "is any inference engine serving": true when the
// llama server, the ds4 engine, or the Strata engine reports status `ok`. In
// exclusive-engine modes llama is intentionally stopped, so health must not
// depend on llama alone.

/**
 * Whether any inference engine is currently healthy.
 * @param {object|null|undefined} stats - The websocket `stats` payload.
 * @returns {boolean} True when llama, ds4 or strata reports `status === 'ok'`.
 */
export function engineHealthy(stats) {
  return stats?.llama?.status === 'ok'
    || stats?.ds4?.status === 'ok'
    || stats?.strata?.status === 'ok';
}
