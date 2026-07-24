// Llama Manager — unit tests for api/engines.js (engine-abstraction helpers).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_TYPES,
  presetEngine,
  resolveDs4Config,
  engineDescriptor,
  ds4EnableGate,
  buildLocalServerRegistry,
  validatePresetEngineFields,
  resolveDs4ModelPath,
  ds4ModelEntry,
  ds4ModelsList,
  ds4TargetUrl,
  ENGINE_PROCESS_COMMS,
  isEngineProcessComm,
  engineSupportsSlots,
  isDs4RepoAllowed,
  listDs4GgufFiles,
  validateDs4DownloadRequest,
} from './engines.js';

// ── isEngineProcessComm (heat/RSS attribution) ───────────────────────────────
test('isEngineProcessComm: matches both llama-server and ds4-server', () => {
  assert.equal(isEngineProcessComm('llama-server'), true);
  assert.equal(isEngineProcessComm('ds4-server'), true);
  // whitespace-trimmed (comm files carry a trailing newline)
  assert.equal(isEngineProcessComm('ds4-server\n'), true);
});
test('isEngineProcessComm: rejects unrelated processes and junk', () => {
  assert.equal(isEngineProcessComm('node'), false);
  assert.equal(isEngineProcessComm('bash'), false);
  assert.equal(isEngineProcessComm(''), false);
  assert.equal(isEngineProcessComm(null), false);
  assert.equal(isEngineProcessComm(undefined), false);
});
test('ENGINE_PROCESS_COMMS lists exactly the two engine binaries', () => {
  assert.deepEqual([...ENGINE_PROCESS_COMMS].sort(), ['ds4-server', 'llama-server']);
});

// ── engineSupportsSlots (slot machinery no-op gate) ──────────────────────────
test('engineSupportsSlots: llama has /slots, ds4 does not', () => {
  assert.equal(engineSupportsSlots(ENGINE_TYPES.LLAMA), true);
  assert.equal(engineSupportsSlots('llama'), true);
  assert.equal(engineSupportsSlots(ENGINE_TYPES.DS4), false);
  assert.equal(engineSupportsSlots('DS4'), false);
});
test('engineSupportsSlots: unknown/empty engine defaults to slot-capable (llama)', () => {
  assert.equal(engineSupportsSlots(undefined), true);
  assert.equal(engineSupportsSlots(''), true);
});

// ── presetEngine ────────────────────────────────────────────────────────────
test('presetEngine: defaults to llama when unset', () => {
  assert.equal(presetEngine({}), ENGINE_TYPES.LLAMA);
  assert.equal(presetEngine(null), ENGINE_TYPES.LLAMA);
  assert.equal(presetEngine({ engine: undefined }), 'llama');
});

test('presetEngine: honors ds4', () => {
  assert.equal(presetEngine({ engine: 'ds4' }), 'ds4');
  assert.equal(presetEngine({ engine: 'DS4' }), 'ds4'); // case-insensitive
});

test('presetEngine: unknown engine falls back to llama', () => {
  assert.equal(presetEngine({ engine: 'vllm' }), 'llama');
});

// ── resolveDs4Config ─────────────────────────────────────────────────────────
test('resolveDs4Config: defaults when nothing set', () => {
  const c = resolveDs4Config({}, {});
  assert.equal(c.binPath, '/home/yolan/.local/bin/ds4-server');
  assert.equal(c.port, 5253);
  assert.equal(c.ggufDir, '/home/yolan/models-ds4/deepseek-v4-gguf');
  assert.equal(c.container, 'llama-rocm-7.2.4');
  assert.equal(c.runInDistrobox, true);
  assert.equal(c.allowEmbedServer, true);
  assert.deepEqual(c.allowedRepos, ['antirez/deepseek-v4-gguf']);
});

test('resolveDs4Config: adaptive defaults (minContext / ssdStreaming / cacheExperts / adaptiveContext)', () => {
  const c = resolveDs4Config({}, {});
  assert.equal(c.minContext, 8192);
  assert.equal(c.ssdStreaming, 'auto');
  assert.equal(c.ssdStreamingCacheExperts, '32GB');
  assert.equal(c.adaptiveContext, true);
  assert.ok(c.kvBytesPerToken > 0);
  assert.ok(c.safetyBytes > 0);
  assert.ok(c.streamingWeightBytes > 0);
});

test('resolveDs4Config: adaptive fields honored from config block', () => {
  const c = resolveDs4Config({ ds4: {
    minContext: 16384, ssdStreaming: 'on', ssdStreamingCacheExperts: '48GB',
    adaptiveContext: false, kvBytesPerToken: 65536, safetyBytes: 123, streamingWeightBytes: 456,
  } }, {});
  assert.equal(c.minContext, 16384);
  assert.equal(c.ssdStreaming, 'on');
  assert.equal(c.ssdStreamingCacheExperts, '48GB');
  assert.equal(c.adaptiveContext, false);
  assert.equal(c.kvBytesPerToken, 65536);
  assert.equal(c.safetyBytes, 123);
  assert.equal(c.streamingWeightBytes, 456);
});

test('resolveDs4Config: adaptive fields env overrides win', () => {
  const c = resolveDs4Config(
    { ds4: { minContext: 16384, ssdStreaming: 'off', adaptiveContext: false } },
    { DS4_MIN_CONTEXT: '4096', DS4_SSD_STREAMING_MODE: 'auto', DS4_ADAPTIVE_CONTEXT: '1', DS4_SSD_STREAMING_CACHE_EXPERTS: '64GB' }
  );
  assert.equal(c.minContext, 4096);
  assert.equal(c.ssdStreaming, 'auto');
  assert.equal(c.adaptiveContext, true);
  assert.equal(c.ssdStreamingCacheExperts, '64GB');
});

test('resolveDs4Config: allowedRepos from config array and env override', () => {
  assert.deepEqual(
    resolveDs4Config({ ds4: { allowedRepos: ['a/b', 'c/d'] } }, {}).allowedRepos,
    ['a/b', 'c/d']
  );
  assert.deepEqual(
    resolveDs4Config({ ds4: { allowedRepos: ['a/b'] } }, { DS4_ALLOWED_REPOS: 'x/y, z/w' }).allowedRepos,
    ['x/y', 'z/w']
  );
  // A returned array must be a copy — mutating it must not poison future reads.
  const first = resolveDs4Config({}, {}).allowedRepos;
  first.push('poison/repo');
  assert.deepEqual(resolveDs4Config({}, {}).allowedRepos, ['antirez/deepseek-v4-gguf']);
});

test('resolveDs4Config: allowEmbedServer honored from config and env', () => {
  assert.equal(resolveDs4Config({ ds4: { allowEmbedServer: false } }, {}).allowEmbedServer, false);
  assert.equal(resolveDs4Config({ ds4: { allowEmbedServer: false } }, { DS4_ALLOW_EMBED_SERVER: '1' }).allowEmbedServer, true);
  assert.equal(resolveDs4Config({}, { DS4_ALLOW_EMBED_SERVER: '0' }).allowEmbedServer, false);
});

test('resolveDs4Config: config block honored', () => {
  const c = resolveDs4Config({ ds4: { binPath: '/opt/ds4', port: 9000, ggufDir: '/m', container: 'box', runInDistrobox: false } }, {});
  assert.equal(c.binPath, '/opt/ds4');
  assert.equal(c.port, 9000);
  assert.equal(c.ggufDir, '/m');
  assert.equal(c.container, 'box');
  assert.equal(c.runInDistrobox, false);
});

test('resolveDs4Config: env overrides config', () => {
  const c = resolveDs4Config(
    { ds4: { binPath: '/opt/ds4', port: 9000, runInDistrobox: true } },
    { DS4_SERVER_BIN: '/x/ds4-server', DS4_PORT: '5300', DS4_GGUF_DIR: '/g', DS4_CONTAINER: 'c2', DS4_IN_DISTROBOX: '0' }
  );
  assert.equal(c.binPath, '/x/ds4-server');
  assert.equal(c.port, 5300);
  assert.equal(c.ggufDir, '/g');
  assert.equal(c.container, 'c2');
  assert.equal(c.runInDistrobox, false);
});

// ── engineDescriptor ─────────────────────────────────────────────────────────
test('engineDescriptor: llama descriptor', () => {
  const d = engineDescriptor('llama', { llamaPort: 8080 });
  assert.equal(d.type, 'llama');
  assert.equal(d.port, 8080);
  assert.equal(d.startScript, 'start-preset.sh');
  assert.equal(d.supportsSlots, true);
  assert.equal(d.supportsRouter, true);
  assert.equal(d.healthPath, '/health');
});

test('engineDescriptor: ds4 descriptor', () => {
  const d = engineDescriptor('ds4', { ds4Config: resolveDs4Config({}, {}) });
  assert.equal(d.type, 'ds4');
  assert.equal(d.port, 5253);
  assert.equal(d.binPath, '/home/yolan/.local/bin/ds4-server');
  assert.equal(d.startScript, 'start-ds4.sh');
  assert.equal(d.supportsSlots, false);
  assert.equal(d.supportsRouter, false);
  assert.equal(d.healthPath, '/v1/models');
});

// ── validatePresetEngineFields ───────────────────────────────────────────────
test('validate: default llama when engine unset', () => {
  const r = validatePresetEngineFields({});
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'llama');
  assert.equal(r.ds4, undefined);
});

test('validate: rejects unknown engine', () => {
  const r = validatePresetEngineFields({ engine: 'triton' });
  assert.equal(r.ok, false);
  assert.match(r.error, /engine/i);
});

test('validate: ds4 requires modelPath', () => {
  const r = validatePresetEngineFields({ engine: 'ds4' });
  assert.equal(r.ok, false);
  assert.match(r.error, /modelPath/i);
});

test('validate: ds4 accepts valid fields', () => {
  const r = validatePresetEngineFields({
    engine: 'ds4',
    modelPath: 'DeepSeek-V4-Flash-IQ2XXS.gguf',
    context: 65536,
    power: 90,
    kvDiskDir: '/var/kv',
    kvDiskSpaceMb: 40000,
    extraSwitches: '--quality',
  });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'ds4');
  assert.equal(r.ds4.modelPath, 'DeepSeek-V4-Flash-IQ2XXS.gguf');
  assert.equal(r.ds4.context, 65536);
  assert.equal(r.ds4.power, 90);
  assert.equal(r.ds4.kvDiskDir, '/var/kv');
  assert.equal(r.ds4.kvDiskSpaceMb, 40000);
  assert.equal(r.ds4.extraSwitches, '--quality');
});

test('validate: ds4 accepts adaptive fields (minContext / ssdStreaming / cacheExperts / adaptiveContext)', () => {
  const r = validatePresetEngineFields({
    engine: 'ds4', modelPath: 'm.gguf',
    minContext: 16384, ssdStreaming: 'on', ssdStreamingCacheExperts: '48GB', adaptiveContext: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.ds4.minContext, 16384);
  assert.equal(r.ds4.ssdStreaming, 'on');
  assert.equal(r.ds4.ssdStreamingCacheExperts, '48GB');
  assert.equal(r.ds4.adaptiveContext, false);
});

test('validate: ds4 rejects invalid ssdStreaming mode', () => {
  const r = validatePresetEngineFields({ engine: 'ds4', modelPath: 'm.gguf', ssdStreaming: 'sometimes' });
  assert.equal(r.ok, false);
  assert.match(r.error, /ssdStreaming/i);
});

test('validate: ds4 rejects negative minContext', () => {
  const r = validatePresetEngineFields({ engine: 'ds4', modelPath: 'm.gguf', minContext: -1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /minContext/i);
});

test('validate: ds4 rejects non-boolean adaptiveContext', () => {
  const r = validatePresetEngineFields({ engine: 'ds4', modelPath: 'm.gguf', adaptiveContext: 'yes' });
  assert.equal(r.ok, false);
  assert.match(r.error, /adaptiveContext/i);
});

test('validate: ds4 rejects out-of-range power', () => {
  const r = validatePresetEngineFields({ engine: 'ds4', modelPath: 'm.gguf', power: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /power/i);
  const r2 = validatePresetEngineFields({ engine: 'ds4', modelPath: 'm.gguf', power: 101 });
  assert.equal(r2.ok, false);
});

test('validate: ds4 rejects non-numeric context', () => {
  const r = validatePresetEngineFields({ engine: 'ds4', modelPath: 'm.gguf', context: 'big' });
  assert.equal(r.ok, false);
  assert.match(r.error, /context/i);
});

// ── resolveDs4ModelPath ──────────────────────────────────────────────────────
test('resolveDs4ModelPath: absolute path passes through', () => {
  assert.equal(resolveDs4ModelPath('/abs/model.gguf', '/gguf'), '/abs/model.gguf');
});

test('resolveDs4ModelPath: relative resolves under ggufDir', () => {
  assert.equal(resolveDs4ModelPath('model.gguf', '/gguf'), '/gguf/model.gguf');
});

// ── ds4ModelEntry / ds4ModelsList ────────────────────────────────────────────
test('ds4ModelEntry: shape with owned_by ds4', () => {
  const e = ds4ModelEntry({ id: 'ds4-deepseek', name: 'DeepSeek V4', context: 65536 }, { created: 1000 });
  assert.equal(e.id, 'ds4-deepseek');
  assert.equal(e.object, 'model');
  assert.equal(e.owned_by, 'ds4');
  assert.equal(e.created, 1000);
  assert.equal(e.n_ctx, 65536);
  assert.equal(e.engine, 'ds4');
});

test('ds4ModelsList: returns ds4 model when ds4 engine active', () => {
  const config = { presets: { p1: { id: 'p1', name: 'DS4', engine: 'ds4', context: 8192 } } };
  const list = ds4ModelsList(config, { currentEngine: 'ds4', currentPreset: 'p1', created: 5 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'p1');
  assert.equal(list[0].owned_by, 'ds4');
});

test('ds4ModelsList: null when not ds4 engine', () => {
  const config = { presets: { p1: { id: 'p1', engine: 'ds4' } } };
  assert.equal(ds4ModelsList(config, { currentEngine: 'llama', currentPreset: null }), null);
});

test('ds4ModelsList: null when ds4 engine but preset missing', () => {
  assert.equal(ds4ModelsList({ presets: {} }, { currentEngine: 'ds4', currentPreset: 'nope' }), null);
});

// ── ds4TargetUrl ─────────────────────────────────────────────────────────────
test('ds4TargetUrl: builds loopback url', () => {
  assert.equal(ds4TargetUrl(5253, '/v1/chat/completions'), 'http://127.0.0.1:5253/v1/chat/completions');
  assert.equal(ds4TargetUrl(5253, 'v1/models'), 'http://127.0.0.1:5253/v1/models');
});

// ── isDs4RepoAllowed ─────────────────────────────────────────────────────────
test('isDs4RepoAllowed: only exact allowlist matches pass', () => {
  const allow = ['antirez/deepseek-v4-gguf'];
  assert.equal(isDs4RepoAllowed('antirez/deepseek-v4-gguf', allow), true);
  assert.equal(isDs4RepoAllowed('unsloth/DeepSeek-V4-GGUF', allow), false);
  assert.equal(isDs4RepoAllowed('', allow), false);
  assert.equal(isDs4RepoAllowed(null, allow), false);
  assert.equal(isDs4RepoAllowed('antirez/deepseek-v4-gguf', null), false);
});

// ── listDs4GgufFiles ─────────────────────────────────────────────────────────
test('listDs4GgufFiles: lists only .gguf files under the dir, sorted, with sizes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds4-gguf-'));
  try {
    writeFileSync(join(dir, 'deepseek-v4-q2-imatrix.gguf'), 'AA');
    writeFileSync(join(dir, 'alpha.gguf'), 'B');
    writeFileSync(join(dir, 'README.md'), 'not a gguf');
    const list = listDs4GgufFiles(dir, { existsSync, readdirSync, statSync });
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'alpha.gguf'); // sorted
    assert.equal(list[1].name, 'deepseek-v4-q2-imatrix.gguf');
    assert.equal(list[1].path, `${dir}/deepseek-v4-q2-imatrix.gguf`);
    assert.equal(list[1].sizeBytes, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listDs4GgufFiles: missing dir → empty list', () => {
  assert.deepEqual(listDs4GgufFiles('/no/such/ds4/dir', { existsSync, readdirSync, statSync }), []);
  assert.deepEqual(listDs4GgufFiles('', { existsSync, readdirSync, statSync }), []);
});

// ── validateDs4DownloadRequest ───────────────────────────────────────────────
const DS4_CFG = { ggufDir: '/home/yolan/models-ds4/deepseek-v4-gguf', allowedRepos: ['antirez/deepseek-v4-gguf'] };

test('validateDs4DownloadRequest: rejects missing repo', () => {
  const r = validateDs4DownloadRequest({}, DS4_CFG);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('validateDs4DownloadRequest: rejects non-allowlisted repo with 400', () => {
  const r = validateDs4DownloadRequest({ repo: 'evil/other-gguf' }, DS4_CFG);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /allowlist/);
});

test('validateDs4DownloadRequest: accepts allowlisted repo and pins targetDir to ggufDir', () => {
  const r = validateDs4DownloadRequest({ repo: 'antirez/deepseek-v4-gguf', pattern: '*imatrix*' }, DS4_CFG);
  assert.equal(r.ok, true);
  assert.equal(r.repo, 'antirez/deepseek-v4-gguf');
  assert.deepEqual(r.includePatterns, ['*imatrix*']);
  assert.equal(r.downloadId, 'antirez/deepseek-v4-gguf:*imatrix*');
  assert.equal(r.targetDir, DS4_CFG.ggufDir); // HARD RULE: never ~/models
});

test('validateDs4DownloadRequest: filename/quantization/default pattern shaping', () => {
  const byFile = validateDs4DownloadRequest({ repo: 'antirez/deepseek-v4-gguf', filename: 'a.gguf' }, DS4_CFG);
  assert.deepEqual(byFile.includePatterns, ['a.gguf']);
  const byQuant = validateDs4DownloadRequest({ repo: 'antirez/deepseek-v4-gguf', quantization: 'q2' }, DS4_CFG);
  assert.deepEqual(byQuant.includePatterns, ['*Q2*.gguf', '*q2*.gguf']);
  const byDefault = validateDs4DownloadRequest({ repo: 'antirez/deepseek-v4-gguf' }, DS4_CFG);
  assert.deepEqual(byDefault.includePatterns, ['*.gguf']);
  assert.equal(byDefault.downloadId, 'antirez/deepseek-v4-gguf:all');
});

// ---------------------------------------------------------------------------
// ds4EnableGate — is there enough unified memory to offer enabling ds4?
// ---------------------------------------------------------------------------

test('ds4EnableGate: eligible when free memory covers the streaming requirement', () => {
  const cfg = resolveDs4Config({}, {}); // streamingWeightBytes 50G + safety 5G ≈ 55G
  const g = ds4EnableGate({ freeMemBytes: 60 * 1024 ** 3, ds4Config: cfg });
  assert.equal(g.eligible, true);
  assert.equal(g.requiredBytes, cfg.streamingWeightBytes + cfg.safetyBytes);
  assert.equal(g.freeBytes, 60 * 1024 ** 3);
});

test('ds4EnableGate: ineligible with a reason when memory is short', () => {
  const cfg = resolveDs4Config({}, {});
  const g = ds4EnableGate({ freeMemBytes: 20 * 1024 ** 3, ds4Config: cfg });
  assert.equal(g.eligible, false);
  assert.match(g.reason, /memory/i);
});

test('ds4EnableGate: non-streaming presets require the full weight + safety', () => {
  const cfg = { ...resolveDs4Config({}, {}), ssdStreaming: 'off', weightBytes: 80 * 1024 ** 3 };
  const g = ds4EnableGate({ freeMemBytes: 60 * 1024 ** 3, ds4Config: cfg });
  assert.equal(g.requiredBytes, 80 * 1024 ** 3 + cfg.safetyBytes);
  assert.equal(g.eligible, false);
});

// ---------------------------------------------------------------------------
// buildLocalServerRegistry — one uniform descriptor per local server.
// ---------------------------------------------------------------------------

test('buildLocalServerRegistry: llama + embeddings + ds4, differing only by models/state', () => {
  const reg = buildLocalServerRegistry({
    llama: { running: true, healthy: true, port: 5251, models: ['gemma-4', 'gpt-oss-120b'], mode: 'router', tps: 100.5, requests: 3 },
    embed: { running: true, healthy: true, port: 5252, models: ['Qwen3-Embedding-0.6B'] },
    ds4: { ds4Config: resolveDs4Config({}, {}), running: false, freeMemBytes: 60 * 1024 ** 3 },
  });
  const byId = Object.fromEntries(reg.map((s) => [s.id, s]));
  assert.deepEqual(reg.map((s) => s.id).sort(), ['ds4', 'embeddings', 'llama']);

  // llama: running router, gemma is one of its models
  assert.equal(byId.llama.type, ENGINE_TYPES.LLAMA);
  assert.equal(byId.llama.state, 'running');
  assert.ok(byId.llama.models.includes('gemma-4'));
  assert.equal(byId.llama.tps, 100.5);

  // embeddings: same shape as llama, only models differ
  assert.deepEqual(Object.keys(byId.embeddings).sort(), Object.keys(byId.llama).sort());

  // ds4: not running but eligible to enable → offered
  assert.equal(byId.ds4.type, ENGINE_TYPES.DS4);
  assert.equal(byId.ds4.state, 'available');
  assert.equal(byId.ds4.enable.eligible, true);
});

test('buildLocalServerRegistry: ds4 shows insufficient-memory when it cannot fit', () => {
  const reg = buildLocalServerRegistry({
    llama: { running: true, healthy: true, port: 5251, models: [] },
    embed: { running: false, healthy: false, port: 5252, models: [] },
    ds4: { ds4Config: resolveDs4Config({}, {}), running: false, freeMemBytes: 10 * 1024 ** 3 },
  });
  const ds4 = reg.find((s) => s.id === 'ds4');
  assert.equal(ds4.state, 'insufficient-memory');
  assert.equal(ds4.enable.eligible, false);
});

test('buildLocalServerRegistry: a running ds4 reports running regardless of the gate', () => {
  const reg = buildLocalServerRegistry({
    llama: { running: true, healthy: true, port: 5251, models: [] },
    embed: { running: false, healthy: false, port: 5252, models: [] },
    ds4: { ds4Config: resolveDs4Config({}, {}), running: true, healthy: true, freeMemBytes: 5 * 1024 ** 3, models: ['deepseek-v4'] },
  });
  const ds4 = reg.find((s) => s.id === 'ds4');
  assert.equal(ds4.state, 'running');
  assert.ok(ds4.models.includes('deepseek-v4'));
});
