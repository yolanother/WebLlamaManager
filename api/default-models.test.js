// Llama Manager — unit tests for api/default-models.js (default-big/default-small aliases).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIG_ALIAS, SMALL_ALIAS, resolveDefaultModel, defaultModelListEntries,
  ds4PresetForModel, validateDefaultModelTarget
} from './default-models.js';

// A config whose presets map holds one ds4 preset and one llama preset, used to
// exercise the ds4-aware default-model helpers below.
const cfgWithDs4 = {
  defaultBigModel: 'ds4-flash',
  defaultSmallModel: 'qwen-1.5b',
  presets: {
    'ds4-flash': { id: 'ds4-flash', name: 'DeepSeek V4 Flash', engine: 'ds4', modelPath: 'dsv4.gguf' },
    'gpt-oss': { id: 'gpt-oss', name: 'GPT-OSS 120B' }, // llama (no engine field)
  },
};

test('alias name constants', () => {
  assert.equal(BIG_ALIAS, 'default-big');
  assert.equal(SMALL_ALIAS, 'default-small');
});

test('resolveDefaultModel: default-big resolves to configured big target', () => {
  const cfg = { defaultBigModel: 'qwen-32b', defaultSmallModel: 'qwen-1.5b' };
  assert.equal(resolveDefaultModel('default-big', cfg), 'qwen-32b');
});

test('resolveDefaultModel: default-small resolves to configured small target', () => {
  const cfg = { defaultBigModel: 'qwen-32b', defaultSmallModel: 'qwen-1.5b' };
  assert.equal(resolveDefaultModel('default-small', cfg), 'qwen-1.5b');
});

test('resolveDefaultModel: unset target passes the alias through unchanged', () => {
  assert.equal(resolveDefaultModel('default-big', { defaultBigModel: null }), 'default-big');
  assert.equal(resolveDefaultModel('default-small', {}), 'default-small');
  assert.equal(resolveDefaultModel('default-big', { defaultBigModel: '' }), 'default-big');
  assert.equal(resolveDefaultModel('default-big', { defaultBigModel: '   ' }), 'default-big');
});

test('resolveDefaultModel: non-alias model names pass through untouched', () => {
  const cfg = { defaultBigModel: 'qwen-32b', defaultSmallModel: 'qwen-1.5b' };
  assert.equal(resolveDefaultModel('gpt-oss-120b', cfg), 'gpt-oss-120b');
  assert.equal(resolveDefaultModel('default', cfg), 'default');
  assert.equal(resolveDefaultModel('unknown', cfg), 'unknown');
});

test('resolveDefaultModel: exact, case-sensitive match only', () => {
  const cfg = { defaultBigModel: 'qwen-32b' };
  assert.equal(resolveDefaultModel('Default-Big', cfg), 'Default-Big');
  assert.equal(resolveDefaultModel('default-big ', cfg), 'default-big ');
});

test('resolveDefaultModel: tolerates missing/odd config and input', () => {
  assert.equal(resolveDefaultModel('default-big', null), 'default-big');
  assert.equal(resolveDefaultModel('default-big', undefined), 'default-big');
  assert.equal(resolveDefaultModel(undefined, { defaultBigModel: 'x' }), undefined);
});

test('resolveDefaultModel: trims surrounding whitespace on the resolved target', () => {
  assert.equal(resolveDefaultModel('default-big', { defaultBigModel: '  qwen-32b  ' }), 'qwen-32b');
});

test('defaultModelListEntries: one entry per configured alias', () => {
  const entries = defaultModelListEntries({ defaultBigModel: 'qwen-32b', defaultSmallModel: 'qwen-1.5b' }, 1000);
  assert.equal(entries.length, 2);
  const big = entries.find(e => e.id === 'default-big');
  const small = entries.find(e => e.id === 'default-small');
  assert.ok(big && small);
  assert.equal(big.object, 'model');
  assert.equal(big.created, 1000);
  assert.equal(big.status, 'alias');
  assert.equal(big.aliasTarget, 'qwen-32b');
  assert.equal(small.aliasTarget, 'qwen-1.5b');
});

test('defaultModelListEntries: omits aliases whose target is unset', () => {
  assert.deepEqual(defaultModelListEntries({}, 1000), []);
  assert.deepEqual(defaultModelListEntries({ defaultBigModel: '', defaultSmallModel: null }, 1000), []);
  const onlyBig = defaultModelListEntries({ defaultBigModel: 'qwen-32b' }, 1000);
  assert.equal(onlyBig.length, 1);
  assert.equal(onlyBig[0].id, 'default-big');
});

test('defaultModelListEntries: tolerates null config', () => {
  assert.deepEqual(defaultModelListEntries(null, 1000), []);
});

// ── ds4-backed default-big ────────────────────────────────────────────────────

test('resolveDefaultModel: default-big resolves to a ds4 preset id', () => {
  // The ds4 model's OpenAI id IS its preset id, so a ds4-backed default-big just
  // resolves to that preset id like any other target string.
  assert.equal(resolveDefaultModel('default-big', cfgWithDs4), 'ds4-flash');
});

test('ds4PresetForModel: returns preset ref when the name is a ds4 preset id', () => {
  const ref = ds4PresetForModel(cfgWithDs4, 'ds4-flash');
  assert.ok(ref);
  assert.equal(ref.presetId, 'ds4-flash');
  assert.equal(ref.preset.engine, 'ds4');
});

test('ds4PresetForModel: null for llama presets, unknown names, and odd input', () => {
  assert.equal(ds4PresetForModel(cfgWithDs4, 'gpt-oss'), null);   // existing llama preset
  assert.equal(ds4PresetForModel(cfgWithDs4, 'qwen-32b'), null);  // plain model name (no preset)
  assert.equal(ds4PresetForModel(cfgWithDs4, undefined), null);
  assert.equal(ds4PresetForModel(null, 'ds4-flash'), null);
  assert.equal(ds4PresetForModel({}, 'ds4-flash'), null);
});

test('validateDefaultModelTarget: accepts a ds4 preset id', () => {
  const r = validateDefaultModelTarget(cfgWithDs4, 'ds4-flash');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'ds4-flash');
  assert.equal(r.engine, 'ds4');
  assert.equal(r.presetId, 'ds4-flash');
});

test('validateDefaultModelTarget: accepts a plain (llama) model name unchanged', () => {
  // Backward compat: a not-yet-loaded model name is accepted, matching direct
  // requests to such a model. No preset lookup match → treated as a llama model.
  const r = validateDefaultModelTarget(cfgWithDs4, '  qwen-32b  ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'qwen-32b');
  assert.equal(r.engine, 'llama');
});

test('validateDefaultModelTarget: null/blank clears the target', () => {
  assert.deepEqual(validateDefaultModelTarget(cfgWithDs4, null), { ok: true, value: null });
  assert.deepEqual(validateDefaultModelTarget(cfgWithDs4, ''), { ok: true, value: null });
  assert.deepEqual(validateDefaultModelTarget(cfgWithDs4, '   '), { ok: true, value: null });
});

test('validateDefaultModelTarget: rejects a non-string target', () => {
  const r = validateDefaultModelTarget(cfgWithDs4, 42);
  assert.equal(r.ok, false);
  assert.match(r.error, /string or null/);
});

test('validateDefaultModelTarget: rejects a target that names a non-ds4 (llama) preset', () => {
  // A llama preset id is not a valid default-model target: default-big maps to a
  // model NAME or a ds4 preset id, never a llama preset id.
  const r = validateDefaultModelTarget(cfgWithDs4, 'gpt-oss');
  assert.equal(r.ok, false);
  assert.match(r.error, /llama preset/);
});

test('defaultModelListEntries: annotates a ds4-backed default target with engine', () => {
  const entries = defaultModelListEntries(cfgWithDs4, 1000);
  const big = entries.find(e => e.id === 'default-big');
  const small = entries.find(e => e.id === 'default-small');
  assert.equal(big.aliasTarget, 'ds4-flash');
  assert.equal(big.engine, 'ds4');       // ds4-backed
  assert.equal(small.aliasTarget, 'qwen-1.5b');
  assert.equal(small.engine, 'llama');   // plain model name
});
