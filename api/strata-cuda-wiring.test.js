// Llama Manager — source-text wiring tests for the Strata CUDA/HIP backend policy in api/server.js.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// server.js is a monolith with no exports, so this reads its source and pins the CUDA wiring
// from docs/Designs/StrataEngine.md §8.2/§8.4/§8.5/§8.6/§9: the policy tick inside the GPU
// sweep interval, the backend swap and leave-CUDA helpers, the drain-before-hold ordering for
// Pods preemption, the sweep skipping Strata's own lease, the CUDA attempt (reservation lease,
// no-wait, wait for drain), CUDA admission on activation, and lease release on stop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

/**
 * Returns the text of the top-level function `name`, up to the next column-0 function or app.* statement.
 * @param {string} name - function name, declared `async function name(` or `function name(`.
 * @returns {string} the function source.
 */
function fnBody(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(m, `${name} must exist in server.js`);
  const rest = source.slice(m.index + m[0].length);
  const next = rest.search(/^(?:async function |function |app\.)/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Asserts every needle occurs in `body`.
 * @param {string} body - text to search.
 * @param {string[]} needles - required substrings.
 * @param {string} label - region name for failure messages.
 */
function includesAll(body, needles, label) {
  for (const n of needles) assert.ok(body.includes(n), `${label} must contain ${n}`);
}

/** The GPU sweep setInterval region. */
function sweepRegion() {
  const a = source.indexOf('for (const expired of gpuReservations.sweep())');
  assert.notEqual(a, -1, 'GPU sweep loop must exist');
  const b = source.indexOf('}, GPU_SWEEP_INTERVAL_MS)', a);
  assert.notEqual(b, -1, 'GPU sweep interval must close with GPU_SWEEP_INTERVAL_MS');
  return source.slice(a, b);
}

test('strataBackendTick is called from the GPU sweep interval and uses the pure policy', () => {
  assert.match(source, /^async function strataBackendTick\(/m);
  assert.ok(sweepRegion().includes('strataBackendTick('), 'sweep must call strataBackendTick(');
  includesAll(fnBody('strataBackendTick'), ['strataBackendDecision(', 'otherComputeVramBytes('], 'strataBackendTick');
});

test('swap and leave-CUDA helpers exist and cancel in-flight strata entries', () => {
  assert.match(source, /^async function strataSwapBackend\(/m);
  assert.match(source, /^async function strataLeaveCuda\(/m);
  const body = fnBody('strataSwapBackend') + fnBody('strataLeaveCuda');
  const at = body.indexOf('abortController?.abort()');
  assert.notEqual(at, -1, 'swap/leave-CUDA must abort in-flight entries via abortController?.abort()');
  assert.ok(body.includes("'strata'"), "swap/leave-CUDA must filter entries by backend 'strata'");
});

test('drainForReservation leaves CUDA before it marks anything held', () => {
  const body = fnBody('drainForReservation');
  const leave = body.indexOf('strataLeaveCuda(');
  const held = body.indexOf('markHeld(');
  assert.notEqual(leave, -1, 'drainForReservation must call strataLeaveCuda(');
  assert.notEqual(held, -1, 'drainForReservation must call markHeld(');
  assert.ok(leave < held, 'strataLeaveCuda( must precede the first markHeld(');
});

test('the sweep drain loop skips Strata\'s own CUDA lease', () => {
  assert.ok(sweepRegion().includes('strataState.cudaLeaseId'), 'sweep must skip strataState.cudaLeaseId');
});

test('startStrataAttempt reserves with the Strata holder, no-wait, and waits for the drain', () => {
  includesAll(fnBody('startStrataAttempt'), ['holder: STRATA_HOLDER', 'noWait: true', 'waitForGpuReservation('], 'startStrataAttempt');
});

test('activateStrataExclusive gates the CUDA attempt on cudaAdmission', () => {
  assert.ok(fnBody('activateStrataExclusive').includes('cudaAdmission('), 'activateStrataExclusive must call cudaAdmission(');
});

test('stopStrataServer releases the CUDA lease', () => {
  assert.ok(fnBody('stopStrataServer').includes('cudaLeaseId'), 'stopStrataServer must release strataState.cudaLeaseId');
});
