// Llama Manager — source-text wiring tests for the Strata engine in api/server.js.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// server.js is a monolith with no exports (importing it boots the server), so this
// reads its source and pins the Strata wiring from docs/Designs/StrataEngine.md
// §3/§5.2/§7/§8.2/§9/§10/§11: the EXCLUSIVE_ENGINES entry, supervisor, kill/activate/
// attempt helpers, the shared Llama eviction, preset create/activate routing, shutdown,
// stats payload, memory watchdog, restart-beside-exclusive and ensure-for-model hooks.
// A few behavioural checks use only the pure helpers exported by engines.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { ENGINE_TYPES, isStrataPreset } from './engines.js';

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

test('EXCLUSIVE_ENGINES registers the Strata engine', () => {
  const start = source.indexOf('const EXCLUSIVE_ENGINES = {');
  assert.notEqual(start, -1);
  const end = source.indexOf('\n};', start);
  assert.ok(source.slice(start, end).includes('[ENGINE_TYPES.STRATA]:'));
});

test('getStrataSupervisor builds an engine supervisor', () => {
  includesAll(fnBody('getStrataSupervisor'), ['createEngineSupervisor('], 'getStrataSupervisor');
});

test('strataRunKill kills the strata pids robustly', () => {
  includesAll(fnBody('strataRunKill'), ["killEnginePidsRobust('strata')"], 'strataRunKill');
});

test('activateStrataExclusive runs the adaptive plan with startStrataAttempt', () => {
  includesAll(fnBody('activateStrataExclusive'), ['runDs4AdaptivePlan({', 'startStrataAttempt'], 'activateStrataExclusive');
});

test('startStrataAttempt reaps resident pids and evicts llama', () => {
  includesAll(fnBody('startStrataAttempt'), ["residentEnginePids('strata')", 'evictLlamaForExclusive('], 'startStrataAttempt');
});

test('evictLlamaForExclusive is shared with the DS4 activation', () => {
  assert.match(source, /^async function evictLlamaForExclusive\(/m);
  includesAll(fnBody('activateDs4Exclusive'), ['evictLlamaForExclusive('], 'activateDs4Exclusive');
});

test('POST /api/presets recognises Strata before the required-fields check', () => {
  const body = routeBody("app.post('/api/presets'");
  const strata = body.indexOf('ENGINE_TYPES.STRATA');
  const missing = body.indexOf('Missing required fields');
  assert.notEqual(strata, -1, 'route must handle ENGINE_TYPES.STRATA');
  assert.notEqual(missing, -1);
  assert.ok(strata < missing, 'Strata handling must precede the Missing required fields rejection');
});

test('preset activate route dispatches Strata presets', () => {
  includesAll(routeBody("app.post('/api/presets/:presetId/activate'"), ['isStrataPreset(preset)'], 'activate route');
});

test('shutdownWithTimeout stops the Strata server', () => {
  includesAll(fnBody('shutdownWithTimeout'), ['stopStrataServer()'], 'shutdownWithTimeout');
});

test('getSystemStats reports strata and strataRuntime', () => {
  const body = fnBody('getSystemStats');
  assert.ok(body.includes('ds4Runtime'), 'sanity: this is the stats payload builder');
  includesAll(body, ['strata:', 'strataRuntime:'], 'getSystemStats');
});

test('the memory watchdog interval handles the Strata engine', () => {
  const start = source.indexOf('isProcessHeaviest(\'ds4-server\')');
  assert.notEqual(start, -1);
  const open = source.lastIndexOf('setInterval(() => {\n  if (memWatchdogCooldown', start);
  assert.notEqual(open, -1, 'mem-watchdog setInterval must exist');
  const close = source.indexOf('\n}, ', start);
  assert.ok(source.slice(open, close).includes('ENGINE_TYPES.STRATA'));
});

test('restartLlamaServer can restart beside an exclusive engine', () => {
  includesAll(fnBody('restartLlamaServer'), ['besideExclusive'], 'restartLlamaServer');
});

test('ensureDs4ForModel resolves Strata presets by model', () => {
  includesAll(fnBody('ensureDs4ForModel'), ['strataPresetForModel('], 'ensureDs4ForModel');
});

test('engines.js pure helpers identify Strata presets', () => {
  assert.equal(ENGINE_TYPES.STRATA, 'strata');
  assert.equal(isStrataPreset({ engine: 'strata' }), true);
  assert.equal(isStrataPreset({ engine: 'llama' }), false);
});
