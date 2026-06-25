// Llama Manager — unit tests for api/upstream-retry.js (router proxy-vs-connection retry plan).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpstreamFailure, upstreamRetryPlan } from './upstream-retry.js';

// ── classifyUpstreamFailure: proxy (router up) vs connection (router down) ────
test('proxy-error 500 bodies are classified as kind=proxy (router responded -> it is UP)', () => {
  for (const t of ['proxy error: Failed to read connection',
                   'Could not establish connection',
                   'proxy error: failed to write connection']) {
    assert.equal(classifyUpstreamFailure({ status: 500, text: t }).kind, 'proxy', t);
  }
});

test('connection errors are classified as kind=connection (router unreachable)', () => {
  assert.equal(classifyUpstreamFailure({ errorCode: 'ECONNREFUSED' }).kind, 'connection');
  assert.equal(classifyUpstreamFailure({ errorMessage: 'fetch failed' }).kind, 'connection');
  assert.equal(classifyUpstreamFailure({ errorCode: 'ECONNRESET' }).kind, 'connection');
});

test('a non-proxy 500 (real upstream error) is kind=other (do not retry/restart)', () => {
  assert.equal(classifyUpstreamFailure({ status: 500, text: 'invalid request: bad messages' }).kind, 'other');
  assert.equal(classifyUpstreamFailure({ status: 400, text: 'whatever' }).kind, 'other');
});

// ── upstreamRetryPlan: the core fix — never restart the router on proxy errors ─
const R = 6;

test('proxy errors NEVER restart the router (a child is loading); they wait and retry', () => {
  for (const attempt of [0, 1, 2, 4]) {
    const p = upstreamRetryPlan({ kind: 'proxy', attempt, retries: R });
    assert.equal(p.action, 'retry', `attempt ${attempt}`);
    assert.equal(p.restart, false, `attempt ${attempt} must not restart`);
    assert.ok(p.delayMs > 0, `attempt ${attempt} should wait for the child to load`);
  }
});

test('proxy retry delay grows with attempts but is capped (gives a big model time to load)', () => {
  const d0 = upstreamRetryPlan({ kind: 'proxy', attempt: 0, retries: R }).delayMs;
  const d2 = upstreamRetryPlan({ kind: 'proxy', attempt: 2, retries: R }).delayMs;
  const dBig = upstreamRetryPlan({ kind: 'proxy', attempt: 50, retries: 99 }).delayMs;
  assert.ok(d2 > d0, 'delay should grow');
  assert.ok(dBig <= 15000, 'delay should be capped');
});

test('proxy errors fail (no more retries) once the attempt budget is exhausted — still no restart', () => {
  const p = upstreamRetryPlan({ kind: 'proxy', attempt: R, retries: R });
  assert.equal(p.action, 'fail');
  assert.equal(p.restart, false);
});

test('connection errors DO restart the router after the first retry (router is down)', () => {
  assert.deepEqual(
    { a: upstreamRetryPlan({ kind: 'connection', attempt: 0, retries: R }).restart,
      b: upstreamRetryPlan({ kind: 'connection', attempt: 1, retries: R }).restart,
      c: upstreamRetryPlan({ kind: 'connection', attempt: 2, retries: R }).restart },
    { a: false, b: true, c: true });
  // first attempt waits (give a crash a beat), later attempts restart
  assert.equal(upstreamRetryPlan({ kind: 'connection', attempt: 0, retries: R }).action, 'retry');
});

test('connection errors fail once the budget is exhausted', () => {
  assert.equal(upstreamRetryPlan({ kind: 'connection', attempt: R, retries: R }).action, 'fail');
});

test('a single restart per request: caller passes alreadyRestarted to suppress repeats', () => {
  const p = upstreamRetryPlan({ kind: 'connection', attempt: 3, retries: R, alreadyRestarted: true });
  assert.equal(p.restart, false, 'do not restart twice in one request');
  assert.equal(p.action, 'retry');
});
