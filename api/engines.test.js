// Llama Manager — unit tests for engine abstraction and router preset helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
// Verifies engine selection, process configuration, and pure generation of
// independent Gemma and Qwen3.8 MTP/ngram model-router INI sections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_TYPES,
  presetEngine,
  resolveDs4Config,
  engineDescriptor,
  ds4EnableGate,
  ds4ModelRef,
  ds4ArgIsShellSafe,
  buildLocalServerRegistry,
  renderModelsPresetIni,
  gemmaMtpPresetSection,
  qwen38MtpPresetSection,
  museGlimmerDflashPresetSection,
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

// ---------------------------------------------------------------------------
// ds4ModelRef — a downloaded DS4 GGUF is usable WITHOUT a stored preset
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ds4 launch arguments must not be able to run commands
// ---------------------------------------------------------------------------

test('ds4ArgIsShellSafe: rejects command substitution and shell operators', () => {
  // ds4 launch arguments are passed through `distrobox enter`, which builds a
  // command string and eval's it. VERIFIED on the appliance: an extraSwitches
  // value of "--flag$(touch /tmp/canary)" created the canary — arbitrary
  // execution as the llama-manager account, reachable by anyone who can PUT a
  // preset. These fields are flags and filenames; none of this belongs in them.
  for (const bad of [
    '--flag$(touch /tmp/x)',
    '--flag`id`',
    '--a; rm -rf /',
    '--a | nc host 1',
    '--a && curl evil',
    '--a > /etc/passwd',
    '--a\nsecond-line',
    '--a$HOME',
  ]) {
    assert.equal(ds4ArgIsShellSafe(bad), false, `expected rejection: ${bad}`);
  }
});

test('validatePresetEngineFields: refuses a ds4 preset that smuggles a command', () => {
  // End of the actual attack path: PUT a preset with a crafted extraSwitches and
  // the launcher runs it. The API must refuse before it is ever stored.
  const bad = validatePresetEngineFields({
    engine: 'ds4', modelPath: 'model.gguf', extraSwitches: '--rocm $(touch /tmp/pwned)',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /shell metacharacters/);

  const badPath = validatePresetEngineFields({
    engine: 'ds4', modelPath: 'model.gguf; rm -rf /',
  });
  assert.equal(badPath.ok, false);

  const good = validatePresetEngineFields({
    engine: 'ds4', modelPath: 'DeepSeek-V4-Flash-IQ2XXS.gguf', extraSwitches: '--rocm --cors',
  });
  assert.equal(good.ok, true);
});

test('ds4ArgIsShellSafe: accepts the switches and paths actually used', () => {
  for (const ok of [
    '--rocm --cors',
    '--ssd-streaming-cache-experts 32',
    '--power 100',
    '/var/lib/llama-manager/models/ds4/DeepSeek-V4-Flash-IQ2XXS.gguf',
    'DeepSeek-V4-Flash-Layers37-42Q4KExperts-chat-v2-imatrix-fixed-0731.gguf',
    '',
  ]) {
    assert.equal(ds4ArgIsShellSafe(ok), true, `expected acceptance: ${ok}`);
  }
});

test('ds4ModelRef: resolves a downloaded GGUF by its listed name', () => {
  // DS4 is meant to behave like any other model: if the weights are there it
  // appears in the model list, and asking for it loads it (evicting others,
  // which is what "exclusive" means). Requiring the operator to hand-build a
  // preset first is what made a downloaded DS4 show as Available and still be
  // unusable.
  const files = [{ name: 'DeepSeek-V4-Flash-IQ2XXS.gguf', path: '/m/ds4/DeepSeek-V4-Flash-IQ2XXS.gguf', sizeBytes: 1 }];
  const ref = ds4ModelRef('DeepSeek-V4-Flash-IQ2XXS.gguf', files);
  assert.ok(ref, 'expected a ref for a listed GGUF');
  assert.equal(ref.preset.modelPath, 'DeepSeek-V4-Flash-IQ2XXS.gguf');
  assert.equal(ref.preset.engine, 'ds4');
});

test('ds4ModelRef: carries the fields the ds4 supervisor actually reads', () => {
  // The supervisor logs `preset: ${preset.id}` and builds the launch env from
  // preset.config. A ref with only modelPath logged "preset: undefined" and
  // launched without --rocm, which is not how a stored preset behaves.
  const files = [{ name: 'DeepSeek-V4-Flash-IQ2XXS.gguf', path: '/m/ds4/x.gguf', sizeBytes: 1 }];
  const ref = ds4ModelRef('DeepSeek-V4-Flash-IQ2XXS.gguf', files);
  assert.equal(ref.preset.id, 'DeepSeek-V4-Flash-IQ2XXS.gguf');
  assert.match(ref.preset.config.extraSwitches, /--rocm/);
  // context stays unset: the adaptive controller sets DS4_CTX per attempt.
  assert.equal(ref.preset.context, undefined);
});

test('ds4ModelRef: matches the name with or without the .gguf suffix', () => {
  const files = [{ name: 'DeepSeek-V4-Flash-IQ2XXS.gguf', path: '/m/ds4/x.gguf', sizeBytes: 1 }];
  assert.ok(ds4ModelRef('DeepSeek-V4-Flash-IQ2XXS', files));
});

test('ds4ModelRef: refuses anything that is not a listed DS4 GGUF', () => {
  // This gates an 87GB load that evicts every resident model, so it must match
  // an actual file in the ds4 directory and nothing else. A loose match here
  // would swap the whole box on a typo.
  const files = [{ name: 'DeepSeek-V4-Flash-IQ2XXS.gguf', path: '/m/ds4/x.gguf', sizeBytes: 1 }];
  assert.equal(ds4ModelRef('Qwen3-8B-Q4_K_M', files), null);
  assert.equal(ds4ModelRef('DeepSeek', files), null);
  assert.equal(ds4ModelRef('', files), null);
  assert.equal(ds4ModelRef(null, files), null);
  assert.equal(ds4ModelRef('DeepSeek-V4-Flash-IQ2XXS.gguf', []), null);
});

test('ds4EnableGate: ineligible when the DS4 weights are not installed', () => {
  // The appliance ships the ds4-server binary but not the ~80GB weights, and it
  // has plenty of RAM. Gating on memory alone advertised DS4 as available on a
  // machine that could never serve it -- the dashboard offered it while the chat
  // panel correctly showed nothing.
  const cfg = resolveDs4Config({}, {});
  const g = ds4EnableGate({ freeMemBytes: 120 * 1024 ** 3, ds4Config: cfg, weightsPresent: false });
  assert.equal(g.eligible, false);
  assert.equal(g.weightsPresent, false);
  assert.match(g.reason, /not installed|no model|weights/i);
  assert.match(g.reason, new RegExp(cfg.ggufDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('ds4EnableGate: present weights plus enough memory is still eligible', () => {
  const cfg = resolveDs4Config({}, {});
  const g = ds4EnableGate({ freeMemBytes: 60 * 1024 ** 3, ds4Config: cfg, weightsPresent: true });
  assert.equal(g.eligible, true);
  assert.equal(g.weightsPresent, true);
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

// ---------------------------------------------------------------------------
// models-preset INI (router speculative-decode wiring for gemma-4)
// ---------------------------------------------------------------------------

test('renderModelsPresetIni: emits [section] with dash-stripped long-flag keys', () => {
  const ini = renderModelsPresetIni([
    { name: 'my-model', options: { 'model-draft': '/d.gguf', 'spec-type': 'draft-mtp', 'spec-draft-n-max': '1' } },
  ]);
  assert.match(ini, /^\[my-model\]/m);
  assert.match(ini, /^model-draft = \/d\.gguf$/m);
  assert.match(ini, /^spec-type = draft-mtp$/m);
  assert.match(ini, /^spec-draft-n-max = 1$/m);
});

test('renderModelsPresetIni: empty sections → empty string (no --models-preset needed)', () => {
  assert.equal(renderModelsPresetIni([]), '');
  assert.equal(renderModelsPresetIni([].filter(Boolean)), '');
});

test('gemmaMtpPresetSection: present drafter → gemma section with draft-mtp flags', () => {
  const s = gemmaMtpPresetSection({ modelsDir: '/home/u/models', draftExists: true });
  assert.equal(s.name, 'google_gemma-4-E2B-it-qat-q4_0-gguf');
  assert.equal(s.options['spec-type'], 'draft-mtp');
  assert.equal(s.options['spec-draft-n-max'], '1');
  assert.equal(s.options['gpu-layers-draft'], '99');
  assert.equal(s.options['model-draft'], '/home/u/models/google_gemma-4-E2B-it-assistant/gemma-4-E2B-it-assistant-BF16.gguf');
});

test('gemmaMtpPresetSection: no drafter → null (router serves gemma without MTP)', () => {
  assert.equal(gemmaMtpPresetSection({ modelsDir: '/m', draftExists: false }), null);
});

test('renderModelsPresetIni round-trips the gemma section into a valid child argv', () => {
  const s = gemmaMtpPresetSection({ modelsDir: '/m', draftExists: true });
  const ini = renderModelsPresetIni([s]);
  // The router strips dashes on write; a consumer re-adds them. Assert the four
  // options are present so the child gets --model-draft/--spec-type/etc.
  for (const k of ['model-draft', 'spec-type', 'spec-draft-n-max', 'gpu-layers-draft']) {
    assert.match(ini, new RegExp(`^${k} = `, 'm'), `missing ${k}`);
  }
});

test('gemmaMtpPresetSection: existing descriptor and rendered bytes remain unchanged', () => {
  const section = gemmaMtpPresetSection({ modelsDir: '/home/u/models', draftExists: true });

  assert.deepEqual(section, {
    name: 'google_gemma-4-E2B-it-qat-q4_0-gguf',
    options: {
      'model-draft': '/home/u/models/google_gemma-4-E2B-it-assistant/gemma-4-E2B-it-assistant-BF16.gguf',
      'spec-type': 'draft-mtp',
      'spec-draft-n-max': '1',
      'gpu-layers-draft': '99',
    },
  });
  assert.equal(
    renderModelsPresetIni([section]),
    '[google_gemma-4-E2B-it-qat-q4_0-gguf]\n'
      + 'model-draft = /home/u/models/google_gemma-4-E2B-it-assistant/gemma-4-E2B-it-assistant-BF16.gguf\n'
      + 'spec-type = draft-mtp\n'
      + 'spec-draft-n-max = 1\n'
      + 'gpu-layers-draft = 99\n',
  );
});

test('qwen38MtpPresetSection: flattened draft produces the combined MTP/ngram descriptor', () => {
  const section = qwen38MtpPresetSection({ modelsDir: '/home/u/models', draftExists: true });

  assert.deepEqual(section, {
    name: 'unsloth_Qwen3.8-27B-GGUF',
    options: {
      'model-draft': '/home/u/models/unsloth_Qwen3.8-27B-GGUF/mtp-Qwen3.8-27B-Q4_0.gguf',
      'spec-type': 'draft-mtp,ngram-mod',
      'spec-draft-n-max': '12',
      'spec-ngram-mod-n-min': '24',
      parallel: '1',
      'gpu-layers-draft': '99',
    },
  });
});

test('qwen38MtpPresetSection: missing flattened draft emits no Qwen preset section', () => {
  const section = qwen38MtpPresetSection({ modelsDir: '/home/u/models', draftExists: false });

  assert.equal(section, null);
  assert.equal(renderModelsPresetIni([section]), '');
});

test('Qwen and Gemma descriptors render as independent valid INI sections', () => {
  const gemma = gemmaMtpPresetSection({ modelsDir: '/home/u/models', draftExists: true });
  const qwen = qwen38MtpPresetSection({ modelsDir: '/home/u/models', draftExists: true });
  const ini = renderModelsPresetIni([gemma, qwen]);
  const blocks = ini.trimEnd().split('\n\n');

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0],
    '[google_gemma-4-E2B-it-qat-q4_0-gguf]\n'
      + 'model-draft = /home/u/models/google_gemma-4-E2B-it-assistant/gemma-4-E2B-it-assistant-BF16.gguf\n'
      + 'spec-type = draft-mtp\n'
      + 'spec-draft-n-max = 1\n'
      + 'gpu-layers-draft = 99');
  assert.match(blocks[1], /^\[unsloth_Qwen3\.8-27B-GGUF\]$/m);
  assert.match(blocks[1], /^model-draft = \/home\/u\/models\/unsloth_Qwen3\.8-27B-GGUF\/mtp-Qwen3\.8-27B-Q4_0\.gguf$/m);
  assert.match(blocks[1], /^spec-type = draft-mtp,ngram-mod$/m);
  assert.match(blocks[1], /^spec-draft-n-max = 12$/m);
  assert.match(blocks[1], /^spec-ngram-mod-n-min = 24$/m);
  assert.match(blocks[1], /^parallel = 1$/m);
  assert.match(blocks[1], /^gpu-layers-draft = 99$/m);
  assert.doesNotMatch(blocks[0], /Qwen3\.8/);
  assert.doesNotMatch(blocks[1], /gemma-4/);
});

test('qwen38MtpPresetSection: public helper is documented and trusts explicit filesystem state', () => {
  const nonexistentRoot = '/definitely/not/a/real/models-directory';
  const section = qwen38MtpPresetSection({ modelsDir: nonexistentRoot, draftExists: true });
  const source = readFileSync(new URL('./engines.js', import.meta.url), 'utf8');
  const documentation = source.match(
    /\/\*\*([\s\S]*?)\*\/\s*export function qwen38MtpPresetSection\b/,
  );

  assert.equal(
    section.options['model-draft'],
    `${nonexistentRoot}/unsloth_Qwen3.8-27B-GGUF/mtp-Qwen3.8-27B-Q4_0.gguf`,
    'the pure helper should trust caller-supplied existence state rather than touching the filesystem',
  );
  assert.ok(documentation, 'the public Qwen preset helper must have adjacent JSDoc');
  assert.match(documentation[1], /pure|filesystem/i);
  assert.match(documentation[1], /@param/);
  assert.match(documentation[1], /@returns?/);
});

test('museGlimmerDflashPresetSection: present drafter → Muse Glimmer section with draft-dflash + published sampling', () => {
  const s = museGlimmerDflashPresetSection({ modelsDir: '/home/u/models', draftExists: true });
  assert.deepEqual(s, {
    name: 'unsloth_Muse-Glimmer-30B-GGUF',
    options: {
      'model-draft': '/home/u/models/unsloth_Muse-Glimmer-30B-GGUF/dflash-kquant.gguf',
      'spec-type': 'draft-dflash',
      'gpu-layers-draft': '99',
      'temp': '1.0',
      'top-p': '0.95',
      'top-k': '64',
    },
  });
  assert.equal(
    renderModelsPresetIni([s]),
    '[unsloth_Muse-Glimmer-30B-GGUF]\n'
      + 'model-draft = /home/u/models/unsloth_Muse-Glimmer-30B-GGUF/dflash-kquant.gguf\n'
      + 'spec-type = draft-dflash\n'
      + 'gpu-layers-draft = 99\n'
      + 'temp = 1.0\n'
      + 'top-p = 0.95\n'
      + 'top-k = 64\n',
  );
});

test('museGlimmerDflashPresetSection: no drafter → null (router serves Muse Glimmer without DFlash)', () => {
  assert.equal(museGlimmerDflashPresetSection({ modelsDir: '/m', draftExists: false }), null);
});
