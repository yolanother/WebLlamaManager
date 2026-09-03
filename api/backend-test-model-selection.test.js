// Llama Manager — regression tests for POST /api/backends/:id/test's probe-model
// selection. Copyright (c) Llama Manager project. Use of this file is governed
// by the LICENSE file in the repository root.
//
// server.js is a monolith with no exports, so this reads its source, extracts the
// pure `selectBackendTestModel()` helper and executes it directly (real imports
// from alias-migration.js / model-aliases.js supplied as arguments), plus
// source-regex assertions that lock the route's wiring around it. Covers
// T31078a98ec6a2: the connectivity test used to read the deleted per-backend
// `modelMapping` (always empty post-migration) and fall back to an arbitrary
// first remote model, which could be legitimately refused by the backend (e.g.
// exclusive DS4 mode) and falsely mark a healthy backend `tested: false`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { synthesizeModelMapping } from './alias-migration.js';
import { expandGlob, BIG_ALIAS } from './model-aliases.js';

/** Load `selectBackendTestModel()` straight out of server.js's source. */
async function loadSelectBackendTestModel() {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function selectBackendTestModel(backend, cfg, remoteModels) {');
  assert.notEqual(start, -1, 'selectBackendTestModel() must still exist in server.js');
  const end = source.indexOf("app.post('/api/backends/:id/test'", start);
  assert.notEqual(end, -1, 'POST /api/backends/:id/test route must still follow the helper');
  const build = new Function(
    'synthesizeModelMapping', 'expandGlob', 'BIG_ALIAS',
    `${source.slice(start, end)}\nreturn selectBackendTestModel;`
  );
  return build(synthesizeModelMapping, expandGlob, BIG_ALIAS);
}

test('selectBackendTestModel prefers a configured default-big alias target for this backend', async () => {
  const selectBackendTestModel = await loadSelectBackendTestModel();
  const cfg = { aliases: { [BIG_ALIAS]: { targets: [{ host: 'drakemore', model: 'default-big' }] } } };
  assert.equal(selectBackendTestModel({ id: 'drakemore' }, cfg, ['Qwen3-8B-Q4_K_M.gguf']), 'default-big');
});

test('selectBackendTestModel falls back to another alias target on this backend when default-big targets elsewhere', async () => {
  const selectBackendTestModel = await loadSelectBackendTestModel();
  const cfg = {
    aliases: {
      [BIG_ALIAS]: { targets: [{ host: 'other-backend', model: 'ds4' }] },
      coder: { targets: [{ host: 'drakemore', model: 'qwen-coder' }] },
    },
  };
  assert.equal(selectBackendTestModel({ id: 'drakemore' }, cfg, []), 'qwen-coder');
});

test('selectBackendTestModel expands a glob alias target against the backend-reported remote models', async () => {
  const selectBackendTestModel = await loadSelectBackendTestModel();
  const cfg = { aliases: { embed: { targets: [{ host: 'drakemore', model: 'qwen-embed-*' }] } } };
  assert.equal(selectBackendTestModel({ id: 'drakemore' }, cfg, ['qwen-embed-v2', 'other']), 'qwen-embed-v2');
});

test('selectBackendTestModel falls back to the first reported remote model only when no alias target exists', async () => {
  const selectBackendTestModel = await loadSelectBackendTestModel();
  assert.equal(selectBackendTestModel({ id: 'drakemore' }, { aliases: {} }, ['Qwen3-8B-Q4_K_M.gguf']), 'Qwen3-8B-Q4_K_M.gguf');
});

test('selectBackendTestModel ignores the deprecated backend.modelMapping field entirely', async () => {
  const selectBackendTestModel = await loadSelectBackendTestModel();
  const backend = { id: 'drakemore', modelMapping: { foo: 'bar' } };
  assert.equal(selectBackendTestModel(backend, { aliases: {} }, []), '');
});

test('selectBackendTestModel returns empty string when nothing is known to probe', async () => {
  const selectBackendTestModel = await loadSelectBackendTestModel();
  assert.equal(selectBackendTestModel({ id: 'drakemore' }, { aliases: {} }, []), '');
});

/** Slice out the POST /api/backends/:id/test route body from server.js's source. */
async function loadTestRouteSource() {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/backends/:id/test'");
  assert.notEqual(start, -1);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test('POST /api/backends/:id/test no longer reads the deprecated backend.modelMapping', async () => {
  const route = await loadTestRouteSource();
  // A mention in an explanatory comment is fine; actually reading the property is the bug.
  assert.doesNotMatch(route, /Object\.values\(backend\.modelMapping/);
  assert.match(route, /selectBackendTestModel\(/);
});

test('POST /api/backends/:id/test honors an explicit request-body test-model override', async () => {
  const route = await loadTestRouteSource();
  assert.match(route, /req\.body\?\.testModel/);
});

test('POST /api/backends/:id/test treats an exclusive_ds4_mode rejection as reachable/healthy, not a failure', async () => {
  const route = await loadTestRouteSource();
  assert.match(route, /DS4_EXCLUSIVE_ERROR/);
  const okStart = route.indexOf('if (response.ok || isDs4ExclusiveRejection)');
  assert.notEqual(okStart, -1, 'the success branch must also accept a ds4-exclusive rejection');
  const elseStart = route.indexOf('} else {', okStart);
  assert.notEqual(elseStart, -1);
  const okBranch = route.slice(okStart, elseStart);
  assert.match(okBranch, /tested = true/);
  assert.match(okBranch, /success: true/);
});
