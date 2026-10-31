// Llama Manager — black-box test: Frostburn's documented routing picks the intended hosts.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Loads distribution/frostburn/routing.json (the durable record of Frostburn's alias and
// backend-priority config, W2 T3231237771803) into the real api/server.js in front of
// fakes named after Frostburn's backends, and pins the coordinator's 2026-10-31 decision:
// default-big prefers drakemore (Strata, for the podcast); default-small prefers dahaka
// (moves ~5 req/min of narration off drakemore's single Strata stream), then drakemore.
// A priority or order edit that flips either choice fails here.
// Run: node --test tests/remote-failover/frostburn-routing.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startStack } from './harness.mjs';

const routing = JSON.parse(readFileSync(new URL('../../distribution/frostburn/routing.json', import.meta.url), 'utf8'));
const DRAKEMORE = 'drakemore-mtj8prpy';
const DAHAKA = 'dahaka-ollama-mngx88pk';
let stack;
let dahakaDown;

before(async () => {
  const backends = [DRAKEMORE, DAHAKA].map((id) => ({ id, priority: routing.backendPriority[id] }));
  stack = await startStack({ backends, aliases: routing.aliases });
  // The same config with dahaka refusing (503), to pin the second choice.
  dahakaDown = await startStack({
    backends: backends.map((b) => (b.id === DAHAKA ? { ...b, status: 503 } : b)),
    aliases: routing.aliases,
  });
});

after(() => { stack?.stop(); dahakaDown?.stop(); });

/** @param {object} s stack @param {string} model @returns {Promise<string>} the serving fake's id. */
async function servedBy(s, model) {
  const res = await s.chat(model);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.choices[0].message.content.replace(/^from /, '');
}

test('default-big prefers drakemore', async () => {
  assert.equal(await servedBy(stack, 'default-big'), DRAKEMORE);
});

test('default-small prefers dahaka', async () => {
  assert.equal(await servedBy(stack, 'default-small'), DAHAKA);
});

test('default-small falls back to drakemore when dahaka cannot serve', async () => {
  assert.equal(await servedBy(dahakaDown, 'default-small'), DRAKEMORE);
});

test('default-big never routes to dahaka', () => {
  assert.ok(!routing.aliases['default-big'].targets.some((t) => t.host === DAHAKA));
});
