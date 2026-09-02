// Llama Manager — model family grouping tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Covers family derivation from real model names served by this project, the
// fidelity ranking that picks a family's default member, and the grouping that
// the picker renders. No browser dependency.

import test from 'node:test';
import assert from 'node:assert/strict';

import { modelFamily, modelQuality, groupModelsByFamily } from './modelFamilies.js';

test('derives the family by cutting at the quantization marker', () => {
  assert.equal(modelFamily('Qwen3-8B-Q4_K_M'), 'Qwen3-8B');
  assert.equal(modelFamily('Qwen3-8B-Q8_0'), 'Qwen3-8B');
  assert.equal(modelFamily('Qwen3-Coder-Next-UD-Q4_K_XL'), 'Qwen3-Coder-Next');
});

test('keeps distinct models in distinct families', () => {
  assert.notEqual(modelFamily('Qwen3-8B-Q4_K_M'), modelFamily('Qwen3-Coder-Next-UD-Q4_K_XL'));
});

test('strips the extension and the split-part suffix', () => {
  // Without this a 4-file split model becomes four one-member families.
  assert.equal(modelFamily('DeepSeek-V4-Flash-IQ2XXS-w2Q2K-00001-of-00004.gguf'), 'DeepSeek-V4-Flash');
  assert.equal(modelFamily('DeepSeek-V4-Flash-IQ2XXS-w2Q2K-00002-of-00004.gguf'), 'DeepSeek-V4-Flash');
});

test('handles the real DS4 filename', () => {
  assert.equal(
    modelFamily('DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf'),
    'DeepSeek-V4-Flash',
  );
});

test('a name with no quantization marker is its own family', () => {
  assert.equal(modelFamily('default-small'), 'default-small');
  assert.equal(modelFamily('auto'), 'auto');
});

test('ranks higher bit widths above lower ones', () => {
  assert.ok(modelQuality('Qwen3-8B-Q8_0') > modelQuality('Qwen3-8B-Q4_K_M'));
  assert.ok(modelQuality('m-F16') > modelQuality('m-Q8_0'));
  assert.ok(modelQuality('m-Q4_K_M') > modelQuality('m-IQ2_XXS'));
});

test('ranks variants within one bit width', () => {
  assert.ok(modelQuality('m-Q4_K_XL') > modelQuality('m-Q4_K_M'));
  assert.ok(modelQuality('m-Q4_K_M') > modelQuality('m-Q4_K_S'));
});

test('an unreadable quantization scores zero rather than throwing', () => {
  assert.equal(modelQuality('mystery-model'), 0);
  assert.equal(modelQuality(''), 0);
  assert.equal(modelQuality(undefined), 0);
});

test('groups a mixed list into families with the best member as default', () => {
  const groups = groupModelsByFamily([
    { id: 'Qwen3-8B-Q4_K_M' },
    { id: 'Qwen3-8B-Q8_0' },
    { id: 'Qwen3-Coder-Next-UD-Q4_K_XL' },
  ]);
  assert.equal(groups.length, 2);
  const qwen8b = groups.find((g) => g.family === 'Qwen3-8B');
  assert.equal(qwen8b.best.id, 'Qwen3-8B-Q8_0', 'Q8 outranks Q4');
  assert.equal(qwen8b.members.length, 2);
  assert.equal(qwen8b.members[0].id, 'Qwen3-8B-Q8_0', 'members are best-first');
});

test('family order follows first appearance in the input', () => {
  const groups = groupModelsByFamily([
    { id: 'auto' },
    { id: 'Zebra-7B-Q4_K_M' },
    { id: 'Alpha-7B-Q4_K_M' },
  ]);
  assert.deepEqual(groups.map((g) => g.family), ['auto', 'Zebra-7B', 'Alpha-7B']);
});

test('ignores empty entries instead of creating a blank family', () => {
  const groups = groupModelsByFamily([{ id: 'Qwen3-8B-Q4_K_M' }, null, { id: '' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].family, 'Qwen3-8B');
});

test('an empty list groups to nothing', () => {
  assert.deepEqual(groupModelsByFamily([]), []);
  assert.deepEqual(groupModelsByFamily(), []);
});
