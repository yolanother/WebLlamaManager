// Llama Manager — manager auto-start scheduling tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the listener-facing scheduling boundary so an explicitly disabled
// manager never posts the engine-start endpoint, including isolated secondary
// instances that must remain passive.

import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleAutoStart } from './auto-start.js';

test('AUTO_START=false schedules no engine start request', () => {
  const effects = [];
  const scheduled = scheduleAutoStart({
    autoStart: false,
    schedule: () => effects.push('schedule'),
    start: () => effects.push('start'),
  });

  assert.equal(scheduled, false);
  assert.deepEqual(effects, []);
});

test('legacy string false cannot trigger auto-start', () => {
  const effects = [];
  const scheduled = scheduleAutoStart({
    autoStart: 'false',
    schedule: () => effects.push('schedule'),
    start: () => effects.push('start'),
  });

  assert.equal(scheduled, false);
  assert.deepEqual(effects, []);
});

test('enabled auto-start schedules one delayed engine start request', () => {
  const effects = [];
  const scheduled = scheduleAutoStart({
    autoStart: true,
    schedule: (callback, delayMs) => {
      effects.push(['schedule', delayMs]);
      callback();
    },
    start: () => effects.push(['start']),
  });

  assert.equal(scheduled, true);
  assert.deepEqual(effects, [['schedule', 1000], ['start']]);
});
