// Llama Manager — unit tests for api/model-aliases.js (model alias groups core).
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the pure alias-resolution core that replaces the inline
// resolveModelMapping() / defaultModelListEntries() machinery: glob expansion
// (expandGlob), alias name -> concrete candidate expansion with local
// preset/ds4/model classification and remote backend eligibility
// (resolveAliasCandidates), the warm/cold tier gate that keeps an alias from
// evicting a resident model (partitionByWarmth), operator-input validation for
// the /api/aliases CRUD surface (validateAlias), and the /v1/models rows that
// advertise each alias (aliasListEntries).
//
// These tests are written directly from the frozen contract in
// docs/superpowers/specs/2026-08-03-model-alias-contract.md, independently of
// the implementation, so they encode what the module is SUPPOSED to do rather
// than what it happens to do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED_ALIAS_NAMES, BIG_ALIAS, SMALL_ALIAS,
  expandGlob, resolveAliasCandidates, partitionByWarmth, validateAlias, aliasListEntries
} from './model-aliases.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

// config.presets: keys are preset ids. A preset is ds4 only when it declares
// engine:'ds4' (isDs4Preset); everything else is a llama preset. 'gpt-oss-120b'
// deliberately duplicates a bare local model name below so the preset-shadows-
// model rule can be exercised.
const PRESETS = {
  'ds4-flash': { id: 'ds4-flash', name: 'DeepSeek V4 Flash', engine: 'ds4', modelPath: 'dsv4.gguf' },
  'gemma4-12b-chat': { id: 'gemma4-12b-chat', name: 'Gemma 4 12B chat' }, // llama (no engine field)
  'gpt-oss-120b': { id: 'gpt-oss-120b', name: 'GPT-OSS 120B tuned' },     // shadows the bare model
};

// Bare local model names as the model directory lists them. 'gpt-oss-120b' also
// exists as a preset id above; the preset must win when it is targeted.
const LOCAL_MODELS = ['Qwen_Qwen3-8B-GGUF', 'Qwen_Qwen3-32B-GGUF', 'gpt-oss-120b'];

// Remote model list for the healthy backend. 'gemma4.1:9b' and 'gemma4X1:9b'
// are a matched pair used to prove that the '.' in a glob's literal part is
// escaped rather than treated as the regex any-char class.
const BORETHRAX_MODELS = ['gemma4:12b', 'gemma4:27b', 'gemma4.1:9b', 'gemma4X1:9b', 'llama3:8b'];

// Backend directory. borethrax-ollama is fully usable; stale-host never passed
// its connectivity test; off-host is disabled; sleepy-host is eligible for
// resolution but currently unavailable, which is a warm/cold input only.
const BACKENDS = [
  { id: 'borethrax-ollama', enabled: true, tested: true, remoteModels: BORETHRAX_MODELS },
  { id: 'stale-host', enabled: true, tested: false, remoteModels: ['gemma4:12b'] },
  { id: 'off-host', enabled: false, tested: true, remoteModels: ['gemma4:12b'] },
  { id: 'sleepy-host', enabled: true, tested: true, available: false, remoteModels: ['mistral:7b'] },
];

// The injected view of what exists. Only Qwen3-8B is currently loaded, so every
// other local candidate is a cold load.
const INVENTORY = {
  localModels: LOCAL_MODELS,
  presets: PRESETS,
  residentModels: ['Qwen_Qwen3-8B-GGUF'],
  backends: BACKENDS,
};

// Server config carrying the alias table. 'empty-alias' has zero targets and
// 'qwen*' is a literal alias name containing wildcard characters — alias names
// never glob, so it can only ever be matched by a request for that exact string.
const CONFIG = {
  presets: PRESETS,
  localModels: LOCAL_MODELS,
  backends: { directory: BACKENDS },
  aliases: {
    'conversational-model': {
      targets: [
        { host: 'local', model: 'gemma4-12b-chat' },
        { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
        { host: 'borethrax-ollama', model: 'gemma4:*' },
      ],
    },
    'default-big': { targets: [{ host: 'local', model: 'ds4-flash' }] },
    'empty-alias': { targets: [] },
    'qwen*': { targets: [{ host: 'local', model: 'Qwen_Qwen3-32B-GGUF' }] },
  },
};

/** Build a one-off config that reuses the shared presets/backends fixtures. */
function configWith(aliases) {
  return { presets: PRESETS, localModels: LOCAL_MODELS, backends: { directory: BACKENDS }, aliases };
}

/** Build a candidate literal for warmth tests without depending on the resolver. */
function candidate(host, model, kind, backendId, order) {
  return { host, model, kind, backendId, order };
}

// ── Constants ────────────────────────────────────────────────────────────────

test('exported alias name constants', () => {
  assert.deepEqual(RESERVED_ALIAS_NAMES, ['auto', 'default-router']);
  assert.equal(BIG_ALIAS, 'default-big');
  assert.equal(SMALL_ALIAS, 'default-small');
});

// ── expandGlob ───────────────────────────────────────────────────────────────

test('expandGlob: an exact pattern returns itself even when absent from names', () => {
  // A wildcard-free target is never filtered against the inventory: a model may
  // be perfectly valid and simply not listed yet.
  assert.deepEqual(expandGlob('gemma4:12b', BORETHRAX_MODELS), ['gemma4:12b']);
  assert.deepEqual(expandGlob('not-downloaded-yet', BORETHRAX_MODELS), ['not-downloaded-yet']);
  assert.deepEqual(expandGlob('anything', []), ['anything']);
});

test('expandGlob: * matches a run of characters', () => {
  assert.deepEqual(expandGlob('gemma4:*', BORETHRAX_MODELS), ['gemma4:12b', 'gemma4:27b']);
  assert.deepEqual(expandGlob('*:8b', BORETHRAX_MODELS), ['llama3:8b']);
});

test('expandGlob: ? matches exactly one character', () => {
  assert.deepEqual(expandGlob('gemma4:?7b', BORETHRAX_MODELS), ['gemma4:27b']);
  assert.deepEqual(expandGlob('gemma4:??b', BORETHRAX_MODELS), ['gemma4:12b', 'gemma4:27b']);
  // A single ? cannot stand in for the two characters of '12'/'27'.
  assert.deepEqual(expandGlob('gemma4:?b', BORETHRAX_MODELS), []);
});

test('expandGlob: a wildcard pattern matching nothing returns an empty list', () => {
  assert.deepEqual(expandGlob('mistral:*', BORETHRAX_MODELS), []);
  assert.deepEqual(expandGlob('*', []), []);
});

test('expandGlob: matches come back in names order, not pattern or sorted order', () => {
  const names = ['zeta-model', 'alpha-model', 'mid-model'];
  assert.deepEqual(expandGlob('*', names), ['zeta-model', 'alpha-model', 'mid-model']);
  assert.deepEqual(expandGlob('*-model', names), ['zeta-model', 'alpha-model', 'mid-model']);
});

test('expandGlob: regex metacharacters in the literal part are escaped', () => {
  // '.' must match a literal dot only — 'gemma4X1:9b' must NOT be matched.
  assert.deepEqual(expandGlob('gemma4.1:*', BORETHRAX_MODELS), ['gemma4.1:9b']);
  // Other metacharacters are literal too: '+' is not a quantifier, '(' not a group.
  const odd = ['a+b-1', 'aaab-1', 'c(d)-2', 'cd-2'];
  assert.deepEqual(expandGlob('a+b-*', odd), ['a+b-1']);
  assert.deepEqual(expandGlob('c(d)-*', odd), ['c(d)-2']);
});

// ── resolveAliasCandidates ───────────────────────────────────────────────────

test('resolveAliasCandidates: an unknown alias name resolves to no candidates', () => {
  assert.deepEqual(resolveAliasCandidates('no-such-alias', CONFIG, INVENTORY), []);
  // A real local model name is not an alias either — the caller keeps its model.
  assert.deepEqual(resolveAliasCandidates('Qwen_Qwen3-8B-GGUF', CONFIG, INVENTORY), []);
});

test('resolveAliasCandidates: an alias with an empty targets array resolves to nothing', () => {
  assert.deepEqual(resolveAliasCandidates('empty-alias', CONFIG, INVENTORY), []);
});

test('resolveAliasCandidates: alias names are exact and never glob', () => {
  // CONFIG has an alias literally named 'qwen*'. A request for 'qwen-32b' must
  // NOT match it — two globbed names could otherwise both claim one request.
  assert.deepEqual(resolveAliasCandidates('qwen-32b', CONFIG, INVENTORY), []);
  // The literal name still resolves.
  const literal = resolveAliasCandidates('qwen*', CONFIG, INVENTORY);
  assert.equal(literal.length, 1);
  assert.equal(literal[0].model, 'Qwen_Qwen3-32B-GGUF');
});

test('resolveAliasCandidates: authored target order is preserved and order is the target index', () => {
  const cfg = configWith({
    ordered: {
      targets: [
        { host: 'local', model: 'gpt-oss-120b' },
        { host: 'borethrax-ollama', model: 'gemma4:*' },   // two candidates, both order 1
        { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
      ],
    },
  });
  const got = resolveAliasCandidates('ordered', cfg, INVENTORY);
  assert.deepEqual(got.map(c => c.model), [
    'gpt-oss-120b', 'gemma4:12b', 'gemma4:27b', 'Qwen_Qwen3-8B-GGUF',
  ]);
  assert.deepEqual(got.map(c => c.order), [0, 1, 1, 2]);
});

test('resolveAliasCandidates: a local exact target is classified model / preset / ds4', () => {
  const cfg = configWith({
    bare: { targets: [{ host: 'local', model: 'Qwen_Qwen3-8B-GGUF' }] },
    llamaPreset: { targets: [{ host: 'local', model: 'gemma4-12b-chat' }] },
    ds4Preset: { targets: [{ host: 'local', model: 'ds4-flash' }] },
  });
  // Full-shape check: a candidate carries exactly host/model/kind/backendId/order.
  assert.deepEqual(resolveAliasCandidates('bare', cfg, INVENTORY), [
    { host: 'local', model: 'Qwen_Qwen3-8B-GGUF', kind: 'model', backendId: null, order: 0 },
  ]);
  assert.deepEqual(resolveAliasCandidates('llamaPreset', cfg, INVENTORY), [
    { host: 'local', model: 'gemma4-12b-chat', kind: 'preset', backendId: null, order: 0 },
  ]);
  assert.deepEqual(resolveAliasCandidates('ds4Preset', cfg, INVENTORY), [
    { host: 'local', model: 'ds4-flash', kind: 'ds4', backendId: null, order: 0 },
  ]);
});

test('resolveAliasCandidates: a preset id shadows a bare local model of the same name', () => {
  // 'gpt-oss-120b' is both a bare model and a preset id; the preset wins, and it
  // yields a single candidate rather than one per inventory list.
  const cfg = configWith({ shadowed: { targets: [{ host: 'local', model: 'gpt-oss-120b' }] } });
  const got = resolveAliasCandidates('shadowed', cfg, INVENTORY);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'preset');
  assert.equal(got[0].backendId, null);
});

test('resolveAliasCandidates: a local glob expands against models and preset ids', () => {
  const cfg = configWith({ qwens: { targets: [{ host: 'local', model: 'Qwen_*' }] } });
  const got = resolveAliasCandidates('qwens', cfg, INVENTORY);
  assert.deepEqual(got.map(c => c.model), ['Qwen_Qwen3-8B-GGUF', 'Qwen_Qwen3-32B-GGUF']);
  assert.ok(got.every(c => c.kind === 'model' && c.host === 'local' && c.backendId === null));

  const presetsToo = configWith({ gem: { targets: [{ host: 'local', model: 'gemma4-*' }] } });
  const gem = resolveAliasCandidates('gem', presetsToo, INVENTORY);
  assert.deepEqual(gem.map(c => c.model), ['gemma4-12b-chat']);
  assert.equal(gem[0].kind, 'preset');
});

test('resolveAliasCandidates: a remote glob expands against that backend remoteModels', () => {
  const cfg = configWith({ remote: { targets: [{ host: 'borethrax-ollama', model: 'gemma4:*' }] } });
  const got = resolveAliasCandidates('remote', cfg, INVENTORY);
  assert.deepEqual(got, [
    { host: 'borethrax-ollama', model: 'gemma4:12b', kind: 'model', backendId: 'borethrax-ollama', order: 0 },
    { host: 'borethrax-ollama', model: 'gemma4:27b', kind: 'model', backendId: 'borethrax-ollama', order: 0 },
  ]);
});

test('resolveAliasCandidates: a target on an unknown backend contributes nothing', () => {
  const cfg = configWith({ ghost: { targets: [{ host: 'nowhere-host', model: 'gemma4:12b' }] } });
  assert.deepEqual(resolveAliasCandidates('ghost', cfg, INVENTORY), []);
});

test('resolveAliasCandidates: a target on a disabled backend contributes nothing', () => {
  const cfg = configWith({ off: { targets: [{ host: 'off-host', model: 'gemma4:12b' }] } });
  assert.deepEqual(resolveAliasCandidates('off', cfg, INVENTORY), []);
});

test('resolveAliasCandidates: a target on an untested backend contributes nothing', () => {
  const cfg = configWith({ stale: { targets: [{ host: 'stale-host', model: 'gemma4:12b' }] } });
  assert.deepEqual(resolveAliasCandidates('stale', cfg, INVENTORY), []);
});

test('resolveAliasCandidates: duplicate (host, model) pairs collapse to the lowest order', () => {
  const cfg = configWith({
    dupes: {
      targets: [
        { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
        { host: 'borethrax-ollama', model: 'gemma4:12b' },
        { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },      // exact repeat of target 0
        { host: 'borethrax-ollama', model: 'gemma4:*' },      // re-emits gemma4:12b
      ],
    },
  });
  const got = resolveAliasCandidates('dupes', cfg, INVENTORY);
  assert.deepEqual(got.map(c => c.model), ['Qwen_Qwen3-8B-GGUF', 'gemma4:12b', 'gemma4:27b']);
  assert.deepEqual(got.map(c => c.order), [0, 1, 3]);
});

test('resolveAliasCandidates: the same model name on two hosts is not a duplicate', () => {
  const cfg = configWith({
    both: {
      targets: [
        { host: 'local', model: 'llama3:8b' },
        { host: 'borethrax-ollama', model: 'llama3:8b' },
      ],
    },
  });
  const got = resolveAliasCandidates('both', cfg, INVENTORY);
  assert.deepEqual(got.map(c => c.host), ['local', 'borethrax-ollama']);
  assert.deepEqual(got.map(c => c.backendId), [null, 'borethrax-ollama']);
});

test('resolveAliasCandidates: a mixed local + remote alias returns both in authored order', () => {
  const got = resolveAliasCandidates('conversational-model', CONFIG, INVENTORY);
  assert.deepEqual(got, [
    { host: 'local', model: 'gemma4-12b-chat', kind: 'preset', backendId: null, order: 0 },
    { host: 'local', model: 'Qwen_Qwen3-8B-GGUF', kind: 'model', backendId: null, order: 1 },
    { host: 'borethrax-ollama', model: 'gemma4:12b', kind: 'model', backendId: 'borethrax-ollama', order: 2 },
    { host: 'borethrax-ollama', model: 'gemma4:27b', kind: 'model', backendId: 'borethrax-ollama', order: 2 },
  ]);
});

// ── partitionByWarmth ────────────────────────────────────────────────────────

test('partitionByWarmth: a resident local candidate is warm', () => {
  const c = candidate('local', 'Qwen_Qwen3-8B-GGUF', 'model', null, 0);
  const { warm, cold } = partitionByWarmth([c], INVENTORY);
  assert.deepEqual(warm, [c]);
  assert.deepEqual(cold, []);
});

test('partitionByWarmth: a non-resident local candidate is cold', () => {
  // A cold local candidate is the expensive action — it may force an eviction,
  // which is exactly what the tier gate exists to avoid.
  const c = candidate('local', 'gpt-oss-120b', 'preset', null, 0);
  const { warm, cold } = partitionByWarmth([c], INVENTORY);
  assert.deepEqual(warm, []);
  assert.deepEqual(cold, [c]);
});

test('partitionByWarmth: a remote candidate on an available backend is warm', () => {
  // The manager does not control remote residency, so an available backend is
  // warm unconditionally — both when `available` is absent and when it is true.
  const c = candidate('borethrax-ollama', 'gemma4:12b', 'model', 'borethrax-ollama', 0);
  const { warm, cold } = partitionByWarmth([c], INVENTORY);
  assert.deepEqual(warm, [c]);
  assert.deepEqual(cold, []);

  const explicit = {
    ...INVENTORY,
    backends: INVENTORY.backends.map(b => (b.id === 'borethrax-ollama' ? { ...b, available: true } : b)),
  };
  assert.deepEqual(partitionByWarmth([c], explicit).warm, [c]);
});

test('partitionByWarmth: a remote candidate whose backend is available:false is cold', () => {
  const c = candidate('sleepy-host', 'mistral:7b', 'model', 'sleepy-host', 0);
  const { warm, cold } = partitionByWarmth([c], INVENTORY);
  assert.deepEqual(warm, []);
  assert.deepEqual(cold, [c]);
});

test('partitionByWarmth: input order is preserved within each bucket', () => {
  const remoteWarm = candidate('borethrax-ollama', 'gemma4:27b', 'model', 'borethrax-ollama', 3);
  const localWarm = candidate('local', 'Qwen_Qwen3-8B-GGUF', 'model', null, 1);
  const coldA = candidate('local', 'gpt-oss-120b', 'preset', null, 0);
  const coldB = candidate('local', 'Qwen_Qwen3-32B-GGUF', 'model', null, 2);
  const { warm, cold } = partitionByWarmth([coldA, localWarm, coldB, remoteWarm], INVENTORY);
  assert.deepEqual(warm, [localWarm, remoteWarm]);
  assert.deepEqual(cold, [coldA, coldB]);
});

test('partitionByWarmth: an empty candidate list yields two empty buckets', () => {
  assert.deepEqual(partitionByWarmth([], INVENTORY), { warm: [], cold: [] });
});

// ── validateAlias ────────────────────────────────────────────────────────────

const OK_TARGETS = [{ host: 'local', model: 'Qwen_Qwen3-8B-GGUF' }];

/** Assert a rejection carries ok:false plus a non-blank error string. */
function assertRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.trim().length > 0, 'rejection must explain itself');
}

test('validateAlias: rejects a blank, whitespace-only, or non-string name', () => {
  assertRejected(validateAlias(CONFIG, '', OK_TARGETS));
  assertRejected(validateAlias(CONFIG, '   ', OK_TARGETS));
  assertRejected(validateAlias(CONFIG, '\t\n', OK_TARGETS));
  assertRejected(validateAlias(CONFIG, 42, OK_TARGETS));
  assertRejected(validateAlias(CONFIG, null, OK_TARGETS));
  assertRejected(validateAlias(CONFIG, undefined, OK_TARGETS));
  assertRejected(validateAlias(CONFIG, { name: 'x' }, OK_TARGETS));
});

test('validateAlias: rejects the reserved router-classifier names', () => {
  assertRejected(validateAlias(CONFIG, 'auto', OK_TARGETS));
  assertRejected(validateAlias(CONFIG, 'default-router', OK_TARGETS));
});

test('validateAlias: rejects targets that are not a non-empty array', () => {
  assertRejected(validateAlias(CONFIG, 'my-alias', []));
  assertRejected(validateAlias(CONFIG, 'my-alias', null));
  assertRejected(validateAlias(CONFIG, 'my-alias', undefined));
  assertRejected(validateAlias(CONFIG, 'my-alias', { host: 'local', model: 'x' }));
  assertRejected(validateAlias(CONFIG, 'my-alias', 'local:x'));
});

test('validateAlias: rejects a target missing host or model', () => {
  assertRejected(validateAlias(CONFIG, 'my-alias', [{ model: 'Qwen_Qwen3-8B-GGUF' }]));
  assertRejected(validateAlias(CONFIG, 'my-alias', [{ host: 'local' }]));
  assertRejected(validateAlias(CONFIG, 'my-alias', [{ host: 'local', model: '' }]));
  assertRejected(validateAlias(CONFIG, 'my-alias', [{ host: '   ', model: 'x' }]));
  // A non-object target is not a target at all.
  assertRejected(validateAlias(CONFIG, 'my-alias', ['local/Qwen_Qwen3-8B-GGUF']));
  assertRejected(validateAlias(CONFIG, 'my-alias', [null]));
});

test('validateAlias: rejects a target whose host or model is not a string', () => {
  assertRejected(validateAlias(CONFIG, 'my-alias', [{ host: 'local', model: 7 }]));
  assertRejected(validateAlias(CONFIG, 'my-alias', [{ host: 3, model: 'Qwen_Qwen3-8B-GGUF' }]));
  assertRejected(validateAlias(CONFIG, 'my-alias', [{ host: 'local', model: ['a'] }]));
});

test('validateAlias: rejects two targets identical in host and model', () => {
  assertRejected(validateAlias(CONFIG, 'my-alias', [
    { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
    { host: 'borethrax-ollama', model: 'gemma4:12b' },
    { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
  ]));
  // Same model on two different hosts is legitimate, not a duplicate.
  const ok = validateAlias(CONFIG, 'my-alias', [
    { host: 'local', model: 'llama3:8b' },
    { host: 'borethrax-ollama', model: 'llama3:8b' },
  ]);
  assert.equal(ok.ok, true);
});

test('validateAlias: warns but accepts a name colliding with a preset id', () => {
  const r = validateAlias(CONFIG, 'gemma4-12b-chat', OK_TARGETS);
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.warnings));
  assert.ok(r.warnings.length >= 1, 'a preset-shadowing alias name must warn');
});

test('validateAlias: warns but accepts a name colliding with a local model', () => {
  const r = validateAlias(CONFIG, 'Qwen_Qwen3-32B-GGUF', OK_TARGETS);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length >= 1, 'a model-shadowing alias name must warn');
});

test('validateAlias: warns but accepts a target naming an unconfigured host', () => {
  const r = validateAlias(CONFIG, 'my-alias', [{ host: 'nowhere-host', model: 'gemma4:12b' }]);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length >= 1, 'an unconfigured host must warn');
});

test('validateAlias: a clean alias is accepted with no warnings', () => {
  const r = validateAlias(CONFIG, 'conversational-model-2', [
    { host: 'local', model: 'gemma4-12b-chat' },
    { host: 'borethrax-ollama', model: 'gemma4:*' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('validateAlias: normalized targets are trimmed and stripped of extra keys', () => {
  const r = validateAlias(CONFIG, 'my-alias', [
    { host: '  local  ', model: '  Qwen_Qwen3-8B-GGUF  ', weight: 3, note: 'drop me' },
    { host: 'borethrax-ollama', model: 'gemma4:*', enabled: true },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    targets: [
      { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
      { host: 'borethrax-ollama', model: 'gemma4:*' },
    ],
  });
});

// ── aliasListEntries ─────────────────────────────────────────────────────────

test('aliasListEntries: one row per alias with targets, in config key order', () => {
  const rows = aliasListEntries(CONFIG, 1717171717);
  assert.deepEqual(rows.map(r => r.id), ['conversational-model', 'default-big', 'qwen*']);
  const first = rows[0];
  assert.equal(first.object, 'model');
  assert.equal(first.owned_by, 'llamacpp');
  assert.equal(first.meta, null);
  assert.equal(first.n_ctx, null);
  assert.equal(first.displayName, 'conversational-model');
  assert.equal(first.alias, null);
});

test('aliasListEntries: an alias with zero targets is omitted', () => {
  const rows = aliasListEntries(CONFIG, 1717171717);
  assert.equal(rows.find(r => r.id === 'empty-alias'), undefined);
  assert.deepEqual(aliasListEntries(configWith({ nothing: { targets: [] } }), 1), []);
});

test('aliasListEntries: status is alias and created is the passed nowSeconds', () => {
  const rows = aliasListEntries(CONFIG, 1717171717);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.status === 'alias'));
  assert.ok(rows.every(r => r.created === 1717171717));
});

test('aliasListEntries: aliasTarget is the first target model (back-compat scalar)', () => {
  const rows = aliasListEntries(CONFIG, 1000);
  assert.equal(rows.find(r => r.id === 'conversational-model').aliasTarget, 'gemma4-12b-chat');
  assert.equal(rows.find(r => r.id === 'default-big').aliasTarget, 'ds4-flash');
  assert.equal(rows.find(r => r.id === 'qwen*').aliasTarget, 'Qwen_Qwen3-32B-GGUF');
});

test('aliasListEntries: engine is ds4 only when the FIRST target is a ds4 preset', () => {
  const rows = aliasListEntries(CONFIG, 1000);
  assert.equal(rows.find(r => r.id === 'default-big').engine, 'ds4');       // ds4 preset first
  assert.equal(rows.find(r => r.id === 'conversational-model').engine, 'llama'); // llama preset first
  assert.equal(rows.find(r => r.id === 'qwen*').engine, 'llama');           // bare model

  // A ds4 preset in a later slot does not make the alias ds4.
  const later = configWith({
    mixed: { targets: [{ host: 'local', model: 'Qwen_Qwen3-8B-GGUF' }, { host: 'local', model: 'ds4-flash' }] },
  });
  assert.equal(aliasListEntries(later, 1000)[0].engine, 'llama');

  // A REMOTE first target is not a local preset, so it cannot be ds4 even when
  // its model name happens to equal a ds4 preset id.
  const remoteFirst = configWith({
    remoteDs4: { targets: [{ host: 'borethrax-ollama', model: 'ds4-flash' }] },
  });
  assert.equal(aliasListEntries(remoteFirst, 1000)[0].engine, 'llama');
});

test('aliasListEntries: targets carries the full group', () => {
  const row = aliasListEntries(CONFIG, 1000).find(r => r.id === 'conversational-model');
  assert.deepEqual(row.targets, [
    { host: 'local', model: 'gemma4-12b-chat' },
    { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
    { host: 'borethrax-ollama', model: 'gemma4:*' },
  ]);
});

test('aliasListEntries: a null or absent alias table yields no rows', () => {
  assert.deepEqual(aliasListEntries(null, 1000), []);
  assert.deepEqual(aliasListEntries(undefined, 1000), []);
  assert.deepEqual(aliasListEntries({}, 1000), []);
  assert.deepEqual(aliasListEntries({ presets: PRESETS, aliases: null }, 1000), []);
  assert.deepEqual(aliasListEntries({ presets: PRESETS, aliases: {} }, 1000), []);
});
