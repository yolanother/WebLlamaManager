// Copyright (c) DoubTech. See LICENSE file in the project root for full license information.
//
// A remote backend that ACCEPTS a request and then produces nothing is a failing
// backend, but the stall watchdog only aborted the request — it never told the
// circuit breaker. So the same dead backend was chosen again and again.
//
// Measured 2026-09-22: "Stall watchdog: aborting remote request 1548 (backend:
// drakemore-mtj8prpy, model: default-big, 0 tokens, idle 393s >= 393s)". The
// caller saw an empty body, and nothing marked the backend unhealthy.
//
// The breaker already resets itself after CIRCUIT_BREAKER_RESET_MS, so a backend
// that comes back (Dahaka does) recovers with no manual re-enabling.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

/** The stall watchdog's remote-abort branch. */
function watchdogAbortBlock() {
  const i = SRC.indexOf('Stall watchdog: aborting remote request');
  assert.ok(i > -1, 'watchdog abort message must exist');
  // Generous window: the branch carries explanatory comments and a multi-line
  // call, and a tight slice fails for formatting rather than for behaviour.
  return SRC.slice(i, i + 3000);
}

test('watchdog kill records a backend failure for the circuit breaker', () => {
  const block = watchdogAbortBlock();
  assert.ok(
    block.includes('recordBackendFailure('),
    'a watchdog kill must feed the circuit breaker, or the dead backend keeps being selected',
  );
});

test('watchdog kill is attributed to the backend it stalled on', () => {
  const block = watchdogAbortBlock();
  assert.ok(
    /recordBackendFailure\(\s*entry\.backend/.test(block),
    'the failure must be recorded against entry.backend, not a hardcoded id',
  );
});

test('circuit breaker still resets itself so a recovered backend returns', () => {
  // Dahaka comes back on its own; nothing here may require manual re-enabling.
  assert.ok(SRC.includes('CIRCUIT_BREAKER_RESET_MS'), 'reset window must exist');
});

test('a ZERO-token stall trips the breaker immediately, not after 3 strikes', () => {
  // CIRCUIT_BREAKER_THRESHOLD is 3, and each stall costs ~394s. Measured
  // 2026-09-22: drakemore stalled twice in a row at 393s/394s with 0 tokens and
  // never tripped, so it kept being selected and killed an episode each time.
  // A backend that ACCEPTED work and produced literally nothing is not "flaky" —
  // it is unusable right now, which the 60s reset window already un-does safely.
  const block = watchdogAbortBlock();
  assert.ok(
    /entry\.tokens === 0/.test(block),
    'the zero-token case must be distinguished from a partial/slow response',
  );
  assert.ok(
    /trip:\s*true|tripImmediately|{\s*trip/.test(block),
    'a zero-token stall must trip the breaker on the first occurrence',
  );
});

test('immediate trip still honours the automatic reset window', () => {
  // Nothing may require a human to re-enable a recovered backend.
  assert.ok(
    SRC.includes('Date.now() - cb.trippedAt > CIRCUIT_BREAKER_RESET_MS'),
    'half-open retry after the reset window must remain',
  );
});
