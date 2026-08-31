// Llama Manager — regression tests for the engine readiness timeout in api/server.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Guards the two properties that made the packaged appliance unbootable, both of
// which are invisible to `node --check` and to every runtime test that does not
// actually start a container.
//
// These assert on the SOURCE rather than by importing the module, because
// importing api/server.js starts a real HTTP server and a real engine: the
// module has no test-only entry point, so a runtime assertion here would leave a
// stray server bound to the manager's port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.js');
const source = readFileSync(SERVER, 'utf8');
const lines = source.split('\n');

const lineOf = (predicate) => lines.findIndex(predicate);

test('the engine readiness ceiling leaves room for a container cold start', () => {
  const match = source.match(/const ENGINE_START_WAIT_MS = (\d+);/);
  assert.ok(match, 'ENGINE_START_WAIT_MS is not declared in server.js');

  // A container going from stopped to running re-runs distrobox's own
  // initialization, which upgrades util-linux and pam and only succeeds on a
  // retry after the first transaction fails. That does not fit in 60s. At the
  // old ceiling the manager killed a start that was progressing normally and
  // reported it as "exit code 125", so the appliance never came up.
  assert.ok(
    Number(match[1]) >= 180_000,
    `engine readiness ceiling is ${match[1]}ms, too short for a container cold start`,
  );
});

test('ENGINE_START_WAIT_MS is declared before every site that uses it', () => {
  // Both call sites sit thousands of lines above waitForServerReady, so
  // declaring the const beside that function puts it in the temporal dead zone:
  // whichever path runs first during startup throws ReferenceError and the
  // manager dies at boot. `node --check` does not catch this.
  const declaration = lineOf((l) => l.includes('const ENGINE_START_WAIT_MS ='));
  assert.notEqual(declaration, -1, 'ENGINE_START_WAIT_MS is not declared');

  const uses = lines
    .map((l, i) => (l.includes('ENGINE_START_WAIT_MS') ? i : -1))
    .filter((i) => i !== -1 && i !== declaration);

  assert.ok(uses.length > 0, 'ENGINE_START_WAIT_MS is declared but never used');
  for (const use of uses) {
    assert.ok(
      use > declaration,
      `ENGINE_START_WAIT_MS used on line ${use + 1}, before its declaration on line ${declaration + 1}`,
    );
  }
});

test('neither engine start path is left on the old 60s ceiling', () => {
  // The restart path and the residency-restore path both launch the engine and
  // both must tolerate a cold container; fixing only one leaves the appliance
  // failing on whichever path runs.
  for (const label of ['restart', 'residency-restore']) {
    const call = lines.find(
      (l) => l.includes('waitForServerReady(') && l.includes(`label: '${label}'`),
    );
    assert.ok(call, `no waitForServerReady call found for the ${label} path`);
    assert.match(
      call,
      /maxWait: ENGINE_START_WAIT_MS/,
      `the ${label} path does not use the shared engine readiness ceiling`,
    );
  }
});
