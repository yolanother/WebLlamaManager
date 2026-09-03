// Llama Manager — executable contract tests for OpenAI background Responses.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify the public, scope-isolated Response registry used by the
// Responses create, retrieve, cancel, and resumable-stream routes. They cover
// OpenAI field names, replay cursors, bounded retention, policy forwarding, and
// cancellation without depending on internal routing implementation.

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

/** Build a complete synchronous OpenAI Responses result. */
function completedResponse(content = 'Complete answer') {
  return {
    id: 'resp_sync_upstream',
    object: 'response',
    created_at: 10,
    completed_at: 11,
    background: false,
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [{
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    }],
  };
}

/** Build the smallest valid background Responses request used by quota tests. */
function requestBody(extra = {}) {
  return {
    model: 'voice-fast',
    input: [{ role: 'user', content: 'hello' }],
    background: true,
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

/** Collect a bounded async event stream through a terminal Responses event. */
async function collectEvents(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
    if (/^response\.(?:completed|failed|cancelled|incomplete)$/.test(event.type)) break;
  }
  return events;
}

test('contracts 2, 3, and 5: submit returns one OpenAI Response resource through completion', async () => {
  const execution = deferred();
  const store = new InferenceJobStore({
    now: () => 1_000,
    createId: () => 'resp_opaque_test_handle',
    execute: () => execution.promise,
  });

  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
  assert.equal(submitted.id, 'resp_opaque_test_handle');
  assert.equal(submitted.id.includes('scope_a'), false);
  assert.equal(submitted.object, 'response');
  assert.equal(submitted.created_at, 1);
  assert.equal(Number.isInteger(submitted.created_at), true);
  assert.equal(submitted.completed_at, null);
  assert.equal(submitted.background, true);
  assert.equal(submitted.status, 'queued');
  assert.deepEqual(submitted.output, []);
  assert.equal(submitted.error, null);
  for (const customField of ['progress', 'result', 'expiresAt', 'createdAt', 'updatedAt']) {
    assert.equal(Object.hasOwn(submitted, customField), false, `${customField} is not an OpenAI Response field`);
  }

  const running = await waitFor(() => {
    const response = store.get(submitted.id, 'scope_a');
    return response?.status === 'in_progress' ? response : null;
  }, 'accepted response never entered in_progress');
  assert.equal(running.completed_at, null);
  assert.deepEqual(running.output, [], 'active responses must not leak partial output');
  assert.equal(running.error, null);

  const upstream = completedResponse();
  execution.resolve({ status: 200, body: upstream });
  const completed = await waitFor(() => {
    const response = store.get(submitted.id, 'scope_a');
    return response?.status === 'completed' ? response : null;
  });
  assert.equal(completed.id, submitted.id, 'polling must retain the background response id');
  assert.equal(completed.object, 'response');
  assert.equal(completed.background, true);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.output, upstream.output);
  assert.equal(completed.error, null);
  assert.equal(Number.isInteger(completed.completed_at), true);
});

test('contract 1: the background store rejects non-background input so synchronous Responses stay separate', () => {
  let executions = 0;
  const store = new InferenceJobStore({
    execute: async () => { executions++; return { status: 200, body: completedResponse() }; },
  });

  for (const body of [null, {}, { model: 'gemma', input: 'hello' }, requestBody({ background: false }), requestBody({ background: 'true' })]) {
    assertSubmitError(() => store.submit({ scopeId: 'scope_a', body, headers: {} }), 400);
  }
  assert.equal(executions, 0, 'ordinary synchronous requests must never enter background execution');
});

test('contract 6: a serialized background request over 4 MiB is rejected before execution', () => {
  let executions = 0;
  const store = new InferenceJobStore({
    execute: async () => { executions++; return { status: 200, body: completedResponse() }; },
  });
  assertSubmitError(() => store.submit({
    scopeId: 'scope_a',
    body: requestBody({ metadata: { padding: 'x'.repeat(4 * 1024 * 1024) } }),
    headers: {},
  }), 413);
  assert.equal(executions, 0);
});

test('contracts 8 and 9: execution strips background recursion, retains policy, and rejects unsupported prepared context', async () => {
  let captured;
  const store = new InferenceJobStore({
    execute: async input => {
      captured = input;
      return { status: 200, body: completedResponse('same observable result') };
    },
  });
  const body = requestBody({
    temperature: 0.25,
    request_priority: 'background',
    routing: 'local_only',
  });
  const submitted = store.submit({
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
  assert.equal(Object.hasOwn(captured.body, 'background'), false, 'loopback execution must not recurse');
  assert.deepEqual(captured.body.input, body.input);
  assert.equal(captured.body.request_priority, 'background');
  assert.equal(captured.body.routing, 'local_only');
  assert.equal(headerValue(captured.headers, 'authorization'), 'Bearer tenant-secret');
  assert.equal(headerValue(captured.headers, 'x-llama-priority'), 'background');
  assert.equal(headerValue(captured.headers, 'x-llama-routing'), 'local_only');
  assert.equal(headerValue(captured.headers, 'cookie'), undefined);
  assert.equal(headerValue(captured.headers, 'x-unrelated'), undefined);

  const completed = await waitFor(() => store.get(submitted.id, 'scope_a')?.status === 'completed'
    && store.get(submitted.id, 'scope_a'));
  const publicJson = JSON.stringify(completed);
  for (const secret of ['tenant-secret', 'session=must-not-be-retained']) {
    assert.equal(publicJson.includes(secret), false, `${secret} leaked through the Response resource`);
  }
  assert.equal(Object.hasOwn(completed, 'body'), false);
  assert.equal(Object.hasOwn(completed, 'headers'), false);
  assert.equal(Object.hasOwn(completed, 'scopeId'), false);

  assertSubmitError(() => store.submit({
    scopeId: 'scope_a',
    body: requestBody({ prepared_context_id: 'ctx_private', prepared_context_mode: 'append' }),
  }), 400);
});

test('contracts 5 and 6: ids are scope-bound and expire about 10 minutes after settlement', async () => {
  let now = 1_000;
  const store = new InferenceJobStore({
    now: () => now,
    createId: () => 'resp_scope_bound',
    execute: async () => ({ status: 200, body: completedResponse() }),
  });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });

  assert.equal(store.get('resp_missing', 'scope_a'), null);
  assert.equal(store.get(submitted.id, 'scope_b'), null);
  assert.equal(store.replay(submitted.id, 'scope_b'), null);
  assert.equal(store.cancel('resp_missing', 'scope_a'), null);
  assert.equal(store.cancel(submitted.id, 'scope_b'), null);
  await waitFor(() => store.get(submitted.id, 'scope_a')?.status === 'completed');
  now += 10 * 60_000 - 1;
  assert.ok(store.get(submitted.id, 'scope_a'), 'temporary polling retention ended too early');
  now += 2;
  assert.equal(store.get(submitted.id, 'scope_a'), null);
});

test('contract 5: transport, HTTP, oversized, and empty outcomes become bounded failed Responses', async () => {
  const huge = 'backend diagnostic '.repeat(500);
  const cases = [
    {
      execute: async () => ({ status: 503, body: { error: { message: huge, type: 'backend_error', code: 'MODEL_LOAD_FAILED' } } }),
      expectedStatus: 503,
      expectedType: 'backend_error',
    },
    { execute: async () => { throw new Error(huge); } },
    { execute: async () => ({ status: 502, body: huge }), expectedStatus: 502 },
    { execute: async () => ({ status: 200, body: completedResponse('x'.repeat(1_000)) }), maxResultBytes: 200, expectedCode: 'result_too_large' },
    { execute: async () => ({ status: 200, body: { id: 'resp_empty', object: 'response', status: 'completed', output: [] } }), expectedCode: 'invalid_upstream_response' },
  ];

  for (const scenario of cases) {
    const store = new InferenceJobStore({ execute: scenario.execute, ...(scenario.maxResultBytes ? { maxResultBytes: scenario.maxResultBytes } : {}) });
    const submitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
    const failed = await waitFor(() => store.get(submitted.id, 'scope_a')?.status === 'failed'
      && store.get(submitted.id, 'scope_a'));
    assert.equal(failed.id, submitted.id);
    assert.equal(failed.object, 'response');
    assert.equal(failed.background, true);
    assert.deepEqual(failed.output, []);
    assert.equal(typeof failed.error.message, 'string');
    assert.ok(failed.error.message.length > 0 && failed.error.message.length <= 1_024);
    assert.equal(typeof failed.error.code, 'string');
    assert.deepEqual(
      Object.keys(failed.error).sort(),
      ['code', 'message'],
      'OpenAI Response.error must not contain manager-specific type/status fields',
    );
    const managerDiagnostics = JSON.stringify(failed._llama_manager || {});
    if (scenario.expectedStatus) assert.match(managerDiagnostics, new RegExp(String(scenario.expectedStatus)));
    if (scenario.expectedType) assert.match(managerDiagnostics, new RegExp(scenario.expectedType));
    if (scenario.expectedCode) assert.equal(failed.error.code, scenario.expectedCode);
    assert.ok(JSON.stringify(failed).length < 3_000);
  }
});

test('contract 5: incomplete remains an OpenAI incomplete background Response', async () => {
  const upstream = {
    ...completedResponse('partial but truthful'),
    status: 'incomplete',
    completed_at: null,
    incomplete_details: { reason: 'max_output_tokens' },
  };
  const store = new InferenceJobStore({ execute: async () => ({ status: 200, body: upstream }) });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
  const incomplete = await waitFor(() => store.get(submitted.id, 'scope_a')?.status === 'incomplete'
    && store.get(submitted.id, 'scope_a'));

  assert.equal(incomplete.id, submitted.id);
  assert.equal(incomplete.object, 'response');
  assert.equal(incomplete.background, true);
  assert.deepEqual(incomplete.output, upstream.output);
  assert.deepEqual(incomplete.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(incomplete.error, null);
});

test('contract 4: cancelling queued work is immediate, terminal, and idempotent', async () => {
  let calls = 0;
  const store = new InferenceJobStore({
    now: () => 2_000,
    execute: async () => { calls++; return { status: 200, body: completedResponse() }; },
  });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });

  const cancelled = store.cancel(submitted.id, 'scope_a');
  assert.equal(cancelled.id, submitted.id);
  assert.equal(cancelled.object, 'response');
  assert.equal(cancelled.background, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.completed_at, 2);
  assert.deepEqual(cancelled.output, []);
  assert.equal(cancelled.error, null);
  assert.deepEqual(store.cancel(submitted.id, 'scope_a'), cancelled);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0, 'queued cancellation must remove work before execution starts');
});

test('contract 4: in-progress cancellation aborts execution and late settlement cannot overwrite it', async () => {
  const execution = deferred();
  let observedSignal;
  const store = new InferenceJobStore({
    execute: ({ signal }) => {
      observedSignal = signal;
      return execution.promise;
    },
  });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} });
  await waitFor(() => observedSignal);

  assert.equal(store.cancel(submitted.id, 'scope_a').status, 'cancelled');
  assert.equal(observedSignal.aborted, true);
  execution.resolve({ status: 200, body: completedResponse('too late') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(submitted.id, 'scope_a').status, 'cancelled');
  assert.deepEqual(store.get(submitted.id, 'scope_a').output, []);
});

test('contract 7: streamed background events replay after a cursor and follow live to response.completed', async () => {
  const finish = deferred();
  const store = new InferenceJobStore({
    createId: () => 'resp_streamed',
    execute: async ({ publish }) => {
      publish({ type: 'response.created', sequence_number: 500, response: { id: 'resp_wrong' } });
      publish({ type: 'response.output_text.delta', sequence_number: 500, delta: 'hel' });
      await finish.promise;
      publish({ type: 'response.output_text.delta', sequence_number: -1, delta: 'lo' });
      return { status: 200, body: completedResponse('hello') };
    },
  });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody({ stream: true }), headers: {} });
  const retained = await waitFor(() => store.replay(submitted.id, 'scope_a')?.length === 2
    && store.replay(submitted.id, 'scope_a'));
  assert.deepEqual(retained.map(event => event.type), ['response.created', 'response.output_text.delta']);
  assert.equal(retained.every(event => Number.isInteger(event.sequence_number)), true);
  assert.ok(retained[1].sequence_number > retained[0].sequence_number);
  assert.equal(retained[0].response.id, submitted.id, 'retained events must use the owned Response id');

  assert.deepEqual(
    store.replay(submitted.id, 'scope_a', { startingAfter: retained[0].sequence_number }),
    [retained[1]],
    'cursor replay is exclusive',
  );
  const followedPromise = collectEvents(store.follow(submitted.id, 'scope_a', {
    startingAfter: retained[1].sequence_number,
  }));
  finish.resolve();
  const followed = await followedPromise;
  assert.equal(followed[0].delta, 'lo');
  assert.equal(followed.at(-1).type, 'response.completed');
  assert.equal(followed.at(-1).response.id, submitted.id);
  assert.equal(followed.every((event, index) => index === 0 || event.sequence_number > followed[index - 1].sequence_number), true);
});

test('contract 7: reconnect without a cursor replays from the beginning before following terminal state', async () => {
  const finish = deferred();
  const store = new InferenceJobStore({
    execute: async ({ publish }) => {
      publish({ type: 'response.created' });
      publish({ type: 'response.output_text.delta', delta: 'first' });
      await finish.promise;
      return { status: 200, body: completedResponse() };
    },
  });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody({ stream: true }), headers: {} });
  await waitFor(() => store.replay(submitted.id, 'scope_a')?.length === 2);
  const allPromise = collectEvents(store.follow(submitted.id, 'scope_a'));
  finish.resolve();
  const all = await allPromise;

  assert.deepEqual(all.map(event => event.type), [
    'response.created',
    'response.output_text.delta',
    'response.completed',
  ]);
});

test('contracts 4 and 7: streamed cancellation is replayable and terminal despite a late success', async () => {
  const execution = deferred();
  const store = new InferenceJobStore({
    execute: async ({ publish }) => {
      publish({ type: 'response.created' });
      return execution.promise;
    },
  });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody({ stream: true }), headers: {} });
  await waitFor(() => store.replay(submitted.id, 'scope_a')?.length === 1);
  store.cancel(submitted.id, 'scope_a');
  execution.resolve({ status: 200, body: completedResponse('late') });
  await new Promise(resolve => setImmediate(resolve));

  const events = store.replay(submitted.id, 'scope_a');
  assert.equal(events.at(-1).type, 'response.cancelled');
  assert.equal(events.at(-1).response.status, 'cancelled');
  assert.equal(store.get(submitted.id, 'scope_a').status, 'cancelled');
});

test('contract 7: replay and live follow are allowed only for Responses originally created with stream true', async () => {
  const store = new InferenceJobStore({ execute: async () => ({ status: 200, body: completedResponse() }) });
  const submitted = store.submit({ scopeId: 'scope_a', body: requestBody({ stream: false }), headers: {} });
  await waitFor(() => store.get(submitted.id, 'scope_a')?.status === 'completed');

  const isDisabled = error => (error?.statusCode ?? error?.status) === 400
    && error?.code === 'background_stream_not_enabled';
  assert.throws(() => store.replay(submitted.id, 'scope_a'), isDisabled);
  let follower;
  let followError;
  try {
    follower = store.follow(submitted.id, 'scope_a');
  } catch (error) {
    followError = error;
  }
  if (followError) assert.equal(isDisabled(followError), true);
  else await assert.rejects(follower.next(), isDisabled);
  assert.equal(store.get(submitted.id, 'scope_a').status, 'completed', 'ordinary JSON polling remains available');
});

test('contracts 6 and 7: event count and byte overflow fail instead of dropping cursor history', async () => {
  let countSignal;
  const countStore = new InferenceJobStore({
    maxEventsPerResponse: 2,
    maxEventBytesPerResponse: 10_000,
    maxRetainedEventBytes: 20_000,
    execute: async ({ publish, signal }) => {
      countSignal = signal;
      publish({ type: 'response.created' });
      publish({ type: 'response.output_text.delta', delta: 'one' });
      publish({ type: 'response.output_text.delta', delta: 'two' });
      return { status: 200, body: completedResponse() };
    },
  });
  const countResponse = countStore.submit({ scopeId: 'scope_a', body: requestBody({ stream: true }), headers: {} });
  const countFailed = await waitFor(() => countStore.get(countResponse.id, 'scope_a')?.status === 'failed'
    && countStore.get(countResponse.id, 'scope_a'));
  assert.equal(countFailed.error.code, 'event_retention_exceeded');
  assert.equal(countSignal.aborted, true);
  assert.equal(countStore.replay(countResponse.id, 'scope_a').length, 2, 'earlier cursors remain replayable');

  const byteStore = new InferenceJobStore({
    maxEventsPerResponse: 10,
    maxEventBytesPerResponse: 120,
    maxRetainedEventBytes: 120,
    execute: async ({ publish }) => {
      publish({ type: 'response.output_text.delta', delta: 'x'.repeat(500) });
      return { status: 200, body: completedResponse() };
    },
  });
  const byteResponse = byteStore.submit({ scopeId: 'scope_a', body: requestBody({ stream: true }), headers: {} });
  const byteFailed = await waitFor(() => byteStore.get(byteResponse.id, 'scope_a')?.status === 'failed'
    && byteStore.get(byteResponse.id, 'scope_a'));
  assert.equal(byteFailed.error.code, 'event_retention_exceeded');
  assert.ok(byteFailed.error.message.length <= 1_024);

  const globalExecutions = [deferred(), deferred()];
  let globalCall = 0;
  const globalStore = new InferenceJobStore({
    maxEventsPerResponse: 10,
    maxEventBytesPerResponse: 5_000,
    maxRetainedEventBytes: 1_000,
    execute: async ({ publish }) => {
      const call = globalCall++;
      publish({ type: 'response.output_text.delta', delta: 'x'.repeat(600) });
      await globalExecutions[call].promise;
      return { status: 200, body: completedResponse() };
    },
  });
  const first = globalStore.submit({ scopeId: 'scope_a', body: requestBody({ stream: true }), headers: {} });
  await waitFor(() => globalStore.replay(first.id, 'scope_a')?.length === 1);
  const second = globalStore.submit({ scopeId: 'scope_b', body: requestBody({ stream: true }), headers: {} });
  const globalFailed = await waitFor(() => globalStore.get(second.id, 'scope_b')?.status === 'failed'
    && globalStore.get(second.id, 'scope_b'));
  assert.equal(globalFailed.error.code, 'event_retention_exceeded');
  assert.equal(globalStore.get(first.id, 'scope_a').status, 'in_progress');
  assert.equal(globalStore.replay(first.id, 'scope_a').length, 1, 'existing replay history must not be evicted');
  globalExecutions[0].resolve();
  globalExecutions[1].resolve();
});

test('contracts 4 and 6: cancelled work retains count and byte capacity until execution settles', async () => {
  const firstExecution = deferred();
  const firstBody = requestBody({ metadata: { padding: 'x'.repeat(100) } });
  const firstBytes = Buffer.byteLength(JSON.stringify(firstBody));
  let calls = 0;
  const store = new InferenceJobStore({
    maxJobs: 1,
    maxJobsPerScope: 1,
    maxActiveRequestBytes: firstBytes,
    maxActiveRequestBytesPerScope: firstBytes,
    execute: () => (++calls === 1 ? firstExecution.promise : Promise.resolve({ status: 200, body: completedResponse() })),
  });
  const first = store.submit({ scopeId: 'scope_a', body: firstBody, headers: {} });
  await waitFor(() => store.get(first.id, 'scope_a')?.status === 'in_progress');

  store.cancel(first.id, 'scope_a');
  assertSubmitError(() => store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} }), 429);
  assertSubmitError(() => store.submit({ scopeId: 'scope_b', body: requestBody(), headers: {} }), 429);
  firstExecution.resolve({ status: 200, body: completedResponse('late') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.submit({ scopeId: 'scope_a', body: requestBody(), headers: {} }).status, 'queued');
});

test('contract 6: global and per-scope active count and byte limits reject without active eviction', async () => {
  const executions = [];
  const body = requestBody({ metadata: { padding: 'x'.repeat(80) } });
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const store = new InferenceJobStore({
    maxJobs: 2,
    maxJobsPerScope: 1,
    maxActiveRequestBytes: bytes * 2,
    maxActiveRequestBytesPerScope: bytes,
    execute: () => {
      const pending = deferred();
      executions.push(pending);
      return pending.promise;
    },
  });

  const first = store.submit({ scopeId: 'scope_a', body, headers: {} });
  assertSubmitError(() => store.submit({ scopeId: 'scope_a', body, headers: {} }), 429);
  const second = store.submit({ scopeId: 'scope_b', body, headers: {} });
  assertSubmitError(() => store.submit({ scopeId: 'scope_c', body, headers: {} }), 429);
  assert.ok(store.get(first.id, 'scope_a'));
  assert.ok(store.get(second.id, 'scope_b'));
  await waitFor(() => executions.length === 2);
  for (const execution of executions) execution.resolve({ status: 200, body: completedResponse() });
});

test('contract 6: oldest terminal Responses are reclaimed but active Responses are never evicted', async () => {
  const activeExecution = deferred();
  let id = 0;
  const store = new InferenceJobStore({
    maxJobs: 2,
    maxJobsPerScope: 2,
    createId: () => `resp_${++id}`,
    execute: ({ body }) => body.input[0].content === 'active'
      ? activeExecution.promise
      : Promise.resolve({ status: 200, body: completedResponse(body.input[0].content) }),
  });

  const old = store.submit({ scopeId: 'scope_a', body: requestBody({ input: [{ role: 'user', content: 'old' }] }), headers: {} });
  await waitFor(() => store.get(old.id, 'scope_a')?.status === 'completed');
  const active = store.submit({ scopeId: 'scope_a', body: requestBody({ input: [{ role: 'user', content: 'active' }] }), headers: {} });
  await waitFor(() => store.get(active.id, 'scope_a')?.status === 'in_progress');

  const replacement = store.submit({ scopeId: 'scope_a', body: requestBody({ input: [{ role: 'user', content: 'replacement' }] }), headers: {} });
  assert.equal(store.get(old.id, 'scope_a'), null, 'the oldest terminal Response should be reclaimed');
  assert.equal(store.get(active.id, 'scope_a').status, 'in_progress', 'active work must not be evicted');
  assert.equal(replacement.status, 'queued');
  activeExecution.resolve({ status: 200, body: completedResponse() });
});
