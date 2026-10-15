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
  assert.equal(r.hip.residentBytes, 100 * GB);
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
