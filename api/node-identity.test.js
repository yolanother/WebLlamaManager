// Llama Manager — appliance node identity tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the naming boundary an appliance is reached through: that any name
// reduced to a hostname is a single legal mDNS label, that names invented by
// the local model are filtered hard enough that a chatty or confused answer can
// never become the machine's address, and that every failure path leaves the
// caller with no name rather than a bad one — because the caller keeping the
// name it already has is what stops a box from going unreachable.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOTSTRAP_NAME,
  MAX_NAME_LENGTH,
  normalizeNodeName,
  hostnameFor,
  urlFor,
  nameFromHostname,
  parseNameCandidates,
  disambiguate,
  buildSuggestionMessages,
  suggestNames,
  readCompletionText,
} from './node-identity.js';

// ── Name normalization ──────────────────────────────────────────────────────

test('a plain name passes through unchanged', () => {
  assert.equal(normalizeNodeName('nebula'), 'nebula');
});

test('names are folded to a legal single mDNS label', () => {
  assert.equal(normalizeNodeName('  Nebula Drift '), 'nebula-drift');
  assert.equal(normalizeNodeName('Thunder_Cat'), 'thunder-cat');
  assert.equal(normalizeNodeName('Já Vů!'), 'ja-vu');
  assert.equal(normalizeNodeName('a--b---c'), 'a-b-c');
});

test('leading and trailing dashes are never published', () => {
  assert.equal(normalizeNodeName('-nebula-'), 'nebula');
  assert.equal(normalizeNodeName('...nebula...'), 'nebula');
});

test('names are length-capped without leaving a trailing dash', () => {
  const long = normalizeNodeName('x'.repeat(MAX_NAME_LENGTH + 20));
  assert.equal(long.length, MAX_NAME_LENGTH);
  const capped = normalizeNodeName(`${'y'.repeat(MAX_NAME_LENGTH - 1)}-tail`);
  assert.equal(capped.length, MAX_NAME_LENGTH - 1);
  assert.doesNotMatch(capped, /-$/);
});

test('a name that survives to nothing is rejected outright', () => {
  assert.equal(normalizeNodeName(''), null);
  assert.equal(normalizeNodeName('   '), null);
  assert.equal(normalizeNodeName('!!!'), null);
  assert.equal(normalizeNodeName('---'), null);
  assert.equal(normalizeNodeName(null), null);
  assert.equal(normalizeNodeName(42), null);
});

// ── Hostname and URL shape ──────────────────────────────────────────────────

test('a node is addressed as one label, never a subdomain', () => {
  assert.equal(hostnameFor('nebula'), 'nebula-llama-manager');
  assert.equal(urlFor('nebula'), 'http://nebula-llama-manager.local');
});

test('the bootstrap identity is addressable before any theme is chosen', () => {
  assert.equal(BOOTSTRAP_NAME, 'setup');
  assert.equal(hostnameFor(BOOTSTRAP_NAME), 'setup-llama-manager');
  assert.equal(urlFor(BOOTSTRAP_NAME), 'http://setup-llama-manager.local');
});

test('a hostname round-trips back to its node name', () => {
  assert.equal(nameFromHostname('nebula-llama-manager'), 'nebula');
  assert.equal(nameFromHostname('NEBULA-LLAMA-MANAGER'), 'nebula');
  assert.equal(nameFromHostname('nebula-llama-manager.local'), 'nebula');
});

test('a hostname this appliance did not choose reports no name', () => {
  assert.equal(nameFromHostname('frostburn'), null);
  assert.equal(nameFromHostname('llama'), null);
  assert.equal(nameFromHostname('llama-manager'), null);
  assert.equal(nameFromHostname(''), null);
});

// ── Candidate parsing: the model is not trusted ─────────────────────────────

test('a JSON array of names is read as the model was asked to answer', () => {
  assert.deepEqual(
    parseNameCandidates('["nebula", "orion", "vega"]'),
    ['nebula', 'orion', 'vega'],
  );
});

test('a JSON array wrapped in prose or a code fence is still read', () => {
  const answer = 'Sure! Here you go:\n```json\n["nebula", "orion"]\n```\nEnjoy.';
  assert.deepEqual(parseNameCandidates(answer), ['nebula', 'orion']);
});

test('a bulleted or numbered list falls back to line parsing', () => {
  assert.deepEqual(
    parseNameCandidates('1. Nebula\n2. Orion\n- vega\n* Lyra'),
    ['nebula', 'orion', 'vega', 'lyra'],
  );
});

test('prose the model wrapped around its answer is discarded', () => {
  const answer = 'Here are some great names for your machine:\nnebula\norion\n'
    + 'Let me know if you would like more suggestions!';
  assert.deepEqual(parseNameCandidates(answer), ['nebula', 'orion']);
});

test('duplicates and empties never reach the operator', () => {
  assert.deepEqual(
    parseNameCandidates('["nebula", "Nebula", "", "!!!", "nebula "]'),
    ['nebula'],
  );
});

test('junk from the model yields no candidates at all', () => {
  assert.deepEqual(parseNameCandidates(''), []);
  assert.deepEqual(parseNameCandidates('I cannot help with that request.'), []);
  assert.deepEqual(parseNameCandidates(null), []);
});

test('the candidate list is capped so the kiosk stays readable', () => {
  const many = Array.from({ length: 40 }, (_, i) => `name${i}`);
  assert.equal(parseNameCandidates(JSON.stringify(many)).length, 8);
});

// ── Collision avoidance ─────────────────────────────────────────────────────

test('a free name is used as-is', async () => {
  assert.equal(await disambiguate('nebula', async () => false), 'nebula');
});

test('a taken name gains a numeric suffix', async () => {
  const taken = new Set(['nebula', 'nebula-2']);
  assert.equal(await disambiguate('nebula', async (n) => taken.has(n)), 'nebula-3');
});

test('a hopeless collision still returns a usable name', async () => {
  assert.equal(await disambiguate('nebula', async () => true), 'nebula');
});

test('a collision probe that throws is treated as no collision', async () => {
  const boom = async () => { throw new Error('mdns is not available'); };
  assert.equal(await disambiguate('nebula', boom), 'nebula');
});

// ── Suggestion flow ─────────────────────────────────────────────────────────

test('the theme reaches the model and its names come back', async () => {
  const seen = [];
  const complete = async (messages) => {
    seen.push(messages);
    return '["thunder", "cirrus"]';
  };
  const result = await suggestNames({ theme: 'weather', complete });
  assert.deepEqual(result.candidates, ['thunder', 'cirrus']);
  assert.equal(result.error, undefined);
  assert.match(JSON.stringify(seen[0]), /weather/);
  assert.deepEqual(buildSuggestionMessages('weather'), seen[0]);
});

test('an empty theme never reaches the model', async () => {
  let called = false;
  const complete = async () => { called = true; return '["x"]'; };
  const result = await suggestNames({ theme: '   ', complete });
  assert.equal(called, false);
  assert.deepEqual(result.candidates, []);
  assert.match(result.error, /theme/i);
});

test('an engine that is not there degrades instead of throwing', async () => {
  const complete = async () => { throw new Error('connect ECONNREFUSED'); };
  const result = await suggestNames({ theme: 'weather', complete });
  assert.deepEqual(result.candidates, []);
  assert.match(result.error, /ECONNREFUSED/);
});

test('a model that answers with junk degrades instead of naming the box', async () => {
  const complete = async () => 'I am sorry, I cannot do that.';
  const result = await suggestNames({ theme: 'weather', complete });
  assert.deepEqual(result.candidates, []);
  assert.match(result.error, /name/i);
});

test('suggested names are checked for collisions before they are offered', async () => {
  const complete = async () => '["thunder", "cirrus"]';
  const taken = new Set(['thunder']);
  const result = await suggestNames({
    theme: 'weather',
    complete,
    isTaken: async (n) => taken.has(n),
  });
  assert.deepEqual(result.candidates, ['thunder-2', 'cirrus']);
});


test('a thinking model that never emits content still yields its answer', () => {
  // MEASURED on the appliance. Qwen3 reasons before answering, and with a
  // 200-token budget it spent all of it on reasoning_content and emitted an
  // EMPTY content string:
  //   finish_reason: "length", content: "", reasoning_content: "Okay, the user
  //   wants me to come up with 6 short computer names..."
  // The parser saw "" and the kiosk reported "the model returned no usable
  // names", blaming the model for a reply that was cut off mid-thought.
  assert.deepEqual(
    readCompletionText({ content: '', reasoning_content: '["ember","wyrm"]' }),
    '["ember","wyrm"]',
  );
});

test('real content always wins over reasoning', () => {
  assert.deepEqual(
    readCompletionText({ content: '["ash"]', reasoning_content: '["wrong"]' }),
    '["ash"]',
  );
});

test('a message with neither yields an empty string, not a crash', () => {
  assert.equal(readCompletionText({}), '');
  assert.equal(readCompletionText(null), '');
});
