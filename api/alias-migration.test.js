// Llama Manager — unit tests for api/alias-migration.js.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Proves the one-time fold of per-backend `modelMapping` maps and the legacy
// `defaultBigModel`/`defaultSmallModel` keys into the global `config.aliases`
// table is faithful, idempotent, and non-throwing on degenerate configs, and
// that the `modelMapping` back-compat read (`synthesizeModelMapping`) and write
// (`foldModelMapping`) keep `GET`/`PUT /api/backends` speaking the old shape.
// Written from the frozen contract in
// docs/superpowers/specs/2026-08-03-model-alias-contract.md § api/alias-migration.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateModelMappings, synthesizeModelMapping, foldModelMapping
} from './alias-migration.js';

// These functions MUTATE the config they are handed, so every test takes its own
// deep copy of a fixture. Sharing one object across tests cross-contaminates and
// produces false passes.
const clone = (value) => structuredClone(value);

// The real pre-migration shape, modelled on the operator's live config.json:
// two Ollama hosts whose mappings share the `Qwen_Qwen3-8B-GGUF` key, a third
// host that is a `"*"` catch-all, and the two legacy top-level default keys.
const LIVE_CONFIG = {
  backends: {
    directory: [
      {
        id: 'borethrax-ollama-mnfmirep',
        name: 'Borethrax Ollama',
        url: 'http://borethrax:11434/v1',
        enabled: true,
        priority: 10,
        apiKeyEnvVar: '',
        modelMapping: { 'Qwen_Qwen3-8B-GGUF': 'qwen3-vl:8b', 'gemini-4-12b': 'gemma4:12b' },
        supportedEndpoints: ['chat/completions', 'completions', 'embeddings'],
        costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
        sharedResourceWeight: 0,
        maxConcurrentRequests: 1,
        timeoutMs: 120000,
        tested: true,
        lastTestTime: 1779724373084,
      },
      {
        id: 'dahaka-ollama-mngx88pk',
        name: 'Dahaka Ollama',
        url: 'http://dahaka:11434/v1',
        enabled: true,
        priority: 10,
        apiKeyEnvVar: '',
        modelMapping: { 'Qwen_Qwen3-8B-GGUF': 'qwen3:8b' },
        supportedEndpoints: ['chat/completions', 'completions', 'embeddings'],
        costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
        sharedResourceWeight: 0,
        maxConcurrentRequests: 1,
        timeoutMs: 120000,
        tested: true,
        lastTestTime: 1775100964191,
      },
      {
        id: 'ember-mpleee8f',
        name: 'Ember',
        url: 'http://ember:11434/v1',
        enabled: true,
        priority: 10,
        apiKeyEnvVar: '',
        modelMapping: { '*': 'qwen3-8b-jetson:latest' },
        supportedEndpoints: ['chat/completions', 'completions', 'embeddings'],
        costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
        sharedResourceWeight: 0,
        maxConcurrentRequests: 5,
        timeoutMs: 300000,
        tested: false,
        lastTestTime: 1779731382608,
      },
    ],
  },
  defaultBigModel: 'Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M',
  defaultSmallModel: 'Qwen_Qwen3-8B-GGUF',
};

/** Minimal single-backend config; `mapping` becomes that backend's modelMapping. */
const oneBackend = (mapping, extra = {}) => ({
  backends: { directory: [{ id: 'host-a', enabled: true, tested: true, modelMapping: mapping }] },
  ...extra,
});

// ── migrateModelMappings: the real config shape ───────────────────────────────

test('migrateModelMappings: folds the live config shape into alias groups', () => {
  const config = clone(LIVE_CONFIG);
  const result = migrateModelMappings(config);

  assert.equal(result.migrated, true);
  assert.deepEqual(config.aliases, {
    'Qwen_Qwen3-8B-GGUF': {
      targets: [
        // Seeded by contract step 4: this key is also the legacy defaultSmallModel,
        // i.e. a real local model, so it keeps local as its primary target.
        { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
        { host: 'borethrax-ollama-mnfmirep', model: 'qwen3-vl:8b' },
        { host: 'dahaka-ollama-mngx88pk', model: 'qwen3:8b' },
      ],
    },
    'gemini-4-12b': {
      targets: [{ host: 'borethrax-ollama-mnfmirep', model: 'gemma4:12b' }],
    },
    'default-big': {
      targets: [{ host: 'local', model: 'Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M' }],
    },
    'default-small': {
      targets: [{ host: 'local', model: 'Qwen_Qwen3-8B-GGUF' }],
    },
  });
  // Groups are built in mapping insertion order, then the legacy defaults are seeded.
  assert.deepEqual(Object.keys(config.aliases), [
    'Qwen_Qwen3-8B-GGUF', 'gemini-4-12b', 'default-big', 'default-small',
  ]);
});

test('migrateModelMappings: two backends mapping one key share a group in directory order', () => {
  const config = clone(LIVE_CONFIG);
  migrateModelMappings(config);

  const group = config.aliases['Qwen_Qwen3-8B-GGUF'];
  // Three targets, not two: contract step 4 prepends the local one, and the two
  // remote targets still follow in backend-directory order behind it.
  assert.equal(group.targets.length, 3);
  assert.deepEqual(group.targets.map(t => t.host),
    ['local', 'borethrax-ollama-mnfmirep', 'dahaka-ollama-mngx88pk']);
  assert.deepEqual(group.targets.filter(t => t.host !== 'local').map(t => t.model),
    ['qwen3-vl:8b', 'qwen3:8b']);
});

test('migrateModelMappings: "*" becomes backend.acceptsAny and creates no alias', () => {
  const config = clone(LIVE_CONFIG);
  migrateModelMappings(config);

  const ember = config.backends.directory.find(b => b.id === 'ember-mpleee8f');
  assert.equal(ember.acceptsAny, 'qwen3-8b-jetson:latest');
  assert.equal(config.aliases['*'], undefined);
  assert.ok(!Object.keys(config.aliases).includes('*'));
  // No other backend gains acceptsAny.
  assert.ok(!('acceptsAny' in config.backends.directory.find(b => b.id === 'dahaka-ollama-mngx88pk')));
});

test('migrateModelMappings: a blank "*" target leaves acceptsAny unset', () => {
  const config = oneBackend({ '*': '   ' });
  migrateModelMappings(config);

  assert.ok(!('acceptsAny' in config.backends.directory[0]));
  assert.deepEqual(config.aliases, {});
});

test('migrateModelMappings: deletes modelMapping from every backend', () => {
  const config = clone(LIVE_CONFIG);
  // A fourth backend that never had a mapping at all must survive untouched.
  config.backends.directory.push({ id: 'no-mapping-host', enabled: true, tested: true });
  migrateModelMappings(config);

  for (const backend of config.backends.directory) {
    assert.ok(!('modelMapping' in backend), `${backend.id} still has modelMapping`);
  }
});

// ── migrateModelMappings: per-key rules ──────────────────────────────────────

test('migrateModelMappings: blank and falsy targets are skipped with a warning', () => {
  const config = oneBackend({ good: 'real-model', empty: '', spaces: '   ', nullish: null });
  const result = migrateModelMappings(config);

  assert.deepEqual(config.aliases, {
    good: { targets: [{ host: 'host-a', model: 'real-model' }] },
  });
  // One warning per skipped key.
  assert.ok(result.warnings.length >= 3,
    `expected >=3 warnings for 3 skipped keys, got ${result.warnings.length}`);
});

test('migrateModelMappings: a glob alias key migrates under its literal name and warns', () => {
  const config = oneBackend({ 'qwen*': 'qwen3:8b', 'gemma?': 'gemma4:12b' });
  const result = migrateModelMappings(config);

  assert.deepEqual(config.aliases, {
    'qwen*': { targets: [{ host: 'host-a', model: 'qwen3:8b' }] },
    'gemma?': { targets: [{ host: 'host-a', model: 'gemma4:12b' }] },
  });
  assert.ok(result.warnings.length >= 2,
    `expected a warning per glob key, got ${result.warnings.length}`);
});

// ── migrateModelMappings: legacy defaults ────────────────────────────────────

test('migrateModelMappings: legacy defaults seed the alias table and are then deleted', () => {
  const config = {
    backends: { directory: [] },
    defaultBigModel: '  gpt-oss-120b  ',
    defaultSmallModel: 'Qwen_Qwen3-8B-GGUF',
  };
  migrateModelMappings(config);

  assert.deepEqual(config.aliases['default-big'],
    { targets: [{ host: 'local', model: 'gpt-oss-120b' }] });   // trimmed
  assert.deepEqual(config.aliases['default-small'],
    { targets: [{ host: 'local', model: 'Qwen_Qwen3-8B-GGUF' }] });
  assert.ok(!('defaultBigModel' in config));
  assert.ok(!('defaultSmallModel' in config));
});

test('migrateModelMappings: a blank legacy default seeds nothing but is still deleted', () => {
  const config = {
    backends: { directory: [] },
    defaultBigModel: '   ',
    defaultSmallModel: '',
  };
  migrateModelMappings(config);

  assert.deepEqual(config.aliases, {});
  assert.ok(!('defaultBigModel' in config));
  assert.ok(!('defaultSmallModel' in config));
});

test('migrateModelMappings: a legacy default colliding with a folded group appends and warns', () => {
  const config = oneBackend(
    { 'default-big': 'remote-big' },
    { defaultBigModel: 'local-big' },
  );
  const result = migrateModelMappings(config);

  assert.deepEqual(config.aliases['default-big'].targets, [
    { host: 'host-a', model: 'remote-big' },   // folded in step 2, not overwritten
    { host: 'local', model: 'local-big' },     // legacy default appended after it
  ]);
  assert.ok(result.warnings.length >= 1, 'expected a warning for the collision');
});

// ── migrateModelMappings: preserving local serving (contract step 4) ─────────

// A folded alias shadows the real model of the same name, so a mapping key that is
// also a local model must keep a `local` target or migration silently ends local
// serving for it. See the rationale block in the contract.

test('migrateModelMappings: an alias name matching a preset id gets a local first target', () => {
  const config = oneBackend(
    { 'coder-preset': 'qwen3-coder:30b' },
    { presets: { 'coder-preset': { model: 'Qwen3-Coder' } } },
  );
  const result = migrateModelMappings(config);

  assert.deepEqual(config.aliases['coder-preset'].targets, [
    { host: 'local', model: 'coder-preset' },
    { host: 'host-a', model: 'qwen3-coder:30b' },
  ]);
  assert.ok(result.warnings.some(w => w.includes('coder-preset')),
    'seeding a local target must warn, naming the alias');
});

test('migrateModelMappings: an alias name matching the localModels argument gets a local first target', () => {
  const config = oneBackend({ 'Llama-3-8B': 'llama3:8b' });
  migrateModelMappings(config, ['Llama-3-8B', 'some-other-local']);

  assert.deepEqual(config.aliases['Llama-3-8B'].targets, [
    { host: 'local', model: 'Llama-3-8B' },
    { host: 'host-a', model: 'llama3:8b' },
  ]);
});

test('migrateModelMappings: an alias name matching the legacy defaultSmallModel gets a local first target', () => {
  // The real motivating case: LIVE_CONFIG's defaultSmallModel is `Qwen_Qwen3-8B-GGUF`,
  // which BOTH ollama hosts also map. `localModels` is deliberately not passed —
  // loadConfig() may run before the local model list exists, and the legacy default
  // alone must still be enough to save local serving.
  const config = clone(LIVE_CONFIG);
  migrateModelMappings(config);

  assert.deepEqual(config.aliases['Qwen_Qwen3-8B-GGUF'].targets, [
    { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
    { host: 'borethrax-ollama-mnfmirep', model: 'qwen3-vl:8b' },
    { host: 'dahaka-ollama-mngx88pk', model: 'qwen3:8b' },
  ]);
  // The legacy key it was matched against is still deleted afterwards.
  assert.ok(!('defaultSmallModel' in config));
});

test('migrateModelMappings: an alias name matching nothing local stays remote-only', () => {
  const config = clone(LIVE_CONFIG);
  migrateModelMappings(config);

  // `gemini-4-12b` is only ever a remote mapping key — no preset, no local model, and
  // neither legacy default names it.
  assert.deepEqual(config.aliases['gemini-4-12b'].targets, [
    { host: 'borethrax-ollama-mnfmirep', model: 'gemma4:12b' },
  ]);
  assert.ok(!config.aliases['gemini-4-12b'].targets.some(t => t.host === 'local'));
});

test('migrateModelMappings: no duplicate local target when the group already has one', () => {
  // `default-big` is folded from a mapping AND seeded from the legacy default, so it
  // already carries a local target by the time step 4 runs.
  const config = oneBackend(
    { 'default-big': 'remote-big', 'shared-name': 'remote-shared' },
    { defaultBigModel: 'default-big', presets: { 'shared-name': {} } },
  );
  migrateModelMappings(config, ['shared-name']);

  const big = config.aliases['default-big'].targets;
  assert.equal(big.filter(t => t.host === 'local').length, 1, 'exactly one local target');
  assert.deepEqual(big, [
    { host: 'host-a', model: 'remote-big' },
    { host: 'local', model: 'default-big' },   // appended by the legacy seed, not moved
  ]);
  // `shared-name` matches both a preset and localModels, but is still seeded once.
  assert.equal(
    config.aliases['shared-name'].targets.filter(t => t.host === 'local').length, 1);
});

test('migrateModelMappings: the seeded local target is FIRST, never appended', () => {
  const config = oneBackend({ 'shared-name': 'remote-a' });
  config.backends.directory.push({
    id: 'host-b', enabled: true, tested: true, modelMapping: { 'shared-name': 'remote-b' },
  });
  migrateModelMappings(config, ['shared-name']);

  const targets = config.aliases['shared-name'].targets;
  assert.deepEqual(targets[0], { host: 'local', model: 'shared-name' });
  assert.deepEqual(targets.map(t => t.host), ['local', 'host-a', 'host-b']);
});

test('migrateModelMappings: idempotency still holds with the local re-seed in place', () => {
  const once = clone(LIVE_CONFIG);
  migrateModelMappings(once, ['Qwen_Qwen3-8B-GGUF']);

  const twice = clone(LIVE_CONFIG);
  migrateModelMappings(twice, ['Qwen_Qwen3-8B-GGUF']);
  const second = migrateModelMappings(twice, ['Qwen_Qwen3-8B-GGUF']);

  assert.deepEqual(second, { migrated: false, warnings: [] });
  assert.deepEqual(twice, once);
  // Specifically: the second pass did not stack a second local target.
  assert.equal(
    twice.aliases['Qwen_Qwen3-8B-GGUF'].targets.filter(t => t.host === 'local').length, 1);
});

// ── migrateModelMappings: idempotency ────────────────────────────────────────

test('migrateModelMappings: no-ops when config.aliases is already present', () => {
  const already = clone(LIVE_CONFIG);
  already.aliases = { 'conversational-model': { targets: [{ host: 'local', model: 'gemma4-12b' }] } };
  const before = clone(already);

  const result = migrateModelMappings(already);

  assert.deepEqual(result, { migrated: false, warnings: [] });
  // Nothing is touched: modelMapping and the legacy defaults all survive.
  assert.deepEqual(already, before);
});

test('migrateModelMappings: an empty-but-present alias table is still a no-op', () => {
  const config = clone(LIVE_CONFIG);
  config.aliases = {};
  const before = clone(config);

  const result = migrateModelMappings(config);

  assert.deepEqual(result, { migrated: false, warnings: [] });
  assert.deepEqual(config, before);
});

test('migrateModelMappings: running twice equals running once', () => {
  const once = clone(LIVE_CONFIG);
  migrateModelMappings(once);

  const twice = clone(LIVE_CONFIG);
  migrateModelMappings(twice);
  const second = migrateModelMappings(twice);

  assert.deepEqual(second, { migrated: false, warnings: [] });
  assert.deepEqual(twice, once);
});

// ── migrateModelMappings: degenerate configs must not throw ──────────────────

test('migrateModelMappings: tolerates a config with no backends key at all', () => {
  const config = {};
  const result = migrateModelMappings(config);

  assert.equal(result.migrated, true);
  assert.deepEqual(config.aliases, {});
});

test('migrateModelMappings: tolerates an empty backends directory', () => {
  const config = { backends: { directory: [] } };
  migrateModelMappings(config);

  assert.deepEqual(config.aliases, {});
});

test('migrateModelMappings: tolerates a backend with no modelMapping', () => {
  const config = { backends: { directory: [{ id: 'host-a', enabled: true, tested: true }] } };
  migrateModelMappings(config);

  assert.deepEqual(config.aliases, {});
});

test('migrateModelMappings: tolerates neither legacy default being set', () => {
  const config = oneBackend({ alpha: 'model-a' });
  migrateModelMappings(config);

  assert.deepEqual(config.aliases, { alpha: { targets: [{ host: 'host-a', model: 'model-a' }] } });
  assert.equal(config.aliases['default-big'], undefined);
  assert.equal(config.aliases['default-small'], undefined);
});

// ── synthesizeModelMapping ───────────────────────────────────────────────────

// A post-migration config whose alias groups deliberately mix hosts, so the
// synthesized per-backend view has to filter rather than flatten.
const SYNTH_CONFIG = {
  backends: {
    directory: [
      { id: 'host-a', enabled: true, tested: true },
      { id: 'host-b', enabled: true, tested: true },
      { id: 'host-quiet', enabled: true, tested: true },
    ],
  },
  aliases: {
    shared: {
      targets: [
        { host: 'local', model: 'local-model' },
        { host: 'host-a', model: 'a-shared' },
        { host: 'host-b', model: 'b-shared' },
      ],
    },
    'a-only': { targets: [{ host: 'host-a', model: 'a-solo' }] },
    'local-only': { targets: [{ host: 'local', model: 'gemma4-12b' }] },
  },
};

test('synthesizeModelMapping: returns only the given backend\'s targets', () => {
  const config = clone(SYNTH_CONFIG);

  assert.deepEqual(synthesizeModelMapping(config, 'host-a'), {
    shared: 'a-shared',
    'a-only': 'a-solo',
  });
  assert.deepEqual(synthesizeModelMapping(config, 'host-b'), { shared: 'b-shared' });
});

test('synthesizeModelMapping: the first target wins when one alias has two on the same backend', () => {
  const config = clone(SYNTH_CONFIG);
  config.aliases.shared.targets.push({ host: 'host-a', model: 'a-second' });

  assert.equal(synthesizeModelMapping(config, 'host-a').shared, 'a-shared');
});

test('synthesizeModelMapping: appends {"*": acceptsAny} when the backend sets it', () => {
  const config = clone(SYNTH_CONFIG);
  config.backends.directory.find(b => b.id === 'host-a').acceptsAny = 'catch-all:latest';

  assert.deepEqual(synthesizeModelMapping(config, 'host-a'), {
    shared: 'a-shared',
    'a-only': 'a-solo',
    '*': 'catch-all:latest',
  });
});

test('synthesizeModelMapping: returns {} for a backend with no targets and no acceptsAny', () => {
  const config = clone(SYNTH_CONFIG);

  assert.deepEqual(synthesizeModelMapping(config, 'host-quiet'), {});
  assert.deepEqual(synthesizeModelMapping(config, 'never-configured'), {});
});

test('synthesizeModelMapping: round-trips every mapping in the live config shape', () => {
  const config = clone(LIVE_CONFIG);
  const originals = new Map(
    config.backends.directory.map(b => [b.id, clone(b.modelMapping)]),
  );
  migrateModelMappings(config);

  for (const [id, original] of originals) {
    assert.deepEqual(synthesizeModelMapping(config, id), original,
      `round-trip lost fidelity for ${id}`);
  }
});

test('synthesizeModelMapping: round-trip drops the targets migration skipped', () => {
  const config = oneBackend({ kept: 'model-a', blank: '', spaced: '   ' });
  migrateModelMappings(config);

  assert.deepEqual(synthesizeModelMapping(config, 'host-a'), { kept: 'model-a' });
});

// ── foldModelMapping ─────────────────────────────────────────────────────────

/** A merged-into alias table: `shared` already holds another host's target. */
const foldConfig = () => ({
  backends: {
    directory: [
      { id: 'host-a', enabled: true, tested: true },
      { id: 'host-b', enabled: true, tested: true },
    ],
  },
  aliases: {
    shared: {
      targets: [
        { host: 'host-b', model: 'b-model' },
        { host: 'local', model: 'local-model' },
      ],
    },
  },
});

test('foldModelMapping: merges without clobbering other hosts in the same group', () => {
  const config = foldConfig();
  foldModelMapping(config, 'host-a', { shared: 'a-model' });

  const targets = config.aliases.shared.targets;
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.filter(t => t.host === 'host-b'), [{ host: 'host-b', model: 'b-model' }]);
  assert.deepEqual(targets.filter(t => t.host === 'local'), [{ host: 'local', model: 'local-model' }]);
  assert.deepEqual(targets.filter(t => t.host === 'host-a'), [{ host: 'host-a', model: 'a-model' }]);
});

test('foldModelMapping: replaces this backend\'s existing target instead of duplicating it', () => {
  const config = foldConfig();
  config.aliases.shared.targets.push({ host: 'host-a', model: 'a-old' });

  foldModelMapping(config, 'host-a', { shared: 'a-new' });

  const mine = config.aliases.shared.targets.filter(t => t.host === 'host-a');
  assert.deepEqual(mine, [{ host: 'host-a', model: 'a-new' }]);
  assert.equal(config.aliases.shared.targets.length, 3);
});

test('foldModelMapping: creates a group for a key the alias table has never seen', () => {
  const config = foldConfig();
  foldModelMapping(config, 'host-a', { shared: 'a-model', brandnew: 'a-new-model' });

  assert.deepEqual(config.aliases.brandnew, { targets: [{ host: 'host-a', model: 'a-new-model' }] });
});

test('foldModelMapping: a dropped key removes this backend\'s target, and the group when empty', () => {
  const config = foldConfig();
  config.aliases.kept = { targets: [{ host: 'host-a', model: 'a-kept' }] };
  config.aliases.solo = { targets: [{ host: 'host-a', model: 'a-solo' }] };
  config.aliases.shared.targets.push({ host: 'host-a', model: 'a-shared' });

  // `solo` and `shared` are absent from the incoming mapping, so host-a leaves both.
  foldModelMapping(config, 'host-a', { kept: 'a-kept' });

  assert.equal(config.aliases.solo, undefined, 'group emptied by the removal must be dropped');
  assert.ok(!('solo' in config.aliases));
  assert.deepEqual(config.aliases.kept, { targets: [{ host: 'host-a', model: 'a-kept' }] });
  // `shared` survives because other hosts still hold targets in it.
  assert.deepEqual(config.aliases.shared.targets, [
    { host: 'host-b', model: 'b-model' },
    { host: 'local', model: 'local-model' },
  ]);
});

test('foldModelMapping: "*" routes to acceptsAny rather than creating an alias', () => {
  const config = foldConfig();
  foldModelMapping(config, 'host-a', { '*': 'catch-all:latest' });

  assert.equal(config.backends.directory.find(b => b.id === 'host-a').acceptsAny, 'catch-all:latest');
  assert.equal(config.aliases['*'], undefined);
});

test('foldModelMapping: skips blank targets like migration does', () => {
  const config = foldConfig();
  foldModelMapping(config, 'host-a', { blank: '', spaced: '   ', good: 'a-model' });

  assert.equal(config.aliases.blank, undefined);
  assert.equal(config.aliases.spaced, undefined);
  assert.deepEqual(config.aliases.good, { targets: [{ host: 'host-a', model: 'a-model' }] });
});

test('foldModelMapping: always returns at least one modelMapping deprecation warning', () => {
  const populated = foldModelMapping(foldConfig(), 'host-a', { shared: 'a-model' });
  assert.ok(populated.warnings.length >= 1);
  assert.ok(populated.warnings.some(w => /modelMapping/.test(w)),
    'a warning must name modelMapping as deprecated');

  // Even a no-change fold is a use of the deprecated field.
  const empty = foldModelMapping(foldConfig(), 'host-a', {});
  assert.ok(empty.warnings.length >= 1);
  assert.ok(empty.warnings.some(w => /modelMapping/.test(w)));
});

test('foldModelMapping: a fold then a synthesize round-trips the mapping it was given', () => {
  const config = foldConfig();
  const mapping = { shared: 'a-model', extra: 'a-extra' };
  foldModelMapping(config, 'host-a', mapping);

  assert.deepEqual(synthesizeModelMapping(config, 'host-a'), mapping);
  // host-b's view is untouched by host-a's write.
  assert.deepEqual(synthesizeModelMapping(config, 'host-b'), { shared: 'b-model' });
});
