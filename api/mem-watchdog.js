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
//
// Also exposes `shouldRestartForResidentLeak`, the resident-relative gate the
// watchdog uses for the high-baseline ds4-server (~81GB): a system-memory
// threshold breach is expected at ds4's baseline and a restart just reloads the
// same 81GB, so ds4 is only restarted when its RSS has grown a margin BEYOND its
// expected baseline (a real leak) — preventing false-positive restarts.

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

/**
 * Decide whether a memory-pressure restart of a HIGH-BASELINE engine (the
 * ds4-server, which holds ~81GB resident by design) is actually warranted.
 *
 * The default llama watchdog treats a system-memory threshold breach as its
 * signal because llama residency is modest, so pressure implies leak/creep that a
 * restart reclaims. ds4 is different: it LEGITIMATELY sits at ~81GB, so
 * `memPercent >= threshold` on its own is expected, not a leak — and restarting
 * reloads the same 81GB (minutes of downtime on the iGPU) without reclaiming
 * anything. That would be a false-positive restart at baseline.
 *
 * So this gate additionally requires the engine's resident set to have grown a
 * `leakMarginFrac` BEYOND its expected baseline (the only case where a restart
 * frees memory) before it will restart, AND still requires the system to be under
 * pressure. Fails SAFE: with an unknown/zero baseline it never restarts on
 * pressure alone, since we cannot distinguish baseline from leak.
 *
 * @param {object} a
 * @param {number} a.memPercent Current system memory usage percent (0-100).
 * @param {number} a.thresholdPct Configured soft restart threshold percent.
 * @param {number} a.residentBytes Current RSS held by the engine's process(es).
 * @param {number} a.expectedResidentBytes Expected baseline RSS for this engine (0 = unknown).
 * @param {number} [a.leakMarginFrac=0.15] Fractional growth over baseline that counts as a leak.
 * @returns {{restart:boolean, leaked:boolean, leakThresholdBytes:number}}
 *   `restart` — whether a memory-pressure restart should proceed; `leaked` —
 *   whether residency exceeded the leak threshold; `leakThresholdBytes` — the
 *   resolved RSS ceiling (expectedResident * (1 + margin)).
 */
export function shouldRestartForResidentLeak({
  memPercent,
  thresholdPct,
  residentBytes,
  expectedResidentBytes,
  leakMarginFrac = 0.15,
}) {
  const baseline = Math.max(0, expectedResidentBytes || 0);
  const leakThresholdBytes = baseline * (1 + Math.max(0, leakMarginFrac));
  // Unknown baseline -> fail safe (cannot tell baseline from leak; never restart).
  const leaked = baseline > 0 && residentBytes > leakThresholdBytes;
  const restart = memPercent >= thresholdPct && leaked;
  return { restart, leaked, leakThresholdBytes };
}
