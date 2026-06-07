// Llama Manager — unit tests for api/embeddings.js (pure embedding helpers).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEmbedConfig, embedTargetUrl, estimateEmbedTokens, buildEmbedLogEntry
} from './embeddings.js';

test('resolveEmbedConfig: defaults when nothing set', () => {
  const c = resolveEmbedConfig({}, {});
  assert.equal(c.port, 5252);
  assert.equal(c.gpuLayers, 99);
  assert.equal(c.ctxSize, 0);
  assert.equal(c.enabled, false);   // disabled until a model is selected
  assert.equal(c.model, '');
});

test('resolveEmbedConfig: config block honored', () => {
  const c = resolveEmbedConfig({ embed: { enabled: true, model: 'm.gguf', port: 5999, gpuLayers: 0, ctxSize: 2048 } }, {});
  assert.equal(c.enabled, true);
  assert.equal(c.model, 'm.gguf');
  assert.equal(c.port, 5999);
  assert.equal(c.gpuLayers, 0);
  assert.equal(c.ctxSize, 2048);
});

test('resolveEmbedConfig: env overrides config', () => {
  const c = resolveEmbedConfig(
    { embed: { enabled: false, model: 'a.gguf', port: 5252 } },
    { EMBED_ENABLED: 'true', EMBED_MODEL: 'b.gguf', EMBED_PORT: '6000', EMBED_GPU_LAYERS: '10', EMBED_CTX: '512' }
  );
  assert.equal(c.enabled, true);
  assert.equal(c.model, 'b.gguf');
  assert.equal(c.port, 6000);
  assert.equal(c.gpuLayers, 10);
  assert.equal(c.ctxSize, 512);
});

test('resolveEmbedConfig: enabled true but empty model => effectively not runnable', () => {
  const c = resolveEmbedConfig({ embed: { enabled: true, model: '' } }, {});
  assert.equal(c.runnable, false);  // enabled but no model
});

test('embedTargetUrl builds localhost url', () => {
  assert.equal(embedTargetUrl(5252), 'http://localhost:5252/v1/embeddings');
});

test('estimateEmbedTokens: string and array', () => {
  assert.equal(estimateEmbedTokens('one two three'), 3);
  assert.equal(estimateEmbedTokens(['a b', 'c d e']), 5);
  assert.equal(estimateEmbedTokens(''), 0);
  assert.equal(estimateEmbedTokens(undefined), 0);
});

test('buildEmbedLogEntry: success with usage', () => {
  const e = buildEmbedLogEntry({
    reqBody: { model: 'qwen-embed', input: ['hello', 'world'] },
    usage: { prompt_tokens: 4 }, status: 200, durationMs: 12, backend: 'local'
  });
  assert.equal(e.endpoint, 'embeddings');
  assert.equal(e.model, 'qwen-embed');
  assert.equal(e.status, 200);
  assert.equal(e.duration, 12);
  assert.equal(e.promptTokens, 4);
  assert.equal(e.completionTokens, 0);
  assert.equal(e.backend, 'local');
  assert.equal(e.error, null);
});

test('buildEmbedLogEntry: error path, token estimate fallback', () => {
  const e = buildEmbedLogEntry({
    reqBody: { model: 'qwen-embed', input: 'a b c' },
    usage: null, status: 502, durationMs: 5, backend: 'local', error: 'boom'
  });
  assert.equal(e.status, 502);
  assert.equal(e.error, 'boom');
  assert.equal(e.promptTokens, 3);   // estimated from input
});
