/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Site-theme manifest logic: pure, DOM-free helpers for the dashboard's
 * host-architecture theming feature. Parses the runtime `themes/index.json`
 * manifest emitted by the build into a normalized, de-duplicated list of
 * selectable site themes, resolves a persisted selection against the available
 * themes (falling back to the always-present "default"), and builds the runtime
 * URLs for each theme's stylesheet and logo asset. Kept free of React and
 * browser globals so it can be unit-tested under `node --test`.
 */

/** localStorage key under which the active site-theme id is persisted. */
export const SITE_THEME_STORAGE_KEY = 'siteTheme';

/** Reserved id for the built-in, always-available default appearance. */
export const DEFAULT_THEME_ID = 'default';

/** Runtime path of the build-emitted theme manifest (root-relative). */
export const THEME_MANIFEST_URL = '/themes/index.json';

/**
 * Normalize an arbitrary parsed manifest payload into a clean theme list.
 *
 * Accepts either a bare array of theme entries or an object of the shape
 * `{ themes: [...] }`. Entries are validated and normalized: each must carry a
 * non-empty string `id` (the reserved `default` id is ignored, as are
 * duplicates — first occurrence wins). `label` defaults to the `id` when
 * missing/blank; `logo` is preserved only when a non-blank string, else `null`.
 *
 * @param {unknown} raw - Parsed JSON from the theme manifest.
 * @returns {{id: string, label: string, logo: (string|null)}[]} Normalized,
 *   de-duplicated theme entries (never includes the default theme).
 */
export function parseManifest(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.themes) ? raw.themes : []);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || id === DEFAULT_THEME_ID || seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof entry.label === 'string' && entry.label.trim()
        ? entry.label.trim()
        : id;
    const logo =
      typeof entry.logo === 'string' && entry.logo.trim()
        ? entry.logo.trim()
        : null;
    out.push({ id, label, logo });
  }
  return out;
}

/**
 * Resolve a persisted selection against the currently available themes.
 *
 * @param {(string|null|undefined)} storedId - The persisted selection, if any.
 * @param {{id: string}[]} themes - Available (parsed) themes.
 * @returns {string} `storedId` when it names an available theme, otherwise
 *   {@link DEFAULT_THEME_ID}.
 */
export function resolveSelection(storedId, themes) {
  if (!storedId || storedId === DEFAULT_THEME_ID) return DEFAULT_THEME_ID;
  return themes.some((t) => t.id === storedId) ? storedId : DEFAULT_THEME_ID;
}

/**
 * Find a theme entry by id.
 *
 * @param {{id: string}[]} themes - Available themes.
 * @param {string} id - Theme id to look up.
 * @returns {(object|null)} The matching entry, or `null`.
 */
export function findTheme(themes, id) {
  return themes.find((t) => t.id === id) || null;
}

/**
 * Build the root-relative URL of a theme's stylesheet.
 *
 * @param {string} id - Theme id.
 * @returns {string} URL of the theme's `theme.css` under `/themes/<id>/`.
 */
export function themeCssHref(id) {
  return `/themes/${encodeURIComponent(id)}/theme.css`;
}

/**
 * Build the root-relative URL of an asset inside a theme directory.
 *
 * @param {string} id - Theme id.
 * @param {(string|null|undefined)} file - Asset filename (e.g. `logo.svg`).
 * @returns {(string|null)} The asset URL, or `null` when `file` is blank.
 */
export function themeAssetUrl(id, file) {
  if (!file) return null;
  return `/themes/${encodeURIComponent(id)}/${file}`;
}

/**
 * Resolve the logo URL for the selected theme, if it declares one.
 *
 * @param {{id: string, logo: (string|null)}[]} themes - Available themes.
 * @param {string} id - Selected theme id.
 * @returns {(string|null)} The logo URL, or `null` when the theme has no logo
 *   (including the default theme).
 */
export function themeLogoUrl(themes, id) {
  const theme = findTheme(themes, id);
  return theme && theme.logo ? themeAssetUrl(id, theme.logo) : null;
}
