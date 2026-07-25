// Llama Manager — visibility-aware polling hook contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Specifies browser-independent scheduling behavior with injected visibility
// and timer controls so the polling cadence can be verified under node --test.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createVisiblePollingScheduler } from './useVisiblePolling.js';

function createFakeEnvironment(initialVisibility = 'visible') {
  let now = 0;
  let visibility = initialVisibility;
  let nextTimerId = 1;
  const timers = new Map();
  const listeners = new Set();

  const environment = {
    now: () => now,
    getVisibilityState: () => visibility,
    setTimeout: (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    addVisibilityListener: (listener) => listeners.add(listener),
    removeVisibilityListener: (listener) => listeners.delete(listener),
  };

  const advanceBy = (duration) => {
    const target = now + duration;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = target;
  };

  const setVisibility = (nextVisibility) => {
    visibility = nextVisibility;
    for (const listener of listeners) listener();
  };

  return {
    environment,
    advanceBy,
    setVisibility,
    activeTimerCount: () => timers.size,
    listenerCount: () => listeners.size,
  };
}

test('fires immediately and keeps the visible cadence', () => {
  const fake = createFakeEnvironment();
  const calls = [];
  const polling = createVisiblePollingScheduler(
    () => calls.push(fake.environment.now()),
    1000,
    fake.environment,
  );

  polling.start();
  assert.deepEqual(calls, [0]);

  fake.advanceBy(2999);
  assert.deepEqual(calls, [0, 1000, 2000]);
  fake.advanceBy(1);
  assert.deepEqual(calls, [0, 1000, 2000, 3000]);
});

test('suspends all ticks while hidden', () => {
  const fake = createFakeEnvironment('hidden');
  const calls = [];
  const polling = createVisiblePollingScheduler(
    () => calls.push(fake.environment.now()),
    1000,
    fake.environment,
  );

  polling.start();
  fake.advanceBy(5000);

  assert.deepEqual(calls, []);
  assert.equal(fake.activeTimerCount(), 0);
});

test('fires immediately on visibility return and resumes from that time', () => {
  const fake = createFakeEnvironment();
  const calls = [];
  const polling = createVisiblePollingScheduler(
    () => calls.push(fake.environment.now()),
    1000,
    fake.environment,
  );

  polling.start();
  fake.advanceBy(400);
  fake.setVisibility('hidden');
  fake.advanceBy(5000);
  assert.deepEqual(calls, [0]);

  fake.setVisibility('visible');
  assert.deepEqual(calls, [0, 5400]);
  fake.advanceBy(999);
  assert.deepEqual(calls, [0, 5400]);
  fake.advanceBy(1);
  assert.deepEqual(calls, [0, 5400, 6400]);
});

test('cleanup removes timers and the visibility listener', () => {
  const fake = createFakeEnvironment();
  let calls = 0;
  const polling = createVisiblePollingScheduler(
    () => { calls += 1; },
    1000,
    fake.environment,
  );

  polling.start();
  assert.equal(fake.listenerCount(), 1);
  assert.equal(fake.activeTimerCount(), 1);

  polling.stop();
  assert.equal(fake.listenerCount(), 0);
  assert.equal(fake.activeTimerCount(), 0);

  fake.advanceBy(5000);
  fake.setVisibility('hidden');
  fake.setVisibility('visible');
  assert.equal(calls, 1);
});
