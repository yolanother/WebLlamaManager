// Llama Manager — unit tests for api/downstream-wait.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The regression these lock down: a router forwarding to a provider whose ds4
// lane is saturated must not tear its own request down while the provider has
// it queued. The final test drives the real ds4Queue and the real
// active-vs-pending rule (activeRequestHoldsSlot) behind a real HTTP server, so
// it exercises the actual router/provider boundary rather than a mock of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import {
  RELAY_REQUEST_ID_HEADER,
  DOWNSTREAM_QUEUE_WAIT_CAP_MS,
  relayRequestIdFor,
  readRelayRequestId,
  downstreamQueueUrl,
  findRelayedQueueItem,
  downstreamWaitDecision,
  probeDownstreamQueue,
  createExtendableDeadline,
} from './downstream-wait.js';
import { ds4Queue, acquireDs4Slot } from './ds4-slot.js';
import { activeRequestHoldsSlot } from './slot-reaper.js';
import { remoteStallVerdict } from './engines.js';

// ── relay request id ────────────────────────────────────────────────────────

test('relayRequestIdFor: identifies the minting node and its request', () => {
  const id = relayRequestIdFor('frostburn-a1b2', 42, 1_700_000_000_000);
  assert.match(id, /^frostburn-a1b2:42:/);
});

test('relayRequestIdFor: the same activeReqId after a restart does not reuse an id', () => {
  const before = relayRequestIdFor('frostburn-a1b2', 1, 1_700_000_000_000);
  const after = relayRequestIdFor('frostburn-a1b2', 1, 1_700_000_600_000);
  assert.notEqual(before, after, 'a restarted router must not collide with its own earlier request');
});

test('relayRequestIdFor: strips anything that cannot travel in a header value', () => {
  const id = relayRequestIdFor('node\r\nX-Injected: 1', 7, 0);
  assert.doesNotMatch(id, /[\r\n]/);
});

test('readRelayRequestId: reads the header, and reports null for a direct client request', () => {
  assert.equal(readRelayRequestId({ [RELAY_REQUEST_ID_HEADER]: 'frostburn:9:abc' }), 'frostburn:9:abc');
  assert.equal(readRelayRequestId({}), null);
  assert.equal(readRelayRequestId({ [RELAY_REQUEST_ID_HEADER]: '   ' }), null);
  assert.equal(readRelayRequestId(undefined), null);
});

// ── queue url derivation ────────────────────────────────────────────────────

test('downstreamQueueUrl: derives the manager queue url from an OpenAI-style base url', () => {
  assert.equal(downstreamQueueUrl('http://drakemore.local:3001/v1'), 'http://drakemore.local:3001/api/queue');
  assert.equal(downstreamQueueUrl('http://10.0.0.5:3001'), 'http://10.0.0.5:3001/api/queue');
  assert.equal(downstreamQueueUrl('https://box:8443/v1/'), 'https://box:8443/api/queue');
});

test('downstreamQueueUrl: refuses to guess for a url it cannot parse', () => {
  assert.equal(downstreamQueueUrl('not a url'), null);
  assert.equal(downstreamQueueUrl(''), null);
  assert.equal(downstreamQueueUrl(undefined), null);
});

// ── finding our request in a provider's queue ───────────────────────────────

const providerPayload = (items) => ({ items, concurrency: 1, totalQueued: items.length });

test('findRelayedQueueItem: finds our own forwarded request and ignores everyone else', () => {
  const payload = providerPayload([
    { id: 1, status: 'active', relayRequestId: null },
    { id: 2, status: 'pending', relayRequestId: 'frostburn:7:abc' },
  ]);
  assert.equal(findRelayedQueueItem(payload, 'frostburn:7:abc').id, 2);
  assert.equal(findRelayedQueueItem(payload, 'frostburn:8:abc'), null);
  assert.equal(findRelayedQueueItem(payload, null), null);
  assert.equal(findRelayedQueueItem({}, 'frostburn:7:abc'), null);
});

test('findRelayedQueueItem: when a provider re-served the request, the live attempt wins', () => {
  const payload = providerPayload([
    { id: 4, status: 'pending', relayRequestId: 'frostburn:7:abc', enqueuedAt: 1_000 },
    { id: 5, status: 'active', relayRequestId: 'frostburn:7:abc', enqueuedAt: 9_000 },
  ]);
  assert.equal(findRelayedQueueItem(payload, 'frostburn:7:abc').id, 5, 'a stale entry must not speak for the live one');
});

// ── the extend-or-give-up decision ──────────────────────────────────────────

test('downstreamWaitDecision: provider reports it queued -> hold the request open', () => {
  const d = downstreamWaitDecision({
    item: { status: 'pending', queuePosition: 2 },
    waitingSince: 1_000,
    now: 1_000 + 600_000, // well past any generation ceiling
  });
  assert.equal(d.extend, true);
  assert.match(d.reason, /position 2/);
});

test('downstreamWaitDecision: provider reports it generating -> the normal ceiling applies again', () => {
  const d = downstreamWaitDecision({ item: { status: 'active' }, waitingSince: 1_000, now: 2_000 });
  assert.equal(d.extend, false);
  assert.match(d.reason, /status=active/);
});

test('downstreamWaitDecision: no evidence (provider does not know the request) -> do not extend', () => {
  const d = downstreamWaitDecision({ item: null, waitingSince: null, now: 2_000 });
  assert.equal(d.extend, false);
});

test('downstreamWaitDecision: a provider queue that never drains is capped', () => {
  const start = 1_000;
  const item = { status: 'pending' };
  assert.equal(downstreamWaitDecision({ item, waitingSince: start, now: start + DOWNSTREAM_QUEUE_WAIT_CAP_MS - 1 }).extend, true);
  const capped = downstreamWaitDecision({ item, waitingSince: start, now: start + DOWNSTREAM_QUEUE_WAIT_CAP_MS });
  assert.equal(capped.extend, false);
  assert.match(capped.reason, /not draining/);
});

test('downstreamWaitDecision: the cap is well clear of a normal ds4 queue wait', () => {
  // A ds4 slot holder is bounded at 8 min and concurrency is 1, so a queue a
  // few requests deep must comfortably fit inside the cap.
  assert.ok(DOWNSTREAM_QUEUE_WAIT_CAP_MS >= 3 * 480_000);
});

// ── probing a provider ──────────────────────────────────────────────────────

test('probeDownstreamQueue: an unreachable or non-manager backend is "no evidence", never a throw', async () => {
  const failing = async () => { throw new Error('ECONNREFUSED'); };
  const down = await probeDownstreamQueue({ backendUrl: 'http://127.0.0.1:1/v1', relayRequestId: 'x:1:a', fetchImpl: failing });
  assert.deepEqual({ reachable: down.reachable, item: down.item }, { reachable: false, item: null });

  const notFound = async () => ({ ok: false, status: 404 });
  const missing = await probeDownstreamQueue({ backendUrl: 'http://host:3001/v1', relayRequestId: 'x:1:a', fetchImpl: notFound });
  assert.equal(missing.reachable, false);

  const garbage = async () => ({ ok: true, json: async () => { throw new Error('not json'); } });
  const bad = await probeDownstreamQueue({ backendUrl: 'http://host:3001/v1', relayRequestId: 'x:1:a', fetchImpl: garbage });
  assert.equal(bad.reachable, false);
});

// ── the renewable attempt deadline ──────────────────────────────────────────

/** Manual timer wheel: run the single pending timer, awaiting its async body. */
function fakeTimers() {
  let pending = null;
  let seq = 0;
  return {
    setTimeoutFn: (fn, ms) => { pending = { fn, ms, id: ++seq }; return pending.id; },
    clearTimeoutFn: (id) => { if (pending?.id === id) pending = null; },
    hasPending: () => pending != null,
    async fire() {
      const due = pending;
      assert.ok(due, 'expected a pending timer');
      pending = null;
      await due.fn();
    },
  };
}

test('createExtendableDeadline: renews while the check says "still queued", fires once it stops', async () => {
  const timers = fakeTimers();
  let queued = true;
  let timedOut = 0;
  const deadline = createExtendableDeadline({
    timeoutMs: 1_000,
    onExpire: () => queued,
    onTimeout: () => { timedOut++; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  await timers.fire();
  await timers.fire();
  assert.equal(timedOut, 0, 'a request the provider has queued must not be aborted');
  assert.equal(deadline.renewals(), 2);

  queued = false;
  await timers.fire();
  assert.equal(timedOut, 1, 'once it is no longer queued, the deadline must fire');
  assert.equal(timers.hasPending(), false);
});

test('createExtendableDeadline: a failing check is not evidence — it times out as before', async () => {
  const timers = fakeTimers();
  let timedOut = 0;
  createExtendableDeadline({
    timeoutMs: 1_000,
    onExpire: async () => { throw new Error('probe blew up'); },
    onTimeout: () => { timedOut++; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  await timers.fire();
  assert.equal(timedOut, 1);
});

test('createExtendableDeadline: cancelling mid-check cannot abort a request that already answered', async () => {
  const timers = fakeTimers();
  let timedOut = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const deadline = createExtendableDeadline({
    timeoutMs: 1_000,
    onExpire: async () => { await gate; return false; },
    onTimeout: () => { timedOut++; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const firing = timers.fire();
  deadline.cancel();   // headers arrived while we were mid-probe
  release();
  await firing;
  assert.equal(timedOut, 0, 'a cancelled deadline must not abort the response it was guarding');
});

// ── router vs. a saturated provider ds4 queue (the actual regression) ───────

/** Minimal stand-in for an Express Response, as acquireDs4Slot uses it. */
function fakeRes() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  return res;
}

/**
 * A provider node: real ds4Queue admission, and an /api/queue rendered with the
 * same active-vs-pending rule server.js uses (activeRequestHoldsSlot), so the
 * router in this test is reading the provider's real ownership answer.
 */
async function startProvider(activeRequestsById) {
  const server = createServer((req, res) => {
    const ds4SlotHolders = new Set();
    for (const item of ds4Queue.activeItems.values()) {
      if (item.activeReqId != null) ds4SlotHolders.add(item.activeReqId);
    }
    const positions = new Map();
    ds4Queue.queue.forEach((item, idx) => {
      if (item.activeReqId != null) positions.set(item.activeReqId, idx + 1);
    });
    const items = [...activeRequestsById.entries()].map(([id, ar]) => ({
      id,
      status: activeRequestHoldsSlot(ar, id, new Set(), ds4SlotHolders) ? 'active' : 'pending',
      backend: ar.backend,
      tokens: 0,
      relayRequestId: ar.relayRequestId || null,
      queuePosition: positions.get(id),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items, concurrency: 1, totalQueued: ds4Queue.queue.length }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test('a routed request queued behind the provider\'s ds4 slot is held open, not expired', async () => {
  const relayRequestId = relayRequestIdFor('frostburn-a1b2', 21, 1_700_000_000_000);
  // Provider state: a local background job owns the ds4 slot, our forwarded
  // request is behind it. Exactly the reported Frostburn -> Drakemore shape.
  const activeRequestsById = new Map([
    [1, { backend: 'ds4', relayRequestId: null }],
    [2, { backend: 'ds4', relayRequestId }],
  ]);
  const { server, url } = await startProvider(activeRequestsById);

  const holder = await acquireDs4Slot(fakeRes(), { activeReqId: 1 });
  const queuedRes = fakeRes();
  const waiting = acquireDs4Slot(queuedRes, { activeReqId: 2 });
  await Promise.resolve();

  try {
    // Router side: its attempt deadline expires while the provider still has us
    // queued. It must renew rather than abort-and-resend.
    const timers = fakeTimers();
    let aborted = 0;
    const waitState = { since: null };
    const checkQueued = async () => {
      const { item } = await probeDownstreamQueue({ backendUrl: url, relayRequestId });
      const now = Date.now();
      const decision = downstreamWaitDecision({ item, waitingSince: waitState.since, now });
      if (!decision.extend) { waitState.since = null; return false; }
      if (waitState.since == null) waitState.since = now;
      return true;
    };
    const deadline = createExtendableDeadline({
      timeoutMs: 1_000,
      onExpire: checkQueued,
      onTimeout: () => { aborted++; },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    await timers.fire();
    await timers.fire();
    assert.equal(aborted, 0, 'the router must not expire a request the provider has queued');
    assert.equal(deadline.renewals(), 2);

    // Provider drains: the holder finishes and our request takes the slot.
    holder.release();
    await waiting;
    assert.ok([...ds4Queue.activeItems.values()].some((i) => i.activeReqId === 2));

    // Now it owns the generation slot, so the normal ceiling applies again and
    // the router stops renewing — a request that goes silent WHILE generating
    // is still a stall the router will act on.
    await timers.fire();
    assert.equal(aborted, 1);
    deadline.cancel();
  } finally {
    queuedRes.emit('close');
    server.close();
    await once(server, 'close');
  }
  assert.equal(ds4Queue.active, 0, 'no slot may leak out of this test');
});

test('a routed request the provider does not know about is still expired', async () => {
  const activeRequestsById = new Map([[1, { backend: 'ds4', relayRequestId: null }]]);
  const { server, url } = await startProvider(activeRequestsById);
  try {
    const { reachable, item } = await probeDownstreamQueue({ backendUrl: url, relayRequestId: 'frostburn-a1b2:99:zz' });
    assert.equal(reachable, true, 'the provider answered');
    assert.equal(item, null, 'but it has no such request — a router must not hold the request open on that');
    assert.equal(downstreamWaitDecision({ item, waitingSince: null, now: Date.now() }).extend, false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// ── server.js wiring (structural) ───────────────────────────────────────────
//
// The pure logic above can be perfect and the bug still live if server.js does
// not use it. These lock the four seams the fix depends on.

const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

test('fetchRemoteBackend forwards the relay request id and renews its attempt deadline', () => {
  const start = serverSource.indexOf('async function fetchRemoteBackend(');
  assert.ok(start >= 0);
  const body = serverSource.slice(start, start + 6000);
  assert.match(
    body,
    /\[RELAY_REQUEST_ID_HEADER\]: relayRequestId/,
    'every forwarded request must carry the id the provider echoes back in /api/queue',
  );
  assert.match(
    body,
    /const timeout = createExtendableDeadline\(\{[\s\S]*?onExpire: \(\) => forwardedRequestIsQueuedDownstream\(backend, relayRequestId, deadlineWait, label\),[\s\S]*?onTimeout: \(\) => controller\.abort\(\),/,
    'the per-attempt deadline must be renewable while the provider reports the request queued',
  );
  assert.doesNotMatch(
    body,
    /setTimeout\(\(\) => controller\.abort\(\), attemptTimeoutMs\)/,
    'the bare abort-on-timeout is what re-enqueued a queued request; it must not come back',
  );
});

test('a relayed request keeps the id it arrived with, so the whole chain correlates', () => {
  const start = serverSource.indexOf('async function fetchRemoteBackend(');
  const body = serverSource.slice(start, start + 6000);
  assert.match(body, /const relayRequestId = entry\?\.relayRequestId\s*\|\|/);
});

test('/api/queue echoes the relay request id and never reports queue wait as active time', () => {
  const start = serverSource.indexOf("app.get('/api/queue'");
  assert.ok(start >= 0);
  const body = serverSource.slice(start, start + 6000);
  assert.match(body, /relayRequestId: ar\.relayRequestId \|\| null/, 'the router finds its request by this field');
  assert.match(
    body,
    /} else if \(isOffloaded && holdsSlot\) \{/,
    'a ds4 request that has not been granted the slot must not report activeElapsed',
  );
});

test('the ds4 lane stamps slot acquisition, so the ceiling is anchored to generation', () => {
  assert.match(
    serverSource,
    /setDs4SlotGrantedObserver\(\(\{ activeReqId \}\) => markGenerationSlotAcquired\(activeReqId\)\)/,
    'ds4 slot grants must start the active clock the same way local slot grants do',
  );
  assert.match(
    serverSource,
    /function markGenerationSlotAcquired\(activeReqId\) \{[\s\S]*?entry\.lastActivityAt = now;\s*entry\.slotAcquiredAt = now;/,
    'the stamp must reset the stall clock and record when generation started',
  );
});

test('every request that registers as active records the relay id it arrived with', () => {
  const starts = [...serverSource.matchAll(/const activeReqId = startActiveRequest\(\{/g)];
  assert.ok(starts.length >= 4, 'expected the known startActiveRequest call sites');
  for (const match of starts) {
    const call = serverSource.slice(match.index, match.index + 700);
    const end = call.indexOf('});');
    assert.match(
      call.slice(0, end),
      /relayRequestId: readRelayRequestId\(req\.headers\)/,
      'a provider that drops the inbound relay id cannot be asked about the request later',
    );
  }
});

// ── both watchdogs, driven by real queue state ──────────────────────────────

test('provider watchdog: the ds4 slot holder is reaped, the request queued behind it is not', async () => {
  // Drakemore's side of the report: a zero-token job owns the single ds4 slot
  // while a forwarded request waits. Only the holder may be killed — killing
  // the waiter is what sent its caller back to the end of this queue.
  const holder = await acquireDs4Slot(fakeRes(), { activeReqId: 31 });
  const waiterRes = fakeRes();
  const waiting = acquireDs4Slot(waiterRes, { activeReqId: 32 });
  await Promise.resolve();

  try {
    const ds4SlotHolders = new Set([...ds4Queue.activeItems.values()].filter(i => i.activeReqId != null).map(i => i.activeReqId));
    const ds4SlotWaiters = new Set(ds4Queue.queue.filter(i => i.activeReqId != null).map(i => i.activeReqId));
    assert.deepEqual([...ds4SlotHolders], [31]);
    assert.deepEqual([...ds4SlotWaiters], [32]);

    const arrivedAt = 1_000_000_000;
    const now = arrivedAt + 900_000; // 15 min of silence for both
    const entries = new Map([
      [31, { backend: 'ds4', startTime: arrivedAt, lastActivityAt: arrivedAt, slotAcquiredAt: arrivedAt }],
      [32, { backend: 'ds4', startTime: arrivedAt, lastActivityAt: arrivedAt, slotAcquiredAt: null }],
    ]);
    const verdicts = new Map(
      [...entries].map(([id, entry]) => [id, remoteStallVerdict({
        entry,
        holdsDs4Slot: ds4SlotHolders.has(id),
        queuedForDs4Slot: ds4SlotWaiters.has(id),
        now,
        genericRemoteStallMs: 393_216,
      })]),
    );
    assert.equal(verdicts.get(31).action, 'stalled', 'the zero-token slot holder must still be bounded');
    assert.equal(verdicts.get(32).action, 'skip', 'the request queued behind it must survive');

    // And once the holder is reaped and the slot passes to the waiter, the
    // waiter's own ceiling starts from ITS acquisition, not from arrival.
    holder.release();
    await waiting;
    const promoted = { backend: 'ds4', startTime: arrivedAt, lastActivityAt: now, slotAcquiredAt: now };
    assert.equal(
      remoteStallVerdict({ entry: promoted, holdsDs4Slot: true, queuedForDs4Slot: false, now, genericRemoteStallMs: 393_216 }).action,
      'skip',
    );
  } finally {
    waiterRes.emit('close');
  }
  assert.equal(ds4Queue.active, 0);
});

test('router watchdog: a forwarded request outlives its remote ceiling while the provider has it queued', async () => {
  const relayRequestId = relayRequestIdFor('frostburn-a1b2', 55, 1_700_000_000_000);
  const activeRequestsById = new Map([
    [1, { backend: 'ds4', relayRequestId: null }],
    [2, { backend: 'ds4', relayRequestId }],
  ]);
  const { server, url } = await startProvider(activeRequestsById);
  const holder = await acquireDs4Slot(fakeRes(), { activeReqId: 1 });
  const queuedRes = fakeRes();
  const waiting = acquireDs4Slot(queuedRes, { activeReqId: 2 });
  await Promise.resolve();

  // The router's own view: a remote-backed entry that has produced nothing.
  const backend = { id: 'drakemore-mtj8prpy', name: 'Drakemore', url };
  const arrivedAt = Date.now() - 900_000; // 15 min, way past the generic ceiling
  const entry = { backend: backend.id, startTime: arrivedAt, lastActivityAt: arrivedAt, relayRequestId, _downstreamWait: { since: null } };

  /** One watchdog tick, as server.js's remote branch performs it. */
  const tick = async () => {
    const verdict = remoteStallVerdict({ entry, holdsDs4Slot: false, queuedForDs4Slot: false, now: Date.now(), genericRemoteStallMs: 393_216 });
    if (verdict.action === 'skip') return 'skipped';
    const { item } = await probeDownstreamQueue({ backendUrl: backend.url, relayRequestId: entry.relayRequestId });
    const now = Date.now();
    const decision = downstreamWaitDecision({ item, waitingSince: entry._downstreamWait.since, now });
    if (decision.extend) {
      if (entry._downstreamWait.since == null) entry._downstreamWait.since = now;
      entry.lastActivityAt = now;
      return 'held';
    }
    entry._downstreamWait.since = null;
    return 'killed';
  };

  try {
    assert.equal(await tick(), 'held', 'the ceiling is blown, but the provider says we are queued');
    assert.equal(await tick(), 'skipped', 'and the extension put the request back inside the ceiling');

    // The provider's queue drains and our request takes the slot.
    holder.release();
    await waiting;
    entry.lastActivityAt = Date.now() - 900_000; // now genuinely silent while it holds the slot
    assert.equal(await tick(), 'killed', 'a request the provider is actually running is still bounded by the router');
  } finally {
    queuedRes.emit('close');
    server.close();
    await once(server, 'close');
  }
  assert.equal(ds4Queue.active, 0);
});

test('DS4 chat and completions share the tracked abort controller so watchdog kills release the slot', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const functions = [
    ['proxyChatToDs4', 'proxyCompletionsToDs4'],
    ['proxyCompletionsToDs4', 'app.post'],
  ];

  for (const [name, nextMarker] of functions) {
    const start = source.indexOf(`async function ${name}`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.indexOf(nextMarker === 'app.post' ? nextMarker : `async function ${nextMarker}`, start + 1);
    assert.ok(end > start, `${name} must have a bounded source section`);
    const body = source.slice(start, end);

    assert.match(
      body,
      /const controller = activeRequests\.get\(activeReqId\)\?\.abortController;/,
      `${name} must use the controller the stall watchdog aborts`,
    );
    assert.doesNotMatch(
      body,
      /const controller = new AbortController\(\);/,
      `${name} must not create a disconnected controller`,
    );
    assert.match(body, /signal: controller\?\.signal/, `${name} must pass the tracked signal to DS4 work`);
    assert.match(body, /finally \{\s*ds4Slot\.release\(\);\s*\}/, `${name} must release its slot after abort rejection`);
  }
});
