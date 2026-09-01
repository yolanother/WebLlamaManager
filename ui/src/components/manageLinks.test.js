// Llama Manager — chat-first "Manage" navigation model tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies MANAGE_LINKS order, shape, and the single external (llama.cpp UI)
// entry, with no browser or React dependencies.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MANAGE_LINKS } from './manageLinks.js';

test('lists every admin route in the documented order', () => {
  assert.deepEqual(
    MANAGE_LINKS.map((link) => link.key),
    ['dashboard', 'models', 'presets', 'download', 'logs', 'queue', 'processes', 'docs', 'api-docs', 'llama-cpp'],
  );
});

test('every internal entry has a route path and no external flag', () => {
  for (const link of MANAGE_LINKS) {
    if (link.key === 'llama-cpp') continue;
    assert.equal(typeof link.to, 'string');
    assert.ok(link.to.startsWith('/'));
    assert.equal(link.external, undefined);
  }
});

test('the llama.cpp UI entry is external with no internal route', () => {
  const llamaCpp = MANAGE_LINKS.find((link) => link.key === 'llama-cpp');
  assert.equal(llamaCpp.to, null);
  assert.equal(llamaCpp.external, true);
  assert.equal(llamaCpp.label, 'llama.cpp UI');
});

test('the Dashboard entry routes to /dashboard', () => {
  const dashboard = MANAGE_LINKS.find((link) => link.key === 'dashboard');
  assert.equal(dashboard.to, '/dashboard');
});
