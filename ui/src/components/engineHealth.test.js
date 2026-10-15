// Llama Manager — engineHealthy truth-table tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that engineHealthy(stats) is true when any of the llama, ds4 or
// strata engines reports status 'ok', and false for missing stats, missing
// sub-objects or non-ok statuses.

import test from 'node:test';
import assert from 'node:assert/strict';

import { engineHealthy } from './engineHealth.js';

test('true when any one engine is ok', () => {
  assert.equal(engineHealthy({ llama: { status: 'ok' } }), true);
  assert.equal(engineHealthy({ ds4: { status: 'ok' } }), true);
  assert.equal(engineHealthy({ strata: { status: 'ok' } }), true);
});

test('true when ok engine sits beside non-ok ones', () => {
  assert.equal(engineHealthy({ llama: { status: 'down' }, ds4: { status: 'starting' }, strata: { status: 'ok' } }), true);
});

test('false for null, undefined and empty stats', () => {
  assert.equal(engineHealthy(null), false);
  assert.equal(engineHealthy(undefined), false);
  assert.equal(engineHealthy({}), false);
});

test('false for missing sub-objects and non-ok statuses', () => {
  assert.equal(engineHealthy({ llama: null, ds4: undefined }), false);
  assert.equal(engineHealthy({ llama: {}, ds4: {}, strata: {} }), false);
  assert.equal(engineHealthy({ llama: { status: 'starting' }, ds4: { status: 'error' }, strata: { status: 'stopped' } }), false);
});
