// Llama Manager — regression test for stopLlamaServer's explicitReclaim default.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// server.js is a monolith with no exports, so this reads its source and pins
// the literal default value of stopLlamaServer's explicitReclaim parameter.
// api/engine-cleanup-policy.test.js proves shouldRunGlobalEngineCleanup()
// itself is fail-closed, but that pure function was never the bug: the
// defect was stopLlamaServer() defaulting explicitReclaim to true, which
// made every plain no-argument call (auto-restart, mode switches, the stop
// endpoint, idle shutdown) bypass the ownership check and authorize a
// host-wide kill of every llama-server process on the host — including
// another manager instance's production engine. The policy tests alone
// cannot see this because they never touch the caller's default. This test
// anchors on the actual function signature (not a comment) so a future
// revert back to `= true` fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

test('stopLlamaServer defaults explicitReclaim to false', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const match = source.match(/async function stopLlamaServer\(\{\s*explicitReclaim\s*=\s*(true|false)\s*\}\s*=\s*\{\}\)/);
  assert.ok(match, 'stopLlamaServer signature with an explicitReclaim default must still exist');
  assert.equal(match[1], 'false');
});
