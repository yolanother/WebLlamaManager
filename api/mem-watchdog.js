// Llama Manager — memory-watchdog restart deferral policy.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Decides whether the memory watchdog may restart llama-server right now or
// must defer because a request is actively streaming. A mid-generation restart
// surfaces to clients as "Stream error: terminated" (observed 2026-07-06
// killing an orchestrator opencode dispatch mid-task), so while memory sits
// between the soft threshold and a hard ceiling we wait for in-flight requests
// to go idle. Past the hard ceiling, host stability wins and the restart
// proceeds regardless.

/**
 * Decide whether a memory-watchdog restart should be deferred.
 *
 * @param {object} opts
 * @param {number} opts.memPercent - Current system memory usage percent (0-100).
 * @param {number} opts.thresholdPct - Configured soft restart threshold percent.
 * @param {Iterable<object>} opts.activeEntries - Values of the activeRequests map;
 *   entries with `_watchdogKilled` are ignored. Activity is read from
 *   `lastActivityAt` falling back to `startTime`.
 * @param {number} opts.nowMs - Current epoch millis.
 * @param {number} [opts.activityWindowMs=30000] - How recent activity must be for a
 *   request to count as "actively progressing".
 * @param {number} [opts.promptGraceMs=600000] - Age below which a request that has
 *   emitted ZERO tokens still counts as progressing. During prompt processing of a
 *   large context llama.cpp emits nothing for minutes, so lastActivityAt goes stale
 *   even though the upstream is actively crunching (same pathology the stall
 *   watchdog handles via its prompt-processing extension).
 * @param {number} [opts.hardCeilingMarginPct=6] - Margin above the soft threshold at
 *   which restarts are no longer deferred (capped at 98%).
 * @returns {{defer: boolean, hardCeilingPct: number, progressing: number}}
 *   `defer` — true when the restart must wait; `hardCeilingPct` — the resolved
 *   ceiling; `progressing` — count of actively-progressing requests found.
 */
export function shouldDeferMemRestart({
  memPercent,
  thresholdPct,
  activeEntries,
  nowMs,
  activityWindowMs = 30_000,
  promptGraceMs = 600_000,
  hardCeilingMarginPct = 6,
}) {
  const hardCeilingPct = Math.min(98, thresholdPct + hardCeilingMarginPct);
  let progressing = 0;
  for (const entry of activeEntries) {
    if (!entry || entry._watchdogKilled) continue;
    const lastActivity = entry.lastActivityAt || entry.startTime || 0;
    if (nowMs - lastActivity < activityWindowMs) {
      progressing++;
      continue;
    }
    const inPromptProcessing = !(entry.tokens > 0);
    const age = nowMs - (entry.startTime || lastActivity);
    if (inPromptProcessing && age < promptGraceMs) progressing++;
  }
  const defer = progressing > 0 && memPercent < hardCeilingPct;
  return { defer, hardCeilingPct, progressing };
}
