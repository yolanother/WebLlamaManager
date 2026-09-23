// Llama Manager — smart alias routing unit tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers the pure smart-alias decision: size inference from sizeB / model name /
// file bytes, prompt text extraction for the four text endpoints, the
// difficulty-by-size + domain-tag candidate pick with the resident-candidate
// rule, routeSmartAlias's never-block fallback to the first target, and
// smartAliasRouting's localTarget computation (I2: a remote pick must fall
// back to the alias's own local candidate, never the alias's name).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSizeFromName, candidateSize, extractPromptText, pickSmartCandidate, routeSmartAlias, smartAliasRouting, SMART_QUESTIONS,
} from './smart-alias.js';

const cand = (model, order, host = 'local') => ({ host, model, kind: 'model', backendId: host === 'local' ? null : host, order });

test('parseSizeFromName reads the largest NNb token', () => {
  assert.equal(parseSizeFromName('Qwen_Qwen3-8B-GGUF'), 8);
  assert.equal(parseSizeFromName('gpt-oss-120b'), 120);
  assert.equal(parseSizeFromName('Qwen_Qwen3-30B-A3B-GGUF'), 30);
  assert.equal(parseSizeFromName('qwen3.6-35b'), 35);
  assert.equal(parseSizeFromName('qwen3:1.5b'), 1.5);
  assert.equal(parseSizeFromName('mystery-model'), null);
  assert.equal(parseSizeFromName('model-bf16'), null);
  assert.equal(parseSizeFromName('model-a1b2c3'), null); // M1: digit after the b/B must not count as a "b" size token
});

test('candidateSize: sizeB wins, then name, then local bytes, else null', () => {
  assert.equal(candidateSize(cand('gpt-oss-120b', 0), { sizeB: 7 }, {}), 7);
  assert.equal(candidateSize(cand('gpt-oss-120b', 0), {}, {}), 120);
  assert.equal(candidateSize(cand('mystery', 0), {}, { mystery: 6e9 }), 10);
  assert.equal(candidateSize(cand('mystery', 0, 'remote1'), {}, { mystery: 6e9 }), null);
  assert.equal(candidateSize(cand('mystery', 0), { sizeB: 0 }, {}), null);
});

test('extractPromptText: last user text for each endpoint shape', () => {
  assert.equal(extractPromptText('chat', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: [{ type: 'text', text: 'c' }] }] }), 'c');
  assert.equal(extractPromptText('completions', { prompt: 'p' }), 'p');
  assert.equal(extractPromptText('completions', { prompt: ['x', 'y'] }), 'y');
  assert.equal(extractPromptText('responses', { input: 'hi' }), 'hi');
  assert.equal(extractPromptText('responses', { input: [{ role: 'user', content: [{ type: 'input_text', text: 'r' }] }] }), 'r');
  assert.equal(extractPromptText('messages', { messages: [{ role: 'user', content: [{ type: 'text', text: 'm' }] }] }), 'm');
});

test('extractPromptText returns empty string for non-text content', () => {
  assert.equal(extractPromptText('messages', { messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }), '');
  assert.equal(extractPromptText('chat', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }), '');
  assert.equal(extractPromptText('chat', null), '');
});

const sizes = { s: 8, m: 30, l: 120 };
const opts = (resident = []) => ({
  sizeOf: c => sizes[c.model] ?? null,
  isResident: c => resident.includes(c.model),
  domainOf: c => c.domain ?? null,
});

test('pickSmartCandidate maps difficulty onto size order', () => {
  const cs = [cand('l', 0), cand('s', 1), cand('m', 2)];
  const pick = score => pickSmartCandidate(cs, { difficulty: { score } }, opts()).model;
  assert.equal(pick(0), 's');
  assert.equal(pick(1.4), 'm');
  assert.equal(pick(3), 'l');
  assert.equal(pick(99), 'l');
  assert.equal(pickSmartCandidate([cand('s', 0)], { difficulty: { score: 3 } }, opts()).model, 's');
});

test('pickSmartCandidate: unknown size ranks largest, ties break on order', () => {
  const cs = [cand('zz', 0), cand('s', 1), cand('s2', 2)];
  const o = { ...opts(), sizeOf: c => ({ s: 8, s2: 8 })[c.model] ?? null };
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 3 } }, o).model, 'zz');
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 0 } }, o).model, 's');
});

test('pickSmartCandidate: confident domain restricts to tagged candidates', () => {
  const cs = [cand('s', 0), { ...cand('l', 1), domain: 'code' }, cand('m', 2)];
  const v = (confidence) => ({ difficulty: { score: 0 }, domain: { choice: 'code', confidence } });
  assert.equal(pickSmartCandidate(cs, v(0.9), opts()).model, 'l');
  assert.equal(pickSmartCandidate(cs, v(0.3), opts()).model, 's');
});

test('pickSmartCandidate prefers a resident candidate at or above the pick', () => {
  const cs = [cand('s', 0), cand('m', 1), cand('l', 2)];
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 1.5 } }, opts(['l'])).model, 'l');
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 1.5 } }, opts(['s'])).model, 'm');
});

const smartConfig = {
  aliases: {
    smart: { type: 'smart', targets: [{ host: 'local', model: 'l-120b' }, { host: 'local', model: 's-8b' }, { host: 'local', model: 'm-30b', domain: 'code' }] },
  },
};
const baseDeps = (over = {}) => ({
  config: smartConfig,
  inventory: { localModels: ['s-8b', 'm-30b', 'l-120b'], residentModels: [] },
  localBytes: {},
  defaultProvider: 'laya',
  warmSystem1: () => {},
  askSystem1: async () => ({ provider: 'laya', answers: { difficulty: { score: 0 }, domain: { choice: 'chitchat', confidence: 0.9 } } }),
  ...over,
});
const chat = text => ({ messages: [{ role: 'user', content: text }] });

test('routeSmartAlias: easy prompt goes to the smallest candidate with a reason', async () => {
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps());
  assert.equal(r.candidate.model, 's-8b');
  assert.equal(r.reason, 'laya:d=0.0,domain=chitchat');
});

test('routeSmartAlias asks SMART_QUESTIONS with the prompt as state and the alias provider', async () => {
  let seen;
  const config = { aliases: { smart: { ...smartConfig.aliases.smart, system1: 'jev' } } };
  await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hello') }, baseDeps({
    config,
    askSystem1: async (q, state, o) => { seen = { q, state, o }; return { provider: 'jev', answers: { difficulty: { score: 0 } } }; },
  }));
  assert.equal(seen.q, SMART_QUESTIONS);
  assert.equal(seen.state, 'hello');
  assert.deepEqual(seen.o, { provider: 'jev', timeoutMs: 1000 });
});

test('routeSmartAlias: a resident larger candidate beats a cold pick', async () => {
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') },
    baseDeps({ inventory: { localModels: ['s-8b', 'm-30b', 'l-120b'], residentModels: ['m-30b'] } }));
  assert.equal(r.candidate.model, 'm-30b');
});

test('routeSmartAlias: fallback when askSystem1 throws — targets[0], warm-up fired', async () => {
  let warmed = null;
  const err = Object.assign(new Error('x'), { code: 'no_decision_host' });
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps({
    askSystem1: async () => { throw err; },
    warmSystem1: p => { warmed = p; },
  }));
  assert.equal(r.candidate.model, 'l-120b');
  assert.equal(r.reason, 'fallback:no_decision_host');
  assert.equal(warmed, 'laya');
});

test('routeSmartAlias: no text and missing difficulty both fall back', async () => {
  const noText = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: { messages: [] } }, baseDeps());
  assert.equal(noText.reason, 'fallback:no_text');
  const bad = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps({ askSystem1: async () => ({ provider: 'laya', answers: {} }) }));
  assert.equal(bad.reason, 'fallback:bad_verdict');
  assert.equal(bad.candidate.model, 'l-120b');
});

test('routeSmartAlias: fallback cause is sanitized for a header', async () => {
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps({ askSystem1: async () => { throw new Error('boom: bad\nthing'); } }));
  assert.match(r.reason, /^fallback:[\w.-]+$/);
});

test('routeSmartAlias: I3 — a never-resolving askSystem1 is bounded by ONE timeoutMs budget, not per-leg', async () => {
  let warmed = null;
  const start = Date.now();
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps({
    timeoutMs: 50,
    askSystem1: () => new Promise(() => {}), // never resolves — simulates a jev-then-laya walk that outlives its own per-leg timeouts
    warmSystem1: p => { warmed = p; },
  }));
  assert.ok(Date.now() - start < 900, 'must resolve well under the 1s smart budget');
  assert.equal(r.reason, 'fallback:timeout');
  assert.equal(r.candidate.model, 'l-120b');
  assert.equal(warmed, 'laya');
});

test('routeSmartAlias returns null for a non-smart or empty alias', async () => {
  assert.equal(await routeSmartAlias({ name: 'nope', endpoint: 'chat', body: chat('hi') }, baseDeps()), null);
  const cfg = { aliases: { f: { targets: [{ host: 'local', model: 's-8b' }] } } };
  assert.equal(await routeSmartAlias({ name: 'f', endpoint: 'chat', body: chat('hi') }, baseDeps({ config: cfg })), null);
});

// I2: smartAliasRouting's localTarget — a remote pick must fall back to the alias's
// own local candidate, never to the alias's name (which could hang a request for the
// full model-load window once the routing layer declines the remote pick).
test('smartAliasRouting: a LOCAL pick reports itself as localTarget, and only itself in candidates/ranked', () => {
  const candidate = cand('m-30b', 1);
  const candidates = [cand('l-120b', 0, 'remote1'), candidate, cand('s-8b', 2)];
  const r = smartAliasRouting('smart', candidate, candidates, { residentModels: ['m-30b'], backends: [] });
  assert.equal(r.name, 'smart');
  assert.deepEqual(r.candidates, [candidate]);
  assert.deepEqual(r.ranked, [candidate]);
  assert.deepEqual(r.warm, [candidate]); // resident, per inventory.residentModels
  assert.deepEqual(r.cold, []);
  assert.equal(r.localTarget, 'm-30b');
});

test('smartAliasRouting: a REMOTE pick with a local candidate present falls back to the FIRST local candidate', () => {
  const candidate = cand('remote-9b', 0, 'remote1');
  const candidates = [candidate, cand('s-8b', 1), cand('m-30b', 2)];
  const r = smartAliasRouting('smart', candidate, candidates, { residentModels: [], backends: [] });
  assert.deepEqual(r.candidates, [candidate]);
  assert.deepEqual(r.ranked, [candidate]);
  assert.equal(r.localTarget, 's-8b');
});

test('smartAliasRouting: a REMOTE-ONLY alias has no local candidate — localTarget is null, not the alias name', () => {
  const candidate = cand('remote-9b', 0, 'remote1');
  const candidates = [candidate, cand('other-9b', 1, 'remote2')];
  const r = smartAliasRouting('smart', candidate, candidates, { residentModels: [], backends: [] });
  assert.deepEqual(r.candidates, [candidate]);
  assert.equal(r.localTarget, null);
});
