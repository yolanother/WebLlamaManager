// Llama Manager — context benchmark summarization tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies percentile reporting and the explicit go/no-go criteria used by the
// end-to-end conversation cache benchmark utility.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  benchmarkDecision,
  localBenchmarkChatBody,
  summarizeSamples,
  waitForPreparedContext,
} from './context-benchmark.js';

test('summarizeSamples reports p50 and nearest-rank p95', () => {
  const summary = summarizeSamples([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(summary, { count: 10, min: 10, p50: 50, p95: 100, max: 100, mean: 55 });
});

test('benchmarkDecision requires TTFT improvement and bounded realtime queue delay', () => {
  assert.equal(benchmarkDecision({ coldP95: 1000, warmP95: 700, realtimeQueueP95: 100 }).decision, 'go');
  assert.equal(benchmarkDecision({ coldP95: 1000, warmP95: 1100, realtimeQueueP95: 100 }).decision, 'no-go');
  assert.equal(benchmarkDecision({ coldP95: 1000, warmP95: 700, realtimeQueueP95: 151 }).decision, 'no-go');
});

test('localBenchmarkChatBody prevents routing policy from offloading cache measurements', () => {
  assert.deepEqual(localBenchmarkChatBody({ model: 'gemma', routing: 'auto' }), {
    model: 'gemma',
    routing: 'local_only',
    stream: true,
  });
});

test('waitForPreparedContext polls queued work until it is reusable', async () => {
  const statuses = ['prefilling', 'ready'];
  let sleeps = 0;
  const ready = await waitForPreparedContext({
    baseUrl: 'http://manager/api/v1',
    id: 'ctx_1',
    fetchImpl: async () => new Response(JSON.stringify({ id: 'ctx_1', status: statuses.shift() }), { status: 200 }),
    sleep: async () => { sleeps++; },
    timeoutMs: 1_000,
  });

  assert.equal(ready.status, 'ready');
  assert.equal(sleeps, 1);
});

test('waitForPreparedContext rejects failed preparation instead of benchmarking cold fallback', async () => {
  await assert.rejects(
    waitForPreparedContext({
      baseUrl: 'http://manager/api/v1',
      id: 'ctx_failed',
      fetchImpl: async () => new Response(JSON.stringify({ id: 'ctx_failed', status: 'failed', error: 'upstream error' }), { status: 200 }),
    }),
    /prepared context ctx_failed failed/,
  );
});
