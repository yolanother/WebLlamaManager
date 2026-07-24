/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Pure effects-tier preference and frame-probe logic for the dashboard.
 * Normalizes persisted choices, resolves Auto to a concrete tier, and evaluates
 * requestAnimationFrame deltas without accessing browser globals or storage.
 */

/** localStorage key under which the user-facing effects preference is stored. */
export const EFFECTS_MODE_STORAGE_KEY = 'effectsMode';

/** localStorage key for the versioned runtime performance verdict. */
export const EFFECTS_PROBE_VERDICT_STORAGE_KEY = 'effectsProbeVerdict';

/** Schema/tuning version used to invalidate previously measured verdicts. */
export const EFFECTS_PROBE_VERSION = 1;

/** Effects preference used when no valid persisted value is available. */
export const DEFAULT_EFFECTS_MODE = 'auto';

/**
 * Number of consecutive visible-frame deltas required for a verdict.
 *
 * Sixty frames covers roughly one second on a healthy 60 Hz display while
 * remaining short enough that Auto can react soon after startup.
 */
export const EFFECTS_PROBE_MIN_SAMPLES = 60;

/**
 * A p75 above 28 ms indicates sustained rendering below roughly 36 fps.
 *
 * The percentile ignores isolated startup hitches while still detecting pages
 * where expensive compositing affects a meaningful share of rendered frames.
 */
export const EFFECTS_PROBE_SLOW_P75_MS = 28;

/**
 * Deltas at or above one second indicate a suspended/hidden tab, not rendering
 * capacity. Such a sample invalidates the run so it can be measured again.
 */
export const EFFECTS_PROBE_HIDDEN_GAP_MS = 1000;

/** Supported user-facing effects preferences. */
const EFFECTS_MODES = new Set(['auto', 'glass', 'simple']);

/**
 * Normalize an arbitrary persisted value to a supported effects preference.
 *
 * @param {unknown} value - Candidate effects preference.
 * @returns {'auto'|'glass'|'simple'} A supported preference, falling back to
 *   {@link DEFAULT_EFFECTS_MODE}.
 */
export function normalizeEffectsMode(value) {
  return EFFECTS_MODES.has(value) ? value : DEFAULT_EFFECTS_MODE;
}

/**
 * Resolve a preference to the concrete effects tier applied to the document.
 *
 * Explicit preferences always win. In Auto, `unsupported` represents a runtime
 * CSS capability check; persisted probe verdicts themselves are `fast`/`slow`.
 *
 * @param {unknown} preference - User-facing Auto, Glass, or Simple preference.
 * @param {'fast'|'slow'|'unsupported'|null|undefined} probeVerdict - Cached
 *   frame result or the runtime backdrop-filter capability result.
 * @param {boolean} reducedTransparency - Whether the OS requests reduced
 *   transparency.
 * @returns {'glass'|'simple'} The concrete effects tier to apply.
 */
export function resolveEffectsMode(
  preference,
  probeVerdict,
  reducedTransparency,
) {
  const normalized = normalizeEffectsMode(preference);
  if (normalized !== 'auto') return normalized;
  if (
    reducedTransparency ||
    probeVerdict === 'unsupported' ||
    probeVerdict === 'slow'
  ) {
    return 'simple';
  }
  return 'glass';
}

/**
 * Evaluate consecutive visible requestAnimationFrame deltas.
 *
 * Invalid, incomplete, or hidden-tab-tainted samples return `null` and must not
 * be persisted. The p75 uses the nearest-rank definition and is slow only when
 * it strictly exceeds {@link EFFECTS_PROBE_SLOW_P75_MS}.
 *
 * @param {number[]} frameTimesMs - Consecutive visible-frame deltas in ms.
 * @returns {'fast'|'slow'|null} A cacheable verdict, or `null` to retry.
 */
export function evaluateFrameProbe(frameTimesMs) {
  if (
    !Array.isArray(frameTimesMs) ||
    frameTimesMs.length < EFFECTS_PROBE_MIN_SAMPLES
  ) {
    return null;
  }

  const samples = frameTimesMs.slice(0, EFFECTS_PROBE_MIN_SAMPLES);
  if (
    samples.some(
      (delta) =>
        !Number.isFinite(delta) ||
        delta <= 0 ||
        delta >= EFFECTS_PROBE_HIDDEN_GAP_MS,
    )
  ) {
    return null;
  }

  samples.sort((a, b) => a - b);
  const percentileIndex = Math.ceil(samples.length * 0.75) - 1;
  return samples[percentileIndex] > EFFECTS_PROBE_SLOW_P75_MS
    ? 'slow'
    : 'fast';
}
