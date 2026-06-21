// Llama Manager — unit tests for api/slot-reaper.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLeakedSlots } from './slot-reaper.js';

const GRACE = 10_000;
const HARDCAP = 3_600_000;

// Helper: a held queue item.
const item = (o) => ({ id: o.id, activeReqId: o.activeReqId ?? null, startedAt: o.startedAt, model: o.model || 'm', endpoint: o.endpoint || 'chat/completions' });

test('chat leak: activeReqId set but request gone, held > grace => reaped', () => {
  const now = 100_000;
  const items = [item({ id: 1, activeReqId: 'a', startedAt: now - 20_000 })];
  const r = findLeakedSlots({ items, liveReqIds: new Set(), now, graceMs: GRACE, hardCapMs: HARDCAP });
  assert.deepEqual(r, [1]);
});

test('chat leak within grace => not yet reaped (avoid racing a pending release)', () => {
  const now = 100_000;
  const items = [item({ id: 1, activeReqId: 'a', startedAt: now - 3_000 })];
  const r = findLeakedSlots({ items, liveReqIds: new Set(), now, graceMs: GRACE, hardCapMs: HARDCAP });
  assert.deepEqual(r, []);
});

test('chat slot still tracked (request alive) => never reaped, even if old', () => {
  const now = 100_000;
  const items = [item({ id: 1, activeReqId: 'a', startedAt: now - 5_000_000 })];
  const r = findLeakedSlots({ items, liveReqIds: new Set(['a']), now, graceMs: GRACE, hardCapMs: HARDCAP });
  assert.deepEqual(r, []);
});

test('non-chat slot (activeReqId null) below hard cap => not reaped (could be legit prompt-processing)', () => {
  const now = 1_000_000;
  const items = [item({ id: 1, activeReqId: null, startedAt: now - 120_000 })];
  const r = findLeakedSlots({ items, liveReqIds: new Set(), now, graceMs: GRACE, hardCapMs: HARDCAP });
  assert.deepEqual(r, []);
});

test('non-chat slot at/over hard cap => reaped', () => {
  const now = 5_000_000;
  const items = [item({ id: 1, activeReqId: null, startedAt: now - HARDCAP - 1 })];
  const r = findLeakedSlots({ items, liveReqIds: new Set(), now, graceMs: GRACE, hardCapMs: HARDCAP });
  assert.deepEqual(r, [1]);
});

test('mixed set returns only the leaked ids', () => {
  const now = 1_000_000;
  const items = [
    item({ id: 1, activeReqId: 'live', startedAt: now - 50_000 }),   // tracked -> keep
    item({ id: 2, activeReqId: 'dead', startedAt: now - 50_000 }),   // chat leak -> reap
    item({ id: 3, activeReqId: null, startedAt: now - 50_000 }),     // non-chat, < hardcap -> keep
    item({ id: 4, activeReqId: null, startedAt: now - HARDCAP - 1 }) // non-chat, >= hardcap -> reap
  ];
  const r = findLeakedSlots({ items, liveReqIds: new Set(['live']), now, graceMs: GRACE, hardCapMs: HARDCAP });
  assert.deepEqual(r.sort(), [2, 4]);
});

test('falls back to enqueuedAt when startedAt missing', () => {
  const now = 100_000;
  const items = [{ id: 1, activeReqId: 'a', enqueuedAt: now - 20_000, endpoint: 'chat/completions' }];
  const r = findLeakedSlots({ items, liveReqIds: new Set(), now, graceMs: GRACE, hardCapMs: HARDCAP });
  assert.deepEqual(r, [1]);
});
