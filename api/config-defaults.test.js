// Llama Manager — configuration-default merge contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Proves package/environment defaults populate an empty persisted config while
// explicit operator values always remain authoritative — except autoStart,
// where AUTO_START=false is a fail-safe veto over a persisted autoStart:true
// (T31079087d6a20: a persisted autoStart:true from a prior run silently
// defeated a boot-time AUTO_START=false override, letting an instance
// auto-start an engine it wasn't supposed to).

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyConfigDefaults } from './config-defaults.js';

test('empty persisted config inherits packaged environment defaults', () => {
  assert.deepEqual(applyConfigDefaults({}, {
    AUTO_START: 'true',
    MODELS_MAX: '3',
    CONTEXT_SIZE: '16384',
  }), {
    autoStart: true,
    modelsMax: 3,
    contextSize: 16384,
    logFilters: [],
    requestLogging: false,
    maxConcurrentRequests: 1,
  });
});

test('absent environment values retain stable source defaults', () => {
  const config = applyConfigDefaults({}, {});
  assert.equal(config.autoStart, true);
  assert.equal(config.modelsMax, 2);
  assert.equal(config.contextSize, 8192);
});

test('explicit persisted values override every environment default', () => {
  const config = applyConfigDefaults({
    autoStart: false,
    modelsMax: 7,
    contextSize: 32768,
  }, {
    AUTO_START: 'true',
    MODELS_MAX: '3',
    CONTEXT_SIZE: '16384',
  });
  assert.equal(config.autoStart, false);
  assert.equal(config.modelsMax, 7);
  assert.equal(config.contextSize, 32768);
});

test('AUTO_START=false vetoes autoStart even over a persisted autoStart:true', () => {
  const config = applyConfigDefaults({ autoStart: true }, { AUTO_START: 'false' });
  assert.equal(config.autoStart, false);
});

test('AUTO_START=false vetoes autoStart with no persisted autoStart key at all', () => {
  const config = applyConfigDefaults({}, { AUTO_START: 'false' });
  assert.equal(config.autoStart, false);
});
