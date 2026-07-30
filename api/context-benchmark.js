// Llama Manager — conversation cache benchmark statistics and decision policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Summarizes end-to-end latency samples and applies the documented prefill
// go/no-go gate: prepared prefixes must improve p95 TTFT while realtime queue
// delay under background contention stays at or below 150 milliseconds.

/**
 * Summarize nonnegative millisecond samples with nearest-rank percentiles.
 * @param {number[]} values Latency samples.
 * @returns {{count:number,min:number,p50:number,p95:number,max:number,mean:number}} Summary.
 */
export function summarizeSamples(values) {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const nearest = percentile => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: nearest(0.5),
    p95: nearest(0.95),
    max: sorted.at(-1),
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

/**
 * Apply the context-prefill acceptance gate to benchmark percentiles.
 * @param {{coldP95:number,warmP95:number,realtimeQueueP95:number}} results Percentiles.
 * @returns {{decision:'go'|'no-go',ttftImprovementPercent:number,reasons:string[]}} Decision.
 */
export function benchmarkDecision({ coldP95, warmP95, realtimeQueueP95 }) {
  const ttftImprovementPercent = coldP95 > 0 ? Math.round(((coldP95 - warmP95) / coldP95) * 1000) / 10 : 0;
  const reasons = [];
  if (!(warmP95 < coldP95)) reasons.push('prepared p95 TTFT did not improve over cold');
  if (realtimeQueueP95 > 150) reasons.push('realtime p95 queue wait exceeded 150 ms');
  return { decision: reasons.length === 0 ? 'go' : 'no-go', ttftImprovementPercent, reasons };
}
