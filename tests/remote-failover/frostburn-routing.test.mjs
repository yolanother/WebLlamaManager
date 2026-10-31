// Llama Manager — black-box test: Frostburn's documented routing picks the intended hosts.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Loads distribution/frostburn/routing.json (the durable record of Frostburn's alias and
// backend-priority config, W2 T3231237771803) into the real api/server.js in front of
// fakes named after Frostburn's backends, and pins the coordinator's 2026-10-31 decisions:
// default-big goes to drakemore (Strata, for the podcast); default-small goes to dahaka and
// never to drakemore (applied live 02:57Z), so narration, display metadata, diary and
// tool-event clients cannot occupy drakemore's single Strata slot. The local Qwen3-8B
// fallback is pinned statically: exercising local generation here would start llama.
// An edit that flips either choice fails here.
// Run: node --test tests/remote-failover/frostburn-routing.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startStack } from './harness.mjs';

const routing = JSON.parse(readFileSync(new URL('../../distribution/frostburn/routing.json', import.meta.url), 'utf8'));
const DRAKEMORE = 'drakemore-mtj8prpy';
const DAHAKA = 'dahaka-ollama-mngx88pk';
let stack;

before(async () => {
  const backends = [DRAKEMORE, DAHAKA].map((id) => ({ id, priority: routing.backendPriority[id] }));
  stack = await startStack({ backends, aliases: routing.aliases });
});

after(() => stack?.stop());

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

test('default-small never reaches drakemore: dahaka, then the local Qwen3-8B', () => {
  assert.deepEqual(routing.aliases['default-small'].targets.map((t) => t.host), [DAHAKA, 'local']);
  assert.equal(routing.aliases['default-small'].targets[1].model, 'Qwen_Qwen3-8B-GGUF');
});

test('default-big never routes to dahaka', () => {
  assert.ok(!routing.aliases['default-big'].targets.some((t) => t.host === DAHAKA));
});

test('drakemore serves default-small requests zero times', () => {
  assert.equal(stack.hits[DRAKEMORE], 1, 'only the one default-big request reached drakemore');
});
