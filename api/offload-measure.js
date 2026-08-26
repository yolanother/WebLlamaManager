// Llama Manager — deciding whether inference offload is worth building.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// The arithmetic and the verdict behind open question O3, which gates Phase 3 of
// the federation epic. Phase 3 routes work to peers when that is faster than
// serving it locally, and it is the largest and least justified phase in the
// epic — so the design says measure before building, and this is the thing that
// measures.
//
// The framing matters more than the code. A single request on an idle box is
// ALWAYS faster served locally: the network hop buys nothing and costs a round
// trip. Offload can only pay when the local node is saturated, or when it cannot
// serve the request at all. So the question is never "is a peer fast?" but "does
// spreading load across the fleet beat queueing it locally, by enough to justify
// the machinery?" — and the answer has to come from this hardware, on this link.
//
// Latency is summarised by percentile rather than by mean throughout. A single
// cold model load in a sample set drags a mean somewhere no request actually
// went, and a verdict read off that mean would be wrong in the expensive
// direction.

/**
 * Smallest improvement under contention that justifies building Phase 3.
 *
 * Below this the machinery — routing, health, trust, failure handling — costs
 * more than it returns. Set deliberately high: the epic is better served by a
 * small honest Phase 3 than a large speculative one.
 */
const WORTHWHILE_RATIO = 1.25;

/**
 * Reduce raw latency samples to the statistics a decision can be read from.
 *
 * Unusable samples are discarded rather than coerced, because a failed request
 * counted as 0 ms makes a broken run look like a fast one.
 *
 * @param {number[]} samples Latencies in milliseconds.
 * @returns {{n:number, p50:number, p95:number, mean:number, min:number,
 *   max:number}|null} Summary, or null when there is nothing to summarise.
 */
export function summarize(samples) {
  if (!Array.isArray(samples)) return null;
  const usable = samples
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!usable.length) return null;

  // Nearest-rank: the p50 of ten samples is the fifth, not the sixth. Getting
  // this off by one shifts every reported latency one sample high, which on a
  // small run is the difference between two verdicts.
  const at = (fraction) => usable[
    Math.min(usable.length - 1, Math.max(0, Math.ceil(fraction * usable.length) - 1))
  ];
  return {
    n: usable.length,
    p50: at(0.5),
    p95: at(0.95),
    mean: usable.reduce((sum, value) => sum + value, 0) / usable.length,
    min: usable[0],
    max: usable[usable.length - 1],
  };
}

/**
 * Decide whether the measurements justify building inference offload.
 *
 * Reads p50 rather than mean, and refuses to answer at all when a measurement is
 * missing — the entire purpose of this gate is to stop Phase 3 being built on
 * assumption, so a half-run harness must not produce a recommendation.
 *
 * @param {Object} measurements
 * @param {Object|null} measurements.localIdle One request, served locally, idle.
 * @param {Object|null} measurements.peerIdle The same request shipped to a peer.
 * @param {Object|null} measurements.localSaturated Concurrent load, local only.
 * @param {Object|null} measurements.splitSaturated The same load across the fleet.
 * @param {Object|null} [measurements.peerCold] A peer that must load the model first.
 * @returns {{worthwhile: boolean|null, reason: string, hopTaxMs: number|null,
 *   crossoverRatio: number|null, coldPenaltyMs: number|null, notes: string[]}}
 *   The verdict, and the numbers it was read from.
 */
export function offloadVerdict({
  localIdle,
  peerIdle,
  localSaturated,
  splitSaturated,
  peerCold,
} = {}) {
  const notes = [];
  const hopTaxMs = localIdle && peerIdle ? peerIdle.p50 - localIdle.p50 : null;
  const coldPenaltyMs = peerCold && peerIdle ? peerCold.p50 - peerIdle.p50 : null;

  if (coldPenaltyMs !== null) {
    notes.push(
      `A peer holding the model answers in ${peerIdle.p50} ms; one that must load `
      + `it first costs ${coldPenaltyMs} ms more. Offload to a cold peer is a `
      + 'different proposition from offload to a warm one and should be treated '
      + 'as a separate decision.',
    );
  }

  if (!localIdle || !peerIdle || !localSaturated || !splitSaturated) {
    return {
      worthwhile: null,
      reason: 'Measurement incomplete — no verdict. Phase 3 must not be built on a partial run.',
      hopTaxMs,
      crossoverRatio: null,
      coldPenaltyMs,
      notes,
    };
  }

  if (hopTaxMs > 0) {
    notes.push(
      `The hop costs ${hopTaxMs} ms on an idle box. Every wrongly-routed request `
      + 'pays that, so routing has to be right more often than that tax is large.',
    );
  }

  const crossoverRatio = splitSaturated.p50 > 0
    ? localSaturated.p50 / splitSaturated.p50
    : null;

  if (!crossoverRatio || crossoverRatio <= 1) {
    return {
      worthwhile: false,
      reason: 'Splitting load across the fleet did not beat serving it locally even '
        + 'under contention. Offload has no window on this hardware.',
      hopTaxMs,
      crossoverRatio,
      coldPenaltyMs,
      notes,
    };
  }

  if (crossoverRatio < WORTHWHILE_RATIO) {
    return {
      worthwhile: false,
      reason: `Under contention, splitting load helped only marginally `
        + `(${crossoverRatio.toFixed(2)}x, below the ${WORTHWHILE_RATIO}x bar) — too small `
        + 'to justify the routing, health, and failure machinery Phase 3 would need.',
      hopTaxMs,
      crossoverRatio,
      coldPenaltyMs,
      notes,
    };
  }

  return {
    worthwhile: true,
    reason: `Under contention, splitting load across the fleet was ${crossoverRatio.toFixed(2)}x `
      + 'faster than queueing locally. Offload has a real window and is worth building '
      + 'for the saturated case.',
    hopTaxMs,
    crossoverRatio,
    coldPenaltyMs,
    notes,
  };
}
