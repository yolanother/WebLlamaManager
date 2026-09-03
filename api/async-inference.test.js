// Llama Manager — executable contract tests for retained async inference jobs.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify the public, scope-isolated job registry used by the HTTP
// submit, poll, and cancel routes. They cover lifecycle visibility, bounded
// retention, completion validation, policy forwarding, and cancellation without
// depending on the server's internal scheduling or routing implementation.

import assert from 'node:assert/strict';
import test from 'node:test';

import { InferenceJobStore } from './async-inference.js';

/** Return a promise whose settlement is controlled by the test. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Yield until an observable condition is true, failing after a bounded loop. */
async function waitFor(check, message = 'condition did not become true') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

/** Build a valid OpenAI-shaped non-streaming result. */
function completion(content = 'Complete answer') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'gemma-real',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
  };
}

/** Build the smallest valid job request used by quota-focused tests. */
function requestBody(extra = {}) {
  return {
    model: 'voice-fast',
    messages: [{ role: 'user', content: 'hello' }],
    ...extra,
  };
}

/** Read a header from either a Headers instance or a plain object. */
function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

/** Assert a synchronous submit-time HTTP error without fixing its class name. */
function assertSubmitError(run, status) {
  assert.throws(run, error => (error?.statusCode ?? error?.status) === status);
}

test('contracts 1 and 4: submit exposes queued/running only, then one complete result', async () => {
  const execution = deferred();
  const store = new InferenceJobStore({
    createId: () => 'job_opaque_test_handle',
    execute: () => execution.promise,
  });

  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
  assert.deepEqual(submitted, {
    id: 'job_opaque_test_handle',
    object: 'inference.job',
    status: 'queued',
    createdAt: submitted.createdAt,
    updatedAt: submitted.updatedAt,
    expiresAt: null,
    progress: { phase: 'queued', percent: null },
    result: null,
    error: null,
  });
  assert.equal(submitted.id.includes('scope_a'), false);

  const running = await waitFor(() => {
    const record = store.get(submitted.id, 'scope_a');
    return record?.status === 'running' ? record : null;
  }, 'accepted work never entered running');
  assert.deepEqual(running.progress, { phase: 'running', percent: null });
  assert.equal(running.result, null, 'active jobs must not leak partial output');
  assert.equal(running.error, null);

  const expected = completion();
  execution.resolve({ status: 200, body: expected });
  const done = await waitFor(() => {
    const record = store.get(submitted.id, 'scope_a');
    return record?.status === 'done' ? record : null;
  });
  assert.deepEqual(done.progress, { phase: 'done', percent: null });
  assert.deepEqual(done.result, expected);
  assert.equal(done.error, null);
  assert.ok(Number.isFinite(done.expiresAt));
});

test('contract 2: malformed, streaming, and over-4-MiB submissions fail before execution', () => {
  let executions = 0;
  const store = new InferenceJobStore({ execute: async () => { executions++; return { status: 200, body: completion() }; } });

  for (const body of [null, {}, { model: 'gemma' }, { messages: [] }, requestBody({ stream: true })]) {
    assertSubmitError(() => store.submit({ scopeId: 'scope_a', body, headers: {} }), 400);
  }
  assertSubmitError(() => store.submit({
    scopeId: 'scope_a',
    body: requestBody({ metadata: 'x'.repeat(4 * 1024 * 1024) }),
    headers: {},
  }), 413);
  assert.equal(executions, 0);
});

test('contract 3: execution receives only the retained body, authorization, priority, and routing policy', async () => {
  let captured;
  const store = new InferenceJobStore({
    execute: async input => {
      captured = input;
      return { status: 200, body: completion('same observable result') };
    },
  });
  const body = requestBody({ temperature: 0.25, prepared_context_id: 'ctx_private' });
  const job = store.submit({
    scopeId: 'scope_a',
    body,
    headers: {
      authorization: 'Bearer tenant-secret',
      'x-llama-priority': 'background',
      'x-llama-routing': 'local_only',
      cookie: 'session=must-not-be-retained',
      'x-unrelated': 'must-not-be-replayed',
    },
  });

  await waitFor(() => captured);
  assert.deepEqual(captured.body, body);
  assert.equal(headerValue(captured.headers, 'authorization'), 'Bearer tenant-secret');
  assert.equal(headerValue(captured.headers, 'x-llama-priority'), 'background');
  assert.equal(headerValue(captured.headers, 'x-llama-routing'), 'local_only');
  assert.equal(headerValue(captured.headers, 'cookie'), undefined);
  assert.equal(headerValue(captured.headers, 'x-unrelated'), undefined);

  const done = await waitFor(() => store.get(job.id, 'scope_a')?.status === 'done' && store.get(job.id, 'scope_a'));
  const publicJson = JSON.stringify(done);
  for (const secret of ['tenant-secret', 'ctx_private', 'session=must-not-be-retained']) {
    assert.equal(publicJson.includes(secret), false, `${secret} leaked through public job metadata`);
  }
  assert.equal(Object.hasOwn(done, 'body'), false);
  assert.equal(Object.hasOwn(done, 'headers'), false);
  assert.equal(Object.hasOwn(done, 'scopeId'), false);
});

test('contract 4: handles are capability references hidden across scopes and after expiry', async () => {
  let now = 1_000;
  const store = new InferenceJobStore({
    now: () => now,
    createId: () => 'job_scope_bound',
    execute: async () => ({ status: 200, body: completion() }),
  });
  const job = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });

  assert.equal(store.get('job_missing', 'scope_a'), null);
  assert.equal(store.get(job.id, 'scope_b'), null);
  assert.equal(store.cancel('job_missing', 'scope_a'), null);
  assert.equal(store.cancel(job.id, 'scope_b'), null);
  const done = await waitFor(() => store.get(job.id, 'scope_a')?.status === 'done' && store.get(job.id, 'scope_a'));
  assert.equal(done.expiresAt, now + 60 * 60_000);
  now = done.expiresAt + 1;
  assert.equal(store.get(job.id, 'scope_a'), null);
});

test('contract 5: HTTP, transport, plain-text, oversized, and invalid-empty outcomes are failed records', async () => {
  const huge = 'backend diagnostic '.repeat(500);
  const cases = [
    {
      name: 'HTTP',
      execute: async () => ({ status: 503, body: { error: { message: huge, type: 'backend_error', code: 'MODEL_LOAD_FAILED' } } }),
      expectedStatus: 503,
    },
    { name: 'transport', execute: async () => { throw new Error(huge); } },
    { name: 'plain text', execute: async () => ({ status: 502, body: huge }), expectedStatus: 502 },
    {
      name: 'oversized result',
      execute: async () => ({ status: 200, body: completion('x'.repeat(1_000)) }),
      maxResultBytes: 200,
      expectedCode: 'result_too_large',
    },
    {
      name: 'invalid empty completion',
      execute: async () => ({ status: 200, body: { id: 'chatcmpl-empty', choices: [] } }),
      expectedCode: 'invalid_upstream_response',
    },
  ];

  for (const scenario of cases) {
    const store = new InferenceJobStore({
      execute: scenario.execute,
      ...(scenario.maxResultBytes ? { maxResultBytes: scenario.maxResultBytes } : {}),
    });
    const job = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
    const failed = await waitFor(() => store.get(job.id, 'scope_a')?.status === 'failed' && store.get(job.id, 'scope_a'), scenario.name);

    assert.equal(failed.result, null, `${scenario.name} became an empty success`);
    assert.equal(failed.progress.phase, 'failed');
    assert.equal(typeof failed.error.message, 'string');
    assert.ok(failed.error.message.length > 0 && failed.error.message.length <= 1_024);
    assert.equal(typeof failed.error.type, 'string');
    assert.equal(typeof failed.error.code, 'string');
    if (scenario.expectedStatus) assert.equal(failed.error.status, scenario.expectedStatus);
    if (scenario.expectedCode) assert.equal(failed.error.code, scenario.expectedCode);
    assert.ok(JSON.stringify(failed).length < 3_000, `${scenario.name} retained an unbounded failure`);
  }
});

test('contract 6: cancelling queued work is immediate, terminal, and idempotent', async () => {
  let calls = 0;
  const store = new InferenceJobStore({
    execute: async () => { calls++; return { status: 200, body: completion() }; },
  });
  const job = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });

  const cancelled = store.cancel(job.id, 'scope_a');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.progress, { phase: 'cancelled', percent: null });
  assert.equal(cancelled.result, null);
  assert.equal(cancelled.error, null);
  assert.deepEqual(store.cancel(job.id, 'scope_a'), cancelled);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0, 'queued cancellation must remove work before execution starts');
});

test('contract 6: active cancellation aborts execution and late settlement cannot overwrite it', async () => {
  const execution = deferred();
  let observedSignal;
  const store = new InferenceJobStore({
    execute: ({ signal }) => {
      observedSignal = signal;
      return execution.promise;
    },
  });
  const job = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
  await waitFor(() => observedSignal);

  const cancelled = store.cancel(job.id, 'scope_a');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(observedSignal.aborted, true);
  execution.resolve({ status: 200, body: completion('too late') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(job.id, 'scope_a').status, 'cancelled');
  assert.equal(store.get(job.id, 'scope_a').result, null);
});

test('contracts 2, 6, and 8: active jobs retain count and byte capacity until execution settles', async () => {
  const firstExecution = deferred();
  const firstBody = requestBody({ metadata: 'x'.repeat(100) });
  const firstBytes = Buffer.byteLength(JSON.stringify(firstBody));
  let calls = 0;
  const store = new InferenceJobStore({
    maxJobs: 1,
    maxJobsPerScope: 1,
    maxActiveRequestBytes: firstBytes,
    maxActiveRequestBytesPerScope: firstBytes,
    execute: () => (++calls === 1 ? firstExecution.promise : Promise.resolve({ status: 200, body: completion() })),
  });
  const first = store.submit({ scopeId: 'scope_a', body: firstBody, headers: {} });
  await waitFor(() => store.get(first.id, 'scope_a')?.status === 'running');

  store.cancel(first.id, 'scope_a');
  assertSubmitError(() => store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} }), 429);
  assertSubmitError(() => store.submit({ scopeId: 'scope_b', body: requestBody(), headers: {} }), 429);

  firstExecution.resolve({ status: 200, body: completion('late') });
  await new Promise(resolve => setImmediate(resolve));
  const admitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
  assert.equal(admitted.status, 'queued', 'settled terminal capacity should be reclaimable');
});

test('contracts 2 and 8: global and per-scope active job-count limits reject without eviction', async () => {
  const executions = [];
  const store = new InferenceJobStore({
    maxJobs: 2,
    maxJobsPerScope: 1,
    execute: () => {
      const pending = deferred();
      executions.push(pending);
      return pending.promise;
    },
  });

  const first = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
  assertSubmitError(() => store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} }), 429);
  const second = store.submit({ scopeId: 'scope_b', body: requestBody(), headers: {} });
  assertSubmitError(() => store.submit({ scopeId: 'scope_c', body: requestBody(), headers: {} }), 429);
  assert.ok(store.get(first.id, 'scope_a'));
  assert.ok(store.get(second.id, 'scope_b'));

  await waitFor(() => executions.length === 2);
  for (const execution of executions) execution.resolve({ status: 200, body: completion() });
});

test('contracts 2 and 8: global and per-scope active request-byte limits are enforced independently', async () => {
  const body = requestBody({ metadata: 'x'.repeat(80) });
  const bytes = Buffer.byteLength(JSON.stringify(body));

  const perScopeExecution = deferred();
  const perScope = new InferenceJobStore({
    maxJobs: 10,
    maxJobsPerScope: 10,
    maxActiveRequestBytes: bytes * 10,
    maxActiveRequestBytesPerScope: bytes,
    execute: () => perScopeExecution.promise,
  });
  const owned = perScope.submit({ scopeId: 'scope_a', body, headers: {} });
  assertSubmitError(() => perScope.submit({ scopeId: 'scope_a', body, headers: {} }), 429);
  const otherScope = perScope.submit({ scopeId: 'scope_b', body, headers: {} });
  assert.ok(perScope.get(owned.id, 'scope_a'));
  assert.ok(perScope.get(otherScope.id, 'scope_b'));

  const globalExecution = deferred();
  const global = new InferenceJobStore({
    maxJobs: 10,
    maxJobsPerScope: 10,
    maxActiveRequestBytes: bytes,
    maxActiveRequestBytesPerScope: bytes * 10,
    execute: () => globalExecution.promise,
  });
  const globalFirst = global.submit({ scopeId: 'scope_a', body, headers: {} });
  assertSubmitError(() => global.submit({ scopeId: 'scope_b', body, headers: {} }), 429);
  assert.ok(global.get(globalFirst.id, 'scope_a'));

  perScopeExecution.resolve({ status: 200, body: completion() });
  globalExecution.resolve({ status: 200, body: completion() });
});

test('contract 8: oldest terminal records are reclaimed but active jobs are never evicted', async () => {
  const activeExecution = deferred();
  let call = 0;
  const store = new InferenceJobStore({
    maxJobs: 2,
    maxJobsPerScope: 2,
    createId: () => `job_${++call}`,
    execute: ({ body }) => body.messages[0].content === 'active'
      ? activeExecution.promise
      : Promise.resolve({ status: 200, body: completion(body.messages[0].content) }),
  });

  const old = store.submit({ scopeId: 'scope_a', body: requestBody({ messages: [{ role: 'user', content: 'old' }] }), headers: {} });
  await waitFor(() => store.get(old.id, 'scope_a')?.status === 'done');
  const active = store.submit({ scopeId: 'scope_a', body: requestBody({ messages: [{ role: 'user', content: 'active' }] }), headers: {} });
  await waitFor(() => store.get(active.id, 'scope_a')?.status === 'running');

  const replacement = store.submit({ scopeId: 'scope_a', body: requestBody({ messages: [{ role: 'user', content: 'replacement' }] }), headers: {} });
  assert.equal(store.get(old.id, 'scope_a'), null, 'the oldest terminal record should be reclaimed');
  assert.equal(store.get(active.id, 'scope_a').status, 'running', 'active work must not be evicted');
  assert.equal(replacement.status, 'queued');
  activeExecution.resolve({ status: 200, body: completion() });
});
