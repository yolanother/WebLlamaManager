// Llama Manager — per-request performance statistics (pure aggregation).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The dashboard's long-standing per-model table is fed by minute-level
// analytics snapshots whose per-model tok/s is ALREADY an average, so spread
// statistics (median / min / max) and time-to-first-token are unrecoverable
// from it. This module is the aggregation half of the per-request store that
// fixes that: api/server.js appends one compact record per completed
// generation to data/requests.jsonl, and the functions here turn those raw
// samples into the per-model summary the dashboard renders — request count,
// average / median / min / max tok/s, average generation duration and average
// TTFT — plus the same statistics bucketed by how many generations were
// running concurrently ("slots").
//
// Concurrency is DERIVED here rather than instrumented in the proxy: every
// sample carries its completion timestamp and duration, which reconstructs the
// interval it occupied, and a sweep line over those intervals yields each
// request's true PEAK concurrency. Keeping this pure makes the whole
// derivation unit-testable without a running router.

/** Time windows the dashboard can request, in milliseconds (null = all time). */
export const WINDOW_MS = {
  '24h': 24 * 3600000,
  '7d': 7 * 86400000,
  '30d': 30 * 86400000,
  'all': null
};

/** Round to one decimal place — the precision the dashboard displays tok/s at. */
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Median of a numeric list, without mutating the caller's array.
 *
 * @param {number[]} values - The values to take the median of.
 * @returns {number|null} The median, or null when `values` is empty.
 */
export function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Reduce a set of request samples to the summary statistics one table row
 * shows. TTFT is averaged over only the samples that actually reported one:
 * llama.cpp's local paths report `timings.prompt_ms`, but remote backends and
 * ds4 report no timings at all, and counting those as zero would understate
 * the average.
 *
 * @param {Array<{tps:number,dur:number,ttft:?number}>} samples - Request samples.
 * @returns {{requests:number, avgTps:?number, medianTps:?number, minTps:?number,
 *   maxTps:?number, avgDuration:?number, avgTtft:?number, ttftSamples:number}}
 *   Summary with null statistics when there is nothing to summarize.
 */
export function summarizeSamples(samples) {
  if (!samples || samples.length === 0) {
    return {
      requests: 0, avgTps: null, medianTps: null, minTps: null,
      maxTps: null, avgDuration: null, avgTtft: null, ttftSamples: 0
    };
  }

  const rates = samples.map(s => Number(s.tps) || 0);
  const durations = samples.map(s => Number(s.dur) || 0);
  const ttfts = samples.map(s => s.ttft).filter(t => Number.isFinite(t) && t >= 0);
  const sum = (arr) => arr.reduce((a, v) => a + v, 0);

  return {
    requests: samples.length,
    avgTps: round1(sum(rates) / rates.length),
    medianTps: round1(median(rates)),
    minTps: round1(Math.min(...rates)),
    maxTps: round1(Math.max(...rates)),
    avgDuration: Math.round(sum(durations) / durations.length),
    avgTtft: ttfts.length > 0 ? Math.round(sum(ttfts) / ttfts.length) : null,
    ttftSamples: ttfts.length
  };
}

/**
 * Annotate each sample with the peak number of generations that were in flight
 * at any instant while it ran. A sample's interval is reconstructed as
 * `[ts - dur, ts]`; a sweep line over all intervals then records, at every
 * start event, the live count against every currently-active sample.
 *
 * Peak (rather than "how many intervals did I touch") matters because one long
 * generation overlapping a run of SEQUENTIAL short ones was never more than
 * 2-way concurrent, and counting touches would report it as N-way.
 *
 * Samples with no usable duration cannot be placed on the timeline and are
 * reported as single-slot.
 *
 * @param {Array<{ts:number,dur:number}>} samples - Request samples.
 * @returns {Array<Object>} Copies of the samples, each with a `slots` field (>= 1).
 */
export function assignSlots(samples) {
  const out = samples.map(s => ({ ...s, slots: 1 }));

  const events = [];
  out.forEach((s, i) => {
    const dur = Number(s.dur) || 0;
    if (dur <= 0) return;              // no interval to place — stays single-slot
    const end = Number(s.ts) || 0;
    events.push({ t: end - dur, start: true, i });
    events.push({ t: end, start: false, i });
  });

  // Ends before starts at an identical timestamp, so a request that begins the
  // instant another finishes is not counted as concurrent with it.
  events.sort((a, b) => (a.t - b.t) || ((a.start ? 1 : 0) - (b.start ? 1 : 0)));

  const active = new Set();
  for (const ev of events) {
    if (!ev.start) {
      active.delete(ev.i);
      continue;
    }
    active.add(ev.i);
    const live = active.size;
    for (const i of active) {
      if (live > out[i].slots) out[i].slots = live;
    }
  }

  return out;
}

/**
 * Split the stored model key into its display parts. Offloaded requests are
 * keyed `"<backend>/<model>"` by recordTokenStats; local ones are the bare
 * model name.
 *
 * @param {string} name - The stored model key.
 * @returns {{name:string, backend:?string, isRemote:boolean, model:string}} Display parts.
 * @private
 */
function splitModelKey(name) {
  const slashIdx = name.indexOf('/');
  const isRemote = slashIdx > 0;
  return {
    name,
    backend: isRemote ? name.slice(0, slashIdx) : null,
    isRemote,
    model: isRemote ? name.slice(slashIdx + 1) : name
  };
}

/**
 * Aggregate raw request samples into the per-model performance breakdown the
 * dashboard table renders, busiest model first, each with a per-slot-count
 * breakdown in ascending concurrency order.
 *
 * Samples without a model or without a positive generation rate (embeddings,
 * failed requests) are discarded before anything else, so they neither skew the
 * statistics nor distort the derived concurrency.
 *
 * @param {Array<Object>} samples - Raw records as persisted in requests.jsonl.
 * @param {Object} [options] - Aggregation options.
 * @param {number} [options.now=Date.now()] - Reference time for window filtering.
 * @param {string} [options.window='all'] - One of the WINDOW_MS keys; unknown
 *   values fall back to all time.
 * @returns {{window:string, models:Array<Object>}} The per-model breakdown.
 */
export function aggregateRequestStats(samples, { now = Date.now(), window = 'all' } = {}) {
  const windowMs = WINDOW_MS[window] ?? null;
  const cutoff = windowMs == null ? -Infinity : now - windowMs;

  const usable = (samples || []).filter(s =>
    s && s.m && Number(s.tps) > 0 && (Number(s.ts) || 0) >= cutoff
  );

  const withSlots = assignSlots(usable);

  const byModel = new Map();
  for (const s of withSlots) {
    if (!byModel.has(s.m)) byModel.set(s.m, []);
    byModel.get(s.m).push(s);
  }

  const models = [...byModel.entries()].map(([name, group]) => {
    const bySlots = new Map();
    for (const s of group) {
      if (!bySlots.has(s.slots)) bySlots.set(s.slots, []);
      bySlots.get(s.slots).push(s);
    }
    const slots = [...bySlots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([count, slotGroup]) => ({ slots: count, ...summarizeSamples(slotGroup) }));

    return { ...splitModelKey(name), ...summarizeSamples(group), slots };
  });

  models.sort((a, b) => (b.requests - a.requests) || a.name.localeCompare(b.name));

  return { window, models };
}
