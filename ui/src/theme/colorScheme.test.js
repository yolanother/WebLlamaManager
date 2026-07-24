/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Unit tests for the pure color-scheme preference helpers. Covers persisted
 * value normalization and resolution of explicit and system-driven schemes
 * without requiring browser globals under `node --test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_COLOR_SCHEME,
  normalizeColorScheme,
  resolveColorScheme,
} from './colorScheme.js';

test('exports the color-scheme persistence contract', () => {
  assert.equal(COLOR_SCHEME_STORAGE_KEY, 'colorScheme');
  assert.equal(DEFAULT_COLOR_SCHEME, 'dark');
});

test('normalizeColorScheme accepts supported persisted preferences', () => {
  assert.equal(normalizeColorScheme('dark'), 'dark');
  assert.equal(normalizeColorScheme('light'), 'light');
  assert.equal(normalizeColorScheme('system'), 'system');
});

test('normalizeColorScheme falls back to the dark default for invalid values', () => {
  for (const value of [null, undefined, '', 'sepia', 'DARK', 1, {}]) {
    assert.equal(normalizeColorScheme(value), 'dark');
  }
});

test('resolveColorScheme preserves explicit dark and light preferences', () => {
  assert.equal(resolveColorScheme('dark', false), 'dark');
  assert.equal(resolveColorScheme('dark', true), 'dark');
  assert.equal(resolveColorScheme('light', false), 'light');
  assert.equal(resolveColorScheme('light', true), 'light');
});

test('resolveColorScheme follows the supplied system preference', () => {
  assert.equal(resolveColorScheme('system', false), 'light');
  assert.equal(resolveColorScheme('system', true), 'dark');
});

test('resolveColorScheme treats invalid preferences as the dark default', () => {
  assert.equal(resolveColorScheme('invalid', false), 'dark');
  assert.equal(resolveColorScheme(null, true), 'dark');
});
