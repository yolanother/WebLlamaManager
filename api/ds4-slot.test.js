// Llama Manager — unit tests for api/ds4-slot.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
// Verifies single-generation admission, release on every response outcome,
// cancellation while queued, and notification only when a request gains the
// actual DS4 generation slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PriorityRequestQueue } from './request-queue.js';
import { ds4Queue, acquireDs4Slot, setDs4SlotGrantedObserver } from './ds4-slot.js';

/** Minimal stand-in for an Express Response: an EventEmitter with the two
 * flags acquireDs4Slot checks synchronously after acquiring. */
function fakeRes({ destroyed = false, writableEnded = false } = {}) {
  const res = new EventEmitter();
  res.destroyed = destroyed;
  res.writableEnded = writableEnded;
  return res;
}

test('ds4Queue is a real single-concurrency admission queue', () => {
  assert.ok(ds4Queue instanceof PriorityRequestQueue);
  assert.equal(ds4Queue.concurrency, 1);
});

test('normal completion: explicit release() frees the slot for the next queued request', async () => {
  const res1 = fakeRes();
  const res2 = fakeRes();
  const slot1 = await acquireDs4Slot(res1, { activeReqId: 1 });
  assert.equal(ds4Queue.active, 1);

  let acquired2 = false;
  const wait2 = acquireDs4Slot(res2, { activeReqId: 2 }).then((s) => { acquired2 = true; return s; });
  await Promise.resolve();
  assert.equal(acquired2, false, 'second request must wait, not run concurrently');
  assert.equal(ds4Queue.pending, 1, '/api/queue must be able to see it as pending, not active');

  slot1.release(); // simulates the caller's finally after a normal 200 response
  const slot2 = await wait2;
  assert.equal(ds4Queue.active, 1);
  assert.equal(ds4Queue.pending, 0);
  slot2.release();
  assert.equal(ds4Queue.active, 0);
});

test('upstream error: release() in the catch/finally path still frees the slot', async () => {
  const res1 = fakeRes();
  const slot1 = await acquireDs4Slot(res1, { activeReqId: 3 });
  assert.equal(ds4Queue.active, 1);
  try {
    throw new Error('ds4-server request failed: fetch failed');
  } catch {
    slot1.release();
  }
  assert.equal(ds4Queue.active, 0, 'an upstream error must not leak the slot');
});

test('client disconnect: res "close" event releases the slot even without an explicit call', async () => {
  const res1 = fakeRes();
  await acquireDs4Slot(res1, { activeReqId: 4 });
  assert.equal(ds4Queue.active, 1);
  res1.emit('close'); // what the proxy's res.on('close') abort handler triggers
  assert.equal(ds4Queue.active, 0, 'a client disconnect must release the slot without the handler calling release() itself');
});

test('normal completion via the "finish" event also releases the slot', async () => {
  const res1 = fakeRes();
  await acquireDs4Slot(res1, { activeReqId: 5 });
  assert.equal(ds4Queue.active, 1);
  res1.emit('finish');
  assert.equal(ds4Queue.active, 0);
});

test('release is idempotent: explicit release() plus a later res event does not double-free', async () => {
  const res1 = fakeRes();
  const res2 = fakeRes();
  const slot1 = await acquireDs4Slot(res1, { activeReqId: 6 });
  slot1.release();
  assert.equal(ds4Queue.active, 0);

  // A second, unrelated request now legitimately holds the only slot.
  const slot2 = await acquireDs4Slot(res2, { activeReqId: 7 });
  assert.equal(ds4Queue.active, 1);

  // res1's own 'finish'/'close' firing late (after its release() already ran)
  // must NOT release slot2's capacity out from under it.
  res1.emit('finish');
  res1.emit('close');
  assert.equal(ds4Queue.active, 1, 'a stale release from a finished request must not free a slot held by a different request');
  slot2.release();
});

test('swap-recovery retry: each failed attempt releases before the next attempt acquires — no accumulation', async () => {
  // Simulates serveDs4WithSwapRecovery's loop: proxyChatToDs4 acquires, the
  // fetch fails mid-swap, its finally releases, then the loop retries with a
  // fresh activeReqId and acquires again. If a retry failed to release, this
  // second acquire would hang forever waiting behind its own leaked slot.
  const res = fakeRes();
  for (let attempt = 0; attempt < 3; attempt++) {
    const slot = await acquireDs4Slot(res, { activeReqId: 100 + attempt });
    assert.equal(ds4Queue.active, 1);
    assert.equal(ds4Queue.pending, 0);
    slot.release(); // this attempt's finally, whether it succeeded or is about to be retried
  }
  assert.equal(ds4Queue.active, 0);
});

test('an already-ended response releases immediately (queue-wait raced client teardown)', async () => {
  const res1 = fakeRes({ writableEnded: true });
  await acquireDs4Slot(res1, { activeReqId: 8 });
  assert.equal(ds4Queue.active, 0, 'a response that ended before we finished acquiring must not hold the slot');
});

test('abort signal while queued rejects the wait and never holds the slot', async () => {
  const res1 = fakeRes();
  const res2 = fakeRes();
  const slot1 = await acquireDs4Slot(res1, { activeReqId: 9 });
  assert.equal(ds4Queue.active, 1);

  const controller = new AbortController();
  const wait2 = acquireDs4Slot(res2, { activeReqId: 10, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(wait2, /AbortError|aborted/i);
  assert.equal(ds4Queue.pending, 0, 'a cancelled queue-wait must not leave a phantom pending item');

  slot1.release();
  assert.equal(ds4Queue.active, 0);
});

test('the slot-granted observer fires on the grant, not when the request starts waiting', async () => {
  const granted = [];
  setDs4SlotGrantedObserver((info) => granted.push(info));
  try {
    const res1 = fakeRes();
    const res2 = fakeRes();
    const slot1 = await acquireDs4Slot(res1, { activeReqId: 11, model: 'ds4', endpoint: 'chat/completions' });
    assert.deepEqual(granted.map(g => g.activeReqId), [11]);

    const wait2 = acquireDs4Slot(res2, { activeReqId: 12 });
    await Promise.resolve();
    assert.deepEqual(
      granted.map(g => g.activeReqId),
      [11],
      'a request still queued has not started generating — stamping it there is what made queue wait look like a stall',
    );

    slot1.release();
    const slot2 = await wait2;
    assert.deepEqual(granted.map(g => g.activeReqId), [11, 12]);
    assert.equal(granted[0].model, 'ds4');
    assert.equal(granted[0].endpoint, 'chat/completions');
    slot2.release();
  } finally {
    setDs4SlotGrantedObserver(null);
  }
});

test('a throwing observer can never break slot admission', async () => {
  setDs4SlotGrantedObserver(() => { throw new Error('bookkeeping blew up'); });
  try {
    const res = fakeRes();
    const slot = await acquireDs4Slot(res, { activeReqId: 13 });
    assert.equal(ds4Queue.active, 1);
    slot.release();
    assert.equal(ds4Queue.active, 0);
  } finally {
    setDs4SlotGrantedObserver(null);
  }
});
