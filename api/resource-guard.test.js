// Llama Manager — unit tests for api/resource-guard.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModelFit, thermalDecision, planMemoryRecovery, dispatchPreference, DEFAULTS } from './resource-guard.js';

const GiB = 2 ** 30;

test('checkModelFit: small model at modest context fits', () => {
  const r = checkModelFit({ fileBytes: 10 * GiB, contextSize: 8192, availableBytes: 124 * GiB });
  assert.equal(r.fits, true);
  assert.equal(r.recommendedContext, 8192);
});

test('checkModelFit: oversized model+context is refused but a smaller context is recommended', () => {
  // 59GiB weights at 131072 ctx with little free RAM: original ctx does not fit.
  const r = checkModelFit({
    fileBytes: 59 * GiB, contextSize: 131072, availableBytes: 90 * GiB,
    kvBytesPerToken: 262144, overheadBytes: 3 * GiB, headroomFrac: 0.1, minContext: 4096
  });
  assert.equal(r.fits, false);
  // weights(59) + overhead(3) = 62 < budget(81) => some context fits => recommend a capped ctx
  assert.ok(r.recommendedContext !== null && r.recommendedContext >= 4096);
  assert.ok(r.recommendedContext < 131072);
});

test('checkModelFit: weights alone exceed budget => cannot fit, no recommendation', () => {
  const r = checkModelFit({
    fileBytes: 120 * GiB, contextSize: 8192, availableBytes: 124 * GiB,
    overheadBytes: 3 * GiB, headroomFrac: 0.1, minContext: 4096
  });
  assert.equal(r.fits, false);
  assert.equal(r.recommendedContext, null);
  assert.match(r.reason, /too large|weights/i);
});

test('checkModelFit: recommendedContext actually fits the budget', () => {
  const r = checkModelFit({
    fileBytes: 40 * GiB, contextSize: 131072, availableBytes: 80 * GiB,
    kvBytesPerToken: 262144, overheadBytes: 2 * GiB, headroomFrac: 0.1, minContext: 2048
  });
  if (r.recommendedContext) {
    const budget = 80 * GiB * 0.9;
    const required = 40 * GiB + r.recommendedContext * 262144 + 2 * GiB;
    assert.ok(required <= budget, 'recommended context must fit budget');
  }
});

test('thermalDecision: normal below warn', () => {
  const d = thermalDecision({ tempC: 70, prevState: 'normal', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(d.state, 'normal');
  assert.equal(d.pauseDispatch, false);
  assert.equal(d.unload, false);
});

test('thermalDecision: warn -> throttle (pause, no unload)', () => {
  const d = thermalDecision({ tempC: 91, prevState: 'normal', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(d.state, 'throttled');
  assert.equal(d.pauseDispatch, true);
  assert.equal(d.unload, false);
});

test('thermalDecision: critical -> unload', () => {
  const d = thermalDecision({ tempC: 97, prevState: 'throttled', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(d.state, 'critical');
  assert.equal(d.pauseDispatch, true);
  assert.equal(d.unload, true);
});

test('thermalDecision: hysteresis — stays throttled between resume and warn', () => {
  const d = thermalDecision({ tempC: 85, prevState: 'throttled', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(d.state, 'throttled');
  assert.equal(d.pauseDispatch, true);
});

test('thermalDecision: resumes to normal at/below resume temp', () => {
  const d = thermalDecision({ tempC: 79, prevState: 'throttled', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(d.state, 'normal');
  assert.equal(d.pauseDispatch, false);
});

test('DEFAULTS present and sane', () => {
  assert.ok(DEFAULTS.warnC < DEFAULTS.criticalC);
  assert.ok(DEFAULTS.resumeC < DEFAULTS.warnC);
  assert.ok(DEFAULTS.headroomFrac > 0 && DEFAULTS.headroomFrac < 1);
});

// ── planMemoryRecovery: decide serve / reclaim / refuse ─────────────────────
const KNOBS = { kvBytesPerToken: 262144, overheadBytes: 3 * GiB, headroomFrac: 0.12, minContext: 4096 };

test('planMemoryRecovery: already-loaded model is always served (memory already committed)', () => {
  // 78GiB model, only 38GiB free — would normally refuse, but it's already loaded.
  const r = planMemoryRecovery({
    fileBytes: 74 * GiB, contextSize: 8192, availableBytes: 38 * GiB,
    alreadyLoaded: true, reclaimableBytes: 0, ...KNOBS
  });
  assert.equal(r.action, 'serve');
});

test('planMemoryRecovery: unknown model size fails open to serve', () => {
  const r = planMemoryRecovery({
    fileBytes: 0, contextSize: 8192, availableBytes: 38 * GiB,
    alreadyLoaded: false, reclaimableBytes: 0, ...KNOBS
  });
  assert.equal(r.action, 'serve');
});

test('planMemoryRecovery: fits at current available => serve, no reclaim needed', () => {
  const r = planMemoryRecovery({
    fileBytes: 20 * GiB, contextSize: 8192, availableBytes: 100 * GiB,
    alreadyLoaded: false, reclaimableBytes: 0, ...KNOBS
  });
  assert.equal(r.action, 'serve');
});

test('planMemoryRecovery: too large now but fits after reclaiming other models => reclaim', () => {
  // The gpt-oss-120b scenario: needs ~77.6GiB, only 38GiB free, but ~53GiB is
  // held by another loaded model. Freeing it (38+53=91) makes the model fit.
  const r = planMemoryRecovery({
    fileBytes: 74 * GiB, contextSize: 8192, availableBytes: 38 * GiB,
    alreadyLoaded: false, reclaimableBytes: 53 * GiB, ...KNOBS
  });
  assert.equal(r.action, 'reclaim');
  assert.ok(r.requiredBytes > r.budgetBytes, 'must not currently fit');
  assert.ok(r.reclaimableBudgetBytes > r.budgetBytes, 'freed budget must be larger');
});

test('planMemoryRecovery: cannot fit even on a fully-freed box => refuse', () => {
  // 120GiB weights can never fit a 128GiB box with headroom — freeing wont help.
  const r = planMemoryRecovery({
    fileBytes: 120 * GiB, contextSize: 8192, availableBytes: 38 * GiB,
    alreadyLoaded: false, reclaimableBytes: 80 * GiB, ...KNOBS
  });
  assert.equal(r.action, 'refuse');
});

test('planMemoryRecovery: nothing reclaimable and does not fit => refuse (no pointless restart)', () => {
  const r = planMemoryRecovery({
    fileBytes: 74 * GiB, contextSize: 8192, availableBytes: 38 * GiB,
    alreadyLoaded: false, reclaimableBytes: 0, ...KNOBS
  });
  assert.equal(r.action, 'refuse');
});

// ── dispatchPreference: try remote-first when prefer-remote OR thermally paused ─
test('dispatchPreference: prefer local when not paused and preferLocal=true', () => {
  const r = dispatchPreference({ preferLocal: true, thermalPaused: false });
  assert.equal(r.tryRemoteFirst, false);
});

test('dispatchPreference: preferLocal=false spreads offloadable work to remote', () => {
  const r = dispatchPreference({ preferLocal: false, thermalPaused: false });
  assert.equal(r.tryRemoteFirst, true);
  assert.match(r.reason, /preferLocal/i);
});

test('dispatchPreference: thermal throttle forces remote-first even when preferLocal=true', () => {
  const r = dispatchPreference({ preferLocal: true, thermalPaused: true });
  assert.equal(r.tryRemoteFirst, true);
  assert.match(r.reason, /thermal/i);
});

test('dispatchPreference: thermal reason takes priority over preferLocal=false', () => {
  const r = dispatchPreference({ preferLocal: false, thermalPaused: true });
  assert.equal(r.tryRemoteFirst, true);
  assert.match(r.reason, /thermal/i);
});
