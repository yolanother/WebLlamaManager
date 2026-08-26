// Llama Manager — offload measurement tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the arithmetic and the verdict behind open question O3, which gates
// the whole of Phase 3. The point of the gate is to find out whether shipping a
// request to a peer ever beats serving it locally on this hardware, so these
// tests pin the two things a wrong answer would turn on: that latency is
// summarised by percentile rather than by mean (one cold load in a sample set
// drags a mean somewhere no request actually went), and that the verdict refuses
// to recommend building Phase 3 on evidence that does not support it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { summarize, offloadVerdict } from './offload-measure.js';

// ── Summarising latencies ───────────────────────────────────────────────────

test('an empty sample set summarises to nothing rather than zero', () => {
  // Zero milliseconds is a measurement. "No measurement" is not, and reporting
  // it as 0 would make a failed run look like an instant one.
  assert.deepEqual(summarize([]), null);
  assert.deepEqual(summarize(null), null);
});

test('percentiles come from the ordered samples', () => {
  const s = summarize([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  assert.equal(s.n, 10);
  assert.equal(s.min, 100);
  assert.equal(s.max, 1000);
  assert.equal(s.p50, 500);
  assert.equal(s.p95, 1000);
});

test('a single sample is its own every statistic', () => {
  const s = summarize([42]);
  assert.equal(s.n, 1);
  assert.equal(s.p50, 42);
  assert.equal(s.p95, 42);
  assert.equal(s.min, 42);
  assert.equal(s.max, 42);
});

test('one cold outlier moves the mean but not the median', () => {
  // This is why the verdict reads p50. A 40-second model load in a set of
  // fast requests puts the mean where nothing actually landed.
  const samples = [100, 110, 120, 130, 40000];
  const s = summarize(samples);
  assert.equal(s.p50, 120);
  assert.ok(s.mean > 8000, 'mean is dragged by the outlier');
});

test('unusable samples are discarded rather than counted as fast', () => {
  const s = summarize([100, null, 200, undefined, NaN, 300, -5]);
  assert.equal(s.n, 3);
  assert.equal(s.p50, 200);
});

// ── The verdict ─────────────────────────────────────────────────────────────

const stat = (p50) => ({ n: 10, p50, p95: p50, mean: p50, min: p50, max: p50 });

test('offload is not worth building when the hop costs more than it saves', () => {
  // The honest default. A single request on an idle box is always faster
  // served locally, because the network hop buys nothing.
  const v = offloadVerdict({
    localIdle: stat(1000),
    peerIdle: stat(1400),
    localSaturated: stat(2000),
    splitSaturated: stat(1900),
  });
  assert.equal(v.worthwhile, false);
  assert.match(v.reason, /contention/i);
});

test('offload is worth building when it clearly wins under contention', () => {
  const v = offloadVerdict({
    localIdle: stat(1000),
    peerIdle: stat(1200),
    localSaturated: stat(8000),
    splitSaturated: stat(4000),
  });
  assert.equal(v.worthwhile, true);
  assert.ok(v.crossoverRatio > 1.5);
});

test('the hop tax is reported even when offload wins', () => {
  // Phase 3 has to know what it costs on an idle box, because that is the
  // penalty every wrongly-routed request pays.
  const v = offloadVerdict({
    localIdle: stat(1000),
    peerIdle: stat(1250),
    localSaturated: stat(8000),
    splitSaturated: stat(4000),
  });
  assert.equal(v.hopTaxMs, 250);
});

test('a missing measurement yields no verdict, not a guess', () => {
  // The gate exists to stop Phase 3 being built on assumption. A harness that
  // half-ran must not produce a recommendation.
  const v = offloadVerdict({ localIdle: stat(1000), peerIdle: null });
  assert.equal(v.worthwhile, null);
  assert.match(v.reason, /incomplete/i);
});

test('a marginal win is reported as marginal rather than as a green light', () => {
  // A 5% improvement does not justify the largest phase in the epic.
  const v = offloadVerdict({
    localIdle: stat(1000),
    peerIdle: stat(1100),
    localSaturated: stat(4000),
    splitSaturated: stat(3850),
  });
  assert.equal(v.worthwhile, false);
  assert.match(v.reason, /marginal|too small/i);
});

test('a cold model load is surfaced as its own cost', () => {
  // Shipping work to a peer that has to load 5 GB first is a different
  // proposition from shipping it to one holding the model already.
  const v = offloadVerdict({
    localIdle: stat(1000),
    peerIdle: stat(1200),
    localSaturated: stat(8000),
    splitSaturated: stat(4000),
    peerCold: stat(45000),
  });
  assert.equal(v.coldPenaltyMs, 43800);
  assert.match(v.notes.join(' '), /cold/i);
});
