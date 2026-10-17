// Llama Manager — tests for the exclusive-engine support helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Covers the SSE carry-over line splitter, the attempts cap and the throttled
// health probe used to clear a sticky 'exhausted' exclusive status, plus
// source-wiring checks that server.js uses them (review minors m4, m7, m8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { createSseLineSplitter, pushCapped, createThrottledProbe, selectBootExclusive } from './exclusive-support.js';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

test('SSE splitter keeps a data line split across chunks', () => {
  const s = createSseLineSplitter();
  assert.deepEqual(s.push('data: {"a":1}\ndata: {"b'), ['data: {"a":1}']);
  assert.deepEqual(s.push('":2}\n\n'), ['data: {"b":2}', '']);
  assert.deepEqual(s.flush(), []);
});

test('SSE splitter flush returns an unterminated tail', () => {
  const s = createSseLineSplitter();
  assert.deepEqual(s.push('data: x'), []);
  assert.deepEqual(s.flush(), ['data: x']);
});

test('pushCapped appends and keeps only the last N', () => {
  const a = Array.from({ length: 25 }, (_, i) => ({ i }));
  assert.equal(pushCapped(a, { i: 25 }, 20), a);
  assert.equal(a.length, 20);
  assert.equal(a[0].i, 6);
  assert.equal(a[19].i, 25);
});

test('throttled probe caches within the interval and shares in-flight', async () => {
  let t = 1000; let calls = 0;
  const probe = createThrottledProbe(async () => { calls++; return true; }, 5000, () => t);
  const [x, y] = await Promise.all([probe(), probe()]);
  assert.equal(x, true); assert.equal(y, true); assert.equal(calls, 1);
  t += 1000; await probe(); assert.equal(calls, 1);
  t += 5000; await probe(); assert.equal(calls, 2);
});

test('throttled probe treats a throwing probe as false', async () => {
  const probe = createThrottledProbe(async () => { throw new Error('x'); }, 5000, () => 0);
  assert.equal(await probe(), false);
});

test('server wiring: sticky exhausted recovers via probe (m4)', () => {
  assert.match(source, /async function exclusiveUnavailableBody\(/);
  assert.equal((source.match(/await exclusiveUnavailableBody\(/g) || []).length, 4);
  assert.match(source, /createThrottledProbe\(/);
});

test('server wiring: preset POST/PUT no longer probe the tokenizer path (m7)', () => {
  assert.doesNotMatch(source, /existsSync\(strataCheck\.strata\.tokenizer\)/);
});

test('server wiring: exclusive proxies use the SSE splitter, attempts are capped (m8)', () => {
  assert.ok((source.match(/createSseLineSplitter\(\)/g) || []).length >= 4);
  assert.equal((source.match(/pushCapped\(runtime\.attempts,/g) || []).length, 4);
});

// ── A2: boot re-activation of the last exclusive preset ─────────────────────

test('selectBootExclusive picks the persisted strata/ds4 preset', () => {
  const config = { lastExclusivePreset: 'p1', presets: { p1: { id: 'p1', engine: 'strata' } } };
  assert.deepEqual(selectBootExclusive(config), { engine: 'strata', presetId: 'p1' });
  config.presets.p1.engine = 'ds4';
  assert.deepEqual(selectBootExclusive(config), { engine: 'ds4', presetId: 'p1' });
});

test('selectBootExclusive returns null when unset, gone, llama, or disabled', () => {
  assert.equal(selectBootExclusive({ presets: {} }), null);
  assert.equal(selectBootExclusive({ lastExclusivePreset: 'p1', presets: {} }), null);
  assert.equal(selectBootExclusive({ lastExclusivePreset: 'p1', presets: { p1: { id: 'p1' } } }), null);
  assert.equal(selectBootExclusive({
    lastExclusivePreset: 'p1', settings: { exclusiveBootReactivate: false },
    presets: { p1: { engine: 'strata' } },
  }), null);
});

test('server wiring: persist on ready, clear on deactivate, kick off at listen (A2)', () => {
  assert.ok((source.match(/rememberExclusivePreset\(/g) || []).length >= 4); // def + ds4 + 2 strata
  assert.match(source, /delete config\.lastExclusivePreset/);
  assert.match(source, /selectBootExclusive\(config\)/);
  assert.match(source, /boot: re-activating \$\{/);
});
