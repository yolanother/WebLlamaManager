/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Specifies the routing aliases an appliance defines for itself on first run.
 * An appliance ships one model and an empty config, so `default-small` -- which
 * `auto` routing resolves to -- pointed at nothing and every request using it
 * failed with "model 'default-small' not found".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDefaultAliases } from './seed-aliases.js';

test('an empty config gets default-small pointed at the only model', () => {
  const config = {};
  const changed = seedDefaultAliases(config, ['Qwen3-8B-Q4_K_M']);
  assert.equal(changed, true);
  assert.deepEqual(config.aliases['default-small'], {
    targets: [{ host: 'local', model: 'Qwen3-8B-Q4_K_M' }],
  });
});

test('an operator alias is never overwritten', () => {
  // Someone who has pointed default-small somewhere deliberately must keep it,
  // even if that target is not currently loaded.
  const config = { aliases: { 'default-small': { targets: [{ host: 'local', model: 'mine' }] } } };
  const changed = seedDefaultAliases(config, ['Qwen3-8B-Q4_K_M']);
  assert.equal(changed, false);
  assert.deepEqual(config.aliases['default-small'].targets, [{ host: 'local', model: 'mine' }]);
});

test('nothing is invented when no model is present', () => {
  const config = {};
  assert.equal(seedDefaultAliases(config, []), false);
  assert.equal(config.aliases, undefined);
});

test('the smallest-looking model is chosen when several exist', () => {
  // A multi-model install should not have "small" point at a 120B. Prefer the
  // one whose name carries the smallest parameter count; fall back to first.
  const config = {};
  seedDefaultAliases(config, ['gpt-oss-120b-Q5_K_M', 'Qwen3-8B-Q4_K_M', 'gemma-27b']);
  assert.equal(config.aliases['default-small'].targets[0].model, 'Qwen3-8B-Q4_K_M');
});

test('existing unrelated aliases survive', () => {
  const config = { aliases: { 'my-alias': { targets: [] } } };
  seedDefaultAliases(config, ['Qwen3-8B-Q4_K_M']);
  assert.ok(config.aliases['my-alias']);
  assert.ok(config.aliases['default-small']);
});


test('a filesystem name is normalised to the id the router advertises', () => {
  // MEASURED: scanLocalModels() yields "Qwen3-8B-Q4_K_M.gguf" but the router
  // advertises "Qwen3-8B-Q4_K_M", so seeding the raw filename produced an alias
  // that resolved to nothing: {"code":400,"message":"model
  // 'Qwen3-8B-Q4_K_M.gguf' not found"} -- the same failure the seeding was
  // added to prevent, one layer further along.
  const config = {};
  seedDefaultAliases(config, ['Qwen3-8B-Q4_K_M.gguf']);
  assert.equal(config.aliases['default-small'].targets[0].model, 'Qwen3-8B-Q4_K_M');
});

test('a name that is already an id is left alone', () => {
  const config = {};
  seedDefaultAliases(config, ['Qwen3-8B-Q4_K_M']);
  assert.equal(config.aliases['default-small'].targets[0].model, 'Qwen3-8B-Q4_K_M');
});
