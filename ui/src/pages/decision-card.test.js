// Llama Manager decision engine card helper tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies which lifecycle action the dashboard offers on the Decision (Laya)
// server card: Stop while it runs, Start when idle-but-runnable, nothing when
// it is disabled or unrunnable, and nothing for any other server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionCardAction, parseGpuList, decisionConfigPatch } from './decision-card.js';

test('running decision engine offers Stop', () => {
  assert.deepEqual(decisionCardAction({ id: 'decision', state: 'running', running: true }), { label: 'Stop', path: '/decision/stop' });
});

test('idle runnable decision engine offers Start', () => {
  assert.deepEqual(decisionCardAction({ id: 'decision', state: 'idle', running: false }), { label: 'Start', path: '/decision/start' });
});

test('disabled decision engine and other servers offer nothing', () => {
  assert.equal(decisionCardAction({ id: 'decision', state: 'down', running: false, enable: { eligible: false } }), null);
  assert.equal(decisionCardAction({ id: 'llama', state: 'running', running: true }), null);
});

// W6-F1: variant + GPU list controls on the decision card.
test('parseGpuList: splits on commas and/or whitespace, trims, drops empties', () => {
  assert.deepEqual(parseGpuList('0, 1,2'), ['0', '1', '2']);
  assert.deepEqual(parseGpuList(' 0   1 '), ['0', '1']);
  assert.deepEqual(parseGpuList(''), []);
  assert.deepEqual(parseGpuList('   '), []);
  assert.deepEqual(parseGpuList(undefined), []);
});

test('decisionConfigPatch: builds a {variant, gpus} patch body, falling back to rocm for an unknown variant', () => {
  assert.deepEqual(decisionConfigPatch({ variant: 'cuda', gpus: '0,1' }), { variant: 'cuda', gpus: ['0', '1'] });
  assert.deepEqual(decisionConfigPatch({ variant: 'nvidia', gpus: '' }), { variant: 'rocm', gpus: [] });
});
