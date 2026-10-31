// Llama Manager — unit tests for the Pods idle-worker release client.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies requestPodsIdleRelease without a network: it does nothing unless
// config.podsRelease is enabled and the environment carries PODS_COORDINATOR_URL,
// PODS_NODE_ID and PODS_API_KEY, posts the node-scoped release request with a
// bearer key only to the environment's coordinator (a coordinatorUrl in runtime
// config is ignored), is rate-limited, never throws on a failed or refused call,
// and never puts the key in what it returns.
// Design: docs/Designs/ResourceArbiter.md section 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestPodsIdleRelease } from './pods-release.js';

const KEY = 'pods-test-key-0123456789';
const cfg = (over = {}) => ({ podsRelease: { enabled: true, ...over } });
const env = { PODS_API_KEY: KEY, PODS_COORDINATOR_URL: 'https://pods.example/', PODS_NODE_ID: 'n-drakemore' };

/** A fetch double that records calls and answers with `body` (or throws `error`). */
function fakeFetch({ status = 200, body = { released: ['w-up'], skipped: [] }, error = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (error) throw error;
    return { ok: status < 400, status, json: async () => body };
  };
  return { fn, calls };
}

test('posts the node-scoped release request with the bearer key and returns the released ids', async () => {
  const { fn, calls } = fakeFetch();
  const state = {};
  const r = await requestPodsIdleRelease({ config: cfg(), env, reason: 'strata needs 103 GiB', fetchFn: fn, state, now: 1000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://pods.example/api/v1/nodes/n-drakemore/release-idle-workers');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { min_idle_seconds: 600, reason: 'strata needs 103 GiB' });
  assert.deepEqual(r, { sent: true, released: ['w-up'], detail: 'released w-up' });
  assert.equal(state.lastAt, 1000);
});

test('does nothing when disabled, incomplete or without a key (negative control: the flag gates every call)', async () => {
  const { fn, calls } = fakeFetch();
  const without = (k) => ({ ...env, [k]: '' });
  for (const [config, e] of [[cfg({ enabled: false }), env], [{}, env], [cfg(), without('PODS_NODE_ID')],
    [cfg(), without('PODS_COORDINATOR_URL')], [cfg(), without('PODS_API_KEY')], [cfg(), { ...env, PODS_COORDINATOR_URL: 'file:///etc/passwd' }]]) {
    const r = await requestPodsIdleRelease({ config, env: e, reason: 'x', fetchFn: fn, state: {}, now: 0 });
    assert.equal(r.sent, false);
  }
  assert.equal(calls.length, 0);
});

test('rate-limited to one request per cooldown', async () => {
  const { fn, calls } = fakeFetch();
  const state = {};
  await requestPodsIdleRelease({ config: cfg(), env, reason: 'a', fetchFn: fn, state, now: 0 });
  const again = await requestPodsIdleRelease({ config: cfg(), env, reason: 'b', fetchFn: fn, state, now: 60_000 });
  assert.equal(again.sent, false);
  assert.match(again.detail, /cooldown/);
  await requestPodsIdleRelease({ config: cfg(), env, reason: 'c', fetchFn: fn, state, now: 5 * 60_000 });
  assert.equal(calls.length, 2);
});

test('a refused or failed call never throws and never leaks the key', async () => {
  for (const f of [fakeFetch({ status: 403, body: { detail: 'Not the owner of this node' } }), fakeFetch({ error: new Error(`connect ECONNREFUSED (${KEY})`) })]) {
    const r = await requestPodsIdleRelease({ config: cfg(), env, reason: 'x', fetchFn: f.fn, state: {}, now: 0 });
    assert.equal(r.sent, true);
    assert.deepEqual(r.released, []);
    assert.ok(!JSON.stringify(r).includes(KEY), JSON.stringify(r));
  }
});

test('the key only ever goes to the coordinator named in the environment, never to a runtime-config URL', async () => {
  const { fn, calls } = fakeFetch();
  await requestPodsIdleRelease({ config: cfg({ coordinatorUrl: 'https://attacker.example', nodeId: 'other' }), env, reason: 'x', fetchFn: fn, state: {}, now: 0 });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, 'https://pods.example');
  assert.match(calls[0].url, /\/nodes\/n-drakemore\//);
  const lone = fakeFetch();
  const r = await requestPodsIdleRelease({ config: cfg({ coordinatorUrl: 'https://attacker.example', nodeId: 'n' }), env: { PODS_API_KEY: KEY }, reason: 'x', fetchFn: lone.fn, state: {}, now: 0 });
  assert.equal(r.sent, false);
  assert.equal(lone.calls.length, 0, 'a runtime-config URL alone never receives the key');
});
