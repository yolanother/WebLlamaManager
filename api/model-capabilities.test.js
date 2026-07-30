// Llama Manager — tests for GGUF-backed per-model multimodal capability metadata.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests verify that projector metadata is parsed from real and synthetic
// GGUF headers, cached beside model files, translated into API modalities, and
// consumed by the server's catalog and multimodal token-accounting surfaces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addModelCapabilityMetadata,
  createModelCapabilityResolver,
  modalitiesForCapabilities,
  parseGgufCapabilities,
} from './model-capabilities.js';

const GEMMA_4_PROJECTORS = [
  '/home/yolan/models/google_gemma-4-12B-it-qat-q4_0-gguf/mmproj-gemma-4-12b-it-qat-q4_0.gguf',
  '/home/yolan/models/google_gemma-4-E2B-it-qat-q4_0-gguf/gemma-4-E2B-it-mmproj-F16.gguf',
];

/**
 * Encode a small GGUF v3 header containing boolean metadata for resolver tests.
 *
 * @param {Array<[string, boolean]>} entries key/value metadata entries.
 * @returns {Buffer} complete metadata-only GGUF fixture.
 */
function booleanGguf(entries) {
  const u32 = value => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const u64 = value => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  const string = value => {
    const bytes = Buffer.from(value);
    return Buffer.concat([u64(bytes.length), bytes]);
  };
  return Buffer.concat([
    Buffer.from('GGUF'), u32(3), u64(0), u64(entries.length),
    ...entries.flatMap(([key, value]) => [string(key), u32(7), Buffer.from([value ? 1 : 0])]),
  ]);
}

test('parseGgufCapabilities reads vision and audio flags from both Gemma-4 projectors', () => {
  for (const projectorPath of GEMMA_4_PROJECTORS) {
    assert.deepEqual(parseGgufCapabilities(projectorPath), { vision: true, audio: true });
  }
});

test('model capability resolver locates an mmproj beside a relative model path', (t) => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'llama-capabilities-'));
  t.after(() => rmSync(modelsDir, { recursive: true, force: true }));
  const modelDir = join(modelsDir, 'gemma-4');
  mkdirSync(modelDir);
  writeFileSync(join(modelDir, 'gemma-4-q4.gguf'), Buffer.alloc(0));
  writeFileSync(join(modelDir, 'gemma-4-mmproj-f16.gguf'), booleanGguf([
    ['clip.has_vision_encoder', true],
    ['clip.has_audio_encoder', true],
  ]));

  const resolveCapabilities = createModelCapabilityResolver(modelsDir);
  assert.deepEqual(resolveCapabilities('gemma-4/gemma-4-q4.gguf'), {
    vision: true,
    audio: true,
    source: 'mmproj',
  });
});

test('model capability resolver caches projector parsing by model directory', (t) => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'llama-capabilities-cache-'));
  t.after(() => rmSync(modelsDir, { recursive: true, force: true }));
  const modelDir = join(modelsDir, 'shared');
  mkdirSync(modelDir);
  writeFileSync(join(modelDir, 'shared.gguf'), Buffer.alloc(0));
  writeFileSync(join(modelDir, 'mmproj-shared.gguf'), booleanGguf([]));
  let parseCalls = 0;
  const resolveCapabilities = createModelCapabilityResolver(modelsDir, {
    parse: () => {
      parseCalls += 1;
      return { vision: true, audio: false };
    },
  });

  resolveCapabilities('shared/shared.gguf');
  resolveCapabilities('shared/shared.gguf');
  assert.equal(parseCalls, 1);
});

test('a shared-directory projector does not grant capabilities to an unrelated model', (t) => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'llama-capabilities-shared-'));
  t.after(() => rmSync(modelsDir, { recursive: true, force: true }));
  writeFileSync(join(modelsDir, 'vision-model.gguf'), Buffer.alloc(0));
  writeFileSync(join(modelsDir, 'text-only.gguf'), Buffer.alloc(0));
  writeFileSync(join(modelsDir, 'mmproj-vision-model.gguf'), booleanGguf([
    ['clip.has_vision_encoder', true],
    ['clip.has_audio_encoder', true],
  ]));

  const resolveCapabilities = createModelCapabilityResolver(modelsDir);
  assert.deepEqual(resolveCapabilities('vision-model.gguf'), {
    vision: true, audio: true, source: 'mmproj',
  });
  assert.deepEqual(resolveCapabilities('text-only.gguf'), {
    vision: false, audio: false, source: 'none',
  });
});

test('modalitiesForCapabilities exposes text plus detected projector encoders', () => {
  assert.deepEqual(modalitiesForCapabilities({ vision: false, audio: false }), ['text']);
  assert.deepEqual(modalitiesForCapabilities({ vision: true, audio: false }), ['text', 'image']);
  assert.deepEqual(modalitiesForCapabilities({ vision: true, audio: true }), ['text', 'image', 'audio']);
});

test('addModelCapabilityMetadata decorates model entries and resolves aliases through their targets', () => {
  const byId = new Map([
    ['gemma-4.gguf', { vision: true, audio: true, source: 'mmproj' }],
    ['text.gguf', { vision: false, audio: false, source: 'none' }],
  ]);
  const entries = addModelCapabilityMetadata([
    { id: 'gemma-4.gguf' },
    { id: 'default-big', aliasTarget: 'gemma-4.gguf' },
    { id: 'text.gguf' },
  ], model => byId.get(model.aliasTarget || model.id));

  assert.deepEqual(entries.map(({ id, modalities, capabilitySource }) => ({
    id, modalities, capabilitySource,
  })), [
    { id: 'gemma-4.gguf', modalities: ['text', 'image', 'audio'], capabilitySource: 'mmproj' },
    { id: 'default-big', modalities: ['text', 'image', 'audio'], capabilitySource: 'mmproj' },
    { id: 'text.gguf', modalities: ['text'], capabilitySource: 'none' },
  ]);
});

test('addModelCapabilityMetadata maps a bare live-router id to its scanned local path', () => {
  let resolvedRecord;
  addModelCapabilityMetadata(
    [{ id: 'gemma-4-q4.gguf' }],
    model => {
      resolvedRecord = model;
      return { vision: true, audio: true, source: 'mmproj' };
    },
    [{ name: 'gemma-4/gemma-4-q4.gguf', path: '/models/gemma-4/gemma-4-q4.gguf' }],
  );
  assert.equal(resolvedRecord.path, '/models/gemma-4/gemma-4-q4.gguf');
});

test('/v1/models wires the cached capability resolver into DS4 and llama catalogs', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*addModelCapabilityMetadata[^}]*createModelCapabilityResolver[^}]*\} from '\.\/model-capabilities\.js';/s);
  assert.match(source, /const resolveModelCapabilities = createModelCapabilityResolver\(MODELS_DIR\);/);

  const handler = source.slice(
    source.indexOf('async function handleModels'),
    source.indexOf("app.get('/api/v1/models'"),
  );
  assert.equal((handler.match(/addModelCapabilityMetadata\(/g) || []).length, 2);
});

test('server token accounting charges named image and per-second audio estimates', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const estimateStart = source.indexOf('const IMAGE_INPUT_TOKEN_ESTIMATE');
  const estimateEnd = source.indexOf('// Estimate how long a request will take locally', estimateStart);
  assert.notEqual(estimateStart, -1, 'named multimodal token constants must precede the estimator');
  assert.notEqual(estimateEnd, -1, 'token estimator block must remain independently testable');

  const loadEstimator = new Function(`${source.slice(estimateStart, estimateEnd)}\nreturn { estimateInputTokens, IMAGE_INPUT_TOKEN_ESTIMATE, AUDIO_INPUT_TOKENS_PER_SECOND };`);
  const {
    estimateInputTokens,
    IMAGE_INPUT_TOKEN_ESTIMATE,
    AUDIO_INPUT_TOKENS_PER_SECOND,
  } = loadEstimator();
  const oneSecondNormalizedAudio = Buffer.alloc(32_000).toString('base64');

  assert.equal(estimateInputTokens({ messages: [{ role: 'user', content: 'abcd' }] }), 1);
  assert.equal(estimateInputTokens({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'abcd' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] }],
  }), 1 + IMAGE_INPUT_TOKEN_ESTIMATE);
  assert.equal(estimateInputTokens({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'abcd' },
      { type: 'input_audio', input_audio: { data: oneSecondNormalizedAudio, format: 'wav' } },
    ] }],
  }), 1 + AUDIO_INPUT_TOKENS_PER_SECOND);
});
