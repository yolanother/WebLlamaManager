// Llama Manager — source-text tests for the boot re-activation race in api/server.js.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pins two fixes found live on drakemore (2026-10-17): (1) the boot re-activation of
// the last exclusive preset must not be undone by the llama auto-start, whose
// POST /api/server/start deactivates any exclusive engine one second after listen;
// (2) a Strata activation whose runtime was superseded mid-load (deactivated or
// replaced) must stop its backend ladder instead of starting the next backend as an
// orphan or stopping the engine a newer activation owns. server.js has no exports
// (importing it boots the server), so these read its source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

/**
 * Returns the source of the top-level async function `name` up to the next line that
 * starts at column 0 with `}` followed by a blank line.
 * @param {string} name - function name.
 * @returns {string} the function source.
 */
function fnBody(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in server.js`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

test('boot re-activation suppresses the llama auto-start', () => {
  const listen = source.slice(source.indexOf("httpServer.listen(API_PORT"));
  const bootAt = listen.indexOf('selectBootExclusive(config)');
  const autoAt = listen.indexOf('scheduleAutoStart({');
  assert.ok(bootAt >= 0 && autoAt >= 0);
  assert.ok(bootAt < autoAt, 'the boot exclusive must be chosen before auto-start is scheduled');
  assert.match(listen.slice(autoAt, autoAt + 200), /autoStart:\s*boot\s*\?\s*false\s*:\s*config\.autoStart/);
});

test('a superseded Strata activation stops its ladder', () => {
  const body = fnBody('activateStrataExclusive');
  assert.match(body, /const superseded = \(\) => strataState\.runtime !== runtime/);
  const start = body.slice(body.indexOf('startAttempt:'));
  assert.match(start.slice(0, 200), /if \(superseded\(\)\) return \{ ok: false, reason: 'superseded' \}/);
  const stop = body.slice(body.indexOf('stopAttempt:'));
  assert.match(stop.slice(0, 200), /if \(superseded\(\)\) return \{ ok: true, remainingPids: \[\] \}/,
    'a superseded stop must not mark CUDA failed or stop the new owner engine');
  const settle = body.slice(body.indexOf('onAttempt:'));
  const guardAt = settle.indexOf('if (superseded())');
  assert.ok(guardAt >= 0 && guardAt < settle.indexOf('if (result.ok)'),
    'the superseded check must run before the result touches the engine or runtime');
});
