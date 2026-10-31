// Llama Manager — tests for remote-backend failover on a "can't serve right now" answer.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pins W2a (T32312b081981f): Frostburn forwarded default-big to drakemore, which answered
// 503 (exclusive Strata `exhausted`) for 12 days, and the chat/completions remote branch
// passed that 503 to the caller instead of trying the alias's other members. Covers the
// pure decision in remote-failover.js and, by source text (importing server.js boots the
// server), that the chat remote branch consults it and excludes the failed backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { remoteFailoverDecision } from './remote-failover.js';

const other = { remote: true, backend: { id: 'b2' } };
const local = { remote: false };

test('503/502/504/429 fail over to another remote member', () => {
  for (const status of [503, 502, 504, 429]) {
    assert.deepEqual(remoteFailoverDecision({ status, next: other }), { action: 'remote', routing: other });
  }
});

test('a failover-able status falls back to the local target when no remote is left', () => {
  assert.deepEqual(remoteFailoverDecision({ status: 503, next: local }), { action: 'local', routing: local });
});

test('client errors and 500s pass through: another backend would answer the same', () => {
  for (const status of [400, 401, 404, 413, 422, 500]) {
    assert.deepEqual(remoteFailoverDecision({ status, next: other }), { action: 'pass-through' });
  }
});

test('an output error (REASONING_EXHAUSTED etc.) passes through: the caller budget, not the backend', () => {
  // W4 measured 71 of 157 drakemore default-small 502s in 31 min were REASONING_EXHAUSTED.
  const body = JSON.stringify({ error: { type: 'upstream_output_error', code: 'REASONING_EXHAUSTED' } });
  assert.deepEqual(remoteFailoverDecision({ status: 502, body, next: other }), { action: 'pass-through' });
  const exclusive = JSON.stringify({ error: { type: 'exclusive_ds4_mode', code: 'exclusive_ds4_mode' } });
  assert.deepEqual(remoteFailoverDecision({ status: 503, body: exclusive, next: other }), { action: 'remote', routing: other });
  assert.deepEqual(remoteFailoverDecision({ status: 502, body: '<html>bad gateway</html>', next: other }), { action: 'remote', routing: other });
});

test('nowhere else to go passes the original error through', () => {
  assert.deepEqual(remoteFailoverDecision({ status: 503, next: null }), { action: 'pass-through' });
  assert.deepEqual(remoteFailoverDecision({ status: 503, next: { remote: false, blocked: true } }), { action: 'pass-through' });
});

test('no local fallback while an exclusive engine owns the box', () => {
  assert.deepEqual(remoteFailoverDecision({ status: 503, next: local, exclusiveActive: true }), { action: 'pass-through' });
  assert.deepEqual(remoteFailoverDecision({ status: 503, next: other, exclusiveActive: true }), { action: 'remote', routing: other });
});

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

test('chat/completions remote branch fails over with the failed backend excluded', () => {
  const start = source.indexOf('async function handleChatCompletions(');
  const body = source.slice(start, source.indexOf('// ===== LOCAL BACKEND PATH', start));
  assert.match(body, /remoteFailoverDecision\(/);
  assert.match(body, /body: error/, 'the upstream body reaches the decision');
  assert.match(body, /excludeBackendIds/);
  assert.match(body, /break remotePath/, 'a local failover must leave the remote block and run the local path');
});

test('routing honours excludeBackendIds in every remote member filter', () => {
  const route = source.slice(source.indexOf('function resolveBackendRoute('), source.indexOf('function buildRemoteRouting('));
  // hasViableRemote, the candidate filter and remoteOnlyAliasRouting's reachable list
  assert.ok((route.match(/excludeBackendIds\.has\(b\.id\)/g) || []).length >= 3);
});
