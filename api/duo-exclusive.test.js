// Llama Manager — tests for duo mode's exclusivity and two-model memory budget.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUO_EXCLUSIVE_ERROR,
  DUO_PLANNER_ID,
  DUO_WORKER_ID,
  duoModelIds,
  duoBudgetBytes,
  duoRequestTarget,
  duoVsDs4Decision,
} from './duo-exclusive.js';

const GB = 1024 * 1024 * 1024;

// The real pair: 81.96 GB planner + 22.36 GB worker.
const PLANNER_BYTES = 81_961_823_936;
const WORKER_BYTES = 22_360_456_160;

test('duo model ids cover both halves of the pair', () => {
  const ids = duoModelIds();
  assert.ok(ids.includes(DUO_PLANNER_ID));
  assert.ok(ids.includes(DUO_WORKER_ID));
});

test('budget sums BOTH models plus KV and headroom — the thing that differs from ds4', () => {
  const b = duoBudgetBytes({
    plannerBytes: PLANNER_BYTES,
    workerBytes: WORKER_BYTES,
    kvBytes: 4 * GB,
    headroomBytes: 2 * GB,
  });
  assert.equal(b, PLANNER_BYTES + WORKER_BYTES + 6 * GB);
});

test('budget never goes negative and tolerates missing parts', () => {
  assert.equal(duoBudgetBytes({}), 0);
  assert.equal(duoBudgetBytes({ plannerBytes: -5 }), 0);
});

// The pair is 104.3 DECIMAL GB but 97.2 GiB, and the box reports 124 GiB. Mixing the
// two units understates the headroom badly, so this pins the real arithmetic.
test('the real pair fits a 124 GiB box alone, but cannot share it with ds4', () => {
  const BOX = 124 * GB;
  const DS4_BYTES = 81 * GB; // DeepSeek-V4-Flash, the peer that duo evicts
  const b = duoBudgetBytes({
    plannerBytes: PLANNER_BYTES,
    workerBytes: WORKER_BYTES,
    kvBytes: 8 * GB,
    headroomBytes: 8 * GB,
  });

  // ~113.2 GiB: duo alone fits, with room to spare for page cache.
  assert.ok(b < BOX, `budget ${b} must fit the box alone`);
  assert.ok(b > 110 * GB, `budget ${b} should be ~113 GiB, not the 104 a GB/GiB mixup implies`);

  // But adding ds4 blows straight past it — which is why duo is exclusive.
  assert.ok(b + DS4_BYTES > BOX, 'duo beside ds4 must not fit, or exclusivity is unjustified');
});

test('a request for either duo model is served locally', () => {
  const ids = duoModelIds();
  assert.equal(duoRequestTarget({ requestedModel: DUO_PLANNER_ID, duoModelIds: ids }).target, 'local-duo');
  assert.equal(duoRequestTarget({ requestedModel: DUO_WORKER_ID, duoModelIds: ids }).target, 'local-duo');
});

test('another model offloads to a remote when one exists, rather than evicting duo', () => {
  const d = duoRequestTarget({
    requestedModel: 'some-other-model',
    duoModelIds: duoModelIds(),
    hasViableRemote: true,
  });
  assert.equal(d.target, 'remote');
});

test('another model with no remote is rejected clearly, never queued forever', () => {
  const d = duoRequestTarget({
    requestedModel: 'some-other-model',
    duoModelIds: duoModelIds(),
    hasViableRemote: false,
  });
  assert.equal(d.target, 'reject');
  assert.match(d.reason, /duo/);
});

test('selecting duo evicts ds4', () => {
  const d = duoVsDs4Decision({ selecting: 'duo', ds4Active: true, duoActive: false });
  assert.equal(d.evict, 'ds4');
});

test('selecting ds4 evicts duo — the rule runs both ways', () => {
  const d = duoVsDs4Decision({ selecting: 'ds4', ds4Active: false, duoActive: true });
  assert.equal(d.evict, 'duo');
});

test('selecting what is already active evicts nothing', () => {
  assert.equal(duoVsDs4Decision({ selecting: 'duo', duoActive: true }).evict, null);
  assert.equal(duoVsDs4Decision({ selecting: 'ds4', ds4Active: true }).evict, null);
});

test('exposes a stable error code for the 503 body', () => {
  assert.equal(DUO_EXCLUSIVE_ERROR, 'exclusive_duo_mode');
});
