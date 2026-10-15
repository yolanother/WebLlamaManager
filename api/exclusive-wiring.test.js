// Llama Manager — source-text wiring tests for the generic exclusive-engine handle.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// server.js is a monolith with no exports, so this reads its source and pins the
// exclusive-engine seam from docs/Designs/StrataEngine.md §2.2/§2.3/§7: the
// EXCLUSIVE_ENGINES registry and its helpers exist, every request handler waits on
// exclusiveSwapsSettled() instead of the DS4-only ds4SwapPromise, completions pass
// llamaRunning to ds4RequestTarget, the completions proxy rethrows before headers,
// and the messages handler resolves its model and proxies through the generic path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

/**
 * Returns the text of the top-level function `name`, from its declaration up to the
 * next top-level function or app.* statement (a line starting at column 0).
 * @param {string} name - function name, declared `async function name(` or `function name(`.
 * @returns {string} the function source.
 */
function fnBody(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(m, `${name} must exist in server.js`);
  const rest = source.slice(m.index + m[0].length);
  const next = rest.search(/^(?:async function |function |app\.)/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('exclusive-engine registry and helpers exist', () => {
  for (const anchor of [
    'const EXCLUSIVE_ENGINES = {',
    'function activeExclusive(',
    'async function exclusiveSwapsSettled(',
    'async function deactivateExclusive(',
    'async function drainExclusiveRequests(',
    'async function proxyMessagesToExclusive(',
  ]) {
    assert.ok(source.includes(anchor), `server.js must contain ${anchor}`);
  }
});

test('proxyMessagesToExclusive sits directly before handleMessages', () => {
  assert.match(
    source,
    /async function proxyMessagesToExclusive\([\s\S]*?\n}\n\s*(?:\/\*\*[\s\S]*?\*\/\s*)?async function handleMessages\(/,
  );
  const body = fnBody('proxyMessagesToExclusive');
  assert.ok(!body.includes('async function handleMessages('), 'no other function may sit between them');
});

for (const name of ['handleChatCompletions', 'handleCompletions', 'handleResponses', 'handleMessages']) {
  test(`${name} waits on exclusiveSwapsSettled, not ds4SwapPromise`, () => {
    const body = fnBody(name);
    assert.match(body, /await exclusiveSwapsSettled\(\)/);
    assert.doesNotMatch(body, /if \(ds4SwapPromise\)/);
  });
}

test('handleCompletions passes llamaRunning to ds4RequestTarget', () => {
  const body = fnBody('handleCompletions');
  const at = body.indexOf('ds4RequestTarget(');
  assert.notEqual(at, -1);
  assert.match(body.slice(at, body.indexOf('});', at) + 3), /llamaRunning: !!llamaProcess/);
});

test('proxyCompletionsToDs4 rethrows before headers are sent', () => {
  assert.match(fnBody('proxyCompletionsToDs4'), /if \(!res\.headersSent\) throw err;/);
});

test('handleMessages resolves the model and proxies through the exclusive path', () => {
  const body = fnBody('handleMessages');
  assert.match(body, /resolveRequestModel\(rawModel, smart\)/);
  assert.match(body, /ensureDs4ForModel\(rawModel, requestedModel,/);
  assert.match(body, /proxy: proxyMessagesToExclusive/);
});

test('buildAliasInventory consults activeExclusive()', () => {
  assert.match(fnBody('buildAliasInventory'), /activeExclusive\(\)/);
});
