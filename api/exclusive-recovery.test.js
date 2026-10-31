// Llama Manager — tests for the exclusive-engine `exhausted` self-recovery policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pins W2b (T32312b18b983c): drakemore's Strata activation failed on 2026-10-19 (CUDA
// refused cuda-busy, HIP reclaim gate unreachable) and its runtime stayed `exhausted`
// until a human re-activated it on 2026-10-31, answering 503 to everything for 12 days.
// The policy retries with exponential backoff (1 min doubling, capped at 30 min) and
// never gives up; the source anchors pin that the GPU sweep drives it for Strata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { exclusiveRecoveryDecision } from './exclusive-recovery.js';

const MIN = 60_000;

test('first sight of exhausted schedules a retry one minute out', () => {
  const d = exclusiveRecoveryDecision({ status: 'exhausted', state: null, now: 0, reason: 'swap-no-backend' });
  assert.equal(d.action, 'wait');
  assert.deepEqual(d.state, { since: 0, attempts: 0, nextAt: MIN, lastReason: 'swap-no-backend' });
});

test('retries when due, doubling the wait up to a 30 minute cap, and never gives up', () => {
  let state = exclusiveRecoveryDecision({ status: 'exhausted', state: null, now: 0 }).state;
  const waits = [];
  for (let i = 0; i < 9; i++) {
    const early = exclusiveRecoveryDecision({ status: 'exhausted', state, now: state.nextAt - 1 });
    assert.equal(early.action, 'wait');
    const due = exclusiveRecoveryDecision({ status: 'exhausted', state, now: state.nextAt });
    assert.equal(due.action, 'retry');
    assert.equal(due.state.attempts, state.attempts + 1);
    waits.push(due.state.nextAt - state.nextAt);
    state = due.state;
  }
  assert.deepEqual(waits.map((w) => w / MIN), [2, 4, 8, 16, 30, 30, 30, 30, 30]);
  assert.equal(state.since, 0, 'since is kept across attempts');
});

test('ready clears the recovery state', () => {
  const d = exclusiveRecoveryDecision({ status: 'ready', state: { since: 0, attempts: 3, nextAt: 9 }, now: 10 });
  assert.deepEqual(d, { action: 'reset', state: null });
});

test('loading, swapping and a wedged stop-unconfirmed never trigger a retry', () => {
  const state = { since: 0, attempts: 1, nextAt: 0 };
  for (const status of ['loading', 'swapping', 'stop-unconfirmed', undefined]) {
    assert.deepEqual(exclusiveRecoveryDecision({ status, state, now: 10 * MIN }), { action: 'idle', state });
  }
});

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

test('the Strata GPU sweep drives the recovery and re-activates the remembered preset', () => {
  const tick = source.slice(source.indexOf('async function strataBackendTick('), source.indexOf('/** In-flight Strata activation'));
  assert.match(tick, /exclusiveRecoveryDecision\(/);
  assert.match(tick, /activateStrataSingleFlight\(/);
});

test('/api/stats exposes the recovery state beside strataRuntime', () => {
  assert.match(source, /strataRecovery:\s*strataState\.recovery/);
});
