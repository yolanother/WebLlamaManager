// Llama Manager dashboard offline asset contract tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repository
// root for license terms.
//
// Verifies that the production HTML entry point does not ask a browser to load
// third-party styles or establish third-party font connections. This keeps the
// appliance dashboard usable offline and prevents unintended client requests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard entry point has no external stylesheet or font preconnect', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const externalStyleOrPreconnect = /<link\b(?=[^>]*\brel=["'](?:stylesheet|preconnect)["'])(?=[^>]*\bhref=["']https?:\/\/)[^>]*>/gi;

  assert.deepEqual(html.match(externalStyleOrPreconnect) ?? [], []);
});
