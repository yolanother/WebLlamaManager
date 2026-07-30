// Llama Manager — priority request queue contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests verify realtime ordering, background admission bounds, cooperative
// preemption, and starvation prevention for the shared local inference lane.

import assert from 'node:assert/strict';
import test from 'node:test';
import { PriorityRequestQueue, normalizeRequestPriority } from './request-queue.js';

test('normalizes supported priorities and defaults to interactive', () => {
  assert.equal(normalizeRequestPriority('realtime'), 'realtime');
  assert.equal(normalizeRequestPriority('background'), 'background');
  assert.equal(normalizeRequestPriority(undefined), 'interactive');
  assert.throws(() => normalizeRequestPriority('urgent'), /request priority/);
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

test('serves background after a bounded burst of realtime requests', async () => {
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
  queue.release(await background);
  queue.release(await realtimeThree);
  assert.deepEqual(order, ['realtime-1', 'realtime-2', 'background', 'realtime-3']);
});
