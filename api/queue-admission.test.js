// Llama Manager — tests for the local-queue admission policy.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueAdmissionDecision,
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_HARD_MAX,
  DEFAULT_STALL_MS,
} from './queue-admission.js';

// Defaults sanity — the whole point of the fix is a soft cap well above the old fixed 8.
test('defaults: soft cap raised well above the old 8, with a hard backstop and stall window', () => {
  assert.equal(DEFAULT_MAX_QUEUE_DEPTH, 32);
  assert.equal(DEFAULT_HARD_MAX, 256);
  assert.equal(DEFAULT_STALL_MS, 60_000);
});

// 1. Normal busy + draining -> accept (below the soft cap).
test('below the soft cap -> accept (normal busy operation)', () => {
  const d = queueAdmissionDecision({ pending: 5, active: 1, msSinceLastCompletion: 500 });
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'under-cap');
});

test('at old fixed cap (8) with no remote -> still accept, does NOT fail like before', () => {
  const d = queueAdmissionDecision({ pending: 8, active: 1, msSinceLastCompletion: 1000 });
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'under-cap');
});

// 2. Overflow with a viable remote -> offload.
test('at/over the soft cap WITH a viable remote -> offload', () => {
  const d = queueAdmissionDecision({
    pending: DEFAULT_MAX_QUEUE_DEPTH,
    active: 1,
    hasViableRemote: true,
    msSinceLastCompletion: 500,
  });
  assert.equal(d.action, 'offload');
  assert.equal(d.reason, 'overflow-offload');
});

test('offload is preferred over the hard ceiling when a remote exists', () => {
  const d = queueAdmissionDecision({
    pending: DEFAULT_HARD_MAX + 50,
    active: 1,
    hasViableRemote: true,
    msSinceLastCompletion: DEFAULT_STALL_MS + 1000,
  });
  assert.equal(d.action, 'offload');
});

// 3. Deep + stalled (no completion within stallMs, no remote) -> reject (wedge protection).
test('deep + stalled (no completion in stallMs) with no remote -> reject', () => {
  const d = queueAdmissionDecision({
    pending: DEFAULT_MAX_QUEUE_DEPTH + 5,
    active: 1,
    hasViableRemote: false,
    msSinceLastCompletion: DEFAULT_STALL_MS + 1,
  });
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'stalled');
});

// Deep but DRAINING (recent completion) -> accept, even far above the old cap.
test('deep but draining (recent completion) with no remote -> accept, queue is allowed to grow', () => {
  const d = queueAdmissionDecision({
    pending: DEFAULT_MAX_QUEUE_DEPTH + 20,
    active: 1,
    hasViableRemote: false,
    msSinceLastCompletion: 2000, // completed 2s ago -> draining fine
  });
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'deep-draining');
});

// Deep with nothing active yet cannot be "stalled" (no in-flight work to stall on) -> accept.
test('deep with active=0 is not treated as stalled -> accept', () => {
  const d = queueAdmissionDecision({
    pending: DEFAULT_MAX_QUEUE_DEPTH + 3,
    active: 0,
    hasViableRemote: false,
    msSinceLastCompletion: DEFAULT_STALL_MS + 5000,
  });
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'deep-draining');
});

// 4. Hard ceiling -> reject (runaway backstop), even while draining.
test('at/over the hard ceiling with no remote -> reject even if draining', () => {
  const d = queueAdmissionDecision({
    pending: DEFAULT_HARD_MAX,
    active: 1,
    hasViableRemote: false,
    msSinceLastCompletion: 100, // draining, but runaway backstop still fires
  });
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'hard-ceiling');
});

// Configurable overrides are honored.
test('custom maxQueueDepth/hardMax/stallMs are honored', () => {
  // Custom soft cap of 4: pending 4 with no remote and stalled -> reject.
  const stalled = queueAdmissionDecision({
    pending: 4,
    active: 1,
    hasViableRemote: false,
    maxQueueDepth: 4,
    hardMax: 100,
    stallMs: 10_000,
    msSinceLastCompletion: 10_000,
  });
  assert.equal(stalled.action, 'reject');
  assert.equal(stalled.reason, 'stalled');

  // Just below the custom soft cap -> accept.
  const ok = queueAdmissionDecision({
    pending: 3,
    active: 1,
    hasViableRemote: false,
    maxQueueDepth: 4,
    hardMax: 100,
    stallMs: 10_000,
    msSinceLastCompletion: 10_000,
  });
  assert.equal(ok.action, 'accept');
  assert.equal(ok.reason, 'under-cap');
});

// Boundary: exactly at stallMs counts as stalled (>=), one ms under does not.
test('stall boundary is inclusive at stallMs', () => {
  const base = {
    pending: DEFAULT_MAX_QUEUE_DEPTH,
    active: 1,
    hasViableRemote: false,
  };
  assert.equal(
    queueAdmissionDecision({ ...base, msSinceLastCompletion: DEFAULT_STALL_MS }).action,
    'reject'
  );
  assert.equal(
    queueAdmissionDecision({ ...base, msSinceLastCompletion: DEFAULT_STALL_MS - 1 }).action,
    'accept'
  );
});
