// Llama Manager — context benchmark summarization tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies percentile reporting and the explicit go/no-go criteria used by the
// end-to-end conversation cache benchmark utility.

import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkDecision, summarizeSamples } from './context-benchmark.js';

test('summarizeSamples reports p50 and nearest-rank p95', () => {
  const summary = summarizeSamples([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(summary, { count: 10, min: 10, p50: 50, p95: 100, max: 100, mean: 55 });
});

test('benchmarkDecision requires TTFT improvement and bounded realtime queue delay', () => {
  assert.equal(benchmarkDecision({ coldP95: 1000, warmP95: 700, realtimeQueueP95: 100 }).decision, 'go');
  assert.equal(benchmarkDecision({ coldP95: 1000, warmP95: 1100, realtimeQueueP95: 100 }).decision, 'no-go');
  assert.equal(benchmarkDecision({ coldP95: 1000, warmP95: 700, realtimeQueueP95: 151 }).decision, 'no-go');
});
