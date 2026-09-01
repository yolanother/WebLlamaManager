/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Unit tests for the pure Look preference helper. Covers the persistence
 * contract and normalization of persisted/URL values without requiring
 * browser globals under `node --test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOOK_STORAGE_KEY, DEFAULT_LOOK, normalizeLook } from './look.js';

test('exports the look persistence contract', () => {
  assert.equal(LOOK_STORAGE_KEY, 'uiLook');
  assert.equal(DEFAULT_LOOK, 'professional');
});

test('normalizeLook accepts every supported value', () => {
  assert.equal(normalizeLook('classic'), 'classic');
  assert.equal(normalizeLook('professional'), 'professional');
});

test('normalizeLook falls back to the professional default for invalid values', () => {
  for (const value of [null, undefined, '', 'GLASS', 1, {}]) {
    assert.equal(normalizeLook(value), 'professional');
  }
});
