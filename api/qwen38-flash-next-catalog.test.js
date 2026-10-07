// Llama Manager — public Flash-Next model catalog availability contracts.
// Copyright (c) Llama Manager project. The LICENSE file in the repo root governs use.
// Executes the real filesystem scanner and OpenAI model-list handler in isolation
// to verify that partial downloads never become selectable planner entries, that
// complete legacy weights remain usable, and that other model rows are preserved.
// Also checks the manager's served-model list without hiding cleanup inventory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as engines from './engines.js';
import { duoChainModelEntry } from './duo-chain.js';
import { DUO_PLANNER_ID, DUO_WORKER_ID } from './duo-exclusive.js';
import { modelDirectoryKey, normalizeModelKey } from './model-identity.js';

const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const serverFunctions = [
  source.slice(source.indexOf('function isSplitModelPart('), source.indexOf('// API Routes')),
  source.slice(source.indexOf('function duoWeightPaths('), source.indexOf('function resolveLoadMode(')),
  source.slice(source.indexOf('async function handleModels('), source.indexOf("app.get('/api/v1/models', handleModels)")),
  source.slice(source.indexOf("app.get('/api/models', async"), source.indexOf('/**\n * Return every GGUF path')),
].join('\n');
const podcastId = 'podcast-qwen3.8-16k';
const otherId = 'Other-model-Q4_K_M.gguf';
const iq4Id = `${DUO_PLANNER_ID}/Qwen3.8-Flash-Next-UD-IQ4_XS.gguf`;
const legacyId = `${DUO_PLANNER_ID}/Qwen3.8-Flash-Next-UD-IQ3_XXS.gguf`;
const iq4 = [1, 2, 3].map(part => `${DUO_PLANNER_ID}/Qwen3.8-Flash-Next-UD-IQ4_XS-0000${part}-of-00003.gguf`);
const legacy = [1, 2, 3].map(part => `${DUO_PLANNER_ID}/Qwen3.8-Flash-Next-UD-IQ3_XXS-0000${part}-of-00003.gguf`);

/**
 * Invoke the actual model-list handler against temporary files and router rows.
 * Startup, network transport, and unrelated engine services are isolated so no
 * appliance server or model process is started by this test.
 * @param {import('node:test').TestContext} t Cleanup owner.
 * @param {string[]} files Relative GGUF files installed for the scenario.
 * @param {Object[]|null} routerRows Router response rows, or null when stopped.
 * @returns {Promise<{catalog:Object, management:Object, scanned:Object[]}>} Actual responses and disk inventory.
 */
async function catalogFor(t, files, routerRows) {
  const modelsDir = mkdtempSync(join(tmpdir(), 'llama-flash-catalog-'));
  t.after(() => rmSync(modelsDir, { recursive: true, force: true }));
  for (const file of [...files, otherId, `${DUO_WORKER_ID}/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`]) {
    const path = join(modelsDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'GGUF');
  }
  const errors = [];
  const routes = new Map();
  const handlers = runInNewContext(`${serverFunctions}\n({handleModels, scanLocalModels, managerModels: routes.get('/api/models')});`, {
    ...engines,
    AbortSignal,
    DUO_PLANNER_ID,
    DUO_WORKER_ID,
    MODELS_DIR: modelsDir,
    LLAMA_PORT: 8080,
    RUNTIME_ENV: {},
    config: { contextSize: 65536, modelAliases: {} },
    currentEngine: engines.ENGINE_TYPES.LLAMA,
    currentPreset: null,
    lastUsedModel: null,
    lastUsedModelTime: null,
    routes,
    app: { get: (path, handler) => routes.set(path, handler) },
    existsSync, readdirSync, statSync, join,
    normalizeModelKey, modelDirectoryKey, duoChainModelEntry,
    console: { error: (...args) => errors.push(args.join(' ')) },
    fetch: async () => {
      if (routerRows === null) throw new Error('Router stopped');
      return { ok: true, json: async () => ({ data: routerRows }) };
    },
    ds4ModelsList: () => null,
    resolveDs4Config: () => ({ ggufDir: '/not-installed' }),
    listDs4GgufFiles: () => [],
    resolveEmbedConfig: () => ({ runnable: false }),
    contextCapabilities: () => ({}),
    slotCacheCfg: () => ({ enabled: false }),
    rememberModelSlotCapability: () => false,
    knownRemoteWindows: () => ({}),
    aliasListEntries: () => [],
    desiredResidentModels: () => [],
    annotateModelResidency: rows => rows,
    addModelCapabilityMetadata: rows => rows,
    resolveModelCapabilities: () => ({}),
  });
  let catalog;
  await handlers.handleModels({}, { json: body => { catalog = body; } });
  let management;
  const managerResponse = {
    json: body => { management = body; },
    status: () => managerResponse,
  };
  await handlers.managerModels({}, managerResponse);
  assert.deepEqual(errors, [], 'catalog publication must complete without silently falling back on handler errors');
  assert.equal(catalog.object, 'list');
  assert.ok(Array.isArray(management.serverModels), 'the actual manager model handler must return its served-model inventory');
  return { catalog, management, scanned: handlers.scanLocalModels() };
}

const cases = [
  { name: 'an IQ4 first shard alone', files: [iq4[0]], complete: [], incomplete: [iq4Id] },
  { name: 'IQ4 with a missing middle shard', files: [iq4[0], iq4[2]], complete: [], incomplete: [iq4Id] },
  { name: 'a legacy first shard alone', files: [legacy[0]], complete: [], incomplete: [legacyId] },
  { name: 'complete legacy weights', files: legacy, complete: [legacyId], incomplete: [] },
  { name: 'complete legacy beside a partial IQ4 download', files: [...legacy, iq4[0]], complete: [legacyId], incomplete: [iq4Id] },
  { name: 'complete IQ4 weights', files: iq4, complete: [iq4Id], incomplete: [] },
  { name: 'complete IQ4 beside a partial legacy download', files: [...iq4, legacy[0]], complete: [iq4Id], incomplete: [legacyId] },
  { name: 'both complete quantizations', files: [...legacy, ...iq4], complete: [legacyId, iq4Id], incomplete: [] },
];

for (const scenario of cases) {
  test(`stopped-router public catalog: ${scenario.name}`, async t => {
    const { catalog, scanned } = await catalogFor(t, scenario.files, null);
    const ids = new Set(catalog.data.map(row => row.id));
    assert.ok(ids.has(otherId), 'unrelated downloaded models remain selectable');
    for (const id of scenario.incomplete) {
      assert.equal(scanned.find(row => row.name === id)?.incomplete, true,
        'the actual disk inventory must retain its partial-download information');
      assert.equal(ids.has(id), false, 'an incomplete Flash-Next download must not be advertised as available');
    }
    for (const id of scenario.complete) {
      assert.equal(catalog.data.find(row => row.id === id)?.status, 'available',
        'every complete installed quantization remains selectable while the router is stopped');
    }
    if (scenario.complete.length === 0) {
      assert.equal(catalog.data.some(row => row.id === DUO_PLANNER_ID || row.id === podcastId), false);
    }
  });

  test(`router-derived public catalog: ${scenario.name}`, async t => {
    const routerRows = [
      { id: DUO_PLANNER_ID, status: { value: 'unloaded', args: ['--ctx-size', '262144'] } },
      { id: podcastId, status: { value: 'unloaded', args: ['--ctx-size', '16384'] } },
      { id: otherId, status: { value: 'loaded', args: ['--ctx-size', '8192'] } },
      ...scenario.incomplete.map(id => ({ id, status: { value: 'unloaded', args: [] } })),
    ];
    const { catalog } = await catalogFor(t, scenario.files, routerRows);
    const ids = new Set(catalog.data.map(row => row.id));
    const unrelated = catalog.data.find(row => row.id === otherId);
    assert.equal(unrelated?.status, 'loaded');
    assert.equal(unrelated.n_ctx, 8192);
    for (const id of scenario.incomplete) {
      assert.equal(ids.has(id), false, 'router rows must not make an incomplete download selectable');
    }
    if (scenario.complete.length === 0) {
      assert.equal(ids.has(DUO_PLANNER_ID), false, 'stale router canonical rows need a complete installed weight set');
      assert.equal(ids.has(podcastId), false, 'stale podcast rows need a complete installed weight set');
    } else {
      assert.equal(catalog.data.find(row => row.id === DUO_PLANNER_ID)?.n_ctx, 262144);
      assert.equal(catalog.data.find(row => row.id === podcastId)?.n_ctx, 16384);
      assert.equal(catalog.data.find(row => row.id === DUO_PLANNER_ID)?.status, 'unloaded');
    }
  });

  test(`manager served-model catalog: ${scenario.name}`, async t => {
    const routerRows = [
      { id: DUO_PLANNER_ID, status: { value: 'unloaded', args: ['--ctx-size', '262144'] } },
      { id: podcastId, status: { value: 'unloaded', args: ['--ctx-size', '16384'] } },
      { id: otherId, status: { value: 'loaded', args: ['--ctx-size', '8192'] } },
      ...scenario.incomplete.map(id => ({ id, status: { value: 'unloaded', args: [] } })),
    ];
    const { management } = await catalogFor(t, scenario.files, routerRows);
    const servedIds = new Set(management.serverModels.map(row => row.id));
    assert.equal(management.serverModels.find(row => row.id === otherId)?.status?.value, 'loaded');
    for (const id of scenario.incomplete) {
      assert.equal(management.localModels.find(row => row.name === id)?.incomplete, true,
        'partial downloads remain visible in local inventory for cleanup');
      assert.equal(servedIds.has(id), false, 'a partial GGUF is never offered in the manager served-model list');
    }
    assert.equal(servedIds.has(DUO_PLANNER_ID), scenario.complete.length > 0);
    assert.equal(servedIds.has(podcastId), scenario.complete.length > 0);
  });

  if (scenario.complete.length === 0) {
    test(`router preset-only catalog: ${scenario.name}`, async t => {
      const routerRows = [
        { id: DUO_PLANNER_ID, status: { value: 'unloaded', args: ['--ctx-size', '262144'] } },
        { id: podcastId, status: { value: 'unloaded', args: ['--ctx-size', '16384'] } },
        { id: otherId, status: { value: 'loaded', args: ['--ctx-size', '8192'] } },
      ];
      const { catalog, management } = await catalogFor(t, scenario.files, routerRows);
      for (const id of [DUO_PLANNER_ID, podcastId]) {
        assert.equal(catalog.data.some(row => row.id === id), false,
          'a stale preset route is not available without a complete installed weight set');
        assert.equal(management.serverModels.some(row => row.id === id), false);
      }
    });
  }
}
