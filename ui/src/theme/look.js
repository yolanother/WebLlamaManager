/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Pure Look preference logic for the dashboard. Normalizes persisted or
 * URL-supplied user choices between the "classic" glass appearance and the
 * flat, desaturated "professional" appearance, without accessing the DOM,
 * localStorage, or the URL.
 */

/** localStorage key under which the Look preference is persisted. */
export const LOOK_STORAGE_KEY = 'uiLook';

/** Look used when no valid persisted preference is available. */
export const DEFAULT_LOOK = 'professional';

/** Supported user-facing Look preferences. */
const LOOKS = new Set(['classic', 'professional']);

/**
 * Normalize an arbitrary persisted or URL value to a supported Look.
 *
 * @param {unknown} value - Candidate Look preference.
 * @returns {'classic'|'professional'} A supported preference, falling back to
 *   {@link DEFAULT_LOOK}.
 */
export function normalizeLook(value) {
  return LOOKS.has(value) ? value : DEFAULT_LOOK;
}
