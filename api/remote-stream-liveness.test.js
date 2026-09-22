/**
 * Copyright (c) DoubTech. Use of this file is governed by the LICENSE file in
 * the repository root.
 *
 * Pins stall-watchdog liveness parity between the LOCAL and REMOTE streaming
 * parsers in api/server.js. A thinking-mode model streams its reasoning in
 * fields beyond OpenAI's canonical `delta.content` (`reasoning_content`,
 * `reasoning`, `thinking`, `text`) and can emit deltas with no text field at
 * all. If a parser does not treat those as progress, updateActiveRequest is
 * never called, entry.tokens stays 0, and the stall watchdog tears down a
 * generation that is actively running.
 *
 * The local parser was taught this; the remote one was not. Measured
 * 2026-09-22: podcast request 222 to backend drakemore-mtj8prpy reported
 * firstTokenMs == latencyMs == 408409 with 4 empty chunks, was killed at
 * "0 tokens, idle 396s >= 393s", and tripped the circuit breaker on a backend
 * that was healthy and generating the whole time.
 *
 * These assert the INVARIANT (remote is never less liveness-aware than local)
 * rather than any literal expression, so formatting changes cannot break them.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

/** Delta fields a parser treats as generation progress, e.g. `delta.thinking`. */
function textFieldsIn(block) {
  return new Set([...block.matchAll(/delta\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
}

/** The remote-backend streaming parser: it rewrites the upstream `model` field. */
function remoteStreamBlock() {
  const i = SRC.indexOf('Normalize model field in remote streaming chunks');
  assert.ok(i > -1, 'remote streaming parser must exist');
  return SRC.slice(i, i + 1800);
}

/** The local streaming parser, which already carries the thinking-mode fix. */
function localStreamBlock() {
  const i = SRC.indexOf("canonical `content` — we've seen `reasoning_content`");
  assert.ok(i > -1, 'local streaming parser must exist');
  return SRC.slice(i, i + 1800);
}

test('the local parser counts every thinking-mode delta shape as progress', () => {
  const fields = textFieldsIn(localStreamBlock());
  for (const f of ['content', 'reasoning_content', 'reasoning', 'thinking']) {
    assert.ok(fields.has(f), `local parser must read delta.${f}`);
  }
});

test('the remote parser is never less liveness-aware than the local one', () => {
  const local = textFieldsIn(localStreamBlock());
  const remote = textFieldsIn(remoteStreamBlock());
  const missing = [...local].filter((f) => !remote.has(f));
  assert.deepStrictEqual(
    missing,
    [],
    `remote streaming parser ignores delta field(s) the local one counts: ${missing.join(', ')}. ` +
      'A model streaming only those fields registers 0 tokens and the stall watchdog kills it.',
  );
});

test('a remote delta carrying no text field still refreshes the stall clock', () => {
  // tool_calls, a bare role, or an unrecognised thinking-mode shape are still
  // proof the backend is alive. Without this branch "no text field matched"
  // is indistinguishable from "model is wedged".
  const block = remoteStreamBlock();
  assert.match(
    block,
    /else if \(Object\.keys\(delta\)\.length > 0\)/,
    'remote parser needs a non-text delta fallback',
  );
  assert.match(
    block,
    /updateActiveRequest\(activeReqId, ''\)/,
    'the fallback must refresh lastActivityAt via updateActiveRequest',
  );
});
