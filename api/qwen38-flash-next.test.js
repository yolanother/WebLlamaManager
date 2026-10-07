// Llama Manager — Flash-Next weight availability and router preset contracts.
// Copyright (c) Llama Manager project. The LICENSE file in the repo root governs use.
// Verifies complete split-weight selection, IQ4 preference with legacy fallback,
// and matching canonical and bounded podcast routes without changing their
// context windows, CPU expert placement, mmap, lazy loading, or thread settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as engines from './engines.js';

const modelsDir = '/volumes/models';
const modelId = 'unsloth_Qwen3.8-Flash-Next-GGUF';
const iq4 = [1, 2, 3].map(part => join(modelsDir, modelId,
  `Qwen3.8-Flash-Next-UD-IQ4_XS-0000${part}-of-00003.gguf`));
const legacy = [1, 2, 3].map(part => join(modelsDir, modelId,
  `Qwen3.8-Flash-Next-UD-IQ3_XXS-0000${part}-of-00003.gguf`));

const availabilityCases = [
  { name: 'a complete IQ4 set makes the planner available', files: iq4, expected: iq4[0] },
  { name: 'a complete legacy set remains available', files: legacy, expected: legacy[0] },
  { name: 'IQ4 wins when both quantizations are complete', files: [...legacy, ...iq4], expected: iq4[0] },
  { name: 'an empty model directory has no available planner', files: [], expected: null },
];
for (const [quantization, shards] of [['IQ4', iq4], ['legacy', legacy]]) {
  availabilityCases.push({
    name: `${quantization} first shard alone does not publish a planner`,
    files: [shards[0]], expected: null,
  });
  for (let missing = 0; missing < shards.length; missing += 1) {
    availabilityCases.push({
      name: `${quantization} missing shard ${missing + 1} does not publish a planner`,
      files: shards.filter((_, index) => index !== missing), expected: null,
    });
  }
}
for (let missing = 0; missing < iq4.length; missing += 1) {
  availabilityCases.push({
    name: `a complete legacy set remains usable while IQ4 shard ${missing + 1} is missing`,
    files: [...legacy, ...iq4.filter((_, index) => index !== missing)], expected: legacy[0],
  });
}

for (const { name, files, expected } of availabilityCases) {
  test(`Flash-Next availability: ${name}`, () => {
    const installed = new Set(files);
    assert.equal(typeof engines.selectQwen38FlashNextWeights, 'function',
      'the public weight selector must report the available first shard');
    assert.equal(engines.selectQwen38FlashNextWeights({
      modelsDir,
      fileExists: path => installed.has(path),
    }), expected);
  });
}

const routes = [
  { name: 'canonical', preset: engines.qwen38FlashNextPresetSection, id: modelId, context: '262144' },
  { name: 'podcast', preset: engines.podcastQwen38PresetSection, id: 'podcast-qwen3.8-16k', context: '16384' },
];

for (const route of routes) {
  for (const [quantization, weightsPath] of [['IQ4', iq4[0]], ['legacy', legacy[0]]]) {
    test(`Flash-Next ${route.name} route uses the selected ${quantization} first shard`, () => {
      const section = route.preset({ modelsDir, weightsExist: true, weightsPath, threads: 16 });
      assert.equal(section?.name, route.id);
      assert.equal(section.options.model, weightsPath);
    });

    for (const threads of [6, 16]) {
      test(`Flash-Next ${route.name} ${quantization} route retains settings at ${threads} physical cores`, () => {
        const section = route.preset({ modelsDir, weightsExist: true, weightsPath, threads });
        assert.equal(section?.name, route.id);
        assert.equal(section.options['ctx-size'], route.context);
        assert.equal(section.options['load-mode'], 'mmap');
        assert.equal(section.options['lazy-mode'], 'on');
        assert.equal(section.options['cpu-moe'], '1');
        assert.equal(section.options.threads, String(threads));
        assert.equal(section.options.fit, 'off');
        assert.equal(section.options.parallel, '1');
        assert.equal(section.options['no-mmap'], undefined);
        assert.equal(section.options.mtp, undefined);
        assert.equal(section.options['model-draft'], undefined);
        assert.equal(section.options['spec-type'], undefined);
      });
    }
  }

  test(`Flash-Next ${route.name} route is omitted when no complete weight set was selected`, () => {
    assert.equal(route.preset({ modelsDir, weightsExist: true, weightsPath: null, threads: 16 }), null);
  });

  test(`Flash-Next ${route.name} route preserves callers that omit the selected weight path`, () => {
    const section = route.preset({ modelsDir, weightsExist: true, threads: 16 });
    assert.equal(section?.name, route.id);
    assert.equal(section.options['ctx-size'], route.context);
    if (route.name === 'podcast') assert.equal(section.options.model, legacy[0]);
    assert.equal(route.preset({ modelsDir, weightsExist: false, threads: 16 }), null);
  });
}
