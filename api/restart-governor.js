// Llama Manager — local llama-server restart governor (debounce + circuit breaker).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free logic that decides whether a local llama-server restart
// should proceed, given the timestamps of recent restart attempts. It exists to
// fix the gpt-oss-120b "restart thrash" wedge: when many failing requests for a
// heavy local model each independently trigger restartLlamaServer(), the manager
// otherwise enters an infinite kill/restart loop (which also starves the distrobox
// exec layer, so the kill itself times out) and never recovers on its own.
//
// Two protections, both driven off a caller-held array of attempt timestamps:
//   - Debounce: collapse a stampede of triggers into a single restart.
//   - Circuit breaker: after maxAttempts restarts within windowMs, suppress further
//     restarts for cooldownMs (then allow one recovery probe). The router keeps
//     serving remote-routable models while the breaker is open. A healthy restart
//     resets the history (the caller clears it), so an isolated later failure
//     restarts immediately.

export const RESTART_DEFAULTS = {
  debounceMs: 5_000,    // ignore triggers arriving within this of the last allowed restart
  maxAttempts: 4,       // allowed restarts within windowMs before the breaker trips
  windowMs: 60_000,     // sliding window over which attempts are counted
  cooldownMs: 60_000    // once tripped, suppress restarts for this long (then probe once)
};

/**
 * Decide whether a local llama-server restart should proceed right now.
 *
 * The function is pure: it never mutates the input `history`. When a restart is
 * allowed it returns a new, window-pruned history with `now` appended; the caller
 * persists that as the new state. When a restart is suppressed it returns the
 * input history unchanged (suppressed triggers are deliberately NOT recorded, so a
 * continuous stampede during cooldown cannot keep the breaker open forever).
 *
 * @param {object} a
 * @param {number[]} [a.history] Ascending timestamps (ms) of prior allowed restarts.
 * @param {number} a.now Current time in ms (caller passes Date.now()).
 * @param {number} [a.debounceMs]
 * @param {number} [a.maxAttempts]
 * @param {number} [a.windowMs]
 * @param {number} [a.cooldownMs]
 * @returns {{allow:boolean, reason:'ok'|'debounce'|'circuit-open', history:number[], retryAfterMs:number}}
 */
export function restartDecision({
  history = [],
  now,
  debounceMs = RESTART_DEFAULTS.debounceMs,
  maxAttempts = RESTART_DEFAULTS.maxAttempts,
  windowMs = RESTART_DEFAULTS.windowMs,
  cooldownMs = RESTART_DEFAULTS.cooldownMs
} = {}) {
  const last = history.length ? history[history.length - 1] : null;

  // Debounce: a fresh trigger right after a restart is the stampede — skip it.
  if (last !== null && now - last < debounceMs) {
    return { allow: false, reason: 'debounce', history, retryAfterMs: debounceMs - (now - last) };
  }

  // Circuit breaker: if the last `maxAttempts` restarts were bunched within
  // `windowMs`, the breaker is tripped and stays open until `cooldownMs` after the
  // most recent attempt (independent of window aging), then allows one probe.
  if (history.length >= maxAttempts) {
    const lastN = history.slice(-maxAttempts);
    const bunchedWithinWindow = (last - lastN[0]) <= windowMs;
    if (bunchedWithinWindow && now - last < cooldownMs) {
      return { allow: false, reason: 'circuit-open', history, retryAfterMs: cooldownMs - (now - last) };
    }
  }

  // Allowed: record this attempt, pruning anything older than the retention span
  // (max of window/cooldown) so the breaker's trip detection survives the cooldown.
  const retentionMs = Math.max(windowMs, cooldownMs);
  const retained = history.filter(t => now - t < retentionMs);
  return { allow: true, reason: 'ok', history: [...retained, now], retryAfterMs: 0 };
}
