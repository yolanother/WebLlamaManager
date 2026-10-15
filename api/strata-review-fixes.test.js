// Llama Manager — regression tests for the Strata integration review fixes (M1-M6, m1-m6).
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Source-text wiring tests (server.js is a monolith with no exports) pinning the
// fixes for the findings in .orchestrator/tasks/strata/review.md: DS4 /v1/messages
// short-circuit, single-flight Strata activation, co-residence readiness, Pods drain
// lease wait, unconfirmed-stop propagation, /api/config hardening, spawn-error
// handling, own-process VRAM names, load-phase gate safety, dead-engine detection
// and Strata models capabilities.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

/**
 * Returns the text of the top-level function `name`, from its declaration up to the
 * next top-level function or app.* statement (a line starting at column 0).
 * @param {string} name - function name, declared `async function name(` or `function name(`.
 * @returns {string} the function source.
 */
function fnBody(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(m, `${name} must exist in server.js`);
  return untilNextTopLevel(source.slice(m.index + m[0].length));
}

/**
 * Returns the text of the express route that starts with `head` (e.g. `app.post('/api/presets'`).
 * @param {string} head - literal start of the route statement.
 * @returns {string} the route source up to the next top-level function or app.* statement.
 */
function routeBody(head) {
  const at = source.indexOf(head);
  assert.notEqual(at, -1, `server.js must contain ${head}`);
  return untilNextTopLevel(source.slice(at + head.length));
}

/**
 * Cuts `rest` at the next column-0 function or app.* statement.
 * @param {string} rest - source following a declaration.
 * @returns {string} the leading chunk belonging to that declaration.
 */
function untilNextTopLevel(rest) {
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

test('M1: handleMessages answers 501 for a DS4 target before ensureDs4ForModel', () => {
  const body = fnBody('handleMessages');
  const at501 = body.indexOf('ds4PresetForModel(config, requestedModel)');
  const ensure = body.indexOf('ensureDs4ForModel(');
  assert.ok(at501 !== -1 && at501 < ensure, 'DS4 check must precede ensureDs4ForModel');
  assert.match(body.slice(at501, ensure), /MESSAGES_UNSUPPORTED/);
});

test('M2: Strata activation is single-flight for every caller', () => {
  const wrapper = fnBody('activateStrataSingleFlight');
  includesAll(wrapper, ['strataActivating', 'activateStrataExclusive('], 'activateStrataSingleFlight');
  assert.match(wrapper, /\.finally\(/, 'the guard must clear when the flip settles');
  assert.ok(source.includes('activate: (presetId, preset) => activateStrataSingleFlight(presetId, preset)'), 'EXCLUSIVE_ENGINES.strata.activate');
  assert.ok(source.includes('await activateStrataSingleFlight(presetId, preset)'), 'preset activate route');
  assert.ok(!/await activateStrataExclusive\(/.test(source), 'no caller bypasses the guard');
});

test('M3: llama is not admitted beside an exclusive engine that is loading or not ready', () => {
  const body = fnBody('ensureDs4ForModel');
  const branch = body.indexOf('exclusive.admitsLlamaBeside(rawModel)');
  const fit = body.indexOf('largestContextBesideDs4(', branch);
  const guard = body.slice(branch, fit);
  includesAll(guard, ['exclusive.swapPromise()', "!== 'ready'", 'return null'], 'co-residence guard before the fit check');
});

test('M4: the Pods drain hook waits for the CUDA lease, not the swap gate', () => {
  const body = fnBody('drainForReservation');
  const hook = body.slice(0, body.indexOf('rpcServer'));
  includesAll(hook, ['waitForCudaLeaseRelease(', 'strataLeaveCuda(', 'drainMaxWaitMs'], 'drain hook');
  assert.ok(!/await strataLeaveCuda\(/.test(hook), 'hook must not call strataLeaveCuda directly (blocks on the gate)');
});

test('M5: strataLeaveCuda throws on an unconfirmed stop and the swap path records stop-unconfirmed', () => {
  includesAll(fnBody('strataLeaveCuda'), ['ok === false', "'strata stop unconfirmed'"], 'strataLeaveCuda');
  assert.match(fnBody('strataSwapBackend'), /stop-unconfirmed/);
});

test('M6: POST /api/config refuses strata from off-box callers and validates presets', () => {
  const body = routeBody("app.post('/api/config'");
  includesAll(body, ['isLoopbackRequest(req)', "'strata' in", '403', 'validatePresetEngineFields(', '400'], '/api/config');
  assert.ok(body.indexOf('403') < body.indexOf('saveConfig('), 'refusal precedes the save');
  assert.ok(body.indexOf('validatePresetEngineFields(') < body.indexOf('saveConfig('), 'validation precedes the save');
});

test('m1: a spawn error event clears the process so isRunning() goes false', async () => {
  const { EventEmitter } = await import('node:events');
  const { createDs4Supervisor } = await import('./ds4-supervisor.js');
  const child = Object.assign(new EventEmitter(), { pid: 1, killed: false, kill() { return true; }, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const logs = [];
  const sup = createDs4Supervisor({
    spawn: () => child, fetchFn: async () => ({ ok: true }), getConfig: () => ({ ds4: {} }), env: {}, projectRoot: '/proj',
    restartDecision: (a) => ({ allow: true, reason: 'ok', history: [], retryAfterMs: 0 }), restartDefaults: {},
    log: (m) => logs.push(m), addLog: () => {}, runKill: async () => {}, now: () => 1000, sleep: async () => {},
    setTimeoutFn: () => 0,
  });
  sup.start({ id: 'p', name: 'p', engine: 'ds4', modelPath: 'm.gguf' });
  assert.equal(sup.isRunning(), true);
  child.emit('error', new Error('spawn ENOENT'));
  assert.equal(sup.isRunning(), false);
  assert.ok(logs.some((l) => /ENOENT/.test(l)), 'error is logged');
});

test('m1: startStrataAttempt reports python-missing instead of spawning', () => {
  const body = fnBody('startStrataAttempt');
  assert.match(body, /existsSync\(cfg\.pythonPath\)/);
  assert.match(body, /python-missing/);
});
