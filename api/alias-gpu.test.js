// Llama Manager — tests for alias-level GPU pool binding and priority.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Covers the three things this decision has to get right: an alias naming a pool that does
// not exist is an error rather than a silent no-op, an alias with neither field behaves
// exactly as it did before the fields existed, and a model claimed by both `pinnedModels`
// and an alias goes to whichever claim holds the higher priority — decided here, not left
// to evaluation order. Pure input/output: no server, no cards, no timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAliasGpu, aliasPinTargets, poolPinPlan, ALIAS_GROUP_KEYS } from './alias-gpu.js';

/**
 * A resolved-pool stand-in. `poolPinPlan` and `aliasPinTargets` read only the fields the
 * real resolver fills in, so a plain object exercises the same paths a two-card box would.
 *
 * @param {string} id Pool id.
 * @param {object} [rest] Overrides — `defaultPriority`, `pinnedModels`, `capacity`.
 * @returns {object} The pool.
 */
function pool(id, rest = {}) {
  return { id, label: id, match: { pciId: '10de:2204' }, pinnedModels: [], defaultPriority: 0, capacity: 1, cards: [], warnings: [], ...rest };
}

// A realistic table: five aliases, a group with four targets spread over local and two
// remote hosts, a pool that matches no card in this machine, and a pool with no pins.
const POOLS = [
  pool('rtx3090', { pinnedModels: ['gpt-oss-120b'], defaultPriority: 10, capacity: 1 }),
  pool('rtx4090', { defaultPriority: 5, capacity: 0 }), // matches no card present
  pool('apu', { pinnedModels: [], defaultPriority: 0, capacity: 1 }),
];
const POOL_IDS = POOLS.map((p) => p.id);

const ALIASES = {
  'default-big': {
    targets: [
      { host: 'local', model: 'Qwen3-Coder-Next-Q5_K_M' },
      { host: 'pomrath', model: 'qwen3-coder-next' },
      { host: 'drakemore', model: 'Qwen3-Coder-Next-Q5_K_M' },
      { host: 'local', model: 'gpt-oss-120b' },
    ],
    gpu: 'rtx3090',
    gpuPriority: 25,
  },
  'default-small': {
    targets: [{ host: 'local', model: 'Qwen3-8B-Q4_K_M' }],
    gpu: 'apu',
  },
  'code-review': {
    targets: [{ host: 'drakemore', model: 'Qwen3-8B-Q4_K_M' }],
    gpu: 'rtx4090',
    gpuPriority: -5,
  },
  'podcast': { targets: [{ host: 'local', model: 'Qwen3-8B-Q4_K_M' }] },
  'embed': { targets: [{ host: 'pomrath', model: 'nomic-embed' }] },
};

// ---------- normalizeAliasGpu ----------

test('an alias with neither field normalizes to no pool and no priority', () => {
  assert.deepEqual(normalizeAliasGpu('podcast', { targets: [{ host: 'local', model: 'm' }] }, POOL_IDS), {
    gpu: null,
    gpuPriority: null,
  });
});

test('an explicit null for either field is the same as omitting it', () => {
  assert.deepEqual(normalizeAliasGpu('podcast', { targets: [], gpu: null, gpuPriority: null }, POOL_IDS), {
    gpu: null,
    gpuPriority: null,
  });
});

test('a pool id and a priority round-trip', () => {
  assert.deepEqual(normalizeAliasGpu('default-big', ALIASES['default-big'], POOL_IDS), {
    gpu: 'rtx3090',
    gpuPriority: 25,
  });
});

test('a pool named with surrounding whitespace is trimmed to the pool id', () => {
  assert.deepEqual(normalizeAliasGpu('a', { targets: [], gpu: '  rtx3090 ' }, POOL_IDS), {
    gpu: 'rtx3090',
    gpuPriority: null,
  });
});

test('a negative priority is accepted — that is how an alias yields to ordinary work', () => {
  assert.equal(normalizeAliasGpu('code-review', ALIASES['code-review'], POOL_IDS).gpuPriority, -5);
});

test('a zero priority is kept, not collapsed into "absent"', () => {
  assert.equal(normalizeAliasGpu('a', { targets: [], gpu: 'apu', gpuPriority: 0 }, POOL_IDS).gpuPriority, 0);
});

test('an alias naming a pool that does not exist throws, naming both the alias and the pool', () => {
  assert.throws(
    () => normalizeAliasGpu('default-big', { targets: [], gpu: 'rtx5090' }, POOL_IDS),
    (err) => err instanceof TypeError
      && err.message.includes('default-big')
      && err.message.includes('rtx5090')
      && err.message.includes('rtx3090'), // says which pools DO exist
  );
});

test('naming a pool when none are configured throws and says so', () => {
  assert.throws(
    () => normalizeAliasGpu('default-big', { targets: [], gpu: 'rtx3090' }, []),
    /default-big.*rtx3090.*no GPU pools/is,
  );
});

test('a non-string gpu throws naming the offending value', () => {
  assert.throws(() => normalizeAliasGpu('a', { gpu: 3 }, POOL_IDS), /alias "a".*gpu.*3/s);
  assert.throws(() => normalizeAliasGpu('a', { gpu: '   ' }, POOL_IDS), /alias "a".*gpu/s);
  assert.throws(() => normalizeAliasGpu('a', { gpu: ['rtx3090'] }, POOL_IDS), /alias "a".*gpu/s);
});

test('a non-integer priority is rejected', () => {
  assert.throws(() => normalizeAliasGpu('a', { gpu: 'apu', gpuPriority: 1.5 }, POOL_IDS), /alias "a".*gpuPriority.*1\.5/s);
  assert.throws(() => normalizeAliasGpu('a', { gpu: 'apu', gpuPriority: '25' }, POOL_IDS), /alias "a".*gpuPriority/s);
  assert.throws(() => normalizeAliasGpu('a', { gpu: 'apu', gpuPriority: NaN }, POOL_IDS), /alias "a".*gpuPriority/s);
});

test('a priority with no pool is rejected rather than silently ignored', () => {
  assert.throws(() => normalizeAliasGpu('a', { targets: [], gpuPriority: 25 }, POOL_IDS), /alias "a".*gpuPriority.*gpu/s);
});

test('an unknown key throws rather than being dropped', () => {
  assert.throws(
    () => normalizeAliasGpu('a', { targets: [], gpuPool: 'rtx3090' }, POOL_IDS),
    /alias "a".*unknown key "gpuPool".*targets, gpu, gpuPriority/s,
  );
  assert.deepEqual(ALIAS_GROUP_KEYS, ['targets', 'gpu', 'gpuPriority']);
});

test('a non-object alias group throws', () => {
  assert.throws(() => normalizeAliasGpu('a', null, POOL_IDS), /alias "a"/);
  assert.throws(() => normalizeAliasGpu('a', [], POOL_IDS), /alias "a"/);
  assert.throws(() => normalizeAliasGpu('a', 'rtx3090', POOL_IDS), /alias "a"/);
});

// ---------- aliasPinTargets ----------

test('only the LOCAL targets of a bound alias are pinned; remote hosts are untouched', () => {
  const { pins } = aliasPinTargets(ALIASES, POOLS);
  const big = pins.find((p) => p.alias === 'default-big');
  assert.deepEqual(big.models, ['Qwen3-Coder-Next-Q5_K_M', 'gpt-oss-120b']);
  assert.equal(big.pool, 'rtx3090');
  assert.equal(big.priority, 25);
});

test('an alias whose only targets are remote pins nothing, and says why', () => {
  const { pins, warnings } = aliasPinTargets(ALIASES, POOLS);
  assert.equal(pins.some((p) => p.alias === 'code-review'), false);
  assert.equal(warnings.some((w) => w.includes('code-review') && /remote/i.test(w)), true);
});

test('an alias with no gpu contributes nothing and raises nothing', () => {
  const { pins, warnings } = aliasPinTargets({ podcast: ALIASES.podcast }, POOLS);
  assert.deepEqual(pins, []);
  assert.deepEqual(warnings, []);
});

test('an alias omitting gpuPriority inherits the pool default', () => {
  const { pins } = aliasPinTargets({ 'default-small': ALIASES['default-small'] }, [pool('apu', { defaultPriority: 7 })]);
  assert.equal(pins[0].priority, 7);
});

test('a pool that matches no card still takes the pin — capacity is the reservation layer\'s problem', () => {
  const { pins } = aliasPinTargets(
    { a: { targets: [{ host: 'local', model: 'm' }], gpu: 'rtx4090' } },
    POOLS,
  );
  assert.deepEqual(pins, [{ alias: 'a', pool: 'rtx4090', models: ['m'], priority: 5 }]);
});

test('a hand-edited alias naming a missing pool is warned about, not thrown, at resolve time', () => {
  const { pins, warnings } = aliasPinTargets({ a: { targets: [{ host: 'local', model: 'm' }], gpu: 'ghost' } }, POOLS);
  assert.deepEqual(pins, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"a".*ghost/s);
});

test('a glob local target is warned about rather than pinned as a literal name', () => {
  const { pins, warnings } = aliasPinTargets(
    { a: { targets: [{ host: 'local', model: 'gemma4:*' }, { host: 'local', model: 'gemma4-27b' }], gpu: 'apu' } },
    POOLS,
  );
  assert.deepEqual(pins[0].models, ['gemma4-27b']);
  assert.equal(warnings.some((w) => w.includes('gemma4:*')), true);
});

test('a duplicated local model in one alias is pinned once', () => {
  const { pins } = aliasPinTargets(
    { a: { targets: [{ host: 'local', model: 'm' }, { host: 'local', model: 'm' }], gpu: 'apu' } },
    POOLS,
  );
  assert.deepEqual(pins[0].models, ['m']);
});

test('no aliases at all is empty, not a throw', () => {
  assert.deepEqual(aliasPinTargets(undefined, POOLS), { pins: [], warnings: [] });
  assert.deepEqual(aliasPinTargets({}, undefined), { pins: [], warnings: [] });
});

// ---------- poolPinPlan ----------

test('with no alias bound to a pool the plan is exactly today\'s pinnedModels behaviour', () => {
  const plan = poolPinPlan(POOLS, { podcast: ALIASES.podcast, embed: ALIASES.embed });
  assert.deepEqual(plan.pools, [{ id: 'rtx3090', models: ['gpt-oss-120b'], priority: 10 }]);
  assert.deepEqual(plan.notes, []);
});

test('a box with no pools configured plans nothing', () => {
  assert.deepEqual(poolPinPlan([], ALIASES).pools, []);
});

test('an alias pin is added to the pool alongside its own pinnedModels', () => {
  const plan = poolPinPlan(POOLS, ALIASES);
  const rtx = plan.pools.find((p) => p.id === 'rtx3090');
  assert.deepEqual(rtx.models, ['gpt-oss-120b', 'Qwen3-Coder-Next-Q5_K_M']);
  // The alias asks for 25, the pool's own default is 10: the reservation is taken at the
  // highest priority anything on that pool asked for.
  assert.equal(rtx.priority, 25);
  const apu = plan.pools.find((p) => p.id === 'apu');
  assert.deepEqual(apu.models, ['Qwen3-8B-Q4_K_M']);
  assert.equal(apu.priority, 0);
});

test('a model pinned by both pinnedModels and an alias goes to the HIGHER priority, and it is logged', () => {
  const pools = [pool('a', { pinnedModels: ['gpt-oss-120b'], defaultPriority: 3 }), pool('b', { defaultPriority: 0 })];
  const plan = poolPinPlan(pools, { big: { targets: [{ host: 'local', model: 'gpt-oss-120b' }], gpu: 'b', gpuPriority: 30 } });
  assert.deepEqual(plan.pools, [{ id: 'b', models: ['gpt-oss-120b'], priority: 30 }]);
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /gpt-oss-120b/);
  assert.match(plan.notes[0], /"big"/);
  assert.match(plan.notes[0], /30/);
  assert.match(plan.notes[0], /"a"/); // the claim that lost is named too
});

test('when the pool pin outranks the alias the pool keeps the model, and it is logged', () => {
  const pools = [pool('a', { pinnedModels: ['gpt-oss-120b'], defaultPriority: 40 }), pool('b', { defaultPriority: 0 })];
  const plan = poolPinPlan(pools, { big: { targets: [{ host: 'local', model: 'gpt-oss-120b' }], gpu: 'b', gpuPriority: 30 } });
  assert.deepEqual(plan.pools, [{ id: 'a', models: ['gpt-oss-120b'], priority: 40 }]);
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /40/);
});

test('an equal-priority tie goes to the pool pin, deterministically, and is logged', () => {
  const pools = [pool('a', { pinnedModels: ['m'], defaultPriority: 7 }), pool('b', { defaultPriority: 0 })];
  const plan = poolPinPlan(pools, { x: { targets: [{ host: 'local', model: 'm' }], gpu: 'b', gpuPriority: 7 } });
  assert.deepEqual(plan.pools, [{ id: 'a', models: ['m'], priority: 7 }]);
  assert.equal(plan.notes.length, 1);
});

test('two aliases naming the same pool merge into one reservation at the higher priority', () => {
  const pools = [pool('a', { defaultPriority: 0 })];
  const plan = poolPinPlan(pools, {
    one: { targets: [{ host: 'local', model: 'm1' }], gpu: 'a', gpuPriority: 4 },
    two: { targets: [{ host: 'local', model: 'm2' }], gpu: 'a', gpuPriority: 12 },
  });
  assert.deepEqual(plan.pools, [{ id: 'a', models: ['m1', 'm2'], priority: 12 }]);
  assert.deepEqual(plan.notes, []); // different models — nothing was contested
});

test('two aliases contesting one model on different pools resolve by priority', () => {
  const pools = [pool('a', { defaultPriority: 0 }), pool('b', { defaultPriority: 0 })];
  const plan = poolPinPlan(pools, {
    lo: { targets: [{ host: 'local', model: 'm' }], gpu: 'a', gpuPriority: 1 },
    hi: { targets: [{ host: 'local', model: 'm' }], gpu: 'b', gpuPriority: 2 },
  });
  assert.deepEqual(plan.pools, [{ id: 'b', models: ['m'], priority: 2 }]);
  assert.equal(plan.notes.length, 1);
});

test('a pool whose every pinned model was won by a higher-priority alias drops out of the plan', () => {
  const pools = [pool('a', { pinnedModels: ['m'], defaultPriority: 0 }), pool('b', { defaultPriority: 0 })];
  const plan = poolPinPlan(pools, { hi: { targets: [{ host: 'local', model: 'm' }], gpu: 'b', gpuPriority: 9 } });
  assert.deepEqual(plan.pools.map((p) => p.id), ['b']);
});

test('the plan carries the resolver warnings so the caller logs them once', () => {
  const plan = poolPinPlan(POOLS, { a: { targets: [{ host: 'local', model: 'm' }], gpu: 'ghost' } });
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /ghost/);
});

test('plan order follows the operator\'s pool order, so the engine pin is predictable', () => {
  const pools = [pool('first', { defaultPriority: 0 }), pool('second', { defaultPriority: 0 })];
  const plan = poolPinPlan(pools, {
    b: { targets: [{ host: 'local', model: 'm2' }], gpu: 'second' },
    a: { targets: [{ host: 'local', model: 'm1' }], gpu: 'first' },
  });
  assert.deepEqual(plan.pools.map((p) => p.id), ['first', 'second']);
});

// ---------- server.js wiring ----------
// server.js is a monolith with no exports, so these read its source, in the house style of
// api/backend-registration.test.js. They guard the three places where the wiring has
// actually been wrong: the pin path reading the raw `pinnedModels` instead of the decided
// plan, the alias write path accepting a pool that does not exist, and a pin outliving the
// alias that asked for it.

import { readFile } from 'fs/promises';

const SERVER = await readFile(new URL('./server.js', import.meta.url), 'utf8');

test('the pin path reads the decided plan, never a pool\'s raw pinnedModels', () => {
  for (const fn of ['function syncGpuPinReservations()', 'function activeGpuPin()', 'function gpuPinPresetDevices(']) {
    const start = SERVER.indexOf(fn);
    assert.notEqual(start, -1, `${fn} must still exist`);
    const body = SERVER.slice(start, SERVER.indexOf('\n}\n', start));
    assert.equal(body.includes('pinnedModels'), false, `${fn} must consult gpuPinPlan, not pinnedModels`);
    assert.equal(body.includes('gpuPinPlan'), true, `${fn} must consult gpuPinPlan`);
  }
});

test('PUT /api/aliases/:name validates the GPU binding and 400s rather than storing it', () => {
  const start = SERVER.indexOf("app.put('/api/aliases/:name'");
  assert.notEqual(start, -1);
  const handler = SERVER.slice(start, SERVER.indexOf('\n});', start));
  assert.match(handler, /normalizeAliasGpu\(/);
  assert.match(handler, /catch \(err\) \{\s*return res\.status\(400\)/);
  // The binding must be validated BEFORE anything is written to config.aliases.
  assert.ok(handler.indexOf('normalizeAliasGpu(') < handler.indexOf('config.aliases[name] ='));
});

test('a pin whose pool has left the plan is released, not left holding the card', () => {
  const start = SERVER.indexOf('function syncGpuPinReservations()');
  const body = SERVER.slice(start, SERVER.indexOf('\n}\n', start));
  assert.match(body, /gpuPinReservations\)\s*\{[\s\S]*gpuReservations\.release/);
  assert.match(body, /gpuPinReservations\.delete/);
});
