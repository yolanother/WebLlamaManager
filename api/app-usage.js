// Llama Manager — per-application resource usage helpers (memory + CPU).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free parsing and math for the dashboard's "app usage" lines,
// which show how much of system memory/CPU the llama.cpp inference stack itself
// (the model router, its per-model child processes, and the embedding server)
// consumes vs. the total-system lines. The caller does the /proc reads and feeds
// the raw text / sampled numbers in here; this module owns the fragile parsing
// (comm fields with spaces/parens, missing VmRSS) and the percent calculations
// (clamping, divide-by-zero, and CPU deltas that skip PIDs lacking a baseline so
// a model swap doesn't produce a spurious spike).

/** Clamp a number to the 0..100 percentage range (NaN -> 0). */
function clampPct(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 100 ? 100 : n;
}

/**
 * Extract VmRSS (resident set size, kB) from /proc/<pid>/status text.
 * @param {string} statusText Contents of /proc/<pid>/status.
 * @returns {number} RSS in kB, or 0 if not present / unreadable.
 */
export function parseRssKb(statusText) {
  if (!statusText) return 0;
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(statusText);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Sum utime+stime (clock ticks) from /proc/<pid>/stat text. The comm field
 * (field 2) may contain spaces and parentheses, so fields are read relative to
 * the LAST ')'. After it, index 11 = utime, index 12 = stime.
 * @param {string} statText Contents of /proc/<pid>/stat.
 * @returns {number} utime+stime in jiffies, or 0 if unparseable.
 */
export function parseProcCpuJiffies(statText) {
  if (!statText) return 0;
  const close = statText.lastIndexOf(')');
  if (close === -1) return 0;
  const rest = statText.slice(close + 1).trim().split(/\s+/);
  const utime = parseInt(rest[11], 10);
  const stime = parseInt(rest[12], 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return 0;
  return utime + stime;
}

/**
 * Sum every field on the aggregate `cpu` line of /proc/stat to get total CPU
 * jiffies across all cores. Accepts either the single line or the whole file.
 * @param {string} procStatText The `cpu  ...` line or full /proc/stat contents.
 * @returns {number} Total CPU jiffies, or 0 if unparseable.
 */
export function parseTotalCpuJiffies(procStatText) {
  if (!procStatText) return 0;
  const line = procStatText.split('\n').find(l => /^cpu\s/.test(l));
  if (!line) return 0;
  return line.trim().split(/\s+/).slice(1)
    .reduce((sum, tok) => sum + (parseInt(tok, 10) || 0), 0);
}

/**
 * App memory as a percentage of total system RAM.
 * @param {number[]} rssKbList Per-process RSS values (kB); negatives ignored.
 * @param {number} totalMemKb Total system memory (kB).
 * @returns {number} Percentage 0..100.
 */
export function appMemoryPercent(rssKbList, totalMemKb) {
  if (!totalMemKb || totalMemKb <= 0) return 0;
  const sum = (rssKbList || []).reduce((a, b) => a + (b > 0 ? b : 0), 0);
  return clampPct((sum / totalMemKb) * 100);
}

/**
 * App CPU as a percentage of total CPU capacity, measured between two samples.
 * Only PIDs present in BOTH samples contribute (a brand-new child has no
 * baseline, so counting its absolute jiffies would spike the line on swap).
 * @param {Object<string,number>} prevProcJiffies pid -> utime+stime, previous tick.
 * @param {Object<string,number>} curProcJiffies pid -> utime+stime, current tick.
 * @param {number} prevTotalJiffies Total CPU jiffies, previous tick.
 * @param {number} curTotalJiffies Total CPU jiffies, current tick.
 * @returns {number} Percentage 0..100.
 */
export function appCpuPercent(prevProcJiffies, curProcJiffies, prevTotalJiffies, curTotalJiffies) {
  const totalDelta = curTotalJiffies - prevTotalJiffies;
  if (!prevProcJiffies || !curProcJiffies || !(totalDelta > 0)) return 0;
  let appDelta = 0;
  for (const pid of Object.keys(curProcJiffies)) {
    const prev = prevProcJiffies[pid];
    if (prev == null) continue; // no baseline -> skip this tick
    const d = curProcJiffies[pid] - prev;
    if (d > 0) appDelta += d;
  }
  return clampPct((appDelta / totalDelta) * 100);
}
