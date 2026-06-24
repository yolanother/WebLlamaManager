// Llama Manager — unit tests for api/restart-governor.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartDecision, RESTART_DEFAULTS } from './restart-governor.js';

// Fixed knobs for deterministic tests.
const KNOBS = { debounceMs: 5_000, maxAttempts: 4, windowMs: 60_000, cooldownMs: 60_000 };

test('first restart is allowed and recorded in history', () => {
  const r = restartDecision({ history: [], now: 1_000, ...KNOBS });
  assert.equal(r.allow, true);
  assert.equal(r.reason, 'ok');
  assert.deepEqual(r.history, [1_000]);
});

test('debounce: a second trigger within debounceMs is suppressed (stampede collapses to one)', () => {
  const first = restartDecision({ history: [], now: 1_000, ...KNOBS });
  // Three more triggers arrive almost immediately (the stampede).
  for (const t of [1_100, 2_000, 4_999]) {
    const r = restartDecision({ history: first.history, now: t, ...KNOBS });
    assert.equal(r.allow, false, `trigger at ${t} should be debounced`);
    assert.equal(r.reason, 'debounce');
    // History is unchanged while suppressed.
    assert.deepEqual(r.history, first.history);
  }
});

test('after the debounce window a fresh restart is allowed (still under attempt budget)', () => {
  const first = restartDecision({ history: [], now: 1_000, ...KNOBS });
  const r = restartDecision({ history: first.history, now: 1_000 + KNOBS.debounceMs + 1, ...KNOBS });
  assert.equal(r.allow, true);
  assert.equal(r.history.length, 2);
});

test('circuit trips after maxAttempts within the window', () => {
  // Space attempts just past debounce so each is allowed until the cap.
  let history = [];
  let now = 0;
  let allowed = 0;
  for (let i = 0; i < KNOBS.maxAttempts; i++) {
    now += KNOBS.debounceMs + 1;
    const r = restartDecision({ history, now, ...KNOBS });
    assert.equal(r.allow, true, `attempt ${i} should be allowed`);
    history = r.history;
    allowed++;
  }
  assert.equal(allowed, KNOBS.maxAttempts);
  // The next trigger (past debounce, still within window) trips the breaker.
  now += KNOBS.debounceMs + 1;
  const tripped = restartDecision({ history, now, ...KNOBS });
  assert.equal(tripped.allow, false);
  assert.equal(tripped.reason, 'circuit-open');
  assert.ok(tripped.retryAfterMs > 0);
});

test('breaker stays open for the cooldown, then allows a single recovery probe', () => {
  // Build a tripped state: maxAttempts attempts, last one at t=last.
  let history = [];
  let now = 0;
  for (let i = 0; i < KNOBS.maxAttempts; i++) {
    now += KNOBS.debounceMs + 1;
    history = restartDecision({ history, now, ...KNOBS }).history;
  }
  const last = now;
  // Midway through the cooldown: still suppressed.
  const mid = restartDecision({ history, now: last + KNOBS.cooldownMs - 1, ...KNOBS });
  assert.equal(mid.allow, false);
  assert.equal(mid.reason, 'circuit-open');
  // Just after the cooldown: one probe restart is allowed (recovery path).
  const after = restartDecision({ history, now: last + KNOBS.cooldownMs + 1, ...KNOBS });
  assert.equal(after.allow, true);
});

test('a healthy restart resets history (caller clears) so the next failure restarts immediately', () => {
  // Caller resets to [] after waitForServerReady succeeds.
  const r = restartDecision({ history: [], now: 999_999, ...KNOBS });
  assert.equal(r.allow, true);
});

test('history is bounded: suppressed triggers never grow it, allowed ones prune to the window', () => {
  let history = [];
  let now = 0;
  // Drive far more triggers than the cap over a long span.
  for (let i = 0; i < 50; i++) {
    now += 1_000; // 1s apart — mostly debounced
    const r = restartDecision({ history, now, ...KNOBS });
    history = r.history;
  }
  // Even after 50 triggers the retained history stays small (bounded by window/debounce).
  assert.ok(history.length <= KNOBS.maxAttempts + 1, `history grew unbounded: ${history.length}`);
});

test('RESTART_DEFAULTS exposes sane operator knobs', () => {
  assert.ok(RESTART_DEFAULTS.debounceMs > 0);
  assert.ok(RESTART_DEFAULTS.maxAttempts >= 2);
  assert.ok(RESTART_DEFAULTS.windowMs > RESTART_DEFAULTS.debounceMs);
  assert.ok(RESTART_DEFAULTS.cooldownMs > 0);
});

// ── Wedged-hold escalation ──────────────────────────────────────────────────
// When the exec/GPU layer is demonstrably wedged (un-killable D-state), probing
// once per normal cooldown still spawns a fresh llama-server onto a locked GPU
// every minute, accumulating D-state processes until the host freezes. The
// `wedged` signal escalates to a much longer hold so probes drop ~15x and the
// router stays in remote-offload mode until manual recovery.

const WEDGE_KNOBS = { ...KNOBS, wedgedCooldownMs: 900_000 };

test('wedged: a single prior attempt holds long even below the attempt cap (not circuit-open)', () => {
  // One allowed attempt, then a wedged trigger past debounce but well under maxAttempts.
  const first = restartDecision({ history: [], now: 1_000, ...WEDGE_KNOBS });
  const r = restartDecision({
    history: first.history, now: 1_000 + KNOBS.debounceMs + 1, wedged: true, ...WEDGE_KNOBS
  });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'wedged-hold');
  assert.ok(r.retryAfterMs > KNOBS.cooldownMs, 'hold should exceed the normal cooldown');
  assert.deepEqual(r.history, first.history, 'suppressed triggers do not grow history');
});

test('wedged hold outlasts the normal cooldown (a probe that would be allowed un-wedged is suppressed)', () => {
  const first = restartDecision({ history: [], now: 0, ...WEDGE_KNOBS });
  const last = first.history[first.history.length - 1];
  // Just past the normal cooldown: un-wedged this would allow a probe...
  const unwedged = restartDecision({ history: first.history, now: last + KNOBS.cooldownMs + 1, ...WEDGE_KNOBS });
  assert.equal(unwedged.allow, true, 'sanity: un-wedged allows a probe after cooldown');
  // ...but wedged it is still held.
  const wedged = restartDecision({ history: first.history, now: last + KNOBS.cooldownMs + 1, wedged: true, ...WEDGE_KNOBS });
  assert.equal(wedged.allow, false);
  assert.equal(wedged.reason, 'wedged-hold');
});

test('wedged: after wedgedCooldownMs a single recovery probe is allowed', () => {
  const first = restartDecision({ history: [], now: 0, ...WEDGE_KNOBS });
  const last = first.history[first.history.length - 1];
  const mid = restartDecision({ history: first.history, now: last + WEDGE_KNOBS.wedgedCooldownMs - 1, wedged: true, ...WEDGE_KNOBS });
  assert.equal(mid.allow, false);
  assert.equal(mid.reason, 'wedged-hold');
  const after = restartDecision({ history: first.history, now: last + WEDGE_KNOBS.wedgedCooldownMs + 1, wedged: true, ...WEDGE_KNOBS });
  assert.equal(after.allow, true, 'one probe allowed once the long hold elapses');
});

test('wedged with empty history still allows the first attempt (nothing to hold against yet)', () => {
  const r = restartDecision({ history: [], now: 5_000, wedged: true, ...WEDGE_KNOBS });
  assert.equal(r.allow, true);
  assert.equal(r.reason, 'ok');
});

test('wedged=false preserves the original circuit-breaker behavior', () => {
  // Build a tripped state, then confirm a probe is allowed right after the normal cooldown.
  let history = [];
  let now = 0;
  for (let i = 0; i < KNOBS.maxAttempts; i++) {
    now += KNOBS.debounceMs + 1;
    history = restartDecision({ history, now, wedged: false, ...WEDGE_KNOBS }).history;
  }
  const last = now;
  const after = restartDecision({ history, now: last + KNOBS.cooldownMs + 1, wedged: false, ...WEDGE_KNOBS });
  assert.equal(after.allow, true);
});

test('RESTART_DEFAULTS includes a wedged-hold cooldown longer than the normal cooldown', () => {
  assert.ok(RESTART_DEFAULTS.wedgedCooldownMs > RESTART_DEFAULTS.cooldownMs);
});

// ── Sustained-thrash (slow-loop) escalation ─────────────────────────────────
// The 60s circuit-breaker window can't see a loop whose period exceeds it: the
// observed "router restarts ready, model unservable ~30s later, restart again"
// pattern recurs ~every 2.4 min, so it never gets 4 restarts inside 60s and never
// trips — yet it churns indefinitely. A second, longer detector trips the long
// hold when there are sustainedAttempts restarts within sustainedWindowMs,
// regardless of whether each restart reported the router "ready".

const SLOW_KNOBS = { ...KNOBS, wedgedCooldownMs: 900_000, sustainedAttempts: 5, sustainedWindowMs: 900_000 };

// Build N allowed restarts spaced `spacingMs` apart starting at t=0. Asserts each
// is allowed (so the test fails loudly if the circuit breaker trips unexpectedly).
function buildAllowed(n, spacingMs, knobs) {
  let history = [];
  let now = 0;
  for (let i = 0; i < n; i++) {
    const r = restartDecision({ history, now, ...knobs });
    assert.equal(r.allow, true, `restart ${i} at t=${now} should be allowed`);
    history = r.history;
    now += spacingMs;
  }
  return { history, lastNow: now - spacingMs, nextNow: now };
}

test('sustained-thrash: a slow loop (period > 60s window) trips the long hold even though the circuit never bunches', () => {
  // 5 restarts 3 min apart: each past debounce, never 4-within-60s, so circuit-open never fires.
  const { history, nextNow } = buildAllowed(5, 180_000, SLOW_KNOBS);
  const r = restartDecision({ history, now: nextNow, ...SLOW_KNOBS });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'sustained-thrash');
  assert.ok(r.retryAfterMs > KNOBS.cooldownMs, 'sustained hold should exceed the normal cooldown');
  assert.deepEqual(r.history, history, 'suppressed triggers do not grow history');
});

test('sustained-thrash: a healthy slow cadence (slower than sustainedWindowMs/sustainedAttempts) is NOT flagged', () => {
  // 5 min apart > the 3-min effective threshold (900s / 5): pruning keeps history short, no trip.
  const { history, nextNow } = buildAllowed(5, 300_000, SLOW_KNOBS);
  const r = restartDecision({ history, now: nextNow, ...SLOW_KNOBS });
  assert.equal(r.allow, true);
  assert.equal(r.reason, 'ok');
});

test('sustained-thrash: after the long hold elapses, one probe is allowed', () => {
  const { history, lastNow } = buildAllowed(5, 180_000, SLOW_KNOBS);
  const mid = restartDecision({ history, now: lastNow + SLOW_KNOBS.wedgedCooldownMs - 1, ...SLOW_KNOBS });
  assert.equal(mid.allow, false);
  assert.equal(mid.reason, 'sustained-thrash');
  const after = restartDecision({ history, now: lastNow + SLOW_KNOBS.wedgedCooldownMs + 1, ...SLOW_KNOBS });
  assert.equal(after.allow, true, 'one probe allowed once the long hold elapses');
});

test('RESTART_DEFAULTS exposes sustained-thrash knobs (slow-loop detection over a long window)', () => {
  assert.ok(RESTART_DEFAULTS.sustainedAttempts >= RESTART_DEFAULTS.maxAttempts);
  assert.ok(RESTART_DEFAULTS.sustainedWindowMs > RESTART_DEFAULTS.windowMs);
});
