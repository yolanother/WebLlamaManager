// Llama Manager — fleet-wide model presence tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the view Phase 4 puts on the main node's screen: a model is not
// present or absent, it has a presence PER NODE, and the operator acts on the
// fleet rather than on a box. These tests pin the parts that decide whether that
// screen tells the truth — that a node which could not be reached is reported as
// unknown rather than as missing a model, and that asking to pull a model onto
// "everything" never silently skips a node or targets one twice.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modelKey,
  mergeFleetModels,
  resolveTargets,
} from './fleet-models.js';

// ── Identifying a model ─────────────────────────────────────────────────────

test('a model entry is keyed the same however a node spells it', () => {
  assert.equal(modelKey('qwen3-8b'), 'qwen3-8b');
  assert.equal(modelKey({ id: 'qwen3-8b' }), 'qwen3-8b');
  assert.equal(modelKey({ name: 'qwen3-8b' }), 'qwen3-8b');
  assert.equal(modelKey({ model: 'qwen3-8b' }), 'qwen3-8b');
});

test('an unusable model entry is ignored rather than keyed as empty', () => {
  // An entry keyed "" would collapse every unreadable model into one row that
  // claims to be present everywhere.
  assert.equal(modelKey(null), null);
  assert.equal(modelKey({}), null);
  assert.equal(modelKey(''), null);
  assert.equal(modelKey(42), null);
});

// ── Presence across the fleet ───────────────────────────────────────────────

test('a model present on one node is reported missing from the other', () => {
  const merged = mergeFleetModels([
    { id: 'aaaa', models: ['qwen3-8b'] },
    { id: 'bbbb', models: [] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].presentOn, ['aaaa']);
  assert.deepEqual(merged[0].missingFrom, ['bbbb']);
});

test('a model on every node is missing from none', () => {
  const merged = mergeFleetModels([
    { id: 'aaaa', models: [{ id: 'qwen3-8b' }] },
    { id: 'bbbb', models: [{ name: 'qwen3-8b' }] },
  ]);
  assert.deepEqual(merged[0].presentOn, ['aaaa', 'bbbb']);
  assert.deepEqual(merged[0].missingFrom, []);
});

test('an unreachable node is unknown, never "missing the model"', () => {
  // The distinction the screen lives or dies on. A node that did not answer has
  // not told us it lacks anything, and showing it as missing would invite the
  // operator to start a redundant multi-gigabyte download onto a box that
  // already has the file.
  const merged = mergeFleetModels([
    { id: 'aaaa', models: ['qwen3-8b'] },
    { id: 'bbbb', reachable: false },
  ]);
  assert.deepEqual(merged[0].presentOn, ['aaaa']);
  assert.deepEqual(merged[0].missingFrom, []);
  assert.deepEqual(merged[0].unknownOn, ['bbbb']);
});

test('models are listed once each, however many nodes hold them', () => {
  const merged = mergeFleetModels([
    { id: 'aaaa', models: ['a', 'b'] },
    { id: 'bbbb', models: ['b', 'c'] },
  ]);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
});

test('a node downloading a model reports it as in flight, not as present', () => {
  // A half-downloaded model is not a model. Counting it as present is how an
  // operator ends up routing work to a node that cannot serve it yet.
  const merged = mergeFleetModels([
    { id: 'aaaa', models: [], downloads: { 'qwen3-8b': { status: 'downloading', progress: 42 } } },
    { id: 'bbbb', models: ['qwen3-8b'] },
  ]);
  const entry = merged.find((m) => m.id === 'qwen3-8b');
  assert.deepEqual(entry.presentOn, ['bbbb']);
  assert.deepEqual(entry.downloadingOn, [{ node: 'aaaa', progress: 42 }]);
  assert.ok(!entry.presentOn.includes('aaaa'));
});

test('a finished download is not reported as still in flight', () => {
  const merged = mergeFleetModels([
    { id: 'aaaa', models: ['qwen3-8b'], downloads: { 'qwen3-8b': { status: 'completed', progress: 100 } } },
  ]);
  assert.deepEqual(merged[0].downloadingOn, []);
  assert.deepEqual(merged[0].presentOn, ['aaaa']);
});

test('an empty fleet yields no rows rather than throwing', () => {
  assert.deepEqual(mergeFleetModels([]), []);
  assert.deepEqual(mergeFleetModels(null), []);
});

// ── Choosing what to act on ─────────────────────────────────────────────────

const fleet = [{ id: 'aaaa' }, { id: 'bbbb' }, { id: 'cccc' }];

test('"all" means every node in the fleet, exactly once', () => {
  assert.deepEqual(resolveTargets('all', fleet), ['aaaa', 'bbbb', 'cccc']);
});

test('an explicit list is honoured and de-duplicated', () => {
  assert.deepEqual(resolveTargets(['bbbb', 'aaaa', 'bbbb'], fleet), ['bbbb', 'aaaa']);
});

test('a node that is not in the fleet is not acted on', () => {
  // Pulling a model onto a node we cannot see is not a request we can honour,
  // and silently accepting it would leave the operator waiting on nothing.
  assert.deepEqual(resolveTargets(['aaaa', 'zzzz'], fleet), ['aaaa']);
});

test('no target given means this fleet does nothing', () => {
  // Defaulting an unspecified target to "all" would turn a mis-typed request
  // into three simultaneous multi-gigabyte downloads.
  assert.deepEqual(resolveTargets(undefined, fleet), []);
  assert.deepEqual(resolveTargets([], fleet), []);
});
