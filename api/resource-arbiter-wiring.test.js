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

test('HIP attempt sizes the expert cache with sizeStrataHipCache and launches with it', () => {
  const body = fnBody('startStrataAttempt');
  assert.match(body, /async function startStrataAttempt|keepAtLeast = 0/);
  assert.match(body, /fit = await sizeStrataHipCache\(cfg, headroomBytes, keepAtLeast\)/);
  assert.match(body, /launch\.expertCache = fit\.slots/, 'the chosen size goes into the launch override');
  assert.match(body, /runtime\.expertCache = /, 'the chosen size and reason are recorded');
  assert.match(body, /getStrataSupervisor\(\)\.start\(preset, \{ planMode: true, override: launch \}\)/);
});

test('a restarted serving engine waits to keep its previous cache before sizing down (review HIGH 1)', () => {
  const body = fnBody('sizeStrataHipCache');
  const keep = body.indexOf('if (keep > 0)');
  const wait = body.indexOf('await waitFor(keep)');
  const fresh = body.indexOf('const fit = choose(cfg.hip.minExpertCache)');
  assert.ok(keep > 0 && wait > keep && fresh > wait, 'keep-previous-size wait comes before the fresh fit');
  assert.match(body, /timeoutMs: DS4_RECLAIM_TIMEOUT_MS/);
  assert.match(fnBody('runStrataLoadPhase'), /\{ backend: 'hip', keepAtLeast \}/);
  assert.match(fnBody('strataSwapBackend'), /runStrataLoadPhase\(target, reason, settle, \{ keepAtLeast \}\)/);
});

test('Pods release is asked only when a start would be refused, never to grow (review MEDIUM)', () => {
  const body = fnBody('sizeStrataHipCache');
  const refusedOnly = body.indexOf('if (fit.slots !== null) return fit;');
  const release = body.indexOf('await releaseIdlePodsWorkers(');
  assert.ok(refusedOnly > 0 && release > refusedOnly, 'release only after the floor did not fit');
  assert.match(fnBody('releaseIdlePodsWorkers'), /requestPodsIdleRelease\(\{ config, env: process\.env, reason, fetchFn: fetch/);
  assert.doesNotMatch(fnBody('strataBackendTick'), /releaseIdlePodsWorkers/);
  assert.doesNotMatch(fnBody('startStrataAttempt'), /releaseIdlePodsWorkers/);
});

test('the backend tick grows with the margin, before the CUDA-only early return, keeping the current size', () => {
  const body = fnBody('strataBackendTick');
  const grow = body.indexOf('strataGrowDecision(');
  assert.ok(grow > 0 && grow < body.indexOf('|| !cfg.cuda'), 'grow-back runs on HIP-only hosts');
  assert.match(body, /growMarginBytes: cfg\.hip\.growMarginBytes/);
  assert.match(body, /strataSwapBackend\('hip', grow\.reason, \{ keepAtLeast: runtime\.expertCache\.effective \}\)/);
});

test('prefill watchdog: bound to the slot holder, holds the lane on cancel, restarts under that hold (review HIGH 3)', () => {
  const body = fnBody('strataBackendTick');
  assert.match(body, /strataPrefillVerdict\(\{\s*live: await readStrataLive\(cfg\.port\), prev: strataState\.prefillWatch, reqId: holder\?\.activeReqId \?\? null/);
  assert.match(body, /stallMs: cfg\.policy\.prefillStallMs/);
  const hold = body.indexOf('strataState.prefillHold = holdStrataLane();');
  const abort = body.indexOf('activeRequests.get(holder.activeReqId)?.abortController?.abort()');
  assert.ok(hold > 0 && abort > hold, 'the lane is held before the holder is aborted');
  const abortQueued = body.indexOf("if (entry.backend === 'strata') entry.abortController?.abort();");
  const freeSlot = body.indexOf('await releaseStrataLaneHold(hold, { settleGate: false })');
  assert.ok(abortQueued > 0 && freeSlot > abortQueued, 'queued requests are aborted (for replay) before the held slot is freed');
  assert.match(body, /strataSwapBackend\(runtime\.backend, 'prefill-wedged', \{\s*settle: hold\?\.settle, keepAtLeast: runtime\.expertCache\?\.effective \?\? 0, drainMs: 0,/);
  assert.match(body, /strataState\.prefillHold && !pf\.state\?\.cancelledAt/, 'recovery after the cancel releases the lane');
  const holdFn = fnBody('holdStrataLane');
  assert.match(holdFn, /armSwapGate\(\)/);
  assert.match(holdFn, /ds4Queue\.acquire\(\{[^}]*priority: 'realtime'/);
  assert.match(fnBody('strataSwapBackend'), /const settle = armed \|\| EXCLUSIVE_ENGINES\[ENGINE_TYPES\.STRATA\]\.armSwapGate\(\)/);
  assert.match(fnBody('strataLeaveCuda'), /drainExclusiveRequests\(eng, drainMs \?\? strataConfig\(\)\.policy\.drainMaxWaitMs\)/);
  const live = fnBody('readStrataLive');
  assert.match(live, /\/metrics/);
  assert.match(live, /Accept: 'application\/json'/);
});

test('POST /api/config enforces configUpdateRefusal before saving (review LOW)', () => {
  const at = source.indexOf("app.post('/api/config'");
  const route = source.slice(at, source.indexOf('\napp.', at + 10));
  const call = route.search(/const refusal = configUpdateRefusal\(\{ updates, loopback: isLoopbackRequest\(req\), host: req\.headers\.host, origin: req\.headers\.origin, localNames: configWriteLocalNames\(\) \}\);\n\s*if \(refusal\) return res\.status\(refusal\.status\)\.json\(refusal\.body\);/);
  assert.ok(call > 0, 'the route calls configUpdateRefusal and returns its refusal');
  assert.ok(call < route.indexOf('config = { ...config, ...updates }'), 'before the config is changed');
});
