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
 * plus imperative `initSiteTheme()` / `selectSiteTheme()` entry points. Also
 * owns the persisted light/dark/system color-scheme preference and keeps the
 * concrete `data-theme` attribute synchronized with system changes. It also
 * owns the Auto/Glass/Simple effects preference, applies `data-effects`, and
 * runs the versioned, non-blocking frame probe used by Auto. All DOM and
 * localStorage access is isolated here; pure logic lives in ./manifest.js,
 * ./colorScheme.js, and ./effectsMode.js.
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
import {
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_COLOR_SCHEME,
  normalizeColorScheme,
  resolveColorScheme,
} from './colorScheme.js';
import {
  DEFAULT_EFFECTS_MODE,
  EFFECTS_MODE_STORAGE_KEY,
  EFFECTS_PROBE_MIN_SAMPLES,
  EFFECTS_PROBE_VERDICT_STORAGE_KEY,
  EFFECTS_PROBE_VERSION,
  evaluateFrameProbe,
  normalizeEffectsMode,
  resolveEffectsMode,
} from './effectsMode.js';

/** DOM id of the injected theme stylesheet <link>. */
const THEME_LINK_ID = 'site-theme-css';

/** Media query used when the selected color-scheme preference is `system`. */
const COLOR_SCHEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Media query that forces Auto to honor reduced-transparency accessibility. */
const REDUCED_TRANSPARENCY_MEDIA_QUERY =
  '(prefers-reduced-transparency: reduce)';

/** Fallback delay before probing when requestIdleCallback is unavailable. */
const EFFECTS_PROBE_START_DELAY_MS = 1000;

/** Internal mutable state; never exposed directly (see {@link getSnapshot}). */
const state = { themes: [], selectedId: DEFAULT_THEME_ID, ready: false };

/** Current persisted color-scheme preference. */
let colorScheme = DEFAULT_COLOR_SCHEME;

/** Current persisted effects preference and cached performance verdict. */
let effectsMode = DEFAULT_EFFECTS_MODE;
let effectsProbeVerdict = null;

/** Lazily-created system color-scheme media query listener target. */
let colorSchemeMedia = null;

/** Lazily-created reduced-transparency media query listener target. */
let reducedTransparencyMedia = null;

/** Immutable snapshot handed to subscribers; replaced wholesale on change. */
let snapshot = { themes: [], selectedId: DEFAULT_THEME_ID, ready: false };

/** Immutable effects snapshot handed to effects-mode hook subscribers. */
let effectsSnapshot = {
  preference: DEFAULT_EFFECTS_MODE,
  resolved: 'glass',
  probeVerdict: null,
  reason: 'checking',
};

/** Set of store subscribers. */
const listeners = new Set();

/** Set of effects-mode store subscribers. */
const effectsListeners = new Set();

/** Handles for a scheduled or running non-blocking frame probe. */
let effectsProbeIdleId = null;
let effectsProbeTimeoutId = null;
let effectsProbeFrameId = null;
let effectsProbeVisibilityHandler = null;

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
 * Rebuild the public effects snapshot and notify its subscribers.
 * @param {'glass'|'simple'} resolved - Concrete tier applied to the document.
 * @param {string} reason - Human-readable resolution reason identifier.
 */
function emitEffects(resolved, reason) {
  effectsSnapshot = {
    preference: effectsMode,
    resolved,
    probeVerdict: effectsProbeVerdict,
    reason,
  };
  for (const listener of effectsListeners) listener();
}

/**
 * Subscribe to effects preference/resolution changes.
 * @param {() => void} callback - Invoked when the preference or tier changes.
 * @returns {() => void} Unsubscribe function.
 */
function subscribeEffects(callback) {
  effectsListeners.add(callback);
  return () => effectsListeners.delete(callback);
}

/**
 * @returns {{preference: 'auto'|'glass'|'simple', resolved: 'glass'|'simple',
 * probeVerdict: 'fast'|'slow'|null, reason: string}} Current effects snapshot.
 */
function getEffectsSnapshot() {
  return effectsSnapshot;
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
 * Read and normalize the persisted color-scheme preference.
 * @returns {'dark'|'light'|'system'} The stored preference or dark default.
 */
function getStoredColorScheme() {
  try {
    return normalizeColorScheme(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY));
  } catch {
    return DEFAULT_COLOR_SCHEME;
  }
}

/**
 * Persist a normalized color-scheme preference when storage is available.
 * @param {'dark'|'light'|'system'} preference - Preference to persist.
 */
function setStoredColorScheme(preference) {
  try {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, preference);
  } catch {
    /* storage unavailable (private mode / SSR) — preference remains in memory */
  }
}

/**
 * Read and normalize the persisted effects preference.
 * @returns {'auto'|'glass'|'simple'} Stored preference or Auto default.
 */
function getStoredEffectsMode() {
  try {
    return normalizeEffectsMode(localStorage.getItem(EFFECTS_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_EFFECTS_MODE;
  }
}

/**
 * Persist a normalized effects preference when storage is available.
 * @param {'auto'|'glass'|'simple'} preference - Preference to persist.
 */
function setStoredEffectsMode(preference) {
  try {
    localStorage.setItem(EFFECTS_MODE_STORAGE_KEY, preference);
  } catch {
    /* storage unavailable (private mode / SSR) — preference remains in memory */
  }
}

/**
 * Read a cacheable verdict only when its tuning version matches this build.
 * @returns {'fast'|'slow'|null} Valid cached verdict, or null when absent/stale.
 */
function getStoredEffectsProbeVerdict() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(EFFECTS_PROBE_VERDICT_STORAGE_KEY) || 'null',
    );
    if (
      parsed?.version === EFFECTS_PROBE_VERSION &&
      (parsed.verdict === 'fast' || parsed.verdict === 'slow')
    ) {
      return parsed.verdict;
    }
  } catch {
    /* malformed or unavailable storage is treated as an empty cache */
  }
  return null;
}

/**
 * Persist a frame-probe verdict with the current tuning version.
 * @param {'fast'|'slow'} verdict - Cacheable frame-probe result.
 */
function setStoredEffectsProbeVerdict(verdict) {
  try {
    localStorage.setItem(
      EFFECTS_PROBE_VERDICT_STORAGE_KEY,
      JSON.stringify({ version: EFFECTS_PROBE_VERSION, verdict }),
    );
  } catch {
    /* storage unavailable — the live verdict still applies for this session */
  }
}

/** Clear any cached performance verdict. */
function clearStoredEffectsProbeVerdict() {
  try {
    localStorage.removeItem(EFFECTS_PROBE_VERDICT_STORAGE_KEY);
  } catch {
    /* storage unavailable — clearing the in-memory verdict is sufficient */
  }
}

/**
 * Return whether the browser currently reports a dark system preference.
 * Defaults to dark when matchMedia is unavailable to preserve the legacy UI.
 * @returns {boolean} Whether the system prefers dark colors.
 */
function systemPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return (
    colorSchemeMedia || window.matchMedia(COLOR_SCHEME_MEDIA_QUERY)
  ).matches;
}

/**
 * Apply the current preference as a concrete `data-theme` document attribute.
 */
function applyColorSchemeToDom() {
  if (typeof document === 'undefined') return;
  const resolved = resolveColorScheme(colorScheme, systemPrefersDark());
  document.documentElement.setAttribute('data-theme', resolved);
}

/**
 * Respond to operating-system color-scheme changes while following `system`.
 */
function handleSystemColorSchemeChange() {
  if (colorScheme === 'system') applyColorSchemeToDom();
}

/**
 * Install the system color-scheme listener once. Supports legacy MediaQueryList
 * implementations for older embedded dashboard browsers.
 */
function listenForSystemColorScheme() {
  if (
    colorSchemeMedia ||
    typeof window === 'undefined' ||
    !window.matchMedia
  ) {
    return;
  }
  colorSchemeMedia = window.matchMedia(COLOR_SCHEME_MEDIA_QUERY);
  if (colorSchemeMedia.addEventListener) {
    colorSchemeMedia.addEventListener('change', handleSystemColorSchemeChange);
  } else if (colorSchemeMedia.addListener) {
    colorSchemeMedia.addListener(handleSystemColorSchemeChange);
  }
}

/**
 * Return whether the browser currently requests reduced transparency.
 * @returns {boolean} Whether transparent effects should be reduced.
 */
function systemPrefersReducedTransparency() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return (
    reducedTransparencyMedia ||
    window.matchMedia(REDUCED_TRANSPARENCY_MEDIA_QUERY)
  ).matches;
}

/**
 * Test native or prefixed backdrop-filter support.
 * @returns {boolean} Whether glass compositing is available.
 */
function supportsBackdropFilter() {
  if (typeof CSS === 'undefined' || !CSS.supports) return false;
  return (
    CSS.supports('backdrop-filter', 'blur(1px)') ||
    CSS.supports('-webkit-backdrop-filter', 'blur(1px)')
  );
}

/**
 * Determine why the current effects preference resolves to its concrete tier.
 * @param {boolean} reducedTransparency - Current accessibility media value.
 * @param {boolean} backdropSupported - Current CSS capability result.
 * @returns {string} Stable reason identifier for settings/help text.
 */
function getEffectsResolutionReason(
  reducedTransparency,
  backdropSupported,
) {
  if (effectsMode !== 'auto') return 'manual';
  if (reducedTransparency) return 'reduced-transparency';
  if (!backdropSupported) return 'unsupported';
  if (effectsProbeVerdict === 'slow') return 'measured';
  if (effectsProbeVerdict === 'fast') return 'measured';
  return 'checking';
}

/**
 * Apply the current preference as a concrete `data-effects` document attribute
 * and notify subscribers of the resolution.
 */
function applyEffectsModeToDom() {
  const reducedTransparency = systemPrefersReducedTransparency();
  const backdropSupported = supportsBackdropFilter();
  const capabilityVerdict = backdropSupported
    ? effectsProbeVerdict
    : 'unsupported';
  const resolved = resolveEffectsMode(
    effectsMode,
    capabilityVerdict,
    reducedTransparency,
  );

  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-effects', resolved);
  }
  emitEffects(
    resolved,
    getEffectsResolutionReason(reducedTransparency, backdropSupported),
  );
}

/**
 * Remove handles/listeners owned by a pending or active frame probe.
 */
function cancelEffectsProbe() {
  if (typeof window === 'undefined') return;
  if (
    effectsProbeIdleId !== null &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    window.cancelIdleCallback(effectsProbeIdleId);
  }
  if (effectsProbeTimeoutId !== null) {
    window.clearTimeout(effectsProbeTimeoutId);
  }
  if (
    effectsProbeFrameId !== null &&
    typeof window.cancelAnimationFrame === 'function'
  ) {
    window.cancelAnimationFrame(effectsProbeFrameId);
  }
  if (effectsProbeVisibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener(
      'visibilitychange',
      effectsProbeVisibilityHandler,
    );
  }
  effectsProbeIdleId = null;
  effectsProbeTimeoutId = null;
  effectsProbeFrameId = null;
  effectsProbeVisibilityHandler = null;
}

/**
 * Return whether current state still calls for a frame probe.
 * @returns {boolean} Whether sampling may start/continue.
 */
function shouldRunEffectsProbe() {
  return (
    effectsMode === 'auto' &&
    effectsProbeVerdict === null &&
    !systemPrefersReducedTransparency() &&
    supportsBackdropFilter() &&
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
  );
}

/**
 * Sample consecutive animation-frame deltas while the page is visible.
 * Hidden-tab transitions reset the sample and resume cleanly when visible.
 */
function startEffectsFrameProbe() {
  if (!shouldRunEffectsProbe()) return;

  const frameTimes = [];
  let previousTimestamp = null;

  const resetSample = () => {
    frameTimes.length = 0;
    previousTimestamp = null;
  };

  const finishProbe = (verdict) => {
    effectsProbeFrameId = null;
    if (effectsProbeVisibilityHandler) {
      document.removeEventListener(
        'visibilitychange',
        effectsProbeVisibilityHandler,
      );
      effectsProbeVisibilityHandler = null;
    }
    effectsProbeVerdict = verdict;
    setStoredEffectsProbeVerdict(verdict);
    applyEffectsModeToDom();
  };

  const sampleFrame = (timestamp) => {
    effectsProbeFrameId = null;
    if (!shouldRunEffectsProbe()) return;
    if (document.visibilityState !== 'visible') {
      resetSample();
      return;
    }

    if (previousTimestamp !== null) {
      frameTimes.push(timestamp - previousTimestamp);
    }
    previousTimestamp = timestamp;

    if (frameTimes.length >= EFFECTS_PROBE_MIN_SAMPLES) {
      const verdict = evaluateFrameProbe(frameTimes);
      if (verdict) {
        finishProbe(verdict);
        return;
      }
      resetSample();
    }
    effectsProbeFrameId = window.requestAnimationFrame(sampleFrame);
  };

  const requestNextFrame = () => {
    if (effectsProbeFrameId === null && shouldRunEffectsProbe()) {
      effectsProbeFrameId = window.requestAnimationFrame(sampleFrame);
    }
  };

  effectsProbeVisibilityHandler = () => {
    if (document.visibilityState !== 'visible') {
      if (effectsProbeFrameId !== null) {
        window.cancelAnimationFrame(effectsProbeFrameId);
        effectsProbeFrameId = null;
      }
      resetSample();
      return;
    }
    requestNextFrame();
  };
  document.addEventListener(
    'visibilitychange',
    effectsProbeVisibilityHandler,
  );

  if (document.visibilityState === 'visible') requestNextFrame();
}

/**
 * Schedule the probe after first paint without blocking startup or interaction.
 */
function scheduleEffectsProbe() {
  cancelEffectsProbe();
  if (!shouldRunEffectsProbe()) return;

  const start = () => {
    effectsProbeIdleId = null;
    effectsProbeTimeoutId = null;
    startEffectsFrameProbe();
  };

  if (typeof window.requestIdleCallback === 'function') {
    effectsProbeIdleId = window.requestIdleCallback(start, {
      timeout: EFFECTS_PROBE_START_DELAY_MS,
    });
  } else {
    effectsProbeTimeoutId = window.setTimeout(
      start,
      EFFECTS_PROBE_START_DELAY_MS,
    );
  }
}

/**
 * Respond to reduced-transparency changes while following Auto.
 */
function handleReducedTransparencyChange() {
  if (effectsMode !== 'auto') return;
  applyEffectsModeToDom();
  if (systemPrefersReducedTransparency()) cancelEffectsProbe();
  else if (effectsProbeVerdict === null) scheduleEffectsProbe();
}

/**
 * Install the reduced-transparency listener once, including legacy MediaQueryList
 * support for older embedded dashboard browsers.
 */
function listenForReducedTransparency() {
  if (
    reducedTransparencyMedia ||
    typeof window === 'undefined' ||
    !window.matchMedia
  ) {
    return;
  }
  reducedTransparencyMedia = window.matchMedia(
    REDUCED_TRANSPARENCY_MEDIA_QUERY,
  );
  if (reducedTransparencyMedia.addEventListener) {
    reducedTransparencyMedia.addEventListener(
      'change',
      handleReducedTransparencyChange,
    );
  } else if (reducedTransparencyMedia.addListener) {
    reducedTransparencyMedia.addListener(handleReducedTransparencyChange);
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
  colorScheme = getStoredColorScheme();
  listenForSystemColorScheme();
  applyColorSchemeToDom();

  effectsMode = getStoredEffectsMode();
  effectsProbeVerdict = getStoredEffectsProbeVerdict();
  listenForReducedTransparency();
  applyEffectsModeToDom();
  scheduleEffectsProbe();

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
 * Return the active color-scheme preference. `system` is returned as a
 * preference rather than its currently resolved light/dark value.
 * @returns {'dark'|'light'|'system'} The active preference.
 */
export function getColorScheme() {
  return colorScheme;
}

/**
 * Select, apply, and persist a color-scheme preference. Invalid values safely
 * fall back to the dark default.
 * @param {'dark'|'light'|'system'} preference - Preference to activate.
 */
export function setColorScheme(preference) {
  colorScheme = normalizeColorScheme(preference);
  setStoredColorScheme(colorScheme);
  listenForSystemColorScheme();
  applyColorSchemeToDom();
}

/**
 * Return the active user-facing effects preference.
 * @returns {'auto'|'glass'|'simple'} The active preference.
 */
export function getEffectsMode() {
  return effectsMode;
}

/**
 * Select, apply, and persist an effects preference. Switching is immediate;
 * Auto reuses a valid cached performance verdict or schedules a new probe.
 * @param {'auto'|'glass'|'simple'} preference - Preference to activate.
 */
export function setEffectsMode(preference) {
  effectsMode = normalizeEffectsMode(preference);
  setStoredEffectsMode(effectsMode);
  cancelEffectsProbe();
  listenForReducedTransparency();
  applyEffectsModeToDom();
  scheduleEffectsProbe();
}

/**
 * Clear the versioned performance cache and schedule a fresh visible-tab probe.
 * The operation is intentionally a no-op outside Auto.
 * @returns {boolean} Whether a new Auto check was requested.
 */
export function rerunEffectsProbe() {
  if (effectsMode !== 'auto') return false;
  cancelEffectsProbe();
  effectsProbeVerdict = null;
  clearStoredEffectsProbeVerdict();
  applyEffectsModeToDom();
  scheduleEffectsProbe();
  return true;
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
 * React hook exposing the live effects preference, resolved tier, and reason.
 * @returns {{preference: 'auto'|'glass'|'simple', resolved: 'glass'|'simple',
 * probeVerdict: 'fast'|'slow'|null, reason: string}} Live effects state.
 */
export function useEffectsMode() {
  return useSyncExternalStore(
    subscribeEffects,
    getEffectsSnapshot,
    getEffectsSnapshot,
  );
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
