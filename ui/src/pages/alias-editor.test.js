// Llama Manager model-alias editor state tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the pure state helpers behind the Settings > Aliases tab: flattening
// an alias map into editable target rows and rebuilding it from them, diffing
// edited groups against the loaded snapshot so only changed aliases are PUT and
// deleted ones are removed, and per-row validation mirroring the server-side
// validateAlias rules for inline UI errors and warnings.
//
// The GPU section at the end covers the shape problem the editor turns on: targets
// are per-ROW but `gpu`/`gpuPriority` are per-ALIAS, so it exercises a ten-alias
// table with one-to-four targets each rather than the single alias that would let
// a grouping bug pass unnoticed, and it pins the property the operator's existing
// config depends on — an alias with no GPU PUTs exactly the body it did before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasesToRows, aliasGroups, rowsToAliases, diffAliases, validateRows } from './alias-editor.js';

/**
 * A non-trivial alias map: three groups, multi-target, mixed local/remote hosts,
 * with a group whose targets are deliberately not host-ordered so order bugs show.
 */
const ALIASES = {
  'default-big': {
    targets: [
      { host: 'local', model: 'gpt-oss-120b' },
      { host: 'pomrath', model: 'qwen3-coder-next' }
    ]
  },
  'conversational-model': {
    targets: [
      { host: 'pomrath', model: 'gemma-4-27b' },
      { host: 'local', model: 'gemma-4-12b' },
      { host: 'local', model: 'llama-3.3-70b' }
    ]
  },
  'default-small': {
    targets: [{ host: 'local', model: 'qwen3-4b' }]
  }
};

/** Fresh deep copy of the fixture, so a test's edits never leak into the next. */
const snapshot = () => structuredClone(ALIASES);

/** The inventory validateRows checks names and hosts against. */
const INVENTORY = {
  presets: { 'coder-max': {}, 'ds4-flash': {} },
  localModels: ['gpt-oss-120b', 'qwen3-4b', 'gemma-4-12b'],
  backendIds: ['pomrath', 'frostburn']
};

/** Every issue validateRows reported for one row. */
const issuesFor = (issues, rowId) => issues.filter(i => i.rowId === rowId);

/** Asserts an issue carries a usable field, level, and human-readable message. */
const assertIssueShape = (issue) => {
  assert.ok(['aliasName', 'gpu', 'gpuPriority', 'host', 'model'].includes(issue.field), `unexpected field ${issue.field}`);
  assert.ok(['error', 'warning'].includes(issue.level), `unexpected level ${issue.level}`);
  assert.equal(typeof issue.message, 'string');
  assert.ok(issue.message.trim().length > 0, 'message must be non-empty');
};

// ---------------------------------------------------------------------------
// aliasesToRows
// ---------------------------------------------------------------------------

test('aliasesToRows emits one row per target, preserving alias and target order', () => {
  const rows = aliasesToRows(ALIASES);

  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(r => [r.aliasName, r.host, r.model]), [
    ['default-big', 'local', 'gpt-oss-120b'],
    ['default-big', 'pomrath', 'qwen3-coder-next'],
    ['conversational-model', 'pomrath', 'gemma-4-27b'],
    ['conversational-model', 'local', 'gemma-4-12b'],
    ['conversational-model', 'local', 'llama-3.3-70b'],
    ['default-small', 'local', 'qwen3-4b']
  ]);
});

test('aliasesToRows gives every row a unique rowId', () => {
  const rows = aliasesToRows(ALIASES);

  for (const r of rows) {
    assert.notEqual(r.rowId, undefined, 'every row needs a rowId');
    assert.notEqual(r.rowId, null, 'every row needs a rowId');
  }
  assert.equal(new Set(rows.map(r => r.rowId)).size, rows.length, 'rowIds must be unique');
});

test('aliasesToRows yields no rows for an alias with zero targets', () => {
  const rows = aliasesToRows({
    empty: { targets: [] },
    populated: { targets: [{ host: 'local', model: 'qwen3-4b' }] }
  });

  assert.deepEqual(rows.map(r => r.aliasName), ['populated']);
});

test('aliasesToRows returns [] for an empty or absent alias map', () => {
  assert.deepEqual(aliasesToRows({}), []);
  assert.deepEqual(aliasesToRows(undefined), []);
  assert.deepEqual(aliasesToRows(null), []);
});

// ---------------------------------------------------------------------------
// rowsToAliases
// ---------------------------------------------------------------------------

test('rowsToAliases round-trips aliasesToRows for a non-trivial alias map', () => {
  assert.deepEqual(rowsToAliases(aliasesToRows(ALIASES)), ALIASES);
});

test('rowsToAliases groups rows sharing an alias name, in row order', () => {
  const rows = [
    { rowId: 1, aliasName: 'a', host: 'local', model: 'm1' },
    { rowId: 2, aliasName: 'b', host: 'pomrath', model: 'm2' },
    { rowId: 3, aliasName: 'a', host: 'frostburn', model: 'm3' }
  ];

  assert.deepEqual(rowsToAliases(rows), {
    a: { targets: [{ host: 'local', model: 'm1' }, { host: 'frostburn', model: 'm3' }] },
    b: { targets: [{ host: 'pomrath', model: 'm2' }] }
  });
});

test('rowsToAliases drops rows with a blank alias name, host, or model', () => {
  const rows = [
    { rowId: 1, aliasName: 'keep', host: 'local', model: 'm1' },
    { rowId: 2, aliasName: '', host: 'local', model: 'm2' },
    { rowId: 3, aliasName: 'keep', host: '', model: 'm3' },
    { rowId: 4, aliasName: 'keep', host: 'local', model: '' }
  ];

  assert.deepEqual(rowsToAliases(rows), {
    keep: { targets: [{ host: 'local', model: 'm1' }] }
  });
});

test('rowsToAliases omits an alias left with no valid rows', () => {
  const rows = [
    { rowId: 1, aliasName: 'ghost', host: 'local', model: '' },
    { rowId: 2, aliasName: 'ghost', host: '', model: 'm' },
    { rowId: 3, aliasName: 'real', host: 'local', model: 'm' }
  ];

  const result = rowsToAliases(rows);

  assert.equal(Object.hasOwn(result, 'ghost'), false, 'an all-blank alias must not appear');
  assert.deepEqual(result, { real: { targets: [{ host: 'local', model: 'm' }] } });
  assert.deepEqual(rowsToAliases([]), {});
});

// ---------------------------------------------------------------------------
// diffAliases
// ---------------------------------------------------------------------------

test('diffAliases reports nothing when the snapshot is untouched', () => {
  assert.deepEqual(diffAliases(snapshot(), snapshot()), { changed: [], removed: [] });
});

test('diffAliases marks only the alias whose target was edited', () => {
  const edited = snapshot();
  edited['conversational-model'].targets[1].model = 'gemma-4-12b-it';

  assert.deepEqual(diffAliases(snapshot(), edited), {
    changed: ['conversational-model'],
    removed: []
  });
});

test('diffAliases marks an alias that gained a target', () => {
  const edited = snapshot();
  edited['default-small'].targets.push({ host: 'pomrath', model: 'qwen3-4b' });

  assert.deepEqual(diffAliases(snapshot(), edited), {
    changed: ['default-small'],
    removed: []
  });
});

test('diffAliases treats target order as meaningful, so a reorder is a change', () => {
  const edited = snapshot();
  edited['default-big'].targets.reverse();

  assert.deepEqual(diffAliases(snapshot(), edited), {
    changed: ['default-big'],
    removed: []
  });
});

test('diffAliases puts a deleted alias in removed, not changed', () => {
  const edited = snapshot();
  delete edited['default-small'];

  assert.deepEqual(diffAliases(snapshot(), edited), {
    changed: [],
    removed: ['default-small']
  });
});

test('diffAliases puts a brand-new alias in changed, not removed', () => {
  const edited = snapshot();
  edited['scratch'] = { targets: [{ host: 'local', model: 'qwen3-4b' }] };

  assert.deepEqual(diffAliases(snapshot(), edited), {
    changed: ['scratch'],
    removed: []
  });
});

// ---------------------------------------------------------------------------
// validateRows — errors
// ---------------------------------------------------------------------------

test('validateRows returns [] for a clean row set', () => {
  const rows = [
    { rowId: 'r1', aliasName: 'default-big', host: 'local', model: 'gpt-oss-120b' },
    { rowId: 'r2', aliasName: 'default-big', host: 'pomrath', model: 'qwen3-coder-next' },
    { rowId: 'r3', aliasName: 'conversational-model', host: 'frostburn', model: 'gemma-4-*' }
  ];

  assert.deepEqual(validateRows(rows, INVENTORY), []);
});

test('validateRows errors on a blank or whitespace-only alias name', () => {
  const rows = [
    { rowId: 'blank', aliasName: '', host: 'local', model: 'qwen3-4b' },
    { rowId: 'spaces', aliasName: '   ', host: 'local', model: 'qwen3-4b' }
  ];

  const issues = validateRows(rows, INVENTORY);

  for (const rowId of ['blank', 'spaces']) {
    const found = issuesFor(issues, rowId);
    assert.equal(found.length, 1, `expected exactly one issue on row ${rowId}`);
    assertIssueShape(found[0]);
    assert.equal(found[0].field, 'aliasName');
    assert.equal(found[0].level, 'error');
  }
});

test('validateRows errors on the reserved alias names auto and default-router', () => {
  const rows = [
    { rowId: 'auto', aliasName: 'auto', host: 'local', model: 'qwen3-4b' },
    { rowId: 'router', aliasName: 'default-router', host: 'local', model: 'qwen3-4b' }
  ];

  const issues = validateRows(rows, INVENTORY);

  for (const rowId of ['auto', 'router']) {
    const found = issuesFor(issues, rowId);
    assert.equal(found.length, 1, `expected exactly one issue on row ${rowId}`);
    assertIssueShape(found[0]);
    assert.equal(found[0].field, 'aliasName');
    assert.equal(found[0].level, 'error');
  }
});

test('validateRows errors on a blank host', () => {
  const rows = [{ rowId: 'h', aliasName: 'my-alias', host: '', model: 'qwen3-4b' }];

  const found = issuesFor(validateRows(rows, INVENTORY), 'h');

  assert.equal(found.length, 1);
  assertIssueShape(found[0]);
  assert.equal(found[0].field, 'host');
  assert.equal(found[0].level, 'error');
});

test('validateRows errors on a blank model', () => {
  const rows = [{ rowId: 'm', aliasName: 'my-alias', host: 'local', model: '' }];

  const found = issuesFor(validateRows(rows, INVENTORY), 'm');

  assert.equal(found.length, 1);
  assertIssueShape(found[0]);
  assert.equal(found[0].field, 'model');
  assert.equal(found[0].level, 'error');
});

test('validateRows errors on two rows identical in aliasName, host, and model', () => {
  const rows = [
    { rowId: 'd1', aliasName: 'dup', host: 'local', model: 'qwen3-4b' },
    { rowId: 'd2', aliasName: 'dup', host: 'local', model: 'qwen3-4b' },
    // Same alias, different host — not a duplicate.
    { rowId: 'd3', aliasName: 'dup', host: 'pomrath', model: 'qwen3-4b' },
    // Same host + model, different alias — not a duplicate.
    { rowId: 'd4', aliasName: 'other', host: 'local', model: 'qwen3-4b' }
  ];

  const issues = validateRows(rows, INVENTORY);

  // The second occurrence is the offender every reasonable implementation flags;
  // whether the first is flagged too is left open on purpose.
  const dupe = issuesFor(issues, 'd2');
  assert.equal(dupe.length, 1);
  assertIssueShape(dupe[0]);
  assert.equal(dupe[0].field, 'model');
  assert.equal(dupe[0].level, 'error');

  assert.deepEqual(issuesFor(issues, 'd3'), []);
  assert.deepEqual(issuesFor(issues, 'd4'), []);
});

// ---------------------------------------------------------------------------
// validateRows — warnings
// ---------------------------------------------------------------------------

test('validateRows warns when an alias name collides with a preset id', () => {
  const rows = [{ rowId: 'p', aliasName: 'coder-max', host: 'local', model: 'qwen3-4b' }];

  const found = issuesFor(validateRows(rows, INVENTORY), 'p');

  assert.equal(found.length, 1);
  assertIssueShape(found[0]);
  assert.equal(found[0].field, 'aliasName');
  assert.equal(found[0].level, 'warning');
});

test('validateRows warns when an alias name collides with a local model', () => {
  const rows = [{ rowId: 'l', aliasName: 'gpt-oss-120b', host: 'local', model: 'gpt-oss-120b' }];

  const found = issuesFor(validateRows(rows, INVENTORY), 'l');

  assert.equal(found.length, 1);
  assertIssueShape(found[0]);
  assert.equal(found[0].field, 'aliasName');
  assert.equal(found[0].level, 'warning');
});

test('validateRows warns on a host that is neither local nor a known backend id', () => {
  const rows = [{ rowId: 'u', aliasName: 'my-alias', host: 'nowhere', model: 'qwen3-4b' }];

  const found = issuesFor(validateRows(rows, INVENTORY), 'u');

  assert.equal(found.length, 1);
  assertIssueShape(found[0]);
  assert.equal(found[0].field, 'host');
  assert.equal(found[0].level, 'warning');
});

// ---------------------------------------------------------------------------
// validateRows — combinations
// ---------------------------------------------------------------------------

test('validateRows surfaces every problem on a single row', () => {
  const rows = [{ rowId: 'bad', aliasName: '', host: '', model: '' }];

  const found = issuesFor(validateRows(rows, INVENTORY), 'bad');

  assert.equal(found.length, 3);
  found.forEach(assertIssueShape);
  assert.deepEqual(found.map(i => i.field).sort(), ['aliasName', 'host', 'model']);
  assert.deepEqual([...new Set(found.map(i => i.level))], ['error']);
});

test('validateRows reports an error and a warning coexisting on one row', () => {
  const rows = [{ rowId: 'mix', aliasName: 'auto', host: 'nowhere', model: 'qwen3-4b' }];

  const found = issuesFor(validateRows(rows, INVENTORY), 'mix');

  assert.equal(found.length, 2);
  found.forEach(assertIssueShape);

  const error = found.find(i => i.level === 'error');
  assert.ok(error, 'the reserved name must be an error');
  assert.equal(error.field, 'aliasName');

  const warning = found.find(i => i.level === 'warning');
  assert.ok(warning, 'the unknown host must be a warning');
  assert.equal(warning.field, 'host');
});

// ---------------------------------------------------------------------------
// Per-alias GPU pool and priority.
//
// The editor's state is one flat row per TARGET, but a GPU pool and a priority
// belong to the ALIAS. Everything below is at a scale where a grouping bug cannot
// hide: ten aliases, one to four targets each, local and remote hosts mixed, and
// model ids long enough to be realistic.
// ---------------------------------------------------------------------------

/** A ten-alias table at the size an operator's box actually reaches. */
const BIG_ALIASES = {
  'default-big': {
    targets: [
      { host: 'local', model: 'unsloth_Qwen3-Coder-Next-GGUF-UD-Q4_K_XL' },
      { host: 'pomrath', model: 'qwen3-coder-next' },
      { host: 'drakemore', model: 'qwen3-coder-next:latest' }
    ],
    gpu: 'rtx3090',
    gpuPriority: 25
  },
  'default-small': {
    targets: [{ host: 'local', model: 'Qwen_Qwen3-8B-GGUF' }],
    gpu: 'apu'
  },
  'conversational-model': {
    targets: [
      { host: 'borethrax', model: 'gemma4:12b' },
      { host: 'local', model: 'gemma-4-12b' }
    ]
  },
  'podcast': {
    targets: [{ host: 'local', model: 'Qwen_Qwen3.8-Flash-Next-GGUF-Q5_K_M' }],
    gpu: 'apu',
    gpuPriority: -10
  },
  'vision': {
    targets: [
      { host: 'local', model: 'google_gemma-4-27b-it-qat-GGUF-Q4_0' },
      { host: 'pomrath', model: 'gemma-4-27b' },
      { host: 'drakemore', model: 'gemma4:27b' },
      { host: 'borethrax', model: 'gemma4:27b-it-qat' }
    ],
    gpu: 'rtx3090',
    gpuPriority: 0
  },
  'embed': { targets: [{ host: 'local', model: 'nomic-embed-text-v1.5' }] },
  'coder-fast': {
    targets: [
      { host: 'local', model: 'Qwen_Qwen3-8B-GGUF' },
      { host: 'pomrath', model: 'qwen3:8b' }
    ],
    gpu: 'workstation'
  },
  'nightly-batch': {
    targets: [{ host: 'local', model: 'unsloth_Qwen3-Coder-Next-GGUF-UD-Q4_K_XL' }],
    gpu: 'apu',
    gpuPriority: -40
  },
  'ds4': { targets: [{ host: 'local', model: 'ds4-flash' }], gpu: 'apu' },
  'retired': { targets: [{ host: 'dahaka-ollama-mngx88pk', model: 'llama3.1:70b-instruct-q4_K_M' }], gpu: 'retired-3090' }
};

/** The GPU pool ids that exist on the box the fixture describes. */
const GPU_IDS = ['apu', 'rtx3090', 'workstation'];

/** The full inventory, GPU pools included, for the alias-level checks. */
const GPU_INVENTORY = { ...INVENTORY, backendIds: ['pomrath', 'drakemore', 'borethrax'], gpuIds: GPU_IDS };

test('aliasesToRows still emits one row per TARGET across a ten-alias table', () => {
  const rows = aliasesToRows(BIG_ALIASES);
  const targetCount = Object.values(BIG_ALIASES).reduce((n, g) => n + g.targets.length, 0);

  assert.equal(targetCount, 17, 'fixture sanity: this is not a one-alias test');
  assert.equal(rows.length, targetCount);
  assert.equal(new Set(rows.map(r => r.rowId)).size, rows.length);
});

test('aliasGroups collapses those rows to exactly ONE entry per alias', () => {
  const groups = aliasGroups(aliasesToRows(BIG_ALIASES));

  assert.equal(groups.length, Object.keys(BIG_ALIASES).length);
  assert.deepEqual(groups.map(g => g.name), Object.keys(BIG_ALIASES), 'alias order must be preserved');
  for (const group of groups) {
    assert.equal(group.rows.length, BIG_ALIASES[group.name].targets.length);
    assert.equal(typeof group.gpu, 'string', 'one gpu value per alias, not one per target');
    assert.equal(typeof group.gpuPriority, 'string');
  }
});

test('a four-target alias shows one GPU and one priority, not four', () => {
  const vision = aliasGroups(aliasesToRows(BIG_ALIASES)).find(g => g.name === 'vision');

  assert.equal(vision.rows.length, 4);
  assert.equal(vision.gpu, 'rtx3090');
  assert.equal(vision.gpuPriority, '0');
  assert.equal(new Set(vision.rows.map(r => r.gpu)).size, 1,
    'every row of an alias must carry the same value, so any of them can be edited');
});

test('aliasGroups keeps target order inside each alias', () => {
  const big = aliasGroups(aliasesToRows(BIG_ALIASES)).find(g => g.name === 'default-big');
  assert.deepEqual(big.rows.map(r => r.host), ['local', 'pomrath', 'drakemore']);
});

test('an alias with no GPU groups to blank strings, never undefined', () => {
  const conv = aliasGroups(aliasesToRows(BIG_ALIASES)).find(g => g.name === 'conversational-model');
  assert.equal(conv.gpu, '');
  assert.equal(conv.gpuPriority, '');
});

test('a freshly added blank target does NOT wipe its alias GPU', () => {
  const rows = aliasesToRows(BIG_ALIASES);
  // The component inserts a new target with blank fields; if grouping read row 0
  // blindly, inserting one at the top would silently clear the pool.
  const visionAt = rows.findIndex(r => r.aliasName === 'vision');
  rows.splice(visionAt, 0, { rowId: 900, aliasName: 'vision', host: 'local', model: '', gpu: '', gpuPriority: '' });

  const vision = aliasGroups(rows).find(g => g.name === 'vision');
  assert.equal(vision.gpu, 'rtx3090');
  assert.equal(vision.rows.length, 5);
});

test('editing the GPU on any one row moves the whole alias', () => {
  const rows = aliasesToRows(BIG_ALIASES).map(r =>
    r.aliasName === 'vision' ? { ...r, gpu: 'apu', gpuPriority: '80' } : r);

  const out = rowsToAliases(rows);
  assert.equal(out.vision.gpu, 'apu');
  assert.equal(out.vision.gpuPriority, 80);
  assert.equal(out.vision.targets.length, 4, 'the targets are untouched by a GPU edit');
});

test('aliasGroups survives junk and an empty table', () => {
  assert.deepEqual(aliasGroups(null), []);
  assert.deepEqual(aliasGroups([]), []);
  assert.deepEqual(aliasGroups('nope'), []);
});

test('rowsToAliases round-trips every alias-level field across the whole table', () => {
  const out = rowsToAliases(aliasesToRows(BIG_ALIASES));
  assert.deepEqual(out, BIG_ALIASES, 'a load-then-save with no edits must reproduce the table exactly');
});

test('AN ALIAS WITH NO GPU PUTS EXACTLY WHAT IT PUT BEFORE', () => {
  const out = rowsToAliases(aliasesToRows(BIG_ALIASES));

  for (const name of ['conversational-model', 'embed']) {
    assert.deepEqual(Object.keys(out[name]), ['targets'],
      `${name} must carry no gpu/gpuPriority keys at all`);
    assert.deepEqual(out[name], { targets: BIG_ALIASES[name].targets });
    // The exact PUT body the component sends.
    assert.equal(JSON.stringify(out[name]), JSON.stringify({ targets: BIG_ALIASES[name].targets }));
  }
});

test('the pre-GPU fixture is byte-identical through the new code path', () => {
  const out = rowsToAliases(aliasesToRows(snapshot()));
  assert.deepEqual(out, ALIASES);
  for (const group of Object.values(out)) assert.deepEqual(Object.keys(group), ['targets']);
});

test('a priority of 0 is kept, not dropped as falsy', () => {
  const out = rowsToAliases([{ rowId: 1, aliasName: 'a', host: 'local', model: 'm', gpu: 'apu', gpuPriority: '0' }]);
  assert.equal(out.a.gpuPriority, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(out.a, 'gpuPriority'));
});

test('a negative priority is kept as a signed number, not a string', () => {
  const out = rowsToAliases(aliasesToRows(BIG_ALIASES));
  assert.equal(out['nightly-batch'].gpuPriority, -40);
  assert.equal(typeof out['nightly-batch'].gpuPriority, 'number');
});

test('a blank priority is absent, so the pool default applies', () => {
  const out = rowsToAliases([{ rowId: 1, aliasName: 'a', host: 'local', model: 'm', gpu: 'apu', gpuPriority: '' }]);
  assert.deepEqual(Object.keys(out.a), ['targets', 'gpu']);
});

test('a half-typed priority never reaches the API as a string', () => {
  const out = rowsToAliases([{ rowId: 1, aliasName: 'a', host: 'local', model: 'm', gpu: 'apu', gpuPriority: '-' }]);
  assert.ok(!Object.prototype.hasOwnProperty.call(out.a, 'gpuPriority'));
});

test('changing ONLY the GPU marks the alias changed', () => {
  const original = structuredClone(BIG_ALIASES);
  const edited = rowsToAliases(aliasesToRows(BIG_ALIASES).map(r =>
    r.aliasName === 'podcast' ? { ...r, gpu: 'rtx3090' } : r));

  const { changed, removed } = diffAliases(original, edited);
  assert.deepEqual(changed, ['podcast'], 'a GPU-only edit must not be silently discarded');
  assert.deepEqual(removed, []);
});

test('changing ONLY the priority marks the alias changed', () => {
  const edited = rowsToAliases(aliasesToRows(BIG_ALIASES).map(r =>
    r.aliasName === 'podcast' ? { ...r, gpuPriority: '-11' } : r));
  assert.deepEqual(diffAliases(structuredClone(BIG_ALIASES), edited).changed, ['podcast']);
});

test('clearing a GPU back to "anywhere" marks the alias changed', () => {
  const edited = rowsToAliases(aliasesToRows(BIG_ALIASES).map(r =>
    r.aliasName === 'ds4' ? { ...r, gpu: '' } : r));

  assert.deepEqual(diffAliases(structuredClone(BIG_ALIASES), edited).changed, ['ds4']);
  assert.deepEqual(Object.keys(edited.ds4), ['targets']);
});

test('a ten-alias table with no edits at all writes nothing', () => {
  const edited = rowsToAliases(aliasesToRows(BIG_ALIASES));
  assert.deepEqual(diffAliases(structuredClone(BIG_ALIASES), edited), { changed: [], removed: [] });
});

test('an alias naming a pool that does not exist is an error, once per alias', () => {
  const issues = validateRows(aliasesToRows(BIG_ALIASES), GPU_INVENTORY);
  const gpuIssues = issues.filter(i => i.field === 'gpu');

  assert.equal(gpuIssues.length, 1, 'one issue for the alias, not one per target row');
  assert.equal(gpuIssues[0].level, 'error');
  assert.match(gpuIssues[0].message, /retired-3090/);
});

test('a bad pool on a four-target alias is still reported exactly once', () => {
  const rows = aliasesToRows(BIG_ALIASES).map(r =>
    r.aliasName === 'vision' ? { ...r, gpu: 'nope' } : r);

  const gpuIssues = validateRows(rows, GPU_INVENTORY).filter(i => i.field === 'gpu');
  assert.equal(gpuIssues.length, 2, 'vision and the pre-existing retired alias');
  assert.equal(gpuIssues.filter(i => i.message.includes('nope')).length, 1);
});

test('the GPU checks are skipped entirely until the pool list has loaded', () => {
  const issues = validateRows(aliasesToRows(BIG_ALIASES), INVENTORY);
  assert.deepEqual(issues.filter(i => i.field === 'gpu' || i.field === 'gpuPriority'), [],
    'an alias must not be accused of naming an unknown pool while the pools are still loading');
});

test('every configured pool validates clean, including priority 0 and negatives', () => {
  const rows = aliasesToRows(BIG_ALIASES).filter(r => r.aliasName !== 'retired');
  const issues = validateRows(rows, GPU_INVENTORY)
    .filter(i => (i.field === 'gpu' || i.field === 'gpuPriority') && i.level === 'error');
  assert.deepEqual(issues, []);
});

test('a non-integer GPU priority is an error', () => {
  const rows = [{ rowId: 5, aliasName: 'a', host: 'local', model: 'm', gpu: 'apu', gpuPriority: 'high' }];
  const found = issuesFor(validateRows(rows, GPU_INVENTORY), 5).filter(i => i.field === 'gpuPriority');

  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  found.forEach(assertIssueShape);
});

test('a priority with no pool is a warning — it has nothing to apply to', () => {
  const rows = [{ rowId: 6, aliasName: 'a', host: 'local', model: 'm', gpu: '', gpuPriority: '25' }];
  const found = issuesFor(validateRows(rows, GPU_INVENTORY), 6).filter(i => i.field === 'gpuPriority');

  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'warning', 'the operator may be about to pick a pool');
});

test('alias-level issues are pinned to the alias FIRST row, where the control lives', () => {
  const rows = aliasesToRows(BIG_ALIASES);
  const firstRetiredRow = rows.find(r => r.aliasName === 'retired');
  const gpuIssue = validateRows(rows, GPU_INVENTORY).find(i => i.field === 'gpu');

  assert.equal(gpuIssue.rowId, firstRetiredRow.rowId);
});

test('target-level validation is unaffected by the alias-level fields', () => {
  const rows = aliasesToRows(BIG_ALIASES);
  const issues = validateRows(rows, GPU_INVENTORY);

  // 'dahaka-ollama-mngx88pk' is not in this inventory's backends.
  const hostWarnings = issues.filter(i => i.field === 'host');
  assert.equal(hostWarnings.length, 1);
  assert.equal(hostWarnings[0].level, 'warning');
  assert.deepEqual(issues.filter(i => i.field === 'model'), [], 'no duplicate targets in the fixture');
});
