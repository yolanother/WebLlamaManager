/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Unit tests for pure effects-tier preference and frame-probe logic. Covers
 * persisted-value normalization, the Auto resolution matrix, percentile
 * thresholds, incomplete samples, and hidden-tab timing gaps under node --test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_EFFECTS_MODE,
  EFFECTS_MODE_STORAGE_KEY,
  EFFECTS_PROBE_HIDDEN_GAP_MS,
  EFFECTS_PROBE_MIN_SAMPLES,
  EFFECTS_PROBE_SLOW_P75_MS,
  EFFECTS_PROBE_VERDICT_STORAGE_KEY,
  EFFECTS_PROBE_VERSION,
  evaluateFrameProbe,
  normalizeEffectsMode,
  resolveEffectsMode,
} from './effectsMode.js';

test('exports the effects preference and versioned probe persistence contract', () => {
  assert.equal(EFFECTS_MODE_STORAGE_KEY, 'effectsMode');
  assert.equal(EFFECTS_PROBE_VERDICT_STORAGE_KEY, 'effectsProbeVerdict');
  assert.equal(DEFAULT_EFFECTS_MODE, 'auto');
  assert.equal(typeof EFFECTS_PROBE_VERSION, 'number');
  assert.ok(EFFECTS_PROBE_VERSION > 0);
});

test('normalizeEffectsMode accepts supported preferences', () => {
  assert.equal(normalizeEffectsMode('auto'), 'auto');
  assert.equal(normalizeEffectsMode('glass'), 'glass');
  assert.equal(normalizeEffectsMode('simple'), 'simple');
});

test('normalizeEffectsMode falls back to Auto for invalid values', () => {
  for (const value of [null, undefined, '', 'system', 'GLASS', 1, {}]) {
    assert.equal(normalizeEffectsMode(value), 'auto');
  }
});

test('resolveEffectsMode always preserves explicit user preferences', () => {
  for (const verdict of [null, 'fast', 'slow', 'unsupported']) {
    assert.equal(resolveEffectsMode('glass', verdict, true), 'glass');
    assert.equal(resolveEffectsMode('simple', verdict, false), 'simple');
  }
});

test('resolveEffectsMode makes Auto simple for accessibility, support, or slow probes', () => {
  assert.equal(resolveEffectsMode('auto', 'fast', true), 'simple');
  assert.equal(resolveEffectsMode('auto', 'unsupported', false), 'simple');
  assert.equal(resolveEffectsMode('auto', 'slow', false), 'simple');
});

test('resolveEffectsMode keeps Auto glass before or after a fast probe', () => {
  assert.equal(resolveEffectsMode('auto', null, false), 'glass');
  assert.equal(resolveEffectsMode('auto', 'fast', false), 'glass');
  assert.equal(resolveEffectsMode('invalid', 'fast', false), 'glass');
});

test('evaluateFrameProbe marks sustained p75 frame time above the threshold slow', () => {
  const frames = Array(EFFECTS_PROBE_MIN_SAMPLES).fill(16);
  const slowestQuarterStart = Math.floor(EFFECTS_PROBE_MIN_SAMPLES * 0.75);
  for (let i = slowestQuarterStart; i < frames.length; i += 1) {
    frames[i] = EFFECTS_PROBE_SLOW_P75_MS + 1;
  }
  frames[slowestQuarterStart - 1] = EFFECTS_PROBE_SLOW_P75_MS + 1;

  assert.equal(evaluateFrameProbe(frames), 'slow');
});

test('evaluateFrameProbe treats a p75 at the threshold as fast', () => {
  assert.equal(
    evaluateFrameProbe(
      Array(EFFECTS_PROBE_MIN_SAMPLES).fill(EFFECTS_PROBE_SLOW_P75_MS),
    ),
    'fast',
  );
});

test('evaluateFrameProbe returns no verdict for empty or short samples', () => {
  assert.equal(evaluateFrameProbe([]), null);
  assert.equal(
    evaluateFrameProbe(Array(EFFECTS_PROBE_MIN_SAMPLES - 1).fill(16)),
    null,
  );
});

test('evaluateFrameProbe rejects invalid deltas and hidden-tab timing gaps', () => {
  const invalid = Array(EFFECTS_PROBE_MIN_SAMPLES).fill(16);
  invalid[4] = Number.NaN;
  assert.equal(evaluateFrameProbe(invalid), null);

  const hidden = Array(EFFECTS_PROBE_MIN_SAMPLES).fill(16);
  hidden[8] = EFFECTS_PROBE_HIDDEN_GAP_MS;
  assert.equal(evaluateFrameProbe(hidden), null);
});
