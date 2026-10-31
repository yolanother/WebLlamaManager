// Llama Manager — tests for operator per-model preset options (ctx-size, cache-ram).
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pins W2e (T3231898735806): config.modelPresetOptions lets an operator give one local
// model its own context window and host prompt-cache cap (llama.cpp --cache-ram, default
// ~8 GiB per resident model) without changing the router-wide defaults. Only those two
// keys are accepted, as positive integers (cache-ram also -1/0, llama.cpp's "no limit" and
// "off"). Operator options override a generated section's value and never drop its other keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeModelPresetOptions, applyModelPresetOptions, modelContextOverride, wantsPresetContextMode,
} from './model-preset-options.js';

test('normalize keeps ctx-size and cache-ram as strings, drops everything else with a warning', () => {
  const { options, warnings } = normalizeModelPresetOptions({
    'unsloth_Qwen3.6-35B-A3B-GGUF': { 'ctx-size': 32768, 'cache-ram': '2048', 'model': '/etc/passwd' },
    'Qwen_Qwen3-8B-GGUF': { 'cache-ram': 0 },
    bad: { 'ctx-size': -5 },
    worse: 'nope',
  });
  assert.deepEqual(options, {
    'unsloth_Qwen3.6-35B-A3B-GGUF': { 'ctx-size': '32768', 'cache-ram': '2048' },
    'Qwen_Qwen3-8B-GGUF': { 'cache-ram': '0' },
  });
  assert.equal(warnings.length, 3, warnings.join(' | '));
  assert.deepEqual(normalizeModelPresetOptions(undefined), { options: {}, warnings: [] });
});

test('apply merges into an existing section (operator wins) and appends missing models', () => {
  const sections = [{ name: 'unsloth_Qwen3.6-35B-A3B-GGUF', options: { threads: '16', 'ctx-size': '262144' } }];
  const out = applyModelPresetOptions(sections, {
    'unsloth_Qwen3.6-35B-A3B-GGUF': { 'ctx-size': '32768' },
    'Qwen_Qwen3-8B-GGUF': { 'cache-ram': '2048' },
  });
  assert.deepEqual(out, [
    { name: 'unsloth_Qwen3.6-35B-A3B-GGUF', options: { threads: '16', 'ctx-size': '32768' } },
    { name: 'Qwen_Qwen3-8B-GGUF', options: { 'cache-ram': '2048' } },
  ]);
  assert.equal(applyModelPresetOptions(sections, {}), sections);
});

test('context override is per model; preset context mode only when one is set', () => {
  const options = { a: { 'ctx-size': '32768' }, b: { 'cache-ram': '1024' } };
  assert.equal(modelContextOverride(options, 'a'), 32768);
  assert.equal(modelContextOverride(options, 'b'), null);
  assert.equal(modelContextOverride(options, 'c'), null);
  assert.equal(wantsPresetContextMode(options), true);
  assert.equal(wantsPresetContextMode({ b: { 'cache-ram': '1024' } }), false);
});

test('server.js: the preset INI, context mode and admission all use the operator options', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const writer = source.slice(source.indexOf('function writeModelsPresetFile('), source.indexOf('function writeModelsPresetFile(') + 4000);
  assert.match(writer, /applyModelPresetOptions\(/);
  const mode = source.slice(source.indexOf('function resolveContextMode('), source.indexOf('function resolveContextMode(') + 300);
  assert.match(mode, /wantsPresetContextMode\(/);
  const guard = source.slice(source.indexOf('async function preflightModelGuard('), source.indexOf('async function preflightModelGuard(') + 2500);
  assert.match(guard, /modelContextOverride\(/);
  assert.match(guard, /modelAdmissionKnobs\(/);
});
