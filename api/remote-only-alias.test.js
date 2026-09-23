// Llama Manager — tests for the remote-only alias fallback (remote-only-alias.js) and
// its wiring into resolveBackend() in server.js.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Regression for 2026-09-23: a request for the remote-only alias `default-big` arrived
// while Drakemore's circuit was open and Dahaka's queue was full. resolveBackend() found
// no free remote candidate and returned a LOCAL routing, so the raw alias name reached
// llama.cpp, which answered 400 "model 'default-big' not found" — a permanent-looking
// error for a transient "no member free right now" condition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { remoteOnlyAliasFallback } from './remote-only-alias.js';

const remoteOnly = { name: 'default-big', localTarget: null };

test('non-alias and locally-served aliases keep the local routing', () => {
  assert.deepEqual(remoteOnlyAliasFallback({ alias: null, members: [] }), { action: 'local' });
  assert.deepEqual(
    remoteOnlyAliasFallback({ alias: { name: 'default-small', localTarget: 'qwen3-8b' }, members: [] }),
    { action: 'local' },
  );
});

test('remote-only alias with every reachable member full queues on the least-loaded one', () => {
  const decision = remoteOnlyAliasFallback({
    alias: remoteOnly,
    members: [
      { id: 'dahaka', priority: 50, active: 1, pending: 3 },
      { id: 'other', priority: 50, active: 1, pending: 0 },
    ],
  });
  assert.deepEqual(decision, { action: 'queue', backendId: 'other' });
});

test('queue ties break on priority', () => {
  const decision = remoteOnlyAliasFallback({
    alias: remoteOnly,
    members: [
      { id: 'b', priority: 60, active: 1, pending: 0 },
      { id: 'a', priority: 10, active: 1, pending: 0 },
    ],
  });
  assert.equal(decision.backendId, 'a');
});

test('remote-only alias with no reachable member is a retryable 503, never a local forward', () => {
  const decision = remoteOnlyAliasFallback({ alias: remoteOnly, members: [] });
  assert.equal(decision.action, 'reject');
  assert.equal(decision.status, 503);
  assert.equal(decision.code, 'model_unavailable');
  assert.match(decision.message, /default-big/);
});

test('local_only on a remote-only alias is a non-retryable conflict, not a local forward', () => {
  const decision = remoteOnlyAliasFallback({
    alias: remoteOnly,
    localOnly: true,
    members: [{ id: 'dahaka', priority: 50, active: 0, pending: 0 }],
  });
  assert.equal(decision.action, 'reject');
  assert.equal(decision.status, 409);
  assert.equal(decision.code, 'ALIAS_REMOTE_ONLY');
});

test('server.js resolveBackend routes every local decision through the remote-only fallback', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('\nfunction resolveBackend(');
  assert.notEqual(start, -1, 'resolveBackend must exist');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /remoteOnlyAliasRouting\(/, 'resolveBackend must apply the remote-only alias fallback');
  // Embeddings previously ignored routing.blocked; a rejected alias must not fall through there either.
  const embStart = source.indexOf("resolveBackend(requestedModel, 'embeddings'");
  assert.notEqual(embStart, -1);
  assert.match(source.slice(embStart, embStart + 300), /routing\.blocked/, 'embeddings must honour routing.blocked');
});
