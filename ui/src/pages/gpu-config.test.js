// Llama Manager GPU pool editor state tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the pure helpers behind the Settings > GPUs tab: flattening the
// settings pool array into editable rows and folding it back without gaining
// defaulted keys, validation mirroring the server's normalizePoolConfig, the
// join against the live /api/gpus readout that must make an empty or warned pool
// read as a PROBLEM rather than as a blank, and the pool choices the alias GPU
// picker offers — including the pool an alias names that no longer exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  poolsToRows,
  rowsToPools,
  validatePoolRows,
  poolLiveState,
  gpuPoolChoices,
  parsePinnedModels,
  formatPinnedModels,
  GPU_MATCH_SELECTORS,
} from './gpu-config.js';

/**
 * A settings `gpus` array with every shape the editor must survive: a fully
 * populated pool, one carrying only an id and a class, one matched by product
 * name, one matched by PCI address, one with a negative default priority, and one
 * with no selectors at all.
 */
const SETTINGS_GPUS = [
  {
    id: 'rtx3090',
    label: 'RTX 3090 (OCuLink)',
    match: { pciId: '10de:2204' },
    pinnedModels: ['llama-3.1-8b', 'unsloth_Qwen3-Coder-Next-GGUF-UD-Q4_K_XL'],
    defaultPriority: 25,
  },
  { id: 'apu', match: { pciId: '1002:1586' } },
  { id: 'workstation', label: 'The big one', match: { name: 'RTX 6000 Ada' } },
  { id: 'slot-pinned', match: { pci: '0000:c6:00.0' }, defaultPriority: -10 },
  { id: 'ghost', label: 'Never wired up', match: {} },
];

/**
 * The `/api/gpus` readout for those pools on a machine that only really has the
 * APU: one healthy pool, one that matched a card with no driver bound, one that
 * matched nothing at all, one contested between two pools, and one absent
 * entirely because it has not been saved.
 */
const LIVE_GPUS = [
  {
    id: 'apu',
    label: 'apu',
    capacity: 1,
    free: 0,
    held: [{ id: 'r1', gpu: 'apu', card: 'card1', holder: 'llama-manager', priority: 0, state: 'held' }],
    pending: [],
    warnings: [],
    pinnedModels: [],
    defaultPriority: 0,
    cards: [{
      card: 'card1', pci: '0000:c6:00.0', name: 'AMD Device 1586', driver: 'amdgpu',
      available: true, vramBytes: 1073741824, vramUsedBytes: 345096192, busyPercent: 100, free: false,
    }],
  },
  {
    id: 'rtx3090',
    label: 'RTX 3090 (OCuLink)',
    capacity: 0,
    free: 0,
    held: [],
    pending: [],
    warnings: ['GPU pool "rtx3090" matches a card with no kernel driver bound, so it has no usable capacity'],
    pinnedModels: ['llama-3.1-8b'],
    defaultPriority: 25,
    cards: [{
      card: 'card0', pci: '0000:03:00.0', name: 'NVIDIA GeForce RTX 3090', driver: null,
      available: false, vramBytes: 25757220864, vramUsedBytes: null, busyPercent: null, free: true,
    }],
  },
  {
    id: 'workstation',
    label: 'The big one',
    capacity: 0, free: 0, held: [], pending: [],
    warnings: ['GPU pool "workstation" matches no card present in this machine'],
    pinnedModels: [], defaultPriority: 0, cards: [],
  },
  {
    id: 'slot-pinned',
    label: 'slot-pinned',
    capacity: 0, free: 0, held: [], pending: [],
    warnings: ['GPU pools "apu" and "slot-pinned" both match card1; it is assigned to "apu" because it is first in the settings order'],
    pinnedModels: [], defaultPriority: -10, cards: [],
  },
  {
    id: 'ghost',
    label: 'Never wired up',
    capacity: 0, free: 0, held: [], pending: [],
    warnings: ['GPU pool "ghost" has no match selectors, so it matches no card; name a pciId, name or pci to give it one'],
    pinnedModels: [], defaultPriority: 0, cards: [],
  },
];

/** Every issue reported against one row. */
const issuesFor = (issues, rowId) => issues.filter(i => i.rowId === rowId);

test('poolsToRows emits one row per pool, in settings order, with unique ids', () => {
  const rows = poolsToRows(SETTINGS_GPUS);

  assert.equal(rows.length, SETTINGS_GPUS.length);
  assert.deepEqual(rows.map(r => r.id), ['rtx3090', 'apu', 'workstation', 'slot-pinned', 'ghost']);
  assert.equal(new Set(rows.map(r => r.rowId)).size, rows.length, 'rowIds must be unique React keys');
});

test('poolsToRows splits the match selectors into their own string fields', () => {
  const [rtx, apu, workstation, slot] = poolsToRows(SETTINGS_GPUS);

  assert.equal(rtx.pciId, '10de:2204');
  assert.equal(rtx.name, '');
  assert.equal(rtx.pci, '');
  assert.equal(apu.pciId, '1002:1586');
  assert.equal(workstation.name, 'RTX 6000 Ada');
  assert.equal(slot.pci, '0000:c6:00.0');
  for (const selector of GPU_MATCH_SELECTORS) {
    assert.equal(typeof rtx[selector], 'string', `${selector} must be a string an input can hold`);
  }
});

test('poolsToRows renders pins and priority as editable text, blank when absent', () => {
  const [rtx, apu] = poolsToRows(SETTINGS_GPUS);

  assert.equal(rtx.pinnedModels, 'llama-3.1-8b, unsloth_Qwen3-Coder-Next-GGUF-UD-Q4_K_XL');
  assert.equal(rtx.defaultPriority, '25');
  assert.equal(apu.pinnedModels, '');
  assert.equal(apu.defaultPriority, '', 'an unset priority must be blank, not "0"');
});

test('a negative default priority survives the round trip as a number', () => {
  const rows = poolsToRows(SETTINGS_GPUS);
  const slot = rowsToPools(rows).find(p => p.id === 'slot-pinned');
  assert.equal(slot.defaultPriority, -10);
});

test('rowsToPools round-trips the settings array without gaining defaulted keys', () => {
  const out = rowsToPools(poolsToRows(SETTINGS_GPUS));

  assert.deepEqual(out.map(p => p.id), SETTINGS_GPUS.map(p => p.id));
  const apu = out.find(p => p.id === 'apu');
  assert.deepEqual(Object.keys(apu).sort(), ['id', 'match'],
    'a pool with no label, pins or priority must not gain those keys on save');
  assert.deepEqual(apu.match, { pciId: '1002:1586' });
});

test('rowsToPools omits a blank selector rather than sending an empty string', () => {
  const pools = rowsToPools([{ rowId: 1, id: 'x', pciId: '10de:2204', name: '  ', pci: '' }]);
  assert.deepEqual(pools[0].match, { pciId: '10de:2204' });
});

test('rowsToPools drops a row with no id — it has no handle to save under', () => {
  const pools = rowsToPools([
    { rowId: 1, id: '', pciId: '10de:2204' },
    { rowId: 2, id: '  ', name: 'RTX' },
    { rowId: 3, id: 'keep', pciId: '1002:1586' },
  ]);
  assert.deepEqual(pools.map(p => p.id), ['keep']);
});

test('rowsToPools trims and drops blank pinned models', () => {
  const pools = rowsToPools([{ rowId: 1, id: 'x', pciId: '10de:2204', pinnedModels: ' a , ,b\nc ,' }]);
  assert.deepEqual(pools[0].pinnedModels, ['a', 'b', 'c']);
});

test('pinned models survive a comma-and-newline round trip', () => {
  assert.deepEqual(parsePinnedModels('a,\nb'), ['a', 'b']);
  assert.equal(formatPinnedModels(['a', 'b']), 'a, b');
  assert.equal(formatPinnedModels(undefined), '');
  assert.deepEqual(parsePinnedModels(''), []);
});

test('poolsToRows and rowsToPools survive junk instead of an array', () => {
  assert.deepEqual(poolsToRows(null), []);
  assert.deepEqual(poolsToRows(undefined), []);
  assert.deepEqual(rowsToPools(null), []);
  assert.deepEqual(rowsToPools('nope'), []);
});

test('validatePoolRows is silent on a well-formed set of five pools', () => {
  const rows = poolsToRows(SETTINGS_GPUS).filter(r => r.id !== 'ghost');
  const errors = validatePoolRows(rows).filter(i => i.level === 'error');
  assert.deepEqual(errors, [], 'nothing the server would accept may be flagged as an error');
});

test('a blank pool id is an error — the id is the handle every caller uses', () => {
  const found = issuesFor(validatePoolRows([{ rowId: 7, id: '', pciId: '10de:2204' }]), 7);
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  assert.equal(found[0].field, 'id');
});

test('a duplicate pool id is an error, reported on the SECOND pool', () => {
  const rows = [
    { rowId: 1, id: 'apu', pciId: '1002:1586' },
    { rowId: 2, id: 'apu', pciId: '10de:2204' },
  ];
  const found = validatePoolRows(rows).filter(i => i.level === 'error');
  assert.equal(found.length, 1);
  assert.equal(found[0].rowId, 2);
  assert.match(found[0].message, /unique/i);
});

test('a malformed pciId is an error, and every legal spelling is accepted', () => {
  const bad = validatePoolRows([{ rowId: 1, id: 'x', pciId: '10de' }]).filter(i => i.level === 'error');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].field, 'pciId');

  for (const pciId of ['10de:2204', '0x10de:0x2204', '10DE:2204']) {
    const errors = validatePoolRows([{ rowId: 1, id: 'x', pciId }]).filter(i => i.level === 'error');
    assert.deepEqual(errors, [], `${pciId} must be accepted`);
  }
});

test('a non-integer default priority is an error; a negative one is not', () => {
  const bad = validatePoolRows([{ rowId: 1, id: 'x', pciId: '10de:2204', defaultPriority: '2.5' }]);
  assert.equal(bad.filter(i => i.level === 'error').length, 1);

  const alsoBad = validatePoolRows([{ rowId: 1, id: 'x', pciId: '10de:2204', defaultPriority: 'high' }]);
  assert.equal(alsoBad.filter(i => i.level === 'error').length, 1);

  const good = validatePoolRows([{ rowId: 1, id: 'x', pciId: '10de:2204', defaultPriority: '-40' }]);
  assert.deepEqual(good.filter(i => i.level === 'error'), []);
});

test('a pool with no selectors warns that it will match nothing, but does not block a save', () => {
  const found = validatePoolRows([{ rowId: 9, id: 'ghost' }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'warning');
  assert.match(found[0].message, /match no card/i);
});

test('poolLiveState reports a healthy pool with its capacity and holder', () => {
  const state = poolLiveState({ id: 'apu' }, LIVE_GPUS);

  assert.equal(state.status, 'ok');
  assert.equal(state.capacity, 1);
  assert.equal(state.free, 0);
  assert.equal(state.cards.length, 1);
  assert.equal(state.holders.length, 1);
  assert.match(state.summary, /llama-manager/);
});

test('a pool with capacity 0 is a PROBLEM, never a blank readout', () => {
  const state = poolLiveState({ id: 'rtx3090' }, LIVE_GPUS);

  assert.equal(state.status, 'problem');
  assert.equal(state.capacity, 0);
  assert.match(state.summary, /no usable card/i);
  assert.equal(state.warnings.length, 1, 'the server warning must be carried through to the operator');
});

test('every pool that matched nothing, lost its card, or named no selector is a problem', () => {
  for (const id of ['rtx3090', 'workstation', 'slot-pinned', 'ghost']) {
    const state = poolLiveState(id, LIVE_GPUS);
    assert.equal(state.status, 'problem', `${id} must render as a problem`);
    assert.ok(state.warnings.length > 0, `${id} must carry the reason`);
  }
});

test('a pool the operator just added reads as unsaved, not as broken', () => {
  const state = poolLiveState({ id: 'brand-new' }, LIVE_GPUS);
  assert.equal(state.status, 'unsaved');
  assert.match(state.summary, /not saved/i);
});

test('poolLiveState accepts a bare id and survives a missing readout', () => {
  assert.equal(poolLiveState('apu', LIVE_GPUS).status, 'ok');
  assert.equal(poolLiveState('apu', null).status, 'unsaved');
  assert.equal(poolLiveState(null, LIVE_GPUS).status, 'unsaved');
});

test('the alias GPU picker offers Anywhere first, then every live pool', () => {
  const choices = gpuPoolChoices(LIVE_GPUS, poolsToRows(SETTINGS_GPUS));

  assert.equal(choices[0].value, '', 'the absent-field case must come first');
  assert.match(choices[0].label, /anywhere/i);
  assert.deepEqual(
    choices.slice(1).map(c => c.value),
    ['apu', 'rtx3090', 'workstation', 'slot-pinned', 'ghost'],
    'every live pool must be offered exactly once'
  );
});

test('the picker flags the pools that cannot run anything, and only those', () => {
  const choices = gpuPoolChoices(LIVE_GPUS, []);
  const problems = choices.filter(c => c.problem).map(c => c.value);
  assert.deepEqual(problems, ['rtx3090', 'workstation', 'slot-pinned', 'ghost']);
  assert.equal(choices.find(c => c.value === 'apu').problem, false);
});

test('a pool an alias names but that no longer exists is still offered, marked unknown', () => {
  const choices = gpuPoolChoices(LIVE_GPUS, [], ['retired-3090']);
  const orphan = choices.find(c => c.value === 'retired-3090');

  assert.ok(orphan, 'dropping it would silently rewrite the alias to "anywhere"');
  assert.equal(orphan.problem, true);
  assert.match(orphan.label, /unknown/i);
});

test('a pool added in this session is selectable before it has been saved', () => {
  const choices = gpuPoolChoices(LIVE_GPUS, [{ rowId: 99, id: 'fresh', pciId: '10de:2204' }]);
  const fresh = choices.find(c => c.value === 'fresh');

  assert.ok(fresh);
  assert.equal(fresh.problem, true, 'it resolves to nothing until saved, so say so');
});

test('the picker never offers a duplicate or a blank pool id', () => {
  const choices = gpuPoolChoices(
    [...LIVE_GPUS, { id: 'apu', label: 'apu', capacity: 1, free: 1, held: [], warnings: [], cards: [] }],
    [{ rowId: 1, id: 'apu' }, { rowId: 2, id: '' }, { rowId: 3, id: '  ' }],
    ['apu', '']
  );
  const values = choices.map(c => c.value);
  assert.equal(new Set(values).size, values.length, 'ids must be offered once');
  assert.equal(values.filter(v => v === '').length, 1, 'only "Anywhere" may carry the empty value');
});

test('the picker degrades to just Anywhere when nothing has loaded yet', () => {
  assert.deepEqual(gpuPoolChoices(null).map(c => c.value), ['']);
  assert.deepEqual(gpuPoolChoices(undefined, undefined, undefined).map(c => c.value), ['']);
});
