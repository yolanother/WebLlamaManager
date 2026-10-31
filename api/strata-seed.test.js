// Llama Manager — tests for the one-time Strata preset + alias seed.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pins W2d (T32312b1bd681b): drakemore's serving state (the Strata preset, default-big /
// default-small pointing at it, boot re-activation) existed only in a hand-edited
// config.json, so a fresh ISO reflash would come up answering 404 for the aliases
// Frostburn forwards to it. The seed recreates it once the Strata package and the model
// pack are on the box, and never fights the operator afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { seedStrataPreset, STRATA_PRESET_ID, strataDefaultPreset } from './strata-seed.js';

const all = () => true;

test('the default preset is the live drakemore preset at 131072 context', () => {
  const p = strataDefaultPreset();
  assert.equal(p.id, STRATA_PRESET_ID);
  assert.equal(p.engine, 'strata');
  assert.equal(p.context, 131072);
  assert.ok(!p.strata.args.includes('--expert-cache'), 'the manager owns --expert-cache');
  assert.ok(p.strata.args.includes('/volumes/models/strata/packs/iq3_s'));
});

test('fresh config with the pack present: preset, both aliases and boot re-activation are seeded', () => {
  const config = { presets: { gpt120: {} } };
  const r = seedStrataPreset(config, { strataEnabled: true, exists: all });
  assert.deepEqual(r, { changed: true, missing: [] });
  assert.equal(config.presets[STRATA_PRESET_ID].id, STRATA_PRESET_ID);
  assert.ok(config.presets.gpt120, 'other presets kept');
  for (const name of ['default-big', 'default-small']) {
    assert.deepEqual(config.aliases[name], { targets: [{ host: 'local', model: STRATA_PRESET_ID }] });
  }
  assert.equal(config.lastExclusivePreset, STRATA_PRESET_ID);
  assert.equal(config.strataSeeded, true);
});

test('a duo-seeded alias on the same fresh box is replaced once; an operator preset is kept', () => {
  const mine = { id: STRATA_PRESET_ID, context: 65536 };
  const config = { presets: { [STRATA_PRESET_ID]: mine }, aliases: { 'default-big': { targets: [{ host: 'local', model: 'duo' }] } }, lastExclusivePreset: 'other' };
  seedStrataPreset(config, { strataEnabled: true, exists: all });
  assert.equal(config.presets[STRATA_PRESET_ID], mine);
  assert.equal(config.aliases['default-big'].targets[0].model, STRATA_PRESET_ID);
  assert.equal(config.lastExclusivePreset, 'other', 'an existing boot preset is not replaced');
});

test('runs once: later operator changes survive every boot', () => {
  const config = { strataSeeded: true, aliases: { 'default-big': { targets: [{ host: 'local', model: 'x' }] } } };
  assert.deepEqual(seedStrataPreset(config, { strataEnabled: true, exists: all }), { changed: false, missing: [] });
  assert.equal(config.aliases['default-big'].targets[0].model, 'x');
});

test('missing pack files or no Strata package: nothing seeded, retried next boot', () => {
  const config = {};
  const r = seedStrataPreset(config, { strataEnabled: true, exists: (p) => !p.endsWith('tokenizer') });
  assert.equal(r.changed, false);
  assert.deepEqual(r.missing, ['/volumes/models/strata/packs/iq3_s/tokenizer']);
  assert.deepEqual(config, {});
  assert.deepEqual(seedStrataPreset(config, { strataEnabled: false, exists: all }), { changed: false, missing: [] });
  assert.deepEqual(config, {});
});

test('server.js seeds Strata before the default-small seed and the boot exclusive pick', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const listen = source.slice(source.indexOf('httpServer.listen(API_PORT'));
  const strataAt = listen.indexOf('seedStrataPreset(config');
  assert.ok(strataAt >= 0);
  assert.ok(strataAt < listen.indexOf('seedDefaultAliases(config'));
  assert.ok(strataAt < listen.indexOf('selectBootExclusive(config)'));
});
