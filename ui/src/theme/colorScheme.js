/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Pure color-scheme preference logic for the dashboard. Normalizes persisted
 * user choices and resolves the system-aware preference to a concrete light or
 * dark scheme without accessing the DOM, localStorage, or media queries.
 */

/** localStorage key under which the color-scheme preference is persisted. */
export const COLOR_SCHEME_STORAGE_KEY = 'colorScheme';

/** Color scheme used when no valid persisted preference is available. */
export const DEFAULT_COLOR_SCHEME = 'dark';

/** Supported user-facing color-scheme preferences. */
const COLOR_SCHEMES = new Set(['dark', 'light', 'system']);

/**
 * Normalize an arbitrary persisted value to a supported preference.
 *
 * @param {unknown} value - Candidate color-scheme preference.
 * @returns {'dark'|'light'|'system'} A supported preference, falling back to
 *   {@link DEFAULT_COLOR_SCHEME}.
 */
export function normalizeColorScheme(value) {
  return COLOR_SCHEMES.has(value) ? value : DEFAULT_COLOR_SCHEME;
}

/**
 * Resolve a preference to the concrete scheme applied to the document.
 *
 * @param {unknown} preference - Explicit or system color-scheme preference.
 * @param {boolean} systemPrefersDark - Whether the system currently prefers
 *   dark colors.
 * @returns {'dark'|'light'} The concrete scheme to apply.
 */
export function resolveColorScheme(preference, systemPrefersDark) {
  const normalized = normalizeColorScheme(preference);
  if (normalized === 'system') return systemPrefersDark ? 'dark' : 'light';
  return normalized;
}
