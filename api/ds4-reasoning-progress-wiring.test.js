// Llama Manager — regression test locking the ds4 proxy streaming loops to
// the reasoning-aware progress helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// server.js is a monolith with no exports, so this reads its source and pins
// the literal call sites in proxyChatToDs4 and proxyResponsesToDs4. Both
// functions must derive their per-chunk progress text via ds4ChatDeltaText /
// ds4ResponsesEventText (api/engines.js) rather than reading delta.content or
// response.output_text.delta alone — otherwise a ds4-server THINKING-phase
// stream (delta.reasoning_content / response.reasoning_summary_text.delta)
// is reported as zero tokens again, even though api/engines.test.js's unit
// tests for the helpers themselves still pass. Anchored on the actual call
// expression inside each function body, not a comment, so a revert of the
// wiring alone (leaving the helpers untouched) fails this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

async function readServerSource() {
  return readFile(new URL('./server.js', import.meta.url), 'utf8');
}

test('proxyChatToDs4 derives streamed progress text via ds4ChatDeltaText', async () => {
  const source = await readServerSource();
  const start = source.indexOf('async function proxyChatToDs4(');
  assert.notEqual(start, -1, 'proxyChatToDs4 must still exist');
  const end = source.indexOf('async function proxyCompletionsToDs4(', start);
  assert.notEqual(end, -1, 'proxyCompletionsToDs4 must still follow proxyChatToDs4');
  const body = source.slice(start, end);
  assert.match(
    body,
    /const t = ds4ChatDeltaText\(d\.choices\?\.\[0\]\?\.delta\)/,
    'proxyChatToDs4 must call ds4ChatDeltaText on the parsed delta, not read delta.content alone'
  );
});

test('proxyResponsesToDs4 derives streamed progress text via ds4ResponsesEventText', async () => {
  const source = await readServerSource();
  const start = source.indexOf('async function proxyResponsesToDs4(');
  assert.notEqual(start, -1, 'proxyResponsesToDs4 must still exist');
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'proxyResponsesToDs4 body must be found');
  const body = source.slice(start, end);
  assert.match(
    body,
    /const text = ds4ResponsesEventText\(event\)/,
    'proxyResponsesToDs4 must call ds4ResponsesEventText on the parsed event, not match response.output_text.delta alone'
  );
});
