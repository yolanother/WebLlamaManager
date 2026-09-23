// Llama Manager — System 1 provider client unit tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers callJev's request shape (bearer key, model, URL) and askSystem1's
// provider order: laya only, jev only, and jev-then-laya falling back to laya
// on a missing key, HTTP error, or thrown fetch — each failure carrying a code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSystem1, callJev, JEV_API_URL } from './system1.js';

const okJev = () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { difficulty: { score: 2 } } }) };
  };
  return { calls, fetchImpl };
};
const laya = (result) => async () => result;
const Q = { difficulty: { type: 'score', instructions: 'x', criteria: ['a', 'b'] } };

test('callJev posts bearer key and model to the TypeSafe endpoint', async () => {
  const { calls, fetchImpl } = okJev();
  const r = await callJev({ questions: Q, state: 's' }, { fetchImpl, jevApiKey: 'k1', jevModel: 'jev-latest', timeoutMs: 500 });
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, JEV_API_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer k1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { questions: Q, state: 's', model: 'jev-latest' });
});

test('askSystem1 laya: returns laya answers; non-200 and null throw with codes', async () => {
  const ok = await askSystem1(Q, 's', { provider: 'laya', timeoutMs: 500 }, { askLaya: laya({ status: 200, body: { model: 'laya-typed-decisions', answers: { difficulty: { score: 1 } } } }) });
  assert.deepEqual(ok, { provider: 'laya', model: 'laya-typed-decisions', answers: { difficulty: { score: 1 } } });
  await assert.rejects(askSystem1(Q, 's', { provider: 'laya', timeoutMs: 500 }, { askLaya: laya(null) }), { code: 'no_decision_host' });
  await assert.rejects(askSystem1(Q, 's', { provider: 'laya', timeoutMs: 500 }, { askLaya: laya({ status: 422, body: {} }) }), { code: 'laya_422' });
});

test('askSystem1 laya passes allowColdStart:false and refresh:false', async () => {
  let seen;
  await askSystem1(Q, 's', { provider: 'laya', timeoutMs: 700 }, { askLaya: async (body, o) => { seen = { body, o }; return { status: 200, body: { answers: {} } }; } });
  assert.deepEqual(seen.o, { timeoutMs: 700, allowColdStart: false, refresh: false });
  assert.deepEqual(seen.body, { questions: Q, state: 's' });
});

test('askSystem1 jev: missing key and HTTP errors throw with codes', async () => {
  await assert.rejects(askSystem1(Q, 's', { provider: 'jev', timeoutMs: 500 }, { fetchImpl: okJev().fetchImpl, jevApiKey: '' }), { code: 'no_jev_key' });
  const f429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(askSystem1(Q, 's', { provider: 'jev', timeoutMs: 500 }, { fetchImpl: f429, jevApiKey: 'k' }), { code: 'jev_429' });
});

test('askSystem1 jev-then-laya falls back to laya', async () => {
  const boom = async () => { throw new Error('network'); };
  const r = await askSystem1(Q, 's', { provider: 'jev-then-laya', timeoutMs: 500 },
    { fetchImpl: boom, jevApiKey: 'k', askLaya: laya({ status: 200, body: { answers: { difficulty: { score: 0 } } } }) });
  assert.equal(r.provider, 'laya');
});

test('askSystem1 jev-then-laya uses jev when it answers', async () => {
  const { fetchImpl } = okJev();
  const r = await askSystem1(Q, 's', { provider: 'jev-then-laya', timeoutMs: 500 }, { fetchImpl, jevApiKey: 'k', jevModel: 'jev-latest', askLaya: laya(null) });
  assert.equal(r.provider, 'jev');
  assert.equal(r.model, 'jev-1.13.0');
});
