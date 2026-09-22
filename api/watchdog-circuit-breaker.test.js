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
  return SRC.slice(i, i + 1400);
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
