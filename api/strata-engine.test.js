// Llama Manager — unit tests for the pure Strata engine helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Verifies the pure, no-I/O helpers in strata-engine.js without spawning Strata:
// resolveStrataConfig (config.strata normalisation: enabled/reason, absolute-path
// requirements, defaults, HIP expertCache 'auto' rejection, CUDA-optional, unit
// conversion, env stringification), strataServerConfig (per-backend server.py config
// JSON with manager-owned --expert-cache/--max-context), strataConfigPath,
// strataLaunchSpec (python argv + cwd) and strataHealthReady (readiness truth table).
// Written test-first (design: docs/Designs/StrataEngine.md §4, §6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStrataConfig,
  strataServerConfig,
  strataConfigPath,
  strataLaunchSpec,
  strataHealthReady,
  effectiveStrataBlock,
  strataHipFootprintBytes,
  strataHipExpertCache,
  strataGrowDecision,
  sizeStrataHipCache,
} from './strata-engine.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const hipBlock = (over = {}) => ({
  exe: '/opt/strata/src/engine/strata',
  libDirs: ['/opt/strata/rocm/install/lib'],
  env: { STRATA_PF_FUSED: 1, STRATA_PA_FAST: true },
  expertCache: 12000,
  residentGb: 100,
  ...over,
});
const cudaBlock = (over = {}) => ({
  exe: '/opt/strata/cuda/engine/strata',
  libDirs: ['/opt/strata/cuda/lib'],
  env: { STRATA_PREFILL_CPU_SHARE: 'auto', STRATA_PREFILL_CPU_SHARE_MAX: 3072 },
  expertCache: 16709,
  hostResidentGb: 56,
  ...over,
});
const baseCfg = (over = {}) => ({
  strata: { root: '/opt/strata/src', pythonPath: '/opt/strata/src/.venv/bin/python', cuda: cudaBlock(), hip: hipBlock(), ...over },
});
const opts = { dataDirDefault: '/var/lib/llama-manager/strata' };
const preset = (over = {}) => ({
  id: 'strata-qwen38-flash-iq3s',
  engine: 'strata',
  context: 131072,
  strata: { args: ['--pack', '/p', '--spec', '5'], tokenizer: '/abs/tok', modelName: 'Qwen3.8-Flash-Next' },
  ...over,
});

// ── resolveStrataConfig ──────────────────────────────────────────────────────
test('resolveStrataConfig: missing block → disabled with a reason', () => {
  for (const cfg of [{}, { strata: null }, undefined]) {
    const r = resolveStrataConfig(cfg, opts);
    assert.equal(r.enabled, false);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  }
});

test('resolveStrataConfig: missing or relative root / pythonPath → disabled', () => {
  const bad = [
    { root: undefined }, { root: 'relative/strata' },
    { pythonPath: undefined }, { pythonPath: 'python3' },
  ];
  for (const over of bad) {
    const r = resolveStrataConfig(baseCfg(over), opts);
    assert.equal(r.enabled, false, JSON.stringify(over));
    assert.ok(r.reason);
  }
});

test('resolveStrataConfig: defaults (port 18090, dataDir from option, enabled)', () => {
  const r = resolveStrataConfig(baseCfg(), opts);
  assert.equal(r.enabled, true);
  assert.equal(r.root, '/opt/strata/src');
  assert.equal(r.pythonPath, '/opt/strata/src/.venv/bin/python');
  assert.equal(r.port, 18090);
  assert.equal(r.dataDir, '/var/lib/llama-manager/strata');
  assert.ok(Array.isArray(r.warnings));
  assert.ok(r.policy && typeof r.policy === 'object');
});

test('resolveStrataConfig: explicit port and dataDir win over defaults', () => {
  const r = resolveStrataConfig(baseCfg({ port: 19000, dataDir: '/data/strata' }), opts);
  assert.equal(r.port, 19000);
  assert.equal(r.dataDir, '/data/strata');
});

test('resolveStrataConfig: hip expertCache missing or "auto" → hip null + warning', () => {
  for (const expertCache of [undefined, 'auto']) {
    const r = resolveStrataConfig(baseCfg({ hip: hipBlock({ expertCache }) }), opts);
    assert.equal(r.hip, null);
    assert.ok(r.warnings.some((w) => /hip|expert/i.test(w)), `warning for ${expertCache}`);
    assert.ok(r.cuda, 'cuda unaffected');
    assert.equal(r.enabled, true, 'still enabled via cuda');
  }
});

test('resolveStrataConfig: cuda absent → HIP only', () => {
  const r = resolveStrataConfig(baseCfg({ cuda: undefined }), opts);
  assert.equal(r.cuda, null);
  assert.ok(r.hip);
  assert.equal(r.enabled, true);
});

test('resolveStrataConfig: no usable backend → disabled', () => {
  const r = resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 'auto' }) }), opts);
  assert.equal(r.enabled, false);
  assert.ok(r.reason);
});

test('resolveStrataConfig: GB → bytes, durations → ms, env stringified', () => {
  const r = resolveStrataConfig(baseCfg({
    policy: { returnToCudaAfterMin: 15, drainMaxWaitSec: 120, idleBaselineMb: 1536, yieldGrowthMb: 512 },
  }), opts);
  assert.equal(r.hip.residentBytes, strataHipFootprintBytes({ expertCache: 12000 }), 'hip footprint is derived, not residentGb');
  assert.equal(r.cuda.hostResidentBytes, 56 * GB);
  assert.equal(r.policy.drainMaxWaitMs, 120000);
  const policyValues = Object.values(r.policy);
  assert.ok(policyValues.includes(15 * 60000), 'returnToCuda 15 min → ms');
  assert.ok(policyValues.includes(1536 * MB), 'idle baseline MB → bytes');
  assert.ok(policyValues.includes(512 * MB), 'yield growth MB → bytes');
  assert.deepEqual(r.hip.env, { STRATA_PF_FUSED: '1', STRATA_PA_FAST: 'true' });
  assert.deepEqual(r.cuda.env, { STRATA_PREFILL_CPU_SHARE: 'auto', STRATA_PREFILL_CPU_SHARE_MAX: '3072' });
});

test('resolveStrataConfig: cuda defaults gpuPool rtx3090 and reservationPriority 50', () => {
  const r = resolveStrataConfig(baseCfg(), opts);
  assert.equal(r.cuda.gpuPool, 'rtx3090');
  assert.equal(r.cuda.reservationPriority, 50);
});

test('resolveStrataConfig: cuda expertCache defaults to "auto"', () => {
  const r = resolveStrataConfig(baseCfg({ cuda: cudaBlock({ expertCache: undefined }) }), opts);
  assert.equal(r.cuda.expertCache, 'auto');
});

// ── strataServerConfig ───────────────────────────────────────────────────────
test('strataServerConfig: exact JSON for cuda', () => {
  const cfg = resolveStrataConfig(baseCfg(), opts);
  assert.deepEqual(strataServerConfig({ cfg, preset: preset(), backend: 'cuda' }), {
    exe: '/opt/strata/cuda/engine/strata',
    args: ['--pack', '/p', '--spec', '5', '--expert-cache', '16709', '--max-context', '131072'],
    cwd: '/opt/strata/src',
    tokenizer: '/abs/tok',
    model_name: 'Qwen3.8-Flash-Next',
    log: '/var/lib/llama-manager/strata/engine-cuda.log',
    lib_dirs: ['/opt/strata/cuda/lib'],
    port: 18090,
    backend: 'cuda',
    env: { STRATA_PREFILL_CPU_SHARE: 'auto', STRATA_PREFILL_CPU_SHARE_MAX: '3072' },
    open_browser: false,
  });
});

test('strataServerConfig: exact JSON for hip', () => {
  const cfg = resolveStrataConfig(baseCfg(), opts);
  assert.deepEqual(strataServerConfig({ cfg, preset: preset(), backend: 'hip' }), {
    exe: '/opt/strata/src/engine/strata',
    args: ['--pack', '/p', '--spec', '5', '--expert-cache', '12000', '--max-context', '131072'],
    cwd: '/opt/strata/src',
    tokenizer: '/abs/tok',
    model_name: 'Qwen3.8-Flash-Next',
    log: '/var/lib/llama-manager/strata/engine-hip.log',
    lib_dirs: ['/opt/strata/rocm/install/lib'],
    port: 18090,
    backend: 'hip',
    env: { STRATA_PF_FUSED: '1', STRATA_PA_FAST: 'true' },
    open_browser: false,
  });
});

test('strataServerConfig: max-context defaults to 262144; model_name falls back to preset id', () => {
  const cfg = resolveStrataConfig(baseCfg(), opts);
  const p = preset({ context: undefined, strata: { args: ['--pack', '/p'], tokenizer: '/abs/tok' } });
  const out = strataServerConfig({ cfg, preset: p, backend: 'hip' });
  assert.deepEqual(out.args.slice(-2), ['--max-context', '262144']);
  assert.equal(out.model_name, 'strata-qwen38-flash-iq3s');
});

test('strataServerConfig: does not mutate the preset args', () => {
  const cfg = resolveStrataConfig(baseCfg(), opts);
  const p = preset();
  strataServerConfig({ cfg, preset: p, backend: 'cuda' });
  assert.deepEqual(p.strata.args, ['--pack', '/p', '--spec', '5']);
});

test('strataServerConfig: throws for an unconfigured backend', () => {
  const hipOnly = resolveStrataConfig(baseCfg({ cuda: undefined }), opts);
  assert.throws(() => strataServerConfig({ cfg: hipOnly, preset: preset(), backend: 'cuda' }));
  const cudaOnly = resolveStrataConfig(baseCfg({ hip: undefined }), opts);
  assert.throws(() => strataServerConfig({ cfg: cudaOnly, preset: preset(), backend: 'hip' }));
});

// ── strataConfigPath / strataLaunchSpec ──────────────────────────────────────
test('strataConfigPath: dataDir/strata-<backend>.json', () => {
  const cfg = resolveStrataConfig(baseCfg(), opts);
  assert.equal(strataConfigPath(cfg, 'cuda'), '/var/lib/llama-manager/strata/strata-cuda.json');
  assert.equal(strataConfigPath(cfg, 'hip'), '/var/lib/llama-manager/strata/strata-hip.json');
});

test('strataLaunchSpec: exact python argv and cwd', () => {
  const cfg = resolveStrataConfig(baseCfg(), opts);
  assert.deepEqual(strataLaunchSpec({ cfg, configPath: '/x/strata-hip.json' }), {
    cmd: '/opt/strata/src/.venv/bin/python',
    args: ['/opt/strata/src/serve/server.py', '--engine', 'strata', '--config', '/x/strata-hip.json', '--port', '18090'],
    cwd: '/opt/strata/src',
  });
});

// ── strataHealthReady ────────────────────────────────────────────────────────
test('strataHealthReady: truth table', () => {
  assert.equal(strataHealthReady({ status: 'ok', loaded: true, max_context: 262144 }), true);
  assert.equal(strataHealthReady({ status: 'ok', loaded: false, max_context: 262144 }), false);
  assert.equal(strataHealthReady({ status: 'ok', loaded: true, max_context: 0 }), false);
  assert.equal(strataHealthReady({ status: 'ok' }), false);
  assert.equal(strataHealthReady({ status: 'loading', loaded: true, max_context: 262144 }), false);
  assert.equal(strataHealthReady(null), false);
  assert.equal(strataHealthReady(undefined), false);
});

// ── effectiveStrataBlock: packaged defaults fallback (A4) ───────────────────

test('effectiveStrataBlock: operator block always wins, no merge, no file read', () => {
  const operator = { root: '/op' };
  const read = () => { throw new Error('must not read'); };
  assert.equal(effectiveStrataBlock(operator, { readText: read }), operator);
});

test('effectiveStrataBlock: absent or empty block loads the defaults file', () => {
  const readText = (p) => (p === '/d.json' ? '{"root":"/pkg","port":1}' : null);
  const env = { LLAMA_MANAGER_STRATA_DEFAULTS: '/d.json' };
  assert.deepEqual(effectiveStrataBlock(undefined, { env, readText }), { root: '/pkg', port: 1 });
  assert.deepEqual(effectiveStrataBlock({}, { env, readText }), { root: '/pkg', port: 1 });
});

test('effectiveStrataBlock: missing or malformed file leaves the block untouched', () => {
  assert.equal(effectiveStrataBlock(undefined, { env: {}, readText: () => null }), undefined);
  assert.equal(effectiveStrataBlock(undefined, { env: {}, readText: () => '{nope' }), undefined);
  assert.equal(effectiveStrataBlock(undefined, { env: {}, readText: () => '[1]' }), undefined);
});

test('effectiveStrataBlock: default path is the packaged location', () => {
  let seen = null;
  effectiveStrataBlock(undefined, { env: {}, readText: (p) => { seen = p; return null; } });
  assert.equal(seen, '/usr/share/llama-manager/strata/defaults.json');
});

// ── HIP footprint (W2c, T32312b1a33838) ──────────────────────────────────────
// Measured on drakemore 2026-10-31 at expertCache 16000: strata RSS ~49 GiB + iGPU GTT
// ~46 GiB, MemAvailable 16.4 of 124.4 GiB. The 48000-slot attempt drove the box to
// 122/124 GB + full swap. The hand-set residentGb (106, then 84) was the only gate.
const DRAKEMORE_TOTAL = 133620523008;
const HEADROOM = 8 * GB;

test('strataHipFootprintBytes: base + slots x ~1.94 MiB, ~95 GiB at 16000', () => {
  const at16k = strataHipFootprintBytes({ expertCache: 16000 });
  assert.ok(at16k > 94 * GB && at16k < 97 * GB, `${at16k / GB} GiB`);
  const delta = strataHipFootprintBytes({ expertCache: 17000 }) - at16k;
  assert.ok(Math.abs(delta - 1000 * 1.94 * MB) < MB, 'each slot ~1.94 MiB');
  assert.equal(strataHipFootprintBytes({ expertCache: 0, baseBytes: 10 * GB }), 10 * GB);
});

test('resolveStrataConfig: hip.baseGb recalibrates the footprint; residentGb is ignored with a warning', () => {
  const r = resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 16000, baseGb: 70, residentGb: 84 }) }), opts);
  assert.equal(r.hip.residentBytes, strataHipFootprintBytes({ expertCache: 16000, baseBytes: 70 * GB }));
  assert.ok(r.warnings.some((w) => /residentGb/.test(w)));
});

test('resolveStrataConfig: a HIP expert cache that can never fit in RAM is refused', () => {
  const fit = { ...opts, memTotalBytes: DRAKEMORE_TOTAL, headroomBytes: HEADROOM };
  const ok = resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 16000 }) }), fit);
  assert.ok(ok.hip, 'the live 16000-slot config fits');
  const big = resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 48000 }) }), fit);
  assert.equal(big.hip, null, 'the 48000-slot incident config is refused');
  assert.equal(big.enabled, false);
  assert.ok(big.warnings.some((w) => /expertCache 48000/.test(w) && /GiB/.test(w)), big.warnings.join('|'));
});

// ── Adaptive HIP expert cache (docs/Designs/ResourceArbiter.md §1) ───────────
// drakemore 2026-10-31 after the deploy: MemAvailable 87-99.6 GiB against ~103 GiB for
// 16000 slots, so the gate refused Strata for hours instead of starting it smaller.
const fitArgs = (over = {}) => ({ configured: 16000, minSlots: 4000, baseBytes: 65 * GB, headroomBytes: HEADROOM, ...over });

test('strataHipExpertCache: starved memory picks a smaller cache instead of refusing', () => {
  const r = strataHipExpertCache(fitArgs({ availableBytes: 87 * GB }));
  assert.ok(r.slots >= 4000 && r.slots < 16000, `slots ${r.slots}`);
  assert.equal(r.slots % 100, 0, 'rounded down to 100');
  assert.ok(strataHipFootprintBytes({ expertCache: r.slots }) + HEADROOM <= 87 * GB, 'the chosen cache fits');
  assert.ok(strataHipFootprintBytes({ expertCache: r.slots + 100 }) + HEADROOM > 87 * GB, 'and is the largest that does');
  assert.match(r.reason, /87\.0 GiB/);
});

test('strataHipExpertCache: enough memory keeps the configured cache', () => {
  const r = strataHipExpertCache(fitArgs({ availableBytes: 110 * GB }));
  assert.equal(r.slots, 16000);
});

test('strataHipExpertCache: below the floor returns null (negative control: the floor is enforced)', () => {
  const r = strataHipExpertCache(fitArgs({ availableBytes: 78 * GB }));
  assert.equal(r.slots, null);
  assert.match(r.reason, /4000/);
  assert.equal(strataHipExpertCache(fitArgs({ availableBytes: 0 })).slots, null, 'unreadable MemAvailable never spawns');
});

test('resolveStrataConfig: hip minExpertCache defaults to 4000, never above the target; growCooldownMin to 10; prefillStallSec to 180', () => {
  const r = resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 16000 }) }), opts);
  assert.equal(r.hip.minExpertCache, 4000);
  assert.equal(r.hip.growMarginBytes, 16 * GB, 'hip.growMarginGb defaults to 16');
  assert.equal(resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 16000, growMarginGb: 24 }) }), opts).hip.growMarginBytes, 24 * GB);
  assert.equal(r.hip.growCooldownMs, 10 * 60_000);
  assert.equal(r.hip.baseBytes, 65 * GB);
  assert.equal(r.policy.prefillStallMs, 180_000);
  const small = resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 3000 }) }), opts);
  assert.equal(small.hip.minExpertCache, 3000);
  const set = resolveStrataConfig(baseCfg({ cuda: undefined, hip: hipBlock({ expertCache: 16000, minExpertCache: 6000, growCooldownMin: 3 }), policy: { prefillStallSec: 60 } }), opts);
  assert.equal(set.hip.minExpertCache, 6000);
  assert.equal(set.hip.growCooldownMs, 3 * 60_000);
  assert.equal(set.policy.prefillStallMs, 60_000);
});

test('strataServerConfig: an expertCache override replaces the configured size', () => {
  const cfg = resolveStrataConfig(baseCfg(), opts);
  const out = strataServerConfig({ cfg, preset: preset(), backend: 'hip', expertCache: 7300 });
  assert.deepEqual(out.args.slice(-4), ['--expert-cache', '7300', '--max-context', '131072']);
});

const MARGIN = 16 * GB;
const growArgs = (over = {}) => ({
  ...fitArgs(), effective: 8000, busy: false, idleSinceMs: 0, settledAt: 0,
  now: 3_600_000, growCooldownMs: 600_000, growMarginBytes: MARGIN, ...over,
});

test('strataGrowDecision: memory freed while idle grows back after the cooldown', () => {
  // Running at 8000 slots with 45 GiB free: a restart fits the full 16000 and still leaves the margin.
  const r = strataGrowDecision(growArgs({ availableBytes: 45 * GB }));
  assert.equal(r.action, 'grow');
  assert.equal(r.slots, 16000);
});

test('strataGrowDecision: a grow always leaves headroom + growMargin free (review: never grow to 2 GiB above the critical stop)', () => {
  // 30 GiB free at 8000 slots: without the margin it would grow to 16000 and leave only the 8 GiB headroom.
  const r = strataGrowDecision(growArgs({ availableBytes: 30 * GB }));
  assert.equal(r.action, 'grow');
  const left = 30 * GB + strataHipFootprintBytes({ expertCache: 8000 }) - strataHipFootprintBytes({ expertCache: r.slots });
  assert.ok(left >= HEADROOM + MARGIN, `leaves ${(left / GB).toFixed(1)} GiB`);
  assert.ok(r.slots < 16000);
  // Negative control: with no margin the same memory grows to the full target.
  assert.equal(strataGrowDecision(growArgs({ availableBytes: 30 * GB, growMarginBytes: 0 })).slots, 16000);
});

test('strataGrowDecision: never inside the cooldown, while busy, or before 60 s of idle (negative controls)', () => {
  const freed = { availableBytes: 45 * GB };
  assert.equal(strataGrowDecision(growArgs({ ...freed, settledAt: 3_600_000 - 60_000 })).action, 'stay', 'cooldown');
  const busy = strataGrowDecision(growArgs({ ...freed, busy: true }));
  assert.equal(busy.action, 'stay', 'busy');
  assert.equal(busy.idleSinceMs, null, 'busy resets the idle streak');
  const fresh = strataGrowDecision(growArgs({ ...freed, idleSinceMs: null }));
  assert.equal(fresh.action, 'stay', 'idle streak just started');
  assert.equal(fresh.idleSinceMs, 3_600_000);
});

test('strataGrowDecision: hysteresis, a small gain does not restart', () => {
  // ~2 GiB free beyond headroom + margin at 8000 slots buys ~1000 more slots: below the 2000-slot step.
  const avail = HEADROOM + MARGIN + 2 * GB;
  const r = strataGrowDecision(growArgs({ availableBytes: avail }));
  assert.equal(r.action, 'stay');
  assert.match(r.reason, /hysteresis/);
});

test('strataGrowDecision: nothing to do at the configured size', () => {
  assert.equal(strataGrowDecision(growArgs({ effective: 16000, availableBytes: 60 * GB })).action, 'stay');
});

// ── sizeStrataHipCache: the size a HIP (re)start actually launches with (re-review) ─────────
// Behavioural, with injected memory: the earlier tests checked only the grow decision, and the
// restart launched at the plain-headroom size, not the decision's (16000 vs 11100 at 30 GiB).
const hip = { expertCache: 16000, minExpertCache: 4000, baseBytes: 65 * GB };

/**
 * Run sizeStrataHipCache against a scripted MemAvailable.
 * @param {object} opts sizing options; `mem` is an array of successive readings (the last repeats),
 *   `waitOk` what waitForBytes answers, `released` what the Pods release frees.
 */
async function sizeWith({ mem, waitOk = false, released = [], ...opts }) {
  const readings = [...mem];
  const calls = { waits: [], releases: 0 };
  const result = await sizeStrataHipCache({
    hip, headroomBytes: HEADROOM, keepWaitMs: 30_000, floorWaitMs: 180_000,
    readMemAvailable: () => (readings.length > 1 ? readings.shift() : readings[0]),
    waitForBytes: async (bytes, ms) => { calls.waits.push({ bytes, ms }); return waitOk; },
    releaseIdle: async () => { calls.releases++; return { released }; },
    ...opts,
  });
  return { ...result, calls };
}

test('sizeStrataHipCache: a grow restart launches at the decided size, leaving headroom + margin (review HIGH)', async () => {
  const decision = strataGrowDecision(growArgs({ availableBytes: 30 * GB }));
  const afterStop = 30 * GB + strataHipFootprintBytes({ expertCache: 8000 });
  const r = await sizeWith({ mem: [afterStop], keepAtLeast: 8000, maxSlots: decision.slots });
  assert.equal(r.slots, decision.slots);
  const left = afterStop - strataHipFootprintBytes({ expertCache: r.slots });
  assert.ok(left >= HEADROOM + MARGIN, `leaves ${(left / GB).toFixed(1)} GiB`);
  // Negative control: uncapped, the same memory launches at the full target and eats the margin.
  assert.equal((await sizeWith({ mem: [afterStop], keepAtLeast: 8000 })).slots, 16000);
});

test('sizeStrataHipCache: a restart keeps its size when memory returns within the bounded keep wait', async () => {
  const keepBytes = strataHipFootprintBytes({ expertCache: 8000 }) + HEADROOM;
  const r = await sizeWith({ mem: [keepBytes - 4 * GB, keepBytes + GB], waitOk: true, keepAtLeast: 8000 });
  assert.ok(r.slots >= 8000, `slots ${r.slots}`);
  assert.deepEqual(r.calls.waits.map((w) => w.ms), [30_000], 'the keep wait is capped at 30 s');
});

test('sizeStrataHipCache: memory that dips again right after the keep wait sizes to what fits, never refuses (review LOW)', async () => {
  const keepBytes = strataHipFootprintBytes({ expertCache: 8000 }) + HEADROOM;
  const dipped = strataHipFootprintBytes({ expertCache: 6000 }) + HEADROOM;
  const r = await sizeWith({ mem: [keepBytes - GB, dipped, dipped], waitOk: true, keepAtLeast: 8000 });
  assert.ok(r.slots !== null && r.slots >= 4000 && r.slots < 8000, `slots ${r.slots}`);
  assert.equal(r.calls.releases, 0, 'a start above the floor never asks Pods');
});

test('sizeStrataHipCache: Pods release only when even the floor does not fit; then the floor wait', async () => {
  const short = strataHipFootprintBytes({ expertCache: 2000 }) + HEADROOM;
  const none = await sizeWith({ mem: [short], released: [] });
  assert.equal(none.slots, null);
  assert.equal(none.calls.releases, 1);
  assert.deepEqual(none.calls.waits, [], 'nothing released: no pointless wait');
  const freed = strataHipFootprintBytes({ expertCache: 9000 }) + HEADROOM;
  const some = await sizeWith({ mem: [short, freed], released: ['w-up'], waitOk: true });
  assert.ok(some.slots >= 4000);
  assert.deepEqual(some.calls.waits.map((w) => w.ms), [180_000]);
});
