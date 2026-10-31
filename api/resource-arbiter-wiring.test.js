// Llama Manager — source-text wiring tests for the resource arbiter in api/server.js.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// server.js has no exports (importing it boots the server), so these tests read its
// source and pin how the pure arbiter helpers are called: the HIP attempt sizes the
// Strata expert cache with strataHipExpertCache and launches with that size, the backend
// tick grows a shrunk idle engine back through the swap path (also on HIP-only hosts),
// the prefill watchdog polls Strata /metrics, the Pods release client is called only
// behind its flag, and /api/stats exposes per-model queue depth.
// Design: docs/Designs/ResourceArbiter.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

/**
 * Returns the text of the top-level function `name`, up to the next column-0 function or app.* statement.
 * @param {string} name - function name.
 * @returns {string} the function source.
 */
function fnBody(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(m, `${name} must exist in server.js`);
  const rest = source.slice(m.index + m[0].length);
  const next = rest.search(/^(?:async function |function |app\.)/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('HIP attempt sizes the expert cache to available memory and launches with it', () => {
  const body = fnBody('startStrataAttempt');
  assert.match(body, /strataHipExpertCache\(\{/);
  assert.match(body, /launch\.expertCache = fit\.slots/, 'the chosen size goes into the launch override');
  assert.match(body, /runtime\.expertCache = /, 'the chosen size and reason are recorded');
  assert.match(body, /getStrataSupervisor\(\)\.start\(preset, \{ planMode: true, override: launch \}\)/);
});

test('the supervisor launch passes the override size to strataServerConfig', () => {
  const body = fnBody('getStrataSupervisor');
  assert.match(body, /strataServerConfig\(\{ cfg, preset, backend, expertCache: override\?\.expertCache \}\)/);
});

test('the backend tick grows a shrunk idle HIP engine before the CUDA-only early return', () => {
  const body = fnBody('strataBackendTick');
  const grow = body.indexOf('strataGrowDecision(');
  assert.ok(grow > 0, 'strataBackendTick calls strataGrowDecision');
  assert.ok(grow < body.indexOf('|| !cfg.cuda'), 'grow-back runs on HIP-only hosts (drakemore has no cuda block)');
  assert.match(body, /strataSwapBackend\('hip', grow\.reason\)/);
});

test('/api/stats exposes per-model queue depth across the llama and exclusive lanes', () => {
  assert.match(source, /byModel: mergeModelDepths\(llamaQueue\.getModelDepths\(\), ds4Queue\.getModelDepths\(\)\)/);
});

test('the backend tick runs the prefill watchdog on Strata /metrics: cancel the slot holder, restart a wedged engine', () => {
  const body = fnBody('strataBackendTick');
  assert.match(body, /strataPrefillVerdict\(\{ live: await readStrataLive\(cfg\.port\)/);
  assert.match(body, /stallMs: cfg\.policy\.prefillStallMs/);
  assert.match(body, /ds4Queue\.activeItems\.values\(\)/, 'cancels the request holding the exclusive slot');
  assert.match(body, /strataSwapBackend\(runtime\.backend, 'prefill-wedged'\)/);
  const live = fnBody('readStrataLive');
  assert.match(live, /\/metrics/);
  assert.match(live, /Accept: 'application\/json'/);
});
