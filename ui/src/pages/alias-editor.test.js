// Llama Manager model-alias editor state tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the pure state helpers behind the Settings > Aliases tab: flattening
// an alias map into editable target rows and rebuilding it from them, diffing
// edited groups against the loaded snapshot so only changed aliases are PUT and
// deleted ones are removed, and per-row validation mirroring the server-side
// validateAlias rules for inline UI errors and warnings.

import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasesToRows, rowsToAliases, diffAliases, validateRows } from './alias-editor.js';

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
  assert.ok(['aliasName', 'host', 'model'].includes(issue.field), `unexpected field ${issue.field}`);
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
