// Llama Manager — tests for the GPU drain decision.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers the three cases the epic names: a model a peer can serve is offloaded rather
// than queued, a model no peer can serve is queued and never errored, and a card with
// nothing resident on it is ready at once. Pure input/output — no server, no timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainPlan, reservationsNeedingDrain } from './gpu-drain.js';

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

// --- reservationsNeedingDrain -----------------------------------------------
//
// A claim that had to queue is bound to a card by the state machine's own promotion
// path, which no route handler observes. Nothing then starts its drain, so it sits
// bound-but-pending until its TTL runs out: `wait` returns 408 forever and the card is
// held without ever being usable. These tests pin down which records the sweep must
// pick up, and — just as importantly — which it must leave alone.

test('a queued claim promoted onto a card needs a drain started', () => {
  const promoted = { id: 'res-2', state: 'pending', card: 'card1' };
  assert.deepEqual(reservationsNeedingDrain([promoted], new Set()), ['res-2']);
});

test('a claim still waiting for a card is not drained', () => {
  // No card bound yet: there is nothing to drain off, and starting one would be a no-op
  // that we would then have to remember not to start again.
  const waiting = { id: 'res-2', state: 'pending', card: null };
  assert.deepEqual(reservationsNeedingDrain([waiting], new Set()), []);
});

test('a drain already running is never started twice', () => {
  // The reserve and lock routes start a drain themselves. Starting a second one races the
  // first over stopping the engine child.
  const pending = { id: 'res-2', state: 'pending', card: 'card1' };
  assert.deepEqual(reservationsNeedingDrain([pending], new Set(['res-2'])), []);
});

test('held, released, expired and preempted records are left alone', () => {
  const records = [
    { id: 'a', state: 'held', card: 'card1' },
    { id: 'b', state: 'released', card: 'card1' },
    { id: 'c', state: 'expired', card: 'card1' },
    { id: 'd', state: 'preempted', card: 'card1' },
  ];
  assert.deepEqual(reservationsNeedingDrain(records, new Set()), []);
});

test('several promoted claims across pools are all reported, in order', () => {
  const records = [
    { id: 'res-9', state: 'pending', card: 'card0' },
    { id: 'res-3', state: 'held', card: 'card1' },
    { id: 'res-4', state: 'pending', card: 'card2' },
    { id: 'res-5', state: 'pending', card: null },
  ];
  assert.deepEqual(reservationsNeedingDrain(records, new Set()), ['res-9', 'res-4']);
});

test('a missing or malformed list is empty, not a throw', () => {
  // This runs on a timer; an exception here would kill TTL expiry for every pool.
  assert.deepEqual(reservationsNeedingDrain(null, new Set()), []);
  assert.deepEqual(reservationsNeedingDrain(undefined, new Set()), []);
  assert.deepEqual(reservationsNeedingDrain([null, undefined], new Set()), []);
});
