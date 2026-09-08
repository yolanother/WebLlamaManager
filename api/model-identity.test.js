// Llama Manager — unit tests for api/model-identity.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelKey, modelDirectoryKey } from './model-identity.js';

test('the router id and the on-disk filename are the same model', () => {
  // The exact bug this exists for: /api/v1/models merges the running router's
  // models with the GGUFs found on disk, deduping on a normalized key. The
  // router reports "Qwen3-8B-Q4_K_M" while the file is
  // "Qwen3-8B-Q4_K_M.gguf", so a normalizer that keeps the extension produced
  // "qwen38bq4km" vs "qwen38bq4kmgguf", the dedupe missed, and the chat model
  // picker listed the same model twice.
  assert.equal(
    normalizeModelKey('Qwen3-8B-Q4_K_M.gguf'),
    normalizeModelKey('Qwen3-8B-Q4_K_M'),
  );
});

test('normalization ignores case and punctuation', () => {
  assert.equal(normalizeModelKey('Qwen3-8B-Q4_K_M'), normalizeModelKey('qwen3_8b.q4-k-m'));
});

test('a split-part suffix is NOT collapsed into the whole model', () => {
  // Split parts are separate files the router handles specially; treating a
  // part as identical to the base model would hide it from the list.
  assert.notEqual(
    normalizeModelKey('big-model-00001-of-00004.gguf'),
    normalizeModelKey('big-model.gguf'),
  );
});

test('genuinely different models stay distinct', () => {
  assert.notEqual(normalizeModelKey('Qwen3-8B-Q4_K_M'), normalizeModelKey('Qwen3-14B-Q4_K_M'));
  assert.notEqual(normalizeModelKey('llama-3-8b'), normalizeModelKey('llama-3-70b'));
});

test('only a trailing model extension is stripped, not one in the middle', () => {
  // "gguf" appearing inside a name is part of the name, not an extension.
  assert.notEqual(normalizeModelKey('gguf-tuned-model'), normalizeModelKey('tuned-model'));
});

test('empty and non-string inputs normalize to an empty key rather than throwing', () => {
  assert.equal(normalizeModelKey(''), '');
  assert.equal(normalizeModelKey(null), '');
  assert.equal(normalizeModelKey(undefined), '');
});

// The router serves a repo DIRECTORY as one model id ('unsloth_Muse-Glimmer-30B-GGUF').
// The disk scan reports the file inside it ('unsloth_Muse-Glimmer-30B-GGUF/Muse-...gguf').
// Those are the same model, but normalizeModelKey cannot collapse them because the path
// form normalises to directory+file. So every model was listed TWICE on /v1/models, once
// servable and once not, and selecting the path form returned
// "model '<dir>/<file>.gguf' not found" - which is what an operator hit for two models.
test('modelDirectoryKey collapses a repo path onto the directory the router serves', () => {
  assert.equal(
    modelDirectoryKey('unsloth_Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-UD-Q4_K_XL.gguf'),
    normalizeModelKey('unsloth_Muse-Glimmer-30B-GGUF'),
  );
  assert.equal(
    modelDirectoryKey('unsloth_Qwen3.8-Flash-Next-GGUF/Qwen3.8-Flash-Next-UD-IQ3_XXS.gguf'),
    normalizeModelKey('unsloth_Qwen3.8-Flash-Next-GGUF'),
  );
});

test('modelDirectoryKey returns null for a bare model name', () => {
  assert.equal(modelDirectoryKey('Qwen3-8B-Q4_K_M'), null);
  assert.equal(modelDirectoryKey('Qwen3-8B-Q4_K_M.gguf'), null);
});

test('modelDirectoryKey tolerates junk without throwing', () => {
  for (const v of [null, undefined, '', 42, {}, '/', 'a/']) {
    assert.doesNotThrow(() => modelDirectoryKey(v));
  }
});

test('nested paths key on the top-level repo directory', () => {
  assert.equal(modelDirectoryKey('repo/sub/file.gguf'), normalizeModelKey('repo'));
});
