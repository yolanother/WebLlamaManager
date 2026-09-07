// Llama Manager — tests for the duo planner->worker->reviewer chain and its alias defaults.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUO_CHAIN_ID,
  duoChainSteps,
  buildPlanPrompt,
  buildExecutePrompt,
  buildReviewPrompt,
  duoAliasTargets,
  isDuoChainRequest,
  duoChainModelEntry,
} from './duo-chain.js';
import { DUO_PLANNER_ID, DUO_WORKER_ID } from './duo-exclusive.js';

test('the chain is plan -> execute -> review, in that order', () => {
  const steps = duoChainSteps();
  assert.deepEqual(steps.map(s => s.role), ['plan', 'execute', 'review']);
});

test('the slow model plans and reviews; the fast model executes', () => {
  const steps = duoChainSteps();
  const byRole = Object.fromEntries(steps.map(s => [s.role, s.model]));
  assert.equal(byRole.plan, DUO_PLANNER_ID, 'planning is the model that never fell for a trap');
  assert.equal(byRole.execute, DUO_WORKER_ID, 'execution is the fast model, ~3x the speed');
  assert.equal(byRole.review, DUO_PLANNER_ID, 'the reviewer must be the planner, not the worker');
});

test('every step names a model that duo actually keeps resident', () => {
  const resident = new Set([DUO_PLANNER_ID, DUO_WORKER_ID]);
  for (const s of duoChainSteps()) {
    assert.ok(resident.has(s.model), `${s.role} would force a model swap`);
  }
});

test('the plan prompt asks for exact steps, because the worker must not decide', () => {
  const p = buildPlanPrompt('Fix the failing test');
  assert.match(p, /Fix the failing test/);
  assert.match(p, /step/i);
});

test('the execute prompt carries the plan AND the original request', () => {
  const p = buildExecutePrompt('Fix the failing test', '1. Read the test\n2. Fix it');
  assert.match(p, /Fix the failing test/);
  assert.match(p, /1\. Read the test/);
});

test('the review prompt carries the request, the plan and the work', () => {
  const p = buildReviewPrompt('Fix it', 'the plan', 'the work done');
  assert.match(p, /Fix it/);
  assert.match(p, /the plan/);
  assert.match(p, /the work done/);
});

test('a green test suite is not proof — the reviewer is told to read the code', () => {
  // The lab result the source called the most worrying: code that passed every
  // test and was still wrong. The reviewer must not accept passing tests as done.
  const p = buildReviewPrompt('req', 'plan', 'work');
  assert.match(p, /test/i);
});

test('default-big points at the duo chain, not at a bare model', () => {
  const t = duoAliasTargets();
  assert.deepEqual(t['default-big'], [{ host: 'local', model: DUO_CHAIN_ID }]);
});

test('default-small points DIRECTLY at the duo worker, so it is already hot', () => {
  const t = duoAliasTargets();
  assert.deepEqual(t['default-small'], [{ host: 'local', model: DUO_WORKER_ID }]);
});

test('both aliases resolve to models duo keeps resident — neither causes a swap', () => {
  const t = duoAliasTargets();
  const resident = new Set([DUO_PLANNER_ID, DUO_WORKER_ID, DUO_CHAIN_ID]);
  for (const [name, targets] of Object.entries(t)) {
    for (const target of targets) {
      assert.equal(target.host, 'local', `${name} must stay local`);
      assert.ok(resident.has(target.model), `${name} -> ${target.model} is not resident under duo`);
    }
  }
});

test('recognises a request for the chain, tolerantly', () => {
  assert.equal(isDuoChainRequest('duo'), true);
  assert.equal(isDuoChainRequest('DUO'), true);
  assert.equal(isDuoChainRequest(' duo '), true);
  assert.equal(isDuoChainRequest(DUO_WORKER_ID), false, 'the worker alone is not the chain');
  assert.equal(isDuoChainRequest(''), false);
  assert.equal(isDuoChainRequest(null), false);
});

test('the chain appears as a selectable model only when BOTH weights are present', () => {
  assert.equal(duoChainModelEntry({ plannerExists: true, workerExists: true }).name, DUO_CHAIN_ID);
  assert.equal(duoChainModelEntry({ plannerExists: true, workerExists: false }), null);
  assert.equal(duoChainModelEntry({ plannerExists: false, workerExists: true }), null);
  assert.equal(duoChainModelEntry({}), null);
});

test('the chain entry is marked virtual so nothing treats it as a file on disk', () => {
  const e = duoChainModelEntry({ plannerExists: true, workerExists: true });
  assert.equal(e.virtual, true);
  assert.equal(e.path, null);
  assert.equal(e.size, 0);
  assert.match(e.displayName, /plan/i);
});
