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
  duoStepBody,
  DUO_REASONING_EFFORT,
  duoMessageText,
  duoConversation,
  duoStepMessages,
  duoStepStats,
  duoChainStats,
  duoResponsesInputMessages,
  duoResponsesEnvelope,
  duoResponsesStreamEvents,
  duoStepText,
  duoStepBudget,
  DUO_REASONING_HEADROOM,
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

// --- Which turn of a conversation is the request -----------------------------------
// Regression cover for a real failure: asked to design a projector-based vibraphone
// trainer, the chain returned a review of that request alongside work that implemented
// `add_numbers(a, b)` — a question from an earlier turn. Every user turn had been
// flattened into one blob, so the steps were free to answer different questions.

test('a multi-turn conversation resolves to the LAST user message', () => {
  const { request } = duoConversation([
    { role: 'user', content: 'Write a Python function that adds two numbers' },
    { role: 'assistant', content: 'def add_numbers(a, b): return a + b' },
    { role: 'user', content: 'Design a projector that gamifies playing a vibraphone' },
  ]);
  assert.equal(request, 'Design a projector that gamifies playing a vibraphone');
});

test('an earlier user turn cannot override the current request', () => {
  const { request, history } = duoConversation([
    { role: 'user', content: 'Write a Python function that adds two numbers' },
    { role: 'assistant', content: 'Here you go.' },
    { role: 'user', content: 'Now design the projector rig instead' },
  ]);
  assert.equal(request, 'Now design the projector rig instead');
  assert.ok(
    !history.some(m => m.role === 'user' && m.content === request),
    'the request must not also appear as a competing history turn',
  );
  assert.match(
    buildExecutePrompt(request, 'PLAN'),
    /projector rig/,
    'the worker is asked for the same request the planner planned for',
  );
});

test('assistant turns survive as context', () => {
  const { history } = duoConversation([
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'What is the vibraphone layout?' },
    { role: 'assistant', content: 'Two rows, like a piano keyboard.' },
    { role: 'user', content: 'Design a projector rig for it' },
  ]);
  assert.deepEqual(history.map(m => m.role), ['system', 'user', 'assistant']);
  assert.equal(history[2].content, 'Two rows, like a piano keyboard.');
});

test('array-shaped content does not stringify to [object Object]', () => {
  const { request, history } = duoConversation([
    { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'Design the rig' }, { type: 'image_url', image_url: { url: 'x' } }] },
  ]);
  assert.equal(request, 'Design the rig');
  assert.ok(!JSON.stringify(history).includes('[object Object]'));
  assert.equal(history[1].content, 'earlier answer');
});

test('duoMessageText handles strings, part arrays, and nothing at all', () => {
  assert.equal(duoMessageText('plain'), 'plain');
  assert.equal(duoMessageText([{ type: 'input_text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(duoMessageText(null), '');
  assert.equal(duoMessageText({ image_url: { url: 'x' } }), '');
});

test('a conversation with no user turn yields an empty request rather than a wrong one', () => {
  assert.equal(duoConversation([{ role: 'assistant', content: 'hi' }]).request, '');
  assert.equal(duoConversation([]).request, '');
  assert.equal(duoConversation(undefined).request, '');
});

test('each step is sent the history plus its own instruction as the final turn', () => {
  const { history, request } = duoConversation([
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'the real request' },
  ]);
  const messages = duoStepMessages(history, buildPlanPrompt(request));
  assert.equal(messages.length, 3);
  assert.equal(messages.at(-1).role, 'user');
  assert.match(messages.at(-1).content, /the real request/);
  assert.deepEqual(messages.slice(0, 2), history);
});

// --- Honest throughput --------------------------------------------------------------

test('a step reports the engine\'s own rate, not visible tokens over wall time', () => {
  const stats = duoStepStats({
    role: 'plan',
    model: DUO_PLANNER_ID,
    elapsedMs: 30_000,
    body: {
      usage: { prompt_tokens: 194, completion_tokens: 243 },
      timings: { prompt_n: 194, predicted_ms: 14_817, predicted_n: 243, predicted_per_second: 16.4 },
    },
  });
  assert.equal(stats.tokensPerSecond, 16.4);
  assert.equal(stats.tokensPerSecondSource, 'engine');
  assert.equal(stats.completionTokens, 243);
  assert.equal(stats.promptTokens, 194);
  assert.equal(stats.elapsedMs, 30_000);
});

test('input tokens are summed across the chain, so the envelope never reports zero', () => {
  const stats = duoChainStats([
    duoStepStats({ role: 'plan', model: 'p', elapsedMs: 1, body: { usage: { prompt_tokens: 200, completion_tokens: 10 } } }),
    duoStepStats({ role: 'execute', model: 'w', elapsedMs: 1, body: { usage: { prompt_tokens: 500, completion_tokens: 20 } } }),
    duoStepStats({ role: 'review', model: 'p', elapsedMs: 1, body: { timings: { prompt_n: 900, predicted_n: 30 } } }),
  ]);
  assert.equal(stats.promptTokens, 1600, 'every step is prompt the operator paid for');
  assert.equal(stats.completionTokens, 60);
});

test('a step without engine timings falls back to wall clock and says so', () => {
  const stats = duoStepStats({ role: 'execute', model: DUO_WORKER_ID, elapsedMs: 2000, body: { usage: { completion_tokens: 100 } } });
  assert.equal(stats.tokensPerSecond, 50);
  assert.equal(stats.tokensPerSecondSource, 'wall_clock');
});

test('a step with no body at all reports zeroes rather than NaN', () => {
  const stats = duoStepStats({ role: 'review', model: DUO_PLANNER_ID, elapsedMs: 0 });
  assert.equal(stats.tokensPerSecond, 0);
  assert.equal(stats.completionTokens, 0);
  assert.ok(Number.isFinite(stats.elapsedMs));
});

test('the aggregate separates what the hardware did from what the operator waited through', () => {
  const stats = duoChainStats([
    duoStepStats({ role: 'plan', model: 'p', elapsedMs: 20_000, body: { usage: { completion_tokens: 200 }, timings: { predicted_ms: 12_000, predicted_per_second: 16.6 } } }),
    duoStepStats({ role: 'execute', model: 'w', elapsedMs: 15_000, body: { usage: { completion_tokens: 500 }, timings: { predicted_ms: 10_000, predicted_per_second: 50 } } }),
    duoStepStats({ role: 'review', model: 'p', elapsedMs: 25_000, body: { usage: { completion_tokens: 300 }, timings: { predicted_ms: 18_000, predicted_per_second: 16.6 } } }),
  ]);
  assert.equal(stats.completionTokens, 1000);
  assert.equal(stats.elapsedMs, 60_000);
  assert.equal(stats.generationMs, 40_000);
  assert.equal(stats.tokensPerSecond, 25, 'tokens over the time the engine spent generating them');
  assert.equal(stats.effectiveTokensPerSecond, 16.7, 'tokens over the whole chain, handoffs included');
  assert.equal(stats.steps.length, 3);
  assert.ok(
    stats.tokensPerSecond > stats.effectiveTokensPerSecond,
    'the generation rate must not be dragged down by queueing the way the old display was',
  );
});

test('the aggregate of nothing is zeroes, not NaN', () => {
  const stats = duoChainStats([]);
  assert.equal(stats.tokensPerSecond, 0);
  assert.equal(stats.effectiveTokensPerSecond, 0);
  assert.equal(stats.completionTokens, 0);
});

// --- The Responses envelope ----------------------------------------------------------

test('a Responses `input` string and array both become chat messages', () => {
  assert.deepEqual(duoResponsesInputMessages('hello'), [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(
    duoResponsesInputMessages([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }]),
    [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }],
  );
  assert.deepEqual(duoResponsesInputMessages(undefined), []);
});

test('a Responses input array still resolves to its LAST user turn', () => {
  const { request } = duoConversation(duoResponsesInputMessages([
    { role: 'user', content: 'add two numbers' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: [{ type: 'input_text', text: 'design the rig' }] },
  ]));
  assert.equal(request, 'design the rig');
});

test('the finished chain is shaped like an ordinary completed Response', () => {
  const response = duoResponsesEnvelope({
    id: 'resp_abc', model: DUO_CHAIN_ID, text: 'the review', promptTokens: 10, completionTokens: 20,
    duo: { plan: 'P', work: 'W', elapsedMs: 100, stats: duoChainStats([]) },
  });
  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.model, DUO_CHAIN_ID);
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].role, 'assistant');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.equal(response.output[0].content[0].text, 'the review');
  assert.equal(response.output_text, 'the review');
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 20, total_tokens: 30 });
  assert.equal(response.duo.work, 'W');
});

test('the replayed event stream ends with the whole Response, which the background follower needs', () => {
  const response = duoResponsesEnvelope({ id: 'resp_x', model: DUO_CHAIN_ID, text: 'answer' });
  const events = duoResponsesStreamEvents(response);
  const types = events.map(e => e.type);
  assert.equal(types[0], 'response.created');
  assert.equal(types.at(-1), 'response.completed');
  assert.ok(types.includes('response.output_item.added'));
  assert.ok(types.includes('response.content_part.added'));
  assert.deepEqual(events.at(-1).response, response, 'the terminal event carries the pollable result');
  assert.deepEqual(events.map(e => e.sequence_number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('the replayed stream carries the answer exactly once, as a delta', () => {
  const response = duoResponsesEnvelope({ id: 'resp_x', model: DUO_CHAIN_ID, text: 'answer' });
  const deltas = duoResponsesStreamEvents(response).filter(e => e.type === 'response.output_text.delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, 'answer');
  assert.equal(deltas[0].item_id, response.output[0].id);
});

test('nothing is emitted as answer text before the chain has finished', () => {
  const response = duoResponsesEnvelope({ id: 'resp_x', model: DUO_CHAIN_ID, text: 'answer' });
  const created = duoResponsesStreamEvents(response).find(e => e.type === 'response.created');
  assert.equal(created.response.status, 'in_progress');
  assert.deepEqual(created.response.output, [], 'the planner and worker text must never reach the client');
});

// --- A step that never finished is a failure, not a result ---------------------------

test('an ordinary reply is used as-is', () => {
  const { text, error } = duoStepText({ message: { content: 'the plan' }, finish_reason: 'stop' });
  assert.equal(text, 'the plan');
  assert.equal(error, null);
});

test('a reasoning model that finished but answered in reasoning_content is still usable', () => {
  const { text, error } = duoStepText({ message: { content: '', reasoning_content: 'the plan' }, finish_reason: 'stop' });
  assert.equal(text, 'the plan');
  assert.equal(error, null);
});

test('a step still reasoning when the budget ran out is rejected, not passed on', () => {
  const { text, error } = duoStepText({
    message: { content: '', reasoning_content: 'I should first consider whether the user' },
    finish_reason: 'length',
  });
  assert.equal(text, '');
  assert.match(error, /still reasoning/);
  assert.match(error, /max_tokens/);
});

test('an answer truncated by the budget is kept — partial work is still on topic', () => {
  const { text, error } = duoStepText({ message: { content: '1. Remove the wheel' }, finish_reason: 'length' });
  assert.equal(text, '1. Remove the wheel');
  assert.equal(error, null);
});

test('an entirely empty step is rejected whatever stopped it', () => {
  assert.match(duoStepText({ message: { content: '' }, finish_reason: 'stop' }).error, /produced no text/);
  assert.match(duoStepText({ message: {}, finish_reason: 'length' }).error, /token budget exhausted/);
  assert.match(duoStepText(undefined).error, /produced no text/);
});

// --- Room to think ------------------------------------------------------------------
// The guard above turns an unfinished step into a loud failure. This is what stops that
// failure being the normal outcome: on the box the same planner prompt took 520 tokens
// one run and blew past 2500 the next, because reasoning tokens are not answer tokens.

test('a step gets the caller\'s answer allowance plus room to reason', () => {
  assert.equal(duoStepBudget(1200), 1200 + DUO_REASONING_HEADROOM);
  assert.equal(duoStepBudget('2500'), 2500 + DUO_REASONING_HEADROOM);
});

test('no max_tokens still yields a budget with headroom, never zero', () => {
  assert.equal(duoStepBudget(undefined), 2048 + DUO_REASONING_HEADROOM);
  assert.equal(duoStepBudget(0), 2048 + DUO_REASONING_HEADROOM);
  assert.equal(duoStepBudget(-5), 2048 + DUO_REASONING_HEADROOM);
  assert.equal(duoStepBudget('nonsense'), 2048 + DUO_REASONING_HEADROOM);
});

test('the headroom is real, not a token or two', () => {
  assert.ok(DUO_REASONING_HEADROOM >= 2048, 'a reasoning model needs room to think, not a rounding allowance');
});

// The planner defaults to unbounded reasoning and, on a substantial request, never
// converges: measured finish=length with EMPTY content at both 4096 and 12000 tokens
// (17k and 52k chars of reasoning respectively), versus finish=stop with a real 6.9k
// answer once effort is bounded. Both flags below are invisible in a normal response
// and trivial to drop by accident, so they are pinned here.
test('every duo step bounds reasoning effort, or the planner never answers', () => {
  const body = duoStepBody('some-model', [{ role: 'user', content: 'hi' }], 1234);
  assert.equal(body.chat_template_kwargs.reasoning_effort, DUO_REASONING_EFFORT);
  assert.ok(DUO_REASONING_EFFORT, 'must be a real effort level, never empty');
});

test('every duo step asks for engine timings, or tok/s degrades to wall clock', () => {
  const body = duoStepBody('some-model', [{ role: 'user', content: 'hi' }], 1234);
  assert.equal(body.timings_per_token, true);
});

test('duoStepBody passes model, messages and budget through unchanged', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const body = duoStepBody('m', msgs, 99);
  assert.equal(body.model, 'm');
  assert.deepEqual(body.messages, msgs);
  assert.equal(body.max_tokens, 99);
});
