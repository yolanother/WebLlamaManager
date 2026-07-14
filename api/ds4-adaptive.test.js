// Llama Manager — unit tests for the adaptive DS4 memory/context planner + controller.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Verifies the pure, no-I/O attempt planner (planDs4Attempts) and the injected-I/O
// activation iterator (runDs4AdaptivePlan) in ds4-adaptive.js WITHOUT booting the
// server or loading the 81GB ds4 model: the non-streaming ctx ladder scaled to a
// memory-fit estimate, the minContext floor, the 'off'/'on'/'auto' streaming modes,
// the streaming ladder that re-raises context, the "weights don't fit → jump to
// streaming" shortcut, single-attempt non-adaptive mode, and the controller loop that
// advances on load-failure, stops on ready (recording the settled config), and aborts
// after exhausting all attempts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planDs4Attempts,
  runDs4AdaptivePlan,
  DEFAULT_DS4_KV_BYTES_PER_TOKEN,
  DEFAULT_DS4_SAFETY_BYTES,
  DEFAULT_DS4_STREAMING_WEIGHT_BYTES,
} from './ds4-adaptive.js';

const GB = 1024 * 1024 * 1024;

// ── planDs4Attempts ──────────────────────────────────────────────────────────
test('planDs4Attempts: dedicated box (plenty of RAM) → first attempt is full ctx, non-streaming', () => {
  const attempts = planDs4Attempts({
    configuredContext: 131072,
    minContext: 8192,
    availBytes: 300 * GB,
    weightBytes: 80 * GB,
    ssdStreamingMode: 'auto',
  });
  assert.equal(attempts[0].context, 131072);
  assert.equal(attempts[0].ssdStreaming, false);
});

test('planDs4Attempts: tight memory → non-streaming ladder starts BELOW configured, floored at minContext', () => {
  // avail 90G, weight 80G, safety 5G → fit = 5G/128KiB = 40960 tokens.
  const attempts = planDs4Attempts({
    configuredContext: 131072,
    minContext: 8192,
    availBytes: 90 * GB,
    weightBytes: 80 * GB,
    kvBytesPerToken: 128 * 1024,
    safetyBytes: 5 * GB,
    ssdStreamingMode: 'off', // isolate the non-streaming ladder
  });
  assert.equal(attempts.every((a) => a.ssdStreaming === false), true);
  assert.equal(attempts[0].context, 40960);
  assert.ok(attempts[0].context < 131072);
  // Descends by halving to the minContext floor (inclusive), never below it.
  assert.deepEqual(attempts.map((a) => a.context), [40960, 20480, 10240, 8192]);
  assert.equal(attempts.every((a) => a.context >= 8192), true);
});

test('planDs4Attempts: mode "on" → every attempt streams, no non-streaming rung', () => {
  const attempts = planDs4Attempts({
    configuredContext: 131072,
    minContext: 8192,
    availBytes: 300 * GB,
    weightBytes: 80 * GB,
    ssdStreamingMode: 'on',
    ssdStreamingCacheExperts: '32GB',
  });
  assert.equal(attempts.every((a) => a.ssdStreaming === true), true);
  assert.equal(attempts[0].context, 131072);
  assert.equal(attempts[0].cacheExperts, '32GB');
});

test('planDs4Attempts: mode "off" → never streams (may exhaust to a clean failure)', () => {
  const attempts = planDs4Attempts({
    configuredContext: 65536,
    minContext: 8192,
    availBytes: 90 * GB,
    weightBytes: 80 * GB,
    ssdStreamingMode: 'off',
  });
  assert.equal(attempts.length > 0, true);
  assert.equal(attempts.every((a) => a.ssdStreaming === false), true);
});

test('planDs4Attempts: weights do not fit + auto → jumps straight to the streaming ladder', () => {
  const attempts = planDs4Attempts({
    configuredContext: 131072,
    minContext: 8192,
    availBytes: 60 * GB, // < 80G weights → non-streaming impossible
    weightBytes: 80 * GB,
    ssdStreamingMode: 'auto',
    streamingWeightBytes: 50 * GB,
  });
  assert.equal(attempts.every((a) => a.ssdStreaming === true), true);
  assert.equal(attempts[0].context, 131072); // streaming re-raises to full ctx
});

test('planDs4Attempts: auto → non-streaming ladder FIRST, then a streaming ladder that re-raises ctx', () => {
  const attempts = planDs4Attempts({
    configuredContext: 131072,
    minContext: 8192,
    availBytes: 90 * GB,
    weightBytes: 80 * GB,
    kvBytesPerToken: 128 * 1024,
    safetyBytes: 5 * GB,
    ssdStreamingMode: 'auto',
    streamingWeightBytes: 50 * GB,
  });
  const firstStreamIdx = attempts.findIndex((a) => a.ssdStreaming === true);
  assert.ok(firstStreamIdx > 0, 'streaming rungs come AFTER non-streaming rungs');
  // All non-streaming attempts precede all streaming attempts.
  assert.equal(attempts.slice(0, firstStreamIdx).every((a) => !a.ssdStreaming), true);
  assert.equal(attempts.slice(firstStreamIdx).every((a) => a.ssdStreaming), true);
  // Streaming frees weight RAM, so the streaming ladder re-raises to full ctx —
  // well above the bottomed-out non-streaming floor.
  assert.equal(attempts[firstStreamIdx].context, 131072);
  assert.ok(attempts[firstStreamIdx].context > attempts[firstStreamIdx - 1].context);
});

test('planDs4Attempts: minContext floor honored across both ladders', () => {
  const attempts = planDs4Attempts({
    configuredContext: 131072,
    minContext: 16384,
    availBytes: 90 * GB,
    weightBytes: 80 * GB,
    kvBytesPerToken: 128 * 1024,
    safetyBytes: 5 * GB,
    ssdStreamingMode: 'auto',
  });
  assert.equal(attempts.every((a) => a.context >= 16384), true);
});

test('planDs4Attempts: no duplicate (context,streaming) pairs', () => {
  const attempts = planDs4Attempts({
    configuredContext: 131072,
    minContext: 8192,
    availBytes: 90 * GB,
    weightBytes: 80 * GB,
    kvBytesPerToken: 128 * 1024,
    safetyBytes: 5 * GB,
    ssdStreamingMode: 'auto',
  });
  const keys = attempts.map((a) => `${a.context}:${a.ssdStreaming}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('planDs4Attempts: adaptiveContext=false → a single attempt at configured ctx', () => {
  const off = planDs4Attempts({
    configuredContext: 65536, minContext: 8192, availBytes: 90 * GB, weightBytes: 80 * GB,
    ssdStreamingMode: 'auto', adaptiveContext: false,
  });
  assert.equal(off.length, 1);
  assert.equal(off[0].context, 65536);
  assert.equal(off[0].ssdStreaming, false);

  const on = planDs4Attempts({
    configuredContext: 65536, minContext: 8192, availBytes: 90 * GB, weightBytes: 80 * GB,
    ssdStreamingMode: 'on', adaptiveContext: false, ssdStreamingCacheExperts: '48GB',
  });
  assert.equal(on.length, 1);
  assert.equal(on[0].context, 65536);
  assert.equal(on[0].ssdStreaming, true);
  assert.equal(on[0].cacheExperts, '48GB');
});

test('planDs4Attempts: cacheExperts propagated onto every attempt', () => {
  const attempts = planDs4Attempts({
    configuredContext: 32768, minContext: 8192, availBytes: 90 * GB, weightBytes: 80 * GB,
    kvBytesPerToken: 128 * 1024, safetyBytes: 5 * GB,
    ssdStreamingMode: 'auto', ssdStreamingCacheExperts: '64GB',
  });
  assert.equal(attempts.every((a) => a.cacheExperts === '64GB'), true);
});

test('planDs4Attempts: exported defaults are sane', () => {
  assert.ok(DEFAULT_DS4_KV_BYTES_PER_TOKEN > 0);
  assert.ok(DEFAULT_DS4_SAFETY_BYTES >= 4 * GB && DEFAULT_DS4_SAFETY_BYTES <= 6 * GB);
  assert.ok(DEFAULT_DS4_STREAMING_WEIGHT_BYTES >= 40 * GB && DEFAULT_DS4_STREAMING_WEIGHT_BYTES <= 60 * GB);
});

// ── runDs4AdaptivePlan (injected-I/O activation iterator) ─────────────────────
function makeHarness(outcomes) {
  const calls = { start: [], stop: 0 };
  let idx = -1;
  return {
    calls,
    startAttempt: (attempt) => { calls.start.push(attempt); idx += 1; },
    waitForOutcome: async () => outcomes[idx],
    stopAttempt: async () => { calls.stop += 1; },
  };
}

test('runDs4AdaptivePlan: stops on the first ready attempt and records it as settled', async () => {
  const attempts = [
    { context: 131072, ssdStreaming: false, cacheExperts: '32GB' },
    { context: 65536, ssdStreaming: false, cacheExperts: '32GB' },
  ];
  const h = makeHarness(['ready', 'ready']);
  const res = await runDs4AdaptivePlan({ attempts, ...h });
  assert.equal(res.ok, true);
  assert.deepEqual(res.settled, attempts[0]);
  assert.equal(res.attemptsMade, 1);
  assert.equal(h.calls.start.length, 1);
  assert.equal(h.calls.stop, 0); // ready on first → never stopped mid-plan
});

test('runDs4AdaptivePlan: advances on load-failure, stops the dead attempt, settles on ready', async () => {
  const attempts = [
    { context: 32768, ssdStreaming: false, cacheExperts: '32GB' },
    { context: 16384, ssdStreaming: false, cacheExperts: '32GB' },
    { context: 8192, ssdStreaming: false, cacheExperts: '32GB' },
  ];
  const h = makeHarness(['load-failure', 'ready', 'ready']);
  const res = await runDs4AdaptivePlan({ attempts, ...h });
  assert.equal(res.ok, true);
  assert.deepEqual(res.settled, attempts[1]);
  assert.equal(res.attemptsMade, 2);
  assert.equal(h.calls.start.length, 2);
  assert.equal(h.calls.stop, 1); // stopped the failed first attempt before the second
});

test('runDs4AdaptivePlan: switches from non-streaming to streaming across the ladder', async () => {
  const attempts = [
    { context: 8192, ssdStreaming: false, cacheExperts: '32GB' },
    { context: 131072, ssdStreaming: true, cacheExperts: '32GB' },
  ];
  const h = makeHarness(['load-failure', 'ready']);
  const res = await runDs4AdaptivePlan({ attempts, ...h });
  assert.equal(res.ok, true);
  assert.equal(res.settled.ssdStreaming, true);
  assert.equal(res.settled.context, 131072);
});

test('runDs4AdaptivePlan: aborts after exhausting every attempt (all load-failure)', async () => {
  const attempts = [
    { context: 32768, ssdStreaming: false, cacheExperts: '32GB' },
    { context: 8192, ssdStreaming: false, cacheExperts: '32GB' },
  ];
  const h = makeHarness(['load-failure', 'load-failure']);
  const res = await runDs4AdaptivePlan({ attempts, ...h });
  assert.equal(res.ok, false);
  assert.equal(res.settled, null);
  assert.equal(res.attemptsMade, 2);
  assert.equal(h.calls.start.length, 2);
  assert.equal(h.calls.stop, 2); // both failed attempts stopped
});

test('runDs4AdaptivePlan: empty plan aborts immediately without spawning', async () => {
  const h = makeHarness([]);
  const res = await runDs4AdaptivePlan({ attempts: [], ...h });
  assert.equal(res.ok, false);
  assert.equal(res.settled, null);
  assert.equal(res.attemptsMade, 0);
  assert.equal(h.calls.start.length, 0);
});

test('runDs4AdaptivePlan: onAttempt is invoked for each attempt made', async () => {
  const attempts = [
    { context: 32768, ssdStreaming: false, cacheExperts: '32GB' },
    { context: 16384, ssdStreaming: false, cacheExperts: '32GB' },
  ];
  const seen = [];
  const h = makeHarness(['load-failure', 'ready']);
  await runDs4AdaptivePlan({ attempts, ...h, onAttempt: (a, i) => seen.push([i, a.context]) });
  assert.deepEqual(seen, [[0, 32768], [1, 16384]]);
});
