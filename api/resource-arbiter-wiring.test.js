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

test('the supervisor launch passes the override size to strataServerConfig', () => {
  const body = fnBody('getStrataSupervisor');
  assert.match(body, /strataServerConfig\(\{ cfg, preset, backend, expertCache: override\?\.expertCache \}\)/);
});

test('/api/stats exposes per-model queue depth across the llama and exclusive lanes', () => {
  assert.match(source, /byModel: mergeModelDepths\(llamaQueue\.getModelDepths\(\), ds4Queue\.getModelDepths\(\)\)/);
});

test('POST /api/config enforces configUpdateRefusal before saving (review LOW)', () => {
  const at = source.indexOf("app.post('/api/config'");
  const route = source.slice(at, source.indexOf('\napp.', at + 10));
  const call = route.search(/const refusal = configUpdateRefusal\(\{ updates, loopback: isLoopbackRequest\(req\), host: req\.headers\.host, origin: req\.headers\.origin, localNames: configWriteLocalNames\(\) \}\);\n\s*if \(refusal\) return res\.status\(refusal\.status\)\.json\(refusal\.body\);/);
  assert.ok(call > 0, 'the route calls configUpdateRefusal and returns its refusal');
  assert.ok(call < route.indexOf('config = { ...config, ...updates }'), 'before the config is changed');
});

test('HIP attempt sizes through sizeHipCacheNow (the tested sizeStrataHipCache) and launches with it', () => {
  const body = fnBody('startStrataAttempt');
  assert.match(body, /fit = await sizeHipCacheNow\(cfg, headroomBytes, \{ keepAtLeast, maxSlots \}\)/);
  assert.match(body, /launch\.expertCache = fit\.slots/);
  assert.match(body, /getStrataSupervisor\(\)\.start\(preset, \{ planMode: true, override: launch \}\)/);
  const now = fnBody('sizeHipCacheNow');
  assert.match(now, /return sizeStrataHipCache\(\{/);
  assert.match(now, /releaseIdle: releaseIdlePodsWorkers/);
  assert.match(now, /keepWaitMs: STRATA_RESTART_KEEP_WAIT_MS, floorWaitMs: DS4_RECLAIM_TIMEOUT_MS/);
  assert.match(source, /const STRATA_RESTART_KEEP_WAIT_MS = 30_000;/);
  assert.doesNotMatch(fnBody('strataBackendTick'), /releaseIdlePodsWorkers/, 'grow-back never asks Pods');
});

test('a grow restart is capped at the decided size and falls back to the previous size (re-review)', () => {
  const body = fnBody('strataBackendTick');
  const grow = body.indexOf('strataGrowDecision(');
  assert.ok(grow > 0 && grow < body.indexOf('|| !cfg.cuda'), 'grow-back runs on HIP-only hosts');
  assert.match(body, /growMarginBytes: cfg\.hip\.growMarginBytes/);
  assert.match(body, /hipAttempts: \[\{ keepAtLeast: prev, maxSlots: grow\.slots \}, \{ keepAtLeast: prev, maxSlots: prev \}\]/);
  assert.match(fnBody('runStrataLoadPhase'), /hipAttempts\.map\(\(a\) => \(\{ backend: 'hip', \.\.\.a \}\)\)/);
  assert.match(fnBody('strataSwapBackend'), /runStrataLoadPhase\(target, reason, settle, \{ hipAttempts \}\)/);
  assert.match(fnBody('startStrataAttempt'), /keepAtLeast = 0, maxSlots = Infinity/);
});

test('prefill watchdog: the cancelled request fails, only Strata waits, a wedge restarts at the same size (re-review)', () => {
  const body = fnBody('strataBackendTick');
  assert.match(body, /strataPrefillVerdict\(\{\s*live: await readStrataLive\(cfg\.port\), prev: strataState\.prefillWatch, reqId: holder\?\.activeReqId \?\? null/);
  assert.match(body, /abort\(prefillStalledError\(pf\.reason\)\)/, 'the holder is aborted with the no-replay reason');
  const hold = fnBody('holdStrataLane');
  assert.doesNotMatch(hold, /armSwapGate/, 'the hold does not gate llama or remote traffic');
  assert.match(hold, /front: true/);
  const arm = body.indexOf('const settle = EXCLUSIVE_ENGINES[ENGINE_TYPES.STRATA].armSwapGate();');
  const abortQueued = body.indexOf("if (settle) for (const entry of activeRequests.values()) if (entry.backend === 'strata') entry.abortController?.abort();");
  const free = body.indexOf('await releaseStrataLaneHold(hold);', abortQueued);
  assert.ok(arm > 0 && abortQueued > arm && free > abortQueued, 'gate, then abort queued (replayed), then free the slot');
  assert.match(body, /hipAttempts: \[size \? \{ keepAtLeast: size, maxSlots: size \} : \{\}\]/);
  assert.match(body, /strataState\.prefillHold && !pf\.state\?\.cancelledAt/);
  const recovery = fnBody('serveDs4WithSwapRecovery');
  assert.match(recovery, /prefillStalled = isPrefillStalled\(err\)/);
  assert.match(recovery, /res\.status\(504\)\.json\(\{ error: \{ message: err\.message, type: 'prefill_stalled'/);
});
