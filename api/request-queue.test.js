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
