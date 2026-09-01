/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Pure Layout preference logic for the dashboard. Normalizes persisted or
 * URL-supplied user choices between the "dashboard" shell and the
 * ChatGPT-style "chat-first" shell, without accessing the DOM, localStorage,
 * or the URL.
 */

/** localStorage key under which the Layout preference is persisted. */
export const LAYOUT_STORAGE_KEY = 'uiLayout';

/** Layout used when no valid persisted preference is available. */
export const DEFAULT_LAYOUT = 'dashboard';

/** Supported user-facing Layout preferences. */
const LAYOUTS = new Set(['dashboard', 'chat-first']);

/**
 * Normalize an arbitrary persisted or URL value to a supported Layout.
 *
 * @param {unknown} value - Candidate Layout preference.
 * @returns {'dashboard'|'chat-first'} A supported preference, falling back to
 *   {@link DEFAULT_LAYOUT}.
 */
export function normalizeLayout(value) {
  return LAYOUTS.has(value) ? value : DEFAULT_LAYOUT;
}
