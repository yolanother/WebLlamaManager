// Llama Manager — priority request queue contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests verify realtime ordering, background admission bounds, cooperative
// preemption, and starvation prevention for the shared local inference lane.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQueueItemId,
  PriorityRequestQueue,
  normalizeRequestPriority,
  mergeModelDepths,
} from './request-queue.js';

test('normalizes supported priorities and defaults to interactive', () => {
  assert.equal(normalizeRequestPriority('realtime'), 'realtime');
  assert.equal(normalizeRequestPriority('background'), 'background');
  assert.equal(normalizeRequestPriority(undefined), 'interactive');
  assert.throws(() => normalizeRequestPriority('urgent'), /request priority/);
});

test('parses numeric and display-prefixed pending queue identifiers exactly', () => {
  for (const value of ['5', 'q5', 5]) assert.equal(parseQueueItemId(value), 5);
  for (const value of ['', 'q', 'slot5', 'q5junk', '5junk', 'q0', '-1', null]) {
    assert.equal(parseQueueItemId(value), null, String(value));
  }
});

test('realtime skips queued interactive and background work', async () => {
  const queue = new PriorityRequestQueue(1);
  const active = await queue.acquire({ priority: 'interactive' });
  const order = [];
  const background = queue.acquire({ priority: 'background' }).then(id => { order.push('background'); return id; });
  const interactive = queue.acquire({ priority: 'interactive' }).then(id => { order.push('interactive'); return id; });
  const realtime = queue.acquire({ priority: 'realtime' }).then(id => { order.push('realtime'); return id; });

  queue.release(active);
  const realtimeId = await realtime;
  queue.release(realtimeId);
  const interactiveId = await interactive;
  queue.release(interactiveId);
  const backgroundId = await background;
  queue.release(backgroundId);

  assert.deepEqual(order, ['realtime', 'interactive', 'background']);
});

test('realtime cooperatively preempts a running background request', async () => {
  const queue = new PriorityRequestQueue(1);
  let preemptionReason = null;
  const background = await queue.acquire({
    priority: 'background',
    onPreempt: reason => { preemptionReason = reason; },
  });

  const realtimePromise = queue.acquire({ priority: 'realtime' });
  assert.equal(preemptionReason, 'realtime_request');
  queue.release(background);
  queue.release(await realtimePromise);
});

test('duplicate and unidentified releases preserve active capacity and serialization', async () => {
  const queue = new PriorityRequestQueue(1);
  const first = await queue.acquire({ priority: 'interactive' });
  let secondStarted = false;
  const secondPromise = queue.acquire({ priority: 'interactive' }).then(id => {
    secondStarted = true;
    return id;
  });

  queue.release();
  await Promise.resolve();
  assert.equal(secondStarted, false);
  assert.equal(queue.active, 1);

  queue.release(first);
  const second = await secondPromise;
  assert.equal(queue.active, 1);

  let thirdStarted = false;
  const thirdPromise = queue.acquire({ priority: 'interactive' }).then(id => {
    thirdStarted = true;
    return id;
  });
  queue.release(first);
  await Promise.resolve();
  assert.equal(thirdStarted, false);
  assert.equal(queue.active, 1);

  queue.release(second);
  const third = await thirdPromise;
  assert.equal(queue.active, 1);
  queue.release(third);
  assert.equal(queue.active, 0);
});

test('bounds queued background work without affecting interactive admission', async () => {
  const queue = new PriorityRequestQueue(1, { maxBackgroundQueued: 1 });
  const active = await queue.acquire({ priority: 'interactive' });
  const firstBackground = queue.acquire({ priority: 'background' });
  await assert.rejects(
    queue.acquire({ priority: 'background' }),
    error => error.code === 'BACKGROUND_QUEUE_FULL' && error.statusCode === 429,
  );
  const interactive = queue.acquire({ priority: 'interactive' });

  queue.release(active);
  queue.release(await interactive);
  queue.release(await firstBackground);
});

test('background fairness never lets background bypass queued realtime work', async () => {
  const queue = new PriorityRequestQueue(1, { maxHighPriorityBurst: 2 });
  const active = await queue.acquire();
  const order = [];
  const background = queue.acquire({ priority: 'background' }).then(id => { order.push('background'); return id; });
  const realtimeOne = queue.acquire({ priority: 'realtime' }).then(id => { order.push('realtime-1'); return id; });
  const realtimeTwo = queue.acquire({ priority: 'realtime' }).then(id => { order.push('realtime-2'); return id; });
  const realtimeThree = queue.acquire({ priority: 'realtime' }).then(id => { order.push('realtime-3'); return id; });

  queue.release(active);
  queue.release(await realtimeOne);
  queue.release(await realtimeTwo);
  queue.release(await realtimeThree);
  queue.release(await background);
  assert.deepEqual(order, ['realtime-1', 'realtime-2', 'realtime-3', 'background']);
});

test('serves background after a bounded burst of interactive requests', async () => {
  const queue = new PriorityRequestQueue(1, { maxHighPriorityBurst: 2 });
  const active = await queue.acquire();
  const order = [];
  const background = queue.acquire({ priority: 'background' }).then(id => { order.push('background'); return id; });
  const interactiveOne = queue.acquire({ priority: 'interactive' }).then(id => { order.push('interactive-1'); return id; });
  const interactiveTwo = queue.acquire({ priority: 'interactive' }).then(id => { order.push('interactive-2'); return id; });
  const interactiveThree = queue.acquire({ priority: 'interactive' }).then(id => { order.push('interactive-3'); return id; });

  queue.release(active);
  queue.release(await interactiveOne);
  queue.release(await interactiveTwo);
  queue.release(await background);
  queue.release(await interactiveThree);
  assert.deepEqual(order, ['interactive-1', 'interactive-2', 'background', 'interactive-3']);
});

test('contract 4: aborting a pending acquisition removes it and it never activates', async () => {
  const queue = new PriorityRequestQueue(1);
  const holder = await queue.acquire({ endpoint: 'chat', priority: 'interactive' });
  const controller = new AbortController();
  const pending = queue.acquire({
    endpoint: 'chat-job',
    priority: 'interactive',
    signal: controller.signal,
  });

  assert.equal(queue.pending, 1);
  controller.abort('job_cancelled');
  await assert.rejects(
    pending,
    error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR',
  );
  assert.equal(queue.pending, 0);

  queue.release(holder);
  await Promise.resolve();
  assert.equal(queue.active, 0, 'the aborted waiter must not activate after capacity opens');

  const next = await queue.acquire({ endpoint: 'chat', priority: 'interactive' });
  assert.equal(queue.active, 1, 'capacity remains usable by a later request');
  queue.release(next);
});

test('contract 4: an already-aborted acquisition is rejected without consuming capacity', async () => {
  const queue = new PriorityRequestQueue(1);
  const controller = new AbortController();
  controller.abort('client_disconnect');

  await assert.rejects(
    queue.acquire({ endpoint: 'chat-job', signal: controller.signal }),
    error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR',
  );
  assert.equal(queue.pending, 0);
  assert.equal(queue.active, 0);
});

// ── Per-model batching (docs/Designs/ResourceArbiter.md section 3) ───────────

/**
 * Drain a queue one item at a time and return the models in activation order.
 * @param {PriorityRequestQueue} queue - queue holding one active item.
 * @param {number} firstId - id of that active item.
 * @param {Array<Promise<number>>} pending - acquisitions tagged with `.model`.
 * @returns {Promise<string[]>} models in the order they were activated.
 */
async function drainOrder(queue, firstId, pending) {
  const order = [];
  const ids = new Map();
  pending.forEach(p => p.then(id => { order.push(p.model); ids.set(order.length - 1, id); }));
  queue.release(firstId);
  for (let i = 0; i < pending.length; i++) {
    await new Promise(r => setImmediate(r));
    queue.release(ids.get(i));
  }
  await Promise.all(pending);
  return order;
}

/** @param {PriorityRequestQueue} q @param {string} model @param {string} [priority] */
function enqueue(q, model, priority = 'interactive') {
  const p = q.acquire({ model, priority });
  p.model = model;
  return p;
}

/** Count model switches in an activation order, starting from `from`. */
const switches = (from, order) => order.reduce((n, m, i) => n + ((i ? order[i - 1] : from) !== m ? 1 : 0), 0);

test('batching: a mixed-model queue switches at most once per model', async () => {
  const queue = new PriorityRequestQueue(1);
  const first = await queue.acquire({ model: 'A' });
  const pending = ['B', 'A', 'B', 'A', 'C', 'B', 'A'].map(m => enqueue(queue, m));
  const order = await drainOrder(queue, first, pending);
  assert.deepEqual(order, ['A', 'A', 'A', 'B', 'B', 'B', 'C']);
  assert.equal(switches('A', order), 2, 'A -> B -> C');
  // Negative control: the same arrivals in plain FIFO order switch seven times.
  assert.equal(switches('A', ['B', 'A', 'B', 'A', 'C', 'B', 'A']), 7);
});

test('batching never overrides priority: realtime for another model goes first', async () => {
  const queue = new PriorityRequestQueue(1);
  const first = await queue.acquire({ model: 'A' });
  const pending = [enqueue(queue, 'A'), enqueue(queue, 'B', 'realtime')];
  const order = await drainOrder(queue, first, pending);
  assert.deepEqual(order, ['B', 'A']);
});

test('batching is bounded: an older request for another model is served after maxModelBatch jumps', async () => {
  const queue = new PriorityRequestQueue(1, { maxModelBatch: 2 });
  const first = await queue.acquire({ model: 'A' });
  const pending = ['B', 'A', 'A', 'A'].map(m => enqueue(queue, m));
  const order = await drainOrder(queue, first, pending);
  assert.deepEqual(order, ['A', 'A', 'B', 'A']);
});

test('getModelDepths counts active and pending items per model', async () => {
  const queue = new PriorityRequestQueue(1);
  await queue.acquire({ model: 'A' });
  enqueue(queue, 'B'); enqueue(queue, 'B'); enqueue(queue, 'A');
  assert.deepEqual(queue.getModelDepths(), { A: { active: 1, pending: 1 }, B: { active: 0, pending: 2 } });
});

test('getModelDepths and mergeModelDepths are safe for hostile model names', async () => {
  const queue = new PriorityRequestQueue(1);
  await queue.acquire({ model: '__proto__' });
  enqueue(queue, 'constructor'); enqueue(queue, { evil: true }); enqueue(queue, '__proto__');
  const depths = queue.getModelDepths();
  assert.deepEqual(depths.__proto__, { active: 1, pending: 1 });
  assert.deepEqual(depths.constructor, { active: 0, pending: 1 });
  assert.deepEqual(depths.unknown, { active: 0, pending: 1 }, 'a non-string model counts as unknown');
  const merged = mergeModelDepths(depths, { __proto__: { active: 2, pending: 0 } }, JSON.parse('{"__proto__":{"active":1,"pending":1}}'));
  assert.deepEqual(merged.__proto__, { active: 2, pending: 2 }, 'own "__proto__" keys sum; a literal {__proto__: x} sets a prototype and is not a model');
  assert.equal(({}).active, undefined, 'Object.prototype is not polluted');
  assert.equal(({}).pending, undefined);
});
