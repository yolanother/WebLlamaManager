// Llama Manager — unit tests for api/default-models.js (default-big/default-small aliases).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIG_ALIAS, SMALL_ALIAS, resolveDefaultModel, defaultModelListEntries
} from './default-models.js';

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
