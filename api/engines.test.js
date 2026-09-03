// Llama Manager — unit tests for engine abstraction and router preset helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
// Verifies engine selection, process configuration, and pure generation of
// independent Gemma and Qwen3.8 MTP/ngram model-router INI sections, including
// ownership-aware DS4 stall decisions and their server watchdog wiring.
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
  llamaFitsBesideDs4,
  isProjectorModelId,
  remoteStallMs,
  DS4_ZERO_TOKEN_STALL_MS,
  remoteStallCeilingMs,
  remoteStallVerdict,
  largestContextBesideDs4,
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
  ds4ChatDeltaText,
  ds4ResponsesEventText,
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

// ---------------------------------------------------------------------------
// llamaFitsBesideDs4 — evict DS4 only when the llama model genuinely cannot fit
// ---------------------------------------------------------------------------

test('llamaFitsBesideDs4: a small model fits in real headroom, so DS4 stays', () => {
  // Measured on the dedicated appliance: DS4 resident leaves ~16 GiB free, and
  // default-small (Qwen3-8B-Q4_K_M) is ~4.7 GiB. Tearing down an 80 GiB engine
  // to serve that is pure waste — the whole point of the gate.
  const fit = llamaFitsBesideDs4({
    freeMemBytes: 16 * 1024 ** 3,
    modelBytes: 5 * 1024 ** 3,
    contextTokens: 8192,
    kvBytesPerToken: 128 * 1024,
    safetyBytes: 2 * 1024 ** 3,
  });
  assert.equal(fit.fits, true);
});

test('llamaFitsBesideDs4: refuses when the headroom is not really there', () => {
  // A contended host (Frostburn runs containers alongside) can have far less
  // free than a dedicated one. Same code, different answer — the decision is
  // made from measured free memory, never from a per-box assumption.
  const fit = llamaFitsBesideDs4({
    freeMemBytes: 6 * 1024 ** 3,
    modelBytes: 5 * 1024 ** 3,
    contextTokens: 8192,
    kvBytesPerToken: 128 * 1024,
    safetyBytes: 2 * 1024 ** 3,
  });
  assert.equal(fit.fits, false);
  assert.match(fit.reason, /not enough/i);
});

test('llamaFitsBesideDs4: counts the KV cache, not just the weights', () => {
  // 8192 tokens * 128KiB = 1 GiB of KV. A check that ignored it would admit a
  // model that then OOMs partway through its first long request.
  const base = { freeMemBytes: 8 * 1024 ** 3, modelBytes: 5 * 1024 ** 3,
                 kvBytesPerToken: 128 * 1024, safetyBytes: 2 * 1024 ** 3 };
  assert.equal(llamaFitsBesideDs4({ ...base, contextTokens: 1024 }).fits, true);
  assert.equal(llamaFitsBesideDs4({ ...base, contextTokens: 65536 }).fits, false);
});

test('llamaFitsBesideDs4: an unknown model size is never assumed to fit', () => {
  // resolveModelSizeBytes returns 0 when it cannot size a model. Treating that
  // as "fits" would evict nothing and then OOM; treating it as "does not fit"
  // falls back to the old evict-first behaviour, which is safe.
  const fit = llamaFitsBesideDs4({
    freeMemBytes: 64 * 1024 ** 3, modelBytes: 0, contextTokens: 8192,
    kvBytesPerToken: 128 * 1024, safetyBytes: 2 * 1024 ** 3,
  });
  assert.equal(fit.fits, false);
  assert.match(fit.reason, /unknown/i);
});

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

test('isProjectorModelId identifies mmproj companions in their usual placements', () => {
  // The exact id that reached the router as a chat model and came back
  // "model not found", surfacing to the caller as an empty completion.
  assert.equal(
    isProjectorModelId('unsloth_Muse-Glimmer-30B-GGUF/mmproj-Muse-Glimmer-30B-Q8_0.gguf'),
    true,
  );
  assert.equal(isProjectorModelId('mmproj-Model-Q8_0.gguf'), true);
  assert.equal(isProjectorModelId('Model.mmproj.gguf'), true);
  assert.equal(isProjectorModelId('Model-mmproj.gguf'), true);
});

test('isProjectorModelId leaves real models alone', () => {
  assert.equal(isProjectorModelId('Qwen3-8B-Q4_K_M'), false);
  assert.equal(isProjectorModelId('unsloth_Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-Q8_0.gguf'), false);
  assert.equal(isProjectorModelId('DeepSeek-V4-Flash-IQ2XXS-w2Q2K.gguf'), false);
  // Contains the letters but is not the token.
  assert.equal(isProjectorModelId('mmprojector-chat-7B-Q4_K_M.gguf'), false);
  assert.equal(isProjectorModelId(''), false);
  assert.equal(isProjectorModelId(undefined), false);
});

test('remoteStallMs keeps the 120s floor for ordinary contexts', () => {
  // Small contexts must behave exactly as before: a wedged remote is still
  // torn down promptly.
  assert.equal(remoteStallMs({ contextTokens: 8192 }), 120000);
  assert.equal(remoteStallMs({ contextTokens: 0 }), 120000);
  assert.equal(remoteStallMs(), 120000);
});

test('remoteStallMs scales past the floor for a large context', () => {
  // The case that killed healthy work: at 65,536 tokens and ~250 tok/s, prefill
  // alone is ~262s, so a flat 120s aborted a backend that was working.
  const ms = remoteStallMs({ contextTokens: 65536 });
  assert.ok(ms > 120000, 'must exceed the floor');
  assert.ok(ms >= 262000, `must cover ~262s of prefill, got ${ms}`);
});

test('remoteStallMs is monotonic in context size', () => {
  const a = remoteStallMs({ contextTokens: 65536 });
  const b = remoteStallMs({ contextTokens: 131072 });
  assert.ok(b > a, 'a bigger context must allow a longer silence');
});

// ── DS4_ZERO_TOKEN_STALL_MS / remoteStallCeilingMs ──────────────────────────

test('DS4_ZERO_TOKEN_STALL_MS clears the measured 228-287s worst-case prefill plus ~25s cold-load with real margin', () => {
  const measuredWorstCaseMs = 287_000 + 25_000; // 287s prefill + 25s ds4 cold-load
  assert.ok(
    DS4_ZERO_TOKEN_STALL_MS > measuredWorstCaseMs * 1.1,
    `must clear the measured worst case with real margin, got ${DS4_ZERO_TOKEN_STALL_MS}`,
  );
});

test('remoteStallCeilingMs: a ds4-backed entry always gets the fixed ds4 ceiling, regardless of the generic value', () => {
  assert.equal(remoteStallCeilingMs({ backend: 'ds4' }, 120_000), DS4_ZERO_TOKEN_STALL_MS);
  assert.equal(remoteStallCeilingMs({ backend: 'ds4' }, 900_000), DS4_ZERO_TOKEN_STALL_MS);
});

test('remoteStallCeilingMs: any other remote backend keeps the generic (context-scaled) ceiling', () => {
  assert.equal(remoteStallCeilingMs({ backend: 'drakemore-mtj8prpy' }, 393_216), 393_216);
  assert.equal(remoteStallCeilingMs({ backend: 'dahaka-ollama-mngx88pk' }, 120_000), 120_000);
});

test('remoteStallCeilingMs: missing backend falls back to the generic ceiling', () => {
  assert.equal(remoteStallCeilingMs({}, 120_000), 120_000);
  assert.equal(remoteStallCeilingMs(undefined, 120_000), 120_000);
});

// ── remoteStallVerdict (ownership-aware ds4 ceiling) ────────────────────────

test('remoteStallVerdict: a ds4 request queued behind another one is never a stall candidate', () => {
  // The whole point: it has produced no tokens for far longer than the ceiling,
  // but only because someone else owns the single ds4 generation slot.
  const now = 1_000_000_000;
  const verdict = remoteStallVerdict({
    entry: { backend: 'ds4', startTime: now - (DS4_ZERO_TOKEN_STALL_MS * 3), lastActivityAt: now - (DS4_ZERO_TOKEN_STALL_MS * 3), slotAcquiredAt: null },
    holdsDs4Slot: false,
    queuedForDs4Slot: true,
    now,
    genericRemoteStallMs: 120_000,
  });
  assert.equal(verdict.action, 'skip');
  assert.match(verdict.reason, /queued for the ds4 generation slot/);
});

test('remoteStallVerdict: a ds4 entry in neither state is an orphan and is still reaped', () => {
  // The exemption is for a request genuinely waiting its turn. An entry that
  // holds nothing and is queued for nothing has no such excuse — leaving it
  // exempt would let a dead handler's entry sit in activeRequests forever.
  const now = 1_000_000_000;
  const verdict = remoteStallVerdict({
    entry: { backend: 'ds4', startTime: now - 600_000, lastActivityAt: now - 600_000 },
    holdsDs4Slot: false,
    queuedForDs4Slot: false,
    now,
    genericRemoteStallMs: 120_000,
  });
  assert.equal(verdict.action, 'stalled');
  assert.equal(verdict.limitMs, DS4_ZERO_TOKEN_STALL_MS);
});

test('remoteStallVerdict: the ds4 slot holder is still bounded, measured from slot acquisition', () => {
  const now = 1_000_000_000;
  const entry = {
    backend: 'ds4',
    startTime: now - 3_600_000,      // waited an hour in the queue
    lastActivityAt: now - 3_600_000, // and produced nothing during that wait
    slotAcquiredAt: now - 60_000,    // but has only held the slot a minute
  };
  const stillFine = remoteStallVerdict({ entry, holdsDs4Slot: true, queuedForDs4Slot: false, now, genericRemoteStallMs: 120_000 });
  assert.equal(stillFine.action, 'skip', 'queue wait must not count toward the generation ceiling');
  assert.ok(stillFine.idleMs < DS4_ZERO_TOKEN_STALL_MS);

  const later = now + DS4_ZERO_TOKEN_STALL_MS;
  const stalled = remoteStallVerdict({ entry, holdsDs4Slot: true, now: later, genericRemoteStallMs: 120_000 });
  assert.equal(stalled.action, 'stalled', 'a zero-token slot holder must still be reaped so the slot frees');
  assert.equal(stalled.limitMs, DS4_ZERO_TOKEN_STALL_MS);
});

test('remoteStallVerdict: a ds4 entry that never recorded slot acquisition falls back to its own activity clock', () => {
  const now = 1_000_000_000;
  const entry = { backend: 'ds4', startTime: now - 600_000, lastActivityAt: now - 600_000 };
  const verdict = remoteStallVerdict({ entry, holdsDs4Slot: true, now, genericRemoteStallMs: 120_000 });
  assert.equal(verdict.action, 'stalled');
  assert.equal(verdict.limitMs, DS4_ZERO_TOKEN_STALL_MS);
});

test('remoteStallVerdict: a non-ds4 remote backend keeps the generic ceiling and the arrival-based clock', () => {
  const now = 1_000_000_000;
  const entry = { backend: 'drakemore-mtj8prpy', startTime: now - 200_000, lastActivityAt: now - 200_000 };
  assert.equal(remoteStallVerdict({ entry, holdsDs4Slot: false, now, genericRemoteStallMs: 393_216 }).action, 'skip');
  const stalled = remoteStallVerdict({ entry, holdsDs4Slot: false, now, genericRemoteStallMs: 120_000 });
  assert.equal(stalled.action, 'stalled');
  assert.equal(stalled.limitMs, 120_000);
});

test('remoteStallVerdict: ds4 slot ownership does not leak to other backends', () => {
  // holdsDs4Slot is meaningless for a remote backend id; it must not exempt it.
  const now = 1_000_000_000;
  const entry = { backend: 'dahaka-ollama-mngx88pk', startTime: now - 500_000, lastActivityAt: now - 500_000 };
  assert.equal(remoteStallVerdict({ entry, holdsDs4Slot: false, now, genericRemoteStallMs: 120_000 }).action, 'stalled');
});

test('stall watchdog wires remoteStallVerdict — with ds4 slot ownership — into its remote/ds4 branch', () => {
  // Pure-function tests above only prove remoteStallVerdict itself is correct;
  // they say nothing about whether server.js's watchdog actually calls it. Lock
  // the wiring structurally so a future edit reverting to a bare
  // currentRemoteStallMs() or an ownership-blind ceiling — silently un-fixing
  // this — fails a test instead of just quietly regressing.
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const branchStart = source.indexOf('// Remote backend stall.');
  assert.ok(branchStart >= 0, 'watchdog remote-stall branch must exist');
  const branch = source.slice(branchStart, branchStart + 3000);
  assert.match(
    branch,
    /const verdict = remoteStallVerdict\(\{[\s\S]*?holdsDs4Slot: ds4SlotHolders\.has\(id\),[\s\S]*?queuedForDs4Slot: ds4SlotWaiters\.has\(id\),[\s\S]*?genericRemoteStallMs: currentRemoteStallMs\(\),[\s\S]*?\}\);/,
    'the remote-stall branch must route through remoteStallVerdict and pass real ds4 slot ownership and queue membership',
  );
  assert.match(
    branch,
    /if \(verdict\.action === 'skip'\) continue;/,
    'a skip verdict must short-circuit before anything is aborted',
  );
  assert.match(
    branch,
    /forwardedRequestIsQueuedDownstream\(backendCfg, entry\.relayRequestId, entry\._downstreamWait, 'watchdog'\)/,
    'the branch must ask the provider whether the request is merely queued before killing it',
  );
  // The ds4 ownership set has to be built from the real queue, not guessed.
  const watchdogStart = source.indexOf('// Local: only candidates that hold a real queue slot are eligible.');
  assert.ok(watchdogStart >= 0);
  const preamble = source.slice(watchdogStart, branchStart);
  assert.match(
    preamble,
    /for \(const item of ds4Queue\.activeItems\.values\(\)\) \{\s*if \(item\.activeReqId != null\) ds4SlotHolders\.add\(item\.activeReqId\);/,
    'ds4SlotHolders must come from ds4Queue.activeItems',
  );
  assert.match(
    preamble,
    /for \(const item of ds4Queue\.queue\) \{\s*if \(item\.activeReqId != null\) ds4SlotWaiters\.add\(item\.activeReqId\);/,
    'ds4SlotWaiters must come from the real ds4Queue backlog',
  );
});

const GIB = 1024 ** 3;

test('largestContextBesideDs4 keeps the full context when it genuinely fits', () => {
  const r = largestContextBesideDs4({
    freeMemBytes: 40 * GIB, modelBytes: 4.7 * GIB, kvBytesPerToken: 144 * 1024,
    safetyBytes: 2 * GIB, desiredContext: 65536, minContext: 4096,
  });
  assert.equal(r.fits, true);
  assert.equal(r.context, 65536);
});

test('largestContextBesideDs4 steps down instead of refusing', () => {
  // The real regression: Qwen3-8B at 65,536 needs ~17.7 GiB but DS4 leaves
  // ~15 GiB, so co-residency was refused and an 87 GB engine was evicted for a
  // small model. A reduced window keeps both engines up.
  // Values measured on drakemore: DS4 resident leaves ~15.1 GiB, the ds4 config
  // budgets KV at 128 KiB/token, and the safety margin is ~5 GiB — which is how
  // the box arrived at "needs ~17.7 GiB, only 15.1 GiB free".
  const r = largestContextBesideDs4({
    freeMemBytes: 15.1 * GIB, modelBytes: 4.68 * GIB, kvBytesPerToken: 128 * 1024,
    safetyBytes: 5 * GIB, desiredContext: 65536, minContext: 4096,
  });
  assert.equal(r.fits, true);
  assert.ok(r.context < 65536, 'must reduce the window');
  assert.ok(r.context >= 4096, `must stay usable, got ${r.context}`);
  assert.match(r.reason, /reduced/);
});

test('largestContextBesideDs4 refuses when even the floor will not fit', () => {
  const r = largestContextBesideDs4({
    freeMemBytes: 3 * GIB, modelBytes: 4.7 * GIB, kvBytesPerToken: 144 * 1024,
    safetyBytes: 1 * GIB, desiredContext: 65536, minContext: 4096,
  });
  assert.equal(r.fits, false);
  assert.equal(r.context, 0);
});

test('largestContextBesideDs4 never admits an unknown model size', () => {
  const r = largestContextBesideDs4({
    freeMemBytes: 40 * GIB, modelBytes: 0, kvBytesPerToken: 144 * 1024, desiredContext: 8192,
  });
  assert.equal(r.fits, false);
  assert.match(r.reason, /unknown/i);
});

// ── ds4ChatDeltaText / ds4ResponsesEventText (reasoning-as-progress) ───────

test('ds4ChatDeltaText: content-only delta returns the content', () => {
  assert.equal(ds4ChatDeltaText({ content: 'hi' }), 'hi');
});

test('ds4ChatDeltaText: a reasoning-only delta (ds4-server THINKING phase) is not dropped', () => {
  // ds4-server emits reasoning text as delta.reasoning_content and only sends
  // delta.content once thinking is done — see ds4_server.c sse_chat_delta_n
  // call sites ("reasoning_content" vs "content"). A generation stuck in
  // THINKING for minutes must still count as progress.
  assert.equal(ds4ChatDeltaText({ reasoning_content: 'thinking...' }), 'thinking...');
});

test('ds4ChatDeltaText: content wins when a delta somehow carries both', () => {
  assert.equal(ds4ChatDeltaText({ content: 'answer', reasoning_content: 'thought' }), 'answer');
});

test('ds4ChatDeltaText: a delta with neither field yields empty string', () => {
  assert.equal(ds4ChatDeltaText({ tool_calls: [] }), '');
  assert.equal(ds4ChatDeltaText(undefined), '');
});

test('ds4ResponsesEventText: an output_text delta is progress', () => {
  assert.equal(ds4ResponsesEventText({ type: 'response.output_text.delta', delta: 'hi' }), 'hi');
});

test('ds4ResponsesEventText: a reasoning_summary_text delta (THINKING phase) is progress too', () => {
  // ds4-server's Responses stream sends reasoning as its own event type —
  // response.reasoning_summary_text.delta — never folded into output_text.
  // See ds4_server.c responses_sse_reasoning_delta.
  assert.equal(ds4ResponsesEventText({ type: 'response.reasoning_summary_text.delta', delta: 'thinking...' }), 'thinking...');
});

test('ds4ResponsesEventText: an unrelated event type yields empty string', () => {
  assert.equal(ds4ResponsesEventText({ type: 'response.completed', delta: 'ignored' }), '');
});
