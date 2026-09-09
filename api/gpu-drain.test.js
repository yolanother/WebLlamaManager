// Llama Manager — tests for the GPU drain decision.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers the three cases the epic names: a model a peer can serve is offloaded rather
// than queued, a model no peer can serve is queued and never errored, and a card with
// nothing resident on it is ready at once. Pure input/output — no server, no timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainPlan } from './gpu-drain.js';

test('a card with nothing on it is ready at once', () => {
  const plan = drainPlan({});
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.offload, []);
  assert.deepEqual(plan.queue, []);
  assert.deepEqual(plan.stop, []);
  assert.match(plan.reason, /nothing/i);
});

test('a model a peer can serve is offloaded, not queued', () => {
  const plan = drainPlan({ models: [{ id: 'llama-3.1-8b', hasViableRemote: true }] });
  assert.deepEqual(plan.offload, ['llama-3.1-8b']);
  assert.deepEqual(plan.queue, []);
});

test('a model no peer can serve is queued, never errored', () => {
  const plan = drainPlan({ models: [{ id: 'gpt-oss-120b', hasViableRemote: false }] });
  assert.deepEqual(plan.queue, ['gpt-oss-120b']);
  assert.deepEqual(plan.offload, []);
  // The whole point: nothing here can refuse a request.
  assert.equal(plan.error, undefined);
});

test('a model with no remote information at all is queued rather than assumed routable', () => {
  const plan = drainPlan({ models: [{ id: 'mystery' }] });
  assert.deepEqual(plan.queue, ['mystery']);
});

test('offload and queue are decided per model, not for the whole card', () => {
  const plan = drainPlan({
    models: [
      { id: 'small', hasViableRemote: true },
      { id: 'huge', hasViableRemote: false },
      { id: 'other', hasViableRemote: true },
    ],
  });
  assert.deepEqual(plan.offload, ['small', 'other']);
  assert.deepEqual(plan.queue, ['huge']);
});

test('the children bound to the card are stopped and the plan is not yet ready', () => {
  const plan = drainPlan({ children: ['llama-router'] });
  assert.deepEqual(plan.stop, ['llama-router']);
  assert.equal(plan.ready, false);
  assert.match(plan.reason, /llama-router/);
});

test('resident models keep the plan un-ready even when no child needs stopping', () => {
  const plan = drainPlan({ models: [{ id: 'small', hasViableRemote: true }] });
  assert.equal(plan.ready, false);
});

test('work still in flight keeps the card un-ready even with nothing resident', () => {
  const plan = drainPlan({ inFlight: 2 });
  assert.equal(plan.ready, false);
  assert.match(plan.reason, /2/);
});

test('in-flight work reported per model counts toward the total', () => {
  const plan = drainPlan({ models: [{ id: 'small', hasViableRemote: true, inFlight: 3 }] });
  assert.equal(plan.ready, false);
  assert.match(plan.reason, /3/);
});

test('a card whose last request has finished and whose child is gone is ready', () => {
  const plan = drainPlan({ models: [], children: [], inFlight: 0 });
  assert.equal(plan.ready, true);
});

test('malformed model entries are ignored rather than throwing mid-drain', () => {
  const plan = drainPlan({ models: [null, { id: '' }, 'not-an-object', { id: 'real' }] });
  assert.deepEqual(plan.queue, ['real']);
  assert.deepEqual(plan.offload, []);
});
