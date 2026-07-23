// Llama Manager — unit tests for api/request-stats.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers the per-request statistics aggregation that backs the dashboard's
// per-model performance table: median/min/max tok/s, average duration and
// average TTFT, the derived concurrency ("slots") bucketing, and window
// filtering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, summarizeSamples, assignSlots, aggregateRequestStats } from './request-stats.js';

// Build a sample the way recordTokenStats persists it: `ts` is the completion
// timestamp and `dur` the generation duration, so the request occupied
// [ts - dur, ts].
const sample = ({ ts, m = 'gpt-oss-120b', b = 'local', tps = 10, ttft = null, dur = 1000, pt = 100, ct = 50 }) =>
  ({ ts, m, b, tps, ttft, dur, pt, ct });

test('median: odd count returns the middle value', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median: even count averages the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('median: empty input returns null', () => {
  assert.equal(median([]), null);
});

test('median: does not mutate the caller array', () => {
  const values = [3, 1, 2];
  median(values);
  assert.deepEqual(values, [3, 1, 2]);
});

test('summarizeSamples: computes count, avg/median/min/max tok/s and avg duration', () => {
  const s = summarizeSamples([
    sample({ ts: 5, tps: 10, dur: 1000 }),
    sample({ ts: 6, tps: 20, dur: 2000 }),
    sample({ ts: 7, tps: 60, dur: 3000 })
  ]);
  assert.equal(s.requests, 3);
  assert.equal(s.avgTps, 30);
  assert.equal(s.medianTps, 20);
  assert.equal(s.minTps, 10);
  assert.equal(s.maxTps, 60);
  assert.equal(s.avgDuration, 2000);
});

test('summarizeSamples: rounds tok/s to one decimal', () => {
  const s = summarizeSamples([
    sample({ ts: 1, tps: 10.04 }),
    sample({ ts: 2, tps: 10.08 })
  ]);
  assert.equal(s.avgTps, 10.1);
});

test('summarizeSamples: avgTtft ignores samples with no TTFT', () => {
  const s = summarizeSamples([
    sample({ ts: 1, ttft: 100 }),
    sample({ ts: 2, ttft: null }),
    sample({ ts: 3, ttft: 300 })
  ]);
  assert.equal(s.avgTtft, 200, 'averages only the two measured TTFTs');
  assert.equal(s.ttftSamples, 2);
});

test('summarizeSamples: avgTtft is null when no sample reported TTFT', () => {
  const s = summarizeSamples([sample({ ts: 1, ttft: null }), sample({ ts: 2, ttft: null })]);
  assert.equal(s.avgTtft, null, 'null, not 0 — remote backends report no timings');
  assert.equal(s.ttftSamples, 0);
});

test('summarizeSamples: empty input yields a zero-request summary with null stats', () => {
  const s = summarizeSamples([]);
  assert.equal(s.requests, 0);
  assert.equal(s.avgTps, null);
  assert.equal(s.medianTps, null);
  assert.equal(s.minTps, null);
  assert.equal(s.maxTps, null);
  assert.equal(s.avgDuration, null);
  assert.equal(s.avgTtft, null);
});

test('assignSlots: sequential non-overlapping requests are all single-slot', () => {
  const out = assignSlots([
    sample({ ts: 1000, dur: 1000 }),   // [0, 1000]
    sample({ ts: 3000, dur: 1000 }),   // [2000, 3000]
    sample({ ts: 5000, dur: 1000 })    // [4000, 5000]
  ]);
  assert.deepEqual(out.map(s => s.slots), [1, 1, 1]);
});

test('assignSlots: two overlapping requests both report 2 slots', () => {
  const out = assignSlots([
    sample({ ts: 2000, dur: 2000 }),   // [0, 2000]
    sample({ ts: 3000, dur: 2000 })    // [1000, 3000]
  ]);
  assert.deepEqual(out.map(s => s.slots), [2, 2]);
});

test('assignSlots: touching intervals do not count as concurrent', () => {
  const out = assignSlots([
    sample({ ts: 1000, dur: 1000 }),   // [0, 1000]
    sample({ ts: 2000, dur: 1000 })    // [1000, 2000] — starts exactly as the first ends
  ]);
  assert.deepEqual(out.map(s => s.slots), [1, 1]);
});

test('assignSlots: reports PEAK concurrency, not total overlap count', () => {
  // One long request spanning three SEQUENTIAL short ones. At no instant were
  // more than 2 generations in flight, so the long request is 2 slots — a
  // naive "count everything I overlap" would wrongly report 4.
  const out = assignSlots([
    sample({ ts: 10000, dur: 10000 }), // [0, 10000]
    sample({ ts: 2000, dur: 1000 }),   // [1000, 2000]
    sample({ ts: 5000, dur: 1000 }),   // [4000, 5000]
    sample({ ts: 8000, dur: 1000 })    // [7000, 8000]
  ]);
  assert.deepEqual(out.map(s => s.slots), [2, 2, 2, 2]);
});

test('assignSlots: four concurrent requests all report 4 slots', () => {
  const out = assignSlots([
    sample({ ts: 5000, dur: 5000 }),
    sample({ ts: 5100, dur: 5000 }),
    sample({ ts: 5200, dur: 5000 }),
    sample({ ts: 5300, dur: 5000 })
  ]);
  assert.deepEqual(out.map(s => s.slots), [4, 4, 4, 4]);
});

test('assignSlots: missing or zero duration degrades to a single slot', () => {
  const out = assignSlots([
    sample({ ts: 1000, dur: 0 }),
    sample({ ts: 1000, dur: undefined })
  ]);
  assert.deepEqual(out.map(s => s.slots), [1, 1]);
});

test('aggregateRequestStats: groups by model and reports per-model summaries', () => {
  const now = 100000;
  const res = aggregateRequestStats([
    sample({ ts: now - 1000, m: 'gpt-oss-120b', tps: 30, dur: 1000, ttft: 200 }),
    sample({ ts: now - 3000, m: 'gpt-oss-120b', tps: 40, dur: 1000, ttft: 400 }),
    sample({ ts: now - 5000, m: 'qwen3-coder', tps: 12, dur: 1000 })
  ], { now, window: 'all' });

  assert.equal(res.window, 'all');
  assert.equal(res.models.length, 2);

  const gpt = res.models.find(m => m.name === 'gpt-oss-120b');
  assert.equal(gpt.requests, 2);
  assert.equal(gpt.avgTps, 35);
  assert.equal(gpt.minTps, 30);
  assert.equal(gpt.maxTps, 40);
  assert.equal(gpt.avgTtft, 300);
});

test('aggregateRequestStats: splits a backend-prefixed model key into backend + model', () => {
  const now = 100000;
  const res = aggregateRequestStats([
    sample({ ts: now - 1000, m: 'Borethrax Ollama/Qwen_Qwen3-8B-GGUF', b: 'borethrax-ollama' })
  ], { now, window: 'all' });

  const m = res.models[0];
  assert.equal(m.isRemote, true);
  assert.equal(m.backend, 'Borethrax Ollama');
  assert.equal(m.model, 'Qwen_Qwen3-8B-GGUF');
});

test('aggregateRequestStats: a bare model key is local', () => {
  const now = 100000;
  const res = aggregateRequestStats([sample({ ts: now - 1000, m: 'gpt-oss-120b' })], { now, window: 'all' });
  const m = res.models[0];
  assert.equal(m.isRemote, false);
  assert.equal(m.backend, null);
  assert.equal(m.model, 'gpt-oss-120b');
});

test('aggregateRequestStats: window filtering drops samples older than the window', () => {
  const now = 10 * 86400000;
  const res = aggregateRequestStats([
    sample({ ts: now - 3600000 }),        // 1h ago  — inside 24h
    sample({ ts: now - 5 * 86400000 })    // 5d ago  — outside 24h
  ], { now, window: '24h' });

  assert.equal(res.models.length, 1);
  assert.equal(res.models[0].requests, 1);
});

test('aggregateRequestStats: unknown window falls back to all-time', () => {
  const now = 10 * 86400000;
  const res = aggregateRequestStats([sample({ ts: now - 5 * 86400000 })], { now, window: 'bogus' });
  assert.equal(res.models[0].requests, 1);
});

test('aggregateRequestStats: buckets each model by slot count, ascending', () => {
  const now = 100000;
  const res = aggregateRequestStats([
    // Two concurrent requests => 2 slots
    sample({ ts: now - 1000, tps: 20, dur: 2000 }),
    sample({ ts: now - 1500, tps: 24, dur: 2000 }),
    // One isolated request well clear of the pair => 1 slot
    sample({ ts: now - 20000, tps: 40, dur: 1000 })
  ], { now, window: 'all' });

  const m = res.models[0];
  assert.deepEqual(m.slots.map(s => s.slots), [1, 2], 'ascending slot buckets');
  assert.equal(m.slots[0].requests, 1);
  assert.equal(m.slots[0].avgTps, 40);
  assert.equal(m.slots[1].requests, 2);
  assert.equal(m.slots[1].avgTps, 22);
});

test('aggregateRequestStats: models are ordered by request volume, busiest first', () => {
  const now = 100000;
  const res = aggregateRequestStats([
    sample({ ts: now - 1000, m: 'quiet' }),
    sample({ ts: now - 2000, m: 'busy' }),
    sample({ ts: now - 4000, m: 'busy' }),
    sample({ ts: now - 6000, m: 'busy' })
  ], { now, window: 'all' });

  assert.deepEqual(res.models.map(m => m.name), ['busy', 'quiet']);
});

test('aggregateRequestStats: no samples yields an empty model list', () => {
  const res = aggregateRequestStats([], { now: 1000, window: '24h' });
  assert.deepEqual(res.models, []);
});

test('aggregateRequestStats: ignores malformed samples without a model or tok/s', () => {
  const now = 100000;
  const res = aggregateRequestStats([
    sample({ ts: now - 1000, m: 'gpt-oss-120b', tps: 30 }),
    { ts: now - 1000, tps: 30 },                       // no model
    sample({ ts: now - 1000, m: 'gpt-oss-120b', tps: 0 }) // no generation rate
  ], { now, window: 'all' });

  assert.equal(res.models.length, 1);
  assert.equal(res.models[0].requests, 1);
});
