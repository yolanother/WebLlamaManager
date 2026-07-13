// Llama Manager — unit tests for api/engines.js (engine-abstraction helpers).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_TYPES,
  presetEngine,
  resolveDs4Config,
  engineDescriptor,
  validatePresetEngineFields,
  resolveDs4ModelPath,
  ds4ModelEntry,
  ds4ModelsList,
  ds4TargetUrl,
  ENGINE_PROCESS_COMMS,
  isEngineProcessComm,
  engineSupportsSlots,
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
