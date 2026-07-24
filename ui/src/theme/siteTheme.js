/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Runtime site-theme controller for the dashboard. Loads the build-emitted
 * `themes/index.json` manifest, applies the active theme to the live document
 * (sets `data-site-theme` on <html> and injects/updates a stylesheet <link> to
 * the theme's `theme.css`), swaps the header logo, and persists the selection
 * in localStorage under `siteTheme`. Exposes a framework-friendly external
 * store via `useSiteTheme()` / `useSiteThemeLogo()` (React `useSyncExternalStore`)
 * plus imperative `initSiteTheme()` / `selectSiteTheme()` entry points. All DOM
 * and localStorage access is isolated here; pure logic lives in ./manifest.js.
 */

import { useSyncExternalStore } from 'react';

import {
  SITE_THEME_STORAGE_KEY,
  DEFAULT_THEME_ID,
  THEME_MANIFEST_URL,
  parseManifest,
  resolveSelection,
  themeCssHref,
  themeLogoUrl,
} from './manifest.js';

/** DOM id of the injected theme stylesheet <link>. */
const THEME_LINK_ID = 'site-theme-css';

/** Internal mutable state; never exposed directly (see {@link getSnapshot}). */
const state = { themes: [], selectedId: DEFAULT_THEME_ID, ready: false };

/** Immutable snapshot handed to subscribers; replaced wholesale on change. */
let snapshot = { themes: [], selectedId: DEFAULT_THEME_ID, ready: false };

/** Set of store subscribers. */
const listeners = new Set();

/**
 * Rebuild the public snapshot from internal state and notify all subscribers.
 * Called after every mutation so `useSyncExternalStore` re-renders correctly.
 */
function emit() {
  snapshot = {
    themes: state.themes,
    selectedId: state.selectedId,
    ready: state.ready,
  };
  for (const listener of listeners) listener();
}

/**
 * Subscribe to store changes.
 * @param {() => void} callback - Invoked on every state change.
 * @returns {() => void} Unsubscribe function.
 */
function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * @returns {{themes: object[], selectedId: string, ready: boolean}} The current
 *   immutable store snapshot (stable reference between mutations).
 */
function getSnapshot() {
  return snapshot;
}

/**
 * Read the persisted theme id from localStorage.
 * @returns {(string|null)} The stored id, or `null` if absent/unavailable.
 */
function getStored() {
  try {
    return localStorage.getItem(SITE_THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist (or clear, for the default theme) the selected theme id.
 * @param {string} id - Selected theme id.
 */
function setStored(id) {
  try {
    if (id === DEFAULT_THEME_ID) localStorage.removeItem(SITE_THEME_STORAGE_KEY);
    else localStorage.setItem(SITE_THEME_STORAGE_KEY, id);
  } catch {
    /* storage unavailable (private mode / SSR) — selection is simply not persisted */
  }
}

/**
 * Apply a theme to the live document: toggle `data-site-theme` on <html> and
 * inject/update/remove the theme stylesheet <link>. Safe to call repeatedly.
 * @param {string} id - Theme id to apply ({@link DEFAULT_THEME_ID} to reset).
 */
function applyThemeToDom(id) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const existing = document.getElementById(THEME_LINK_ID);

  if (id === DEFAULT_THEME_ID) {
    html.removeAttribute('data-site-theme');
    if (existing) existing.remove();
    return;
  }

  html.setAttribute('data-site-theme', id);
  let link = existing;
  if (!link) {
    link = document.createElement('link');
    link.id = THEME_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const href = themeCssHref(id);
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

/**
 * Initialize the site-theme system: optimistically apply any persisted
 * selection to reduce flash, fetch and parse the theme manifest, reconcile the
 * selection against the available themes, and apply the resolved theme. Call
 * once at application startup (before render). Never throws — a missing or
 * malformed manifest yields the default theme and an empty theme list.
 * @returns {Promise<void>} Resolves once the manifest has been loaded/applied.
 */
export async function initSiteTheme() {
  const stored = getStored();
  if (stored && stored !== DEFAULT_THEME_ID) {
    // Optimistic apply: the css href only needs the id, so we can theme the
    // document before the manifest confirms the theme still exists.
    state.selectedId = stored;
    applyThemeToDom(stored);
    emit();
  }

  let themes = [];
  try {
    const res = await fetch(THEME_MANIFEST_URL, { cache: 'no-cache' });
    if (res.ok) themes = parseManifest(await res.json());
  } catch {
    themes = [];
  }

  const selectedId = resolveSelection(getStored(), themes);
  state.themes = themes;
  state.selectedId = selectedId;
  state.ready = true;
  applyThemeToDom(selectedId);
  emit();
}

/**
 * Select and apply a site theme, persisting the choice. Ids that do not name an
 * available theme resolve to the default.
 * @param {string} id - Theme id to activate.
 */
export function selectSiteTheme(id) {
  const selectedId = resolveSelection(id, state.themes);
  state.selectedId = selectedId;
  setStored(selectedId);
  applyThemeToDom(selectedId);
  emit();
}

/**
 * React hook exposing the current site-theme store snapshot.
 * @returns {{themes: object[], selectedId: string, ready: boolean}} Live state.
 */
export function useSiteTheme() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * React hook returning the active theme's logo URL, or a fallback.
 * @param {(string|null)} [fallback=null] - Returned when the active theme
 *   declares no logo (including the default theme).
 * @returns {(string|null)} Logo URL to render.
 */
export function useSiteThemeLogo(fallback = null) {
  const { themes, selectedId } = useSiteTheme();
  return themeLogoUrl(themes, selectedId) || fallback;
}
