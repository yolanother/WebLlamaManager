/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * DOM and storage controller for the Look and Layout appearance preferences.
 * Builds both from one `createAttributePreference` helper that persists a
 * normalized value to localStorage, applies it as an attribute on
 * `<html>`, and exposes a `useSyncExternalStore`-based React hook. Also owns
 * `?look=`/`?layout=` URL overrides applied once at startup. All DOM and
 * localStorage access is isolated here; pure normalization logic lives in
 * ./look.js and ./layout.js.
 */

import { useSyncExternalStore } from 'react';

import { LOOK_STORAGE_KEY, DEFAULT_LOOK, normalizeLook } from './look.js';
import { LAYOUT_STORAGE_KEY, DEFAULT_LAYOUT, normalizeLayout } from './layout.js';

/**
 * Build a small persisted, DOM-attribute-backed preference store.
 *
 * @param {object} options
 * @param {string} options.storageKey - localStorage key for persistence.
 * @param {string} options.attribute - Attribute name applied to `<html>`.
 * @param {(value: unknown) => string} options.normalize - Normalizes an
 *   arbitrary candidate value to a supported one, falling back to a default.
 * @param {string} options.defaultValue - Value used before `init()` runs.
 * @returns {{
 *   get: () => string,
 *   set: (value: unknown) => void,
 *   use: () => string,
 *   init: () => string,
 * }} The preference store's imperative API and React hook.
 */
export function createAttributePreference({ storageKey, attribute, normalize, defaultValue }) {
  let value = defaultValue;
  const listeners = new Set();

  function emit() {
    for (const listener of listeners) listener();
  }

  function getStored() {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }

  function setStored(next) {
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* storage unavailable (private mode / SSR) — preference remains in memory */
    }
  }

  function applyToDom(next) {
    try {
      document.documentElement.setAttribute(attribute, next);
    } catch {
      /* document unavailable (SSR) — nothing to apply */
    }
  }

  /** @returns {string} The current in-memory preference value. */
  function get() {
    return value;
  }

  /**
   * Normalize, apply, persist, and broadcast a new preference value.
   * @param {unknown} next - Candidate value; normalized before use.
   */
  function set(next) {
    value = normalize(next);
    setStored(value);
    applyToDom(value);
    emit();
  }

  /**
   * Load the persisted value (or default), apply it to the DOM, and
   * broadcast it. Call once at startup, before first paint.
   * @returns {string} The resolved value that was applied.
   */
  function init() {
    value = normalize(getStored());
    applyToDom(value);
    emit();
    return value;
  }

  function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  /** React hook returning the live preference value. */
  function use() {
    return useSyncExternalStore(subscribe, get, get);
  }

  return { get, set, use, init };
}

/** Look preference store (`data-look`, localStorage `uiLook`). */
const lookPreference = createAttributePreference({
  storageKey: LOOK_STORAGE_KEY,
  attribute: 'data-look',
  normalize: normalizeLook,
  defaultValue: DEFAULT_LOOK,
});

/** Layout preference store (`data-layout`, localStorage `uiLayout`). */
const layoutPreference = createAttributePreference({
  storageKey: LAYOUT_STORAGE_KEY,
  attribute: 'data-layout',
  normalize: normalizeLayout,
  defaultValue: DEFAULT_LAYOUT,
});

/**
 * Apply `?look=`/`?layout=` URL overrides, if present: normalize, persist,
 * apply, then strip just those two parameters from the URL (keeping any
 * others) via `history.replaceState`. Never throws.
 */
function applyUrlOverrides() {
  if (typeof location === 'undefined') return;
  let params;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return;
  }

  let changed = false;
  if (params.has('look')) {
    lookPreference.set(params.get('look'));
    params.delete('look');
    changed = true;
  }
  if (params.has('layout')) {
    layoutPreference.set(params.get('layout'));
    params.delete('layout');
    changed = true;
  }

  if (!changed) return;
  try {
    const query = params.toString();
    const newUrl = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
    history.replaceState(null, '', newUrl);
  } catch {
    /* history API unavailable — override is still applied and persisted */
  }
}

/**
 * Initialize both preferences: apply the persisted (or default) Look and
 * Layout to `<html>` before first paint, then apply any `?look=`/`?layout=`
 * URL overrides. Call once at application startup, next to `initSiteTheme()`.
 * Never throws.
 */
export function initUiPrefs() {
  lookPreference.init();
  layoutPreference.init();
  applyUrlOverrides();
}

/** @returns {'classic'|'professional'} The active Look preference. */
export function getLook() {
  return lookPreference.get();
}

/**
 * Select, apply, and persist a Look preference. Invalid values fall back to
 * the professional default.
 * @param {unknown} value - Candidate Look preference.
 */
export function setLook(value) {
  lookPreference.set(value);
}

/** React hook returning the live Look preference. */
export function useLook() {
  return lookPreference.use();
}

/** @returns {'dashboard'|'chat-first'} The active Layout preference. */
export function getLayout() {
  return layoutPreference.get();
}

/**
 * Select, apply, and persist a Layout preference. Invalid values fall back
 * to the dashboard default.
 * @param {unknown} value - Candidate Layout preference.
 */
export function setLayout(value) {
  layoutPreference.set(value);
}

/** React hook returning the live Layout preference. */
export function useLayout() {
  return layoutPreference.use();
}
