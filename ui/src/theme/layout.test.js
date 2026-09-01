/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Unit tests for the pure Layout preference helper. Covers the persistence
 * contract and normalization of persisted/URL values without requiring
 * browser globals under `node --test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LAYOUT_STORAGE_KEY, DEFAULT_LAYOUT, normalizeLayout } from './layout.js';

test('exports the layout persistence contract', () => {
  assert.equal(LAYOUT_STORAGE_KEY, 'uiLayout');
  assert.equal(DEFAULT_LAYOUT, 'dashboard');
});

test('normalizeLayout accepts every supported value', () => {
  assert.equal(normalizeLayout('dashboard'), 'dashboard');
  assert.equal(normalizeLayout('chat-first'), 'chat-first');
});

test('normalizeLayout falls back to the dashboard default for invalid values', () => {
  for (const value of [null, undefined, '', 'GLASS', 1, {}]) {
    assert.equal(normalizeLayout(value), 'dashboard');
  }
});
