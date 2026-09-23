// Llama Manager — route tests for api/decision-router.js (System 1 proxy + decision status).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionRouter } from './decision-router.js';
import { resolveDecisionConfig } from './decision.js';

const PINNED = `sha256:${'c'.repeat(64)}`;

/** Fake Express surface: records routes; no body parsing (app.use(express.json()) runs upstream). */
function harness(overrides = {}) {
  const routes = new Map();
  const router = { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) };
  const state = {
    decision: { enabled: true, image: PINNED, port: 5254 },
    running: false,
    starts: 0,
    touches: 0,
    stops: 0,
    fetches: [],
    availableBytes: 64 * 1024 ** 3,
    ...overrides.state,
  };
  const supervisor = {
    ensureStarted: async () => {
      const c = resolveDecisionConfig({ decision: state.decision }, {});
      if (!c.runnable) throw new Error(`decision engine not runnable: ${c.reason}`);
      state.starts++; state.running = true;
    },
    touch: () => { state.touches++; },
    stop: async () => { state.stops++; state.running = false; },
    status: () => ({ running: state.running, healthy: state.running, startedAt: null, lastUsedAt: null, lastError: null }),
  };
  const fetchImpl = overrides.fetchImpl || (async (url, init) => {
    state.fetches.push({ url, init });
    return new Response(JSON.stringify({ model: 'laya-typed-decisions', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 0 } }), { status: 200 });
  });
  createDecisionRouter({
    expressImpl: { Router: () => router },
    fetchImpl,
    supervisor,
    getConfig: () => resolveDecisionConfig({ decision: state.decision }, {}),
    updateConfig: (patch) => { state.decision = { ...state.decision, ...patch }; },
    nodeName: () => 'frostburn',
    memAvailableBytes: () => state.availableBytes,
    isLoopback: (req) => req.socket?.remoteAddress === '127.0.0.1',
    fleetPeers: overrides.fleetPeers,
  });
  return { routes, state };
}

/** Invoke a recorded handler with a fake req/res; resolves to the res. */
async function invoke(routes, key, { body, headers = {}, remote = '127.0.0.1' } = {}) {
  const res = {
    statusCode: 200, headers: {},
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
  };
  await routes.get(key)({ body, headers, socket: { remoteAddress: remote } }, res);
  return res;
}

const Q = { questions: { q: { type: 'noul', instructions: 'invoice?' } }, state: 'INV-1' };

test('systemone: registered on /v1 and /api/v1', () => {
  const { routes } = harness();
  assert.ok(routes.has('POST /v1/systemone'));
  assert.ok(routes.has('POST /api/v1/systemone'));
});

test('systemone: rejects a non-decision model with 400 and still names the host', async () => {
  const { routes, state } = harness();
  const res = await invoke(routes, 'POST /v1/systemone', { body: { ...Q, model: 'gpt-oss-120b' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'unsupported_model');
  assert.equal(res.headers['x-laya-host'], 'frostburn');
  // A7: the JSON body also carries the host, since node-proxy drops headers.
  assert.equal(res.body.host, 'frostburn');
  assert.equal(state.starts, 0);
});

// A6: llama-manager rewrites `model` to the loaded checkpoint (default
// `typed-decisions`) for laya, laya-* (unless it already names the loaded
// checkpoint) and jev-*, before forwarding to the local engine.
const A6_REWRITES = { undefined: undefined, laya: 'laya-typed-decisions', 'laya-typed-decisions': 'laya-typed-decisions', 'jev-latest': 'laya-typed-decisions' };

for (const model of [undefined, 'laya', 'laya-typed-decisions', 'jev-latest']) {
  test(`systemone: model ${model} lazily starts local, forwards, touches, sets x-laya-host`, async () => {
    const { routes, state } = harness();
    const res = await invoke(routes, 'POST /api/v1/systemone', { body: { ...Q, model } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.answers.q.noul, 0.9);
    assert.equal(res.headers['x-laya-host'], 'frostburn');
    // A7: response body also carries host.
    assert.equal(res.body.host, 'frostburn');
    assert.equal(state.starts, 1);
    assert.ok(state.touches >= 1);
    assert.equal(state.fetches[0].url, 'http://127.0.0.1:5254/v1/systemone');
    const rewritten = A6_REWRITES[String(model)];
    // JSON.stringify drops an undefined-valued `model` key entirely, so the
    // undefined case expects no `model` key at all rather than `model: undefined`.
    assert.deepEqual(JSON.parse(state.fetches[0].init.body), rewritten === undefined ? { ...Q } : { ...Q, model: rewritten });
  });
}

test('systemone: A6 rewrites a laya-<other checkpoint> name that is not loaded', async () => {
  const { routes, state } = harness();
  await invoke(routes, 'POST /v1/systemone', { body: { ...Q, model: 'laya-multilingual' } });
  assert.equal(JSON.parse(state.fetches[0].init.body).model, 'laya-typed-decisions');
});

test('systemone: A6 leaves a model naming the actually-loaded checkpoint untouched', async () => {
  const { routes, state } = harness({ state: { decision: { enabled: true, image: PINNED, checkpoint: 'multilingual' } } });
  await invoke(routes, 'POST /v1/systemone', { body: { ...Q, model: 'laya-multilingual' } });
  assert.equal(JSON.parse(state.fetches[0].init.body).model, 'laya-multilingual');
});

test('systemone: upstream 422 is passed through, not failed over', async () => {
  const { routes } = harness({ fetchImpl: async () => new Response(JSON.stringify({ detail: 'bad question' }), { status: 422 }) });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.detail, 'bad question');
});

test('systemone: disabled engine → 503 no_decision_host', async () => {
  const { routes, state } = harness({ state: { decision: { enabled: false, image: PINNED } } });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 503);
  // A7: 503 no_decision_host also carries host in the body.
  assert.deepEqual(res.body, { error: 'no_decision_host', host: 'frostburn' });
  assert.equal(res.headers['x-laya-host'], 'frostburn');
  assert.equal(state.starts, 0);
});

test('systemone: memory guard refuses a cold start below minFreeMemBytes', async () => {
  const { routes, state } = harness({ state: { availableBytes: 1024 } });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 503);
  assert.equal(state.starts, 0);
});

test('systemone: memory guard keeps an already-running engine serving', async () => {
  const { routes } = harness({ state: { availableBytes: 1024, running: true } });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 200);
});

test('systemone: local 5xx or a thrown start → 503', async () => {
  const { routes } = harness({ fetchImpl: async () => new Response('{"detail":"oom"}', { status: 500 }) });
  assert.equal((await invoke(routes, 'POST /v1/systemone', { body: Q })).statusCode, 503);
});

test('status: reports config, supervisor state, availability and node', async () => {
  const { routes } = harness();
  const res = await invoke(routes, 'GET /api/decision/status');
  assert.equal(res.body.node, 'frostburn');
  assert.equal(res.body.available, true);
  assert.equal(res.body.port, 5254);
  assert.equal(res.body.running, false);
  assert.deepEqual(res.body.peers, []);
  assert.equal(res.headers['x-laya-host'], 'frostburn');
  // The dashboard GPU controls seed themselves from these.
  assert.equal(res.body.variant, 'rocm');
  assert.deepEqual(res.body.gpus, []);
});

test('config: off-box callers get 403; loopback persists only known keys', async () => {
  const { routes, state } = harness();
  assert.equal((await invoke(routes, 'POST /api/decision/config', { body: { enabled: false }, remote: '192.168.1.5' })).statusCode, 403);
  const res = await invoke(routes, 'POST /api/decision/config', { body: { enabled: false, gpu: 'rocm-igpu', evil: 1 } });
  assert.equal(res.body.ok, true);
  assert.equal(state.decision.enabled, false);
  assert.equal(state.decision.gpu, 'rocm-igpu');
  assert.equal('evil' in state.decision, false);
});

test('start/stop: drive the supervisor', async () => {
  const { routes, state } = harness();
  assert.equal((await invoke(routes, 'POST /api/decision/start')).body.running, true);
  assert.equal((await invoke(routes, 'POST /api/decision/stop')).body.running, false);
  assert.equal(state.stops, 1);
});

test('start: not runnable → 409 with the reason', async () => {
  const { routes } = harness({ state: { decision: { enabled: false, image: PINNED } } });
  const res = await invoke(routes, 'POST /api/decision/start');
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /disabled in config/);
});

// W6-T3: laya alias routing — configured peers (ordered), then local, then 503.
/** fetch fake: peer status + peer/local systemone, recording calls. */
function peerFetch({ peerAvailable = true, peerStatus = 200, peerHost = 'drakemore' } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'http://d:3001/api/decision/status') return new Response(JSON.stringify({ available: peerAvailable }), { status: 200 });
    if (url === 'http://d:3001/api/v1/systemone') {
      return new Response(JSON.stringify({ model: 'laya-typed-decisions', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }),
        { status: peerStatus, headers: { 'x-laya-host': peerHost } });
    }
    if (url === 'http://127.0.0.1:5254/v1/systemone') return new Response(JSON.stringify({ model: 'local', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  return { fn, calls };
}

const WITH_PEER = { decision: { enabled: true, image: PINNED, port: 5254, peers: [{ name: 'drakemore', url: 'http://d:3001' }] } };

test('alias: healthy drakemore serves first; hop header sent; x-laya-host from the peer', async () => {
  const f = peerFetch();
  const { routes, state } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-laya-host'], 'drakemore');
  const fwd = f.calls.find((c) => c.url.endsWith('/api/v1/systemone'));
  assert.equal(fwd.init.headers['x-laya-hop'], 'frostburn');
  assert.equal(state.starts, 0, 'local engine not started when the peer serves');
});

test('alias: peer health is cached within peerHealthTtlMs', async () => {
  const f = peerFetch();
  const { routes } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  await invoke(routes, 'POST /v1/systemone', { body: Q });
  await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(f.calls.filter((c) => c.url.endsWith('/api/decision/status')).length, 1);
});

test('alias: peer unavailable → local serves with x-laya-host = this node', async () => {
  const f = peerFetch({ peerAvailable: false });
  const { routes, state } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.headers['x-laya-host'], 'frostburn');
  assert.equal(state.starts, 1);
});

test('alias: peer 503 → falls over to local and marks the peer down', async () => {
  const f = peerFetch({ peerStatus: 503 });
  const { routes } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.body.model, 'local');
  const status = await invoke(routes, 'GET /api/decision/status');
  assert.equal(status.body.peers[0].available, false);
});

test('alias: peer down and local memory too low → 503 no_decision_host', async () => {
  const f = peerFetch({ peerAvailable: false });
  const { routes } = harness({ state: { ...WITH_PEER, availableBytes: 1 }, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 503);
  // A7: 503 no_decision_host also carries host in the body, consistent with
  // the disabled-engine 503 case above.
  assert.deepEqual(res.body, { error: 'no_decision_host', host: 'frostburn' });
});

test('alias: a forwarded request (x-laya-hop) is served locally only', async () => {
  const f = peerFetch();
  const { routes } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q, headers: { 'x-laya-hop': 'drakemore' } });
  assert.equal(res.body.model, 'local');
  assert.equal(f.calls.some((c) => c.url.startsWith('http://d:3001')), false);
});

test('alias: a name-only peer resolves through fleetPeers', async () => {
  const f = peerFetch();
  const { routes } = harness({
    state: { decision: { enabled: true, image: PINNED, port: 5254, peers: [{ name: 'drakemore' }] } },
    fetchImpl: f.fn,
    fleetPeers: () => [{ name: 'drakemore', url: 'http://d:3001' }],
  });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.headers['x-laya-host'], 'drakemore');
});
