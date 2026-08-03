// Llama Manager — unit tests for api/resource-guard.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkModelFit, thermalDecision, planMemoryRecovery, dispatchPreference, memoryPressureDecision, DEFAULTS } from './resource-guard.js';

const GiB = 2 ** 30;

test('checkModelFit: small model at modest context fits', () => {
  const r = checkModelFit({ fileBytes: 10 * GiB, contextSize: 8192, availableBytes: 124 * GiB });
  assert.equal(r.fits, true);
  assert.equal(r.recommendedContext, 8192);
});

test('checkModelFit reserves headroom from total RAM rather than current availability', () => {
  const r = checkModelFit({
    fileBytes: 25 * GiB,
    contextSize: 4096,
    availableBytes: 38 * GiB,
    totalBytes: 124 * GiB,
    kvBytesPerToken: 0,
    overheadBytes: 3 * GiB,
    headroomFrac: 0.12,
  });

  assert.equal(r.budgetBytes, Math.floor(38 * GiB - (124 * GiB * 0.12)));
  assert.equal(r.fits, false);
});

test('checkModelFit allows an absolute reserved headroom override', () => {
  const r = checkModelFit({
    fileBytes: 19 * GiB,
    contextSize: 4096,
    availableBytes: 38 * GiB,
    totalBytes: 124 * GiB,
    reservedHeadroomBytes: 16 * GiB,
    kvBytesPerToken: 0,
    overheadBytes: 3 * GiB,
    headroomFrac: 0.5,
  });

  assert.equal(r.budgetBytes, 22 * GiB);
  assert.equal(r.fits, true);
});

test('checkModelFit never creates a budget larger than total RAM minus reserve', () => {
  const r = checkModelFit({
    fileBytes: 1,
    contextSize: 0,
    availableBytes: 150 * GiB,
    totalBytes: 124 * GiB,
    kvBytesPerToken: 0,
    overheadBytes: 0,
    headroomFrac: 0.12,
  });

  assert.equal(r.budgetBytes, Math.floor(124 * GiB * 0.88));
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

test('thermalDecision: critical -> pause/offload but NEVER unload (idle model is not a heat source)', () => {
  const d = thermalDecision({ tempC: 97, prevState: 'throttled', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(d.state, 'critical');
  assert.equal(d.pauseDispatch, true);
  assert.equal(d.unload, false);
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
  // Heat-attribution knobs present and ordered sanely.
  assert.ok(DEFAULTS.criticalC < DEFAULTS.hardCriticalC, 'hard ceiling above the throttle-critical');
  assert.ok(DEFAULTS.gpuWarnC > 0 && DEFAULTS.gpuWarnC < DEFAULTS.hardCriticalC);
  assert.ok(DEFAULTS.appCpuHeatPct > 0 && DEFAULTS.appCpuHeatPct <= 100);
});

// ── thermalDecision heat attribution: don't throttle llama for EXTERNAL heat ──

test('thermalDecision: die hot but iGPU cool + llama-CPU low => EXTERNAL heat, do NOT pause/unload', () => {
  // The observed incident: external CPU load drives the die (cpuC) to 98C while
  // llama's iGPU is idle (41C) and llama's own CPU share is tiny.
  const d = thermalDecision({
    tempC: 98, prevState: 'normal',
    warnC: 90, resumeC: 80, criticalC: 96,
    gpuC: 41, appCpuPct: 3, gpuWarnC: 85, appCpuHeatPct: 25, hardCriticalC: 105
  });
  assert.equal(d.state, 'normal');
  assert.equal(d.pauseDispatch, false);
  assert.equal(d.unload, false);
});

test('thermalDecision: external heat holding => still normal even if we were throttled before', () => {
  const d = thermalDecision({
    tempC: 97, prevState: 'throttled',
    warnC: 90, resumeC: 80, criticalC: 96,
    gpuC: 40, appCpuPct: 2, gpuWarnC: 85, appCpuHeatPct: 25, hardCriticalC: 105
  });
  assert.equal(d.state, 'normal');
  assert.equal(d.pauseDispatch, false);
  assert.equal(d.unload, false);
});

test("thermalDecision: die hot AND iGPU hot (llama's own compute) => pause/offload, NEVER unload", () => {
  const d = thermalDecision({
    tempC: 97, prevState: 'normal',
    warnC: 90, resumeC: 80, criticalC: 96,
    gpuC: 92, appCpuPct: 5, gpuWarnC: 85, appCpuHeatPct: 25, hardCriticalC: 105
  });
  assert.equal(d.state, 'critical');
  assert.equal(d.pauseDispatch, true);
  assert.equal(d.unload, false);
});

test('thermalDecision: high llama CPU share alone attributes the heat to llama => throttle', () => {
  // iGPU cool but llama is the one pegging the CPU (its own workload).
  const d = thermalDecision({
    tempC: 91, prevState: 'normal',
    warnC: 90, resumeC: 80, criticalC: 96,
    gpuC: 60, appCpuPct: 70, gpuWarnC: 85, appCpuHeatPct: 25, hardCriticalC: 105
  });
  assert.equal(d.state, 'throttled');
  assert.equal(d.pauseDispatch, true);
  assert.equal(d.unload, false);
});

test('thermalDecision: at hardCriticalC => pause REGARDLESS of source, still NEVER unload', () => {
  // Even though the heat is external (iGPU cool, llama CPU low), the absolute die
  // ceiling forces a pause to protect the shared hardware — but keep the model loaded.
  const d = thermalDecision({
    tempC: 106, prevState: 'normal',
    warnC: 90, resumeC: 80, criticalC: 96,
    gpuC: 40, appCpuPct: 2, gpuWarnC: 85, appCpuHeatPct: 25, hardCriticalC: 105
  });
  assert.equal(d.state, 'critical');
  assert.equal(d.pauseDispatch, true);
  assert.equal(d.unload, false);
});

test('thermalDecision: no attribution inputs => backward-compatible threshold behavior (no unload)', () => {
  // Old callers pass only tempC — assume llama could be the source and throttle,
  // but the thermal path no longer unloads.
  const warn = thermalDecision({ tempC: 91, prevState: 'normal', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(warn.state, 'throttled');
  assert.equal(warn.pauseDispatch, true);
  assert.equal(warn.unload, false);
  const crit = thermalDecision({ tempC: 97, prevState: 'normal', warnC: 90, resumeC: 80, criticalC: 96 });
  assert.equal(crit.state, 'critical');
  assert.equal(crit.pauseDispatch, true);
  assert.equal(crit.unload, false);
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

test('explicit model preload runs memory admission before contacting llama.cpp', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const routeStart = source.indexOf("app.post('/api/models/load'");
  const routeEnd = source.indexOf("app.post('/api/models/unload'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  const queueAdmission = route.indexOf('await acquireLocalSlot(req, res');
  const admission = route.indexOf("await ensureModelServed(model, { requireKnownSize: true })");
  const upstreamLoad = route.indexOf("fetch(`http://localhost:${LLAMA_PORT}/v1/chat/completions`");

  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'model load route must exist');
  assert.ok(queueAdmission >= 0, 'model load route must serialize through the local lane');
  assert.ok(queueAdmission < admission, 'queue admission must precede memory and mode admission');
  assert.ok(admission >= 0, 'model load route must invoke proactive memory admission');
  assert.ok(admission < upstreamLoad, 'memory admission must run before the upstream load request');
  assert.match(route, /res\.status\(error\.statusCode \|\| 500\)/);
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

// --- memoryPressureDecision -------------------------------------------------
// Regression cover for the Jul 30 / Aug 2 2026 kernel panics: OOM-killing
// llama-server NULL-derefs amdgpu_hmm_range_valid and takes the whole box down,
// so the governor must shed the model GRACEFULLY before the kernel intervenes.

test('memoryPressureDecision: ample memory stays normal and sheds nothing', () => {
  const r = memoryPressureDecision({ availableBytes: 80 * GiB, modelLoaded: true });
  assert.equal(r.state, 'normal');
  assert.equal(r.shed, false);
  assert.equal(r.pauseDispatch, false);
});

test('memoryPressureDecision: watch band pauses dispatch but does not shed yet', () => {
  const r = memoryPressureDecision({ availableBytes: 20 * GiB, modelLoaded: true });
  assert.equal(r.state, 'watch');
  assert.equal(r.shed, false);
  assert.equal(r.pauseDispatch, true);
});

test('memoryPressureDecision: below the shed threshold sheds the model', () => {
  const r = memoryPressureDecision({ availableBytes: 12 * GiB, modelLoaded: true });
  assert.equal(r.state, 'shed');
  assert.equal(r.shed, true);
  assert.match(r.reason, /memory/i);
});

test('memoryPressureDecision: nothing loaded means there is nothing to shed', () => {
  const r = memoryPressureDecision({ availableBytes: 4 * GiB, modelLoaded: false });
  assert.equal(r.shed, false);
  assert.equal(r.pauseDispatch, true, 'still refuses new local work while starved');
});

test('memoryPressureDecision: unreadable MemAvailable (0) fails open, never sheds', () => {
  // Mirrors the thermal governor ignoring all-zero telemetry. A failed
  // /proc/meminfo read must not be mistaken for an out-of-memory box.
  const r = memoryPressureDecision({ availableBytes: 0, modelLoaded: true });
  assert.equal(r.shed, false);
  assert.equal(r.state, 'normal');
  assert.match(r.reason, /unknown|unreadable|telemetry/i);
});

test('memoryPressureDecision: cooldown prevents re-shedding before the unload lands', () => {
  // Freeing ~60 GiB is not instant; MemAvailable lags. Without a cooldown the
  // next tick would shed again and stampede the unload path.
  const r = memoryPressureDecision({
    availableBytes: 12 * GiB, modelLoaded: true,
    prevState: 'shed', lastShedAt: 1_000, now: 6_000, cooldownMs: 60_000,
  });
  assert.equal(r.shed, false);
  assert.match(r.reason, /cooldown/i);
});

test('memoryPressureDecision: sheds again once the cooldown has elapsed', () => {
  const r = memoryPressureDecision({
    availableBytes: 12 * GiB, modelLoaded: true,
    prevState: 'shed', lastShedAt: 1_000, now: 90_000, cooldownMs: 60_000,
  });
  assert.equal(r.shed, true);
});

test('memoryPressureDecision: hysteresis holds the shed state through the watch band', () => {
  // Recovering to 20 GiB is NOT enough to declare normal — flapping back would
  // let the residency restorer reload 60 GiB straight back into a strained box.
  const r = memoryPressureDecision({ availableBytes: 20 * GiB, modelLoaded: false, prevState: 'shed' });
  assert.equal(r.state, 'shed');
  assert.equal(r.allowResidencyRestore, false);
});

test('memoryPressureDecision: clears to normal only above the resume threshold', () => {
  const r = memoryPressureDecision({ availableBytes: 40 * GiB, modelLoaded: false, prevState: 'shed' });
  assert.equal(r.state, 'normal');
  assert.equal(r.allowResidencyRestore, true);
});

test('memoryPressureDecision: suppresses residency restore while shedding', () => {
  // The desired-residency restorer would otherwise immediately reload exactly
  // the model the governor just freed, and the box would oscillate.
  const r = memoryPressureDecision({ availableBytes: 12 * GiB, modelLoaded: true });
  assert.equal(r.allowResidencyRestore, false);
});

test('memoryPressureDecision: thresholds are operator-tunable', () => {
  const r = memoryPressureDecision({
    availableBytes: 30 * GiB, modelLoaded: true,
    shedBelowBytes: 32 * GiB, watchBelowBytes: 48 * GiB, resumeAboveBytes: 64 * GiB,
  });
  assert.equal(r.shed, true);
});

test('memoryPressureDecision: exposes defaults for the 16/24/32 GiB policy', () => {
  assert.equal(DEFAULTS.memShedBelowBytes, 16 * GiB);
  assert.equal(DEFAULTS.memWatchBelowBytes, 24 * GiB);
  assert.equal(DEFAULTS.memResumeAboveBytes, 32 * GiB);
  assert.ok(DEFAULTS.memShedCooldownMs > 0);
});
