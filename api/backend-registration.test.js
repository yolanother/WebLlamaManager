// Llama Manager — regression test for the default remote-backend endpoint
// capability list registered by POST /api/backends in api/server.js.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// server.js is a monolith with no exports, so this reads its source and
// asserts on the literal default value POST /api/backends falls back to when
// the caller omits `supportedEndpoints`. resolveBackend() and
// findFastestAvailableBackend() gate every remote candidate on
// `backend.supportedEndpoints.includes(endpoint)`; a backend that defaults to
// missing an endpoint name is never viable for it, regardless of whether the
// requested model resolves through an alias. `/v1/responses` (async and sync)
// used this same default and it omitted 'responses', so a backend that only
// serves an alias's remote target (e.g. default-big -> a remote-only alias)
// was never selected, and the request fell through to the local engine with
// the raw unresolved alias name, which correctly reported "model not found".
// This locks the default to cover 'responses' alongside the other three
// OpenAI-compatible endpoints this server proxies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

test('POST /api/backends defaults supportedEndpoints to include responses', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const handlerStart = source.indexOf("app.post('/api/backends'");
  assert.notEqual(handlerStart, -1, 'POST /api/backends handler must still exist');
  const handlerEnd = source.indexOf('\n});', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  const match = handler.match(/supportedEndpoints:\s*supportedEndpoints\s*\|\|\s*\[([^\]]*)\]/);
  assert.ok(match, 'default supportedEndpoints fallback array must be present');

  // The matched source is a flat list of single-quoted string literals; parse it
  // as JSON rather than eval'ing source text.
  const defaultEndpoints = JSON.parse(`[${match[1].replace(/'/g, '"')}]`);
  assert.deepEqual(defaultEndpoints, ['chat/completions', 'completions', 'embeddings', 'responses']);
});
