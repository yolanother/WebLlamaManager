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
