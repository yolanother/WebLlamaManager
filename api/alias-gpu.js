/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Binds an ALIAS to a named GPU pool and to a priority of its own, and resolves
 * the result into the per-pool model pins the reservation layer already
 * understands. Pools and per-model pins shipped as JSON-only knobs keyed on
 * concrete model ids; this is the layer that lets the operator say "default-big
 * runs on the 3090, and it outranks the pods agent" without naming the model
 * that alias happens to point at today.
 *
 * Two decisions live here. The first is validation at the write boundary: an
 * alias naming a pool that does not exist, a priority that is not an integer, a
 * priority with no pool to apply it to, or a key nobody reads are all errors
 * that name the alias and the offending value -- never a silently dropped field,
 * which is the failure mode this whole area has been cured of twice. The second
 * is precedence: a model claimed both by a pool's own `pinnedModels` and by an
 * alias bound elsewhere goes to whichever claim holds the HIGHER priority, and
 * the decision is reported so the loser is visible in the log rather than being
 * whatever evaluation order happened to produce.
 *
 * Pools are a LOCAL concept, so only an alias target on host `local` is ever
 * pinned; remote targets route exactly as they did. Pure and I/O-free: every
 * case that matters -- several aliases contesting one card, a pool that matches
 * no card in this machine, a group spread over local and remote hosts -- is
 * testable on a box with one GPU and no engine running.
 */

/**
 * Every key an alias group may carry. An unknown key is an operator typo, and it
 * is rejected rather than ignored for the same reason `normalizePoolConfig`
 * rejects an unknown match selector: a field nobody reads leaves the alias doing
 * less than what was written, with nothing said about it.
 * @type {ReadonlyArray<string>}
 */
export const ALIAS_GROUP_KEYS = ['targets', 'gpu', 'gpuPriority'];

/** Host sentinel meaning "this manager". Mirrors api/model-aliases.js. */
const LOCAL_HOST = 'local';

/**
 * Validate an alias group's GPU binding and fill in what it omits.
 *
 * Runs at the trust boundary -- `PUT /api/aliases/:name` and any hand-edited
 * config.json -- so it is strict about shape and about the pool actually
 * existing. It reads no other part of the group: `targets` is validated by
 * {@link import('./model-aliases.js').validateAlias}, and is accepted here in
 * whatever shape it arrives so the two validators can run in either order.
 *
 * @param {string} alias The alias name, used in every message so an operator
 *   reading a 400 knows which of their aliases is wrong.
 * @param {?object} entry The stored alias group.
 * @param {?Array<string>} poolIds Ids of the pools configured in settings, in
 *   the operator's order; an empty list means no pools are configured and any
 *   `gpu` at all is therefore an error.
 * @returns {{gpu: ?string, gpuPriority: ?number}} The normalized pair. `gpu` is
 *   trimmed; both are null when absent, and a null `gpuPriority` means "use the
 *   pool's defaultPriority" -- distinct from an explicit 0, which is
 *   llama-manager's baseline and is preserved.
 * @throws {TypeError} When the group is not an object, carries an unknown key,
 *   names a pool that is not configured, sets a non-integer `gpuPriority`, or
 *   sets a `gpuPriority` with no `gpu` for it to apply to.
 */
export function normalizeAliasGpu(alias, entry, poolIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`alias "${alias}" must be an object, got ${entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry}`);
  }
  for (const key of Object.keys(entry)) {
    if (!ALIAS_GROUP_KEYS.includes(key)) {
      throw new TypeError(`alias "${alias}" has unknown key "${key}"; known keys are ${ALIAS_GROUP_KEYS.join(', ')}`);
    }
  }

  const known = (Array.isArray(poolIds) ? poolIds : []).map((id) => String(id).trim()).filter(Boolean);

  let gpu = null;
  if (entry.gpu !== undefined && entry.gpu !== null) {
    if (typeof entry.gpu !== 'string' || !entry.gpu.trim()) {
      throw new TypeError(`alias "${alias}" gpu must be a GPU pool id, got ${JSON.stringify(entry.gpu)}`);
    }
    gpu = entry.gpu.trim();
    if (!known.includes(gpu)) {
      throw new TypeError(
        `alias "${alias}" names GPU pool "${gpu}", which is not configured; `
        + (known.length ? `configured pools are ${known.join(', ')}` : 'no GPU pools are configured on this machine'),
      );
    }
  }

  let gpuPriority = null;
  if (entry.gpuPriority !== undefined && entry.gpuPriority !== null) {
    if (!Number.isSafeInteger(entry.gpuPriority)) {
      throw new TypeError(`alias "${alias}" gpuPriority must be an integer, got ${JSON.stringify(entry.gpuPriority) ?? String(entry.gpuPriority)}`);
    }
    if (!gpu) {
      throw new TypeError(`alias "${alias}" sets gpuPriority ${entry.gpuPriority} but no gpu; a priority has no meaning without a pool to hold`);
    }
    gpuPriority = entry.gpuPriority;
  }

  return { gpu, gpuPriority };
}

/**
 * Which local models each bound alias asks a pool to pin, and at what priority.
 *
 * Tolerant where {@link normalizeAliasGpu} is strict: this runs on every pool
 * refresh against config that may have been hand-edited since it was written, so
 * a group that fails validation costs that one alias its pin and produces a
 * warning, rather than throwing and taking every other pin down with it.
 *
 * @param {?Object<string, object>} aliases The alias table (`config.aliases`).
 * @param {?Array<{id: string, defaultPriority: number}>} pools Resolved pools,
 *   in the operator's order.
 * @returns {{pins: Array<{alias: string, pool: string, models: Array<string>, priority: number}>,
 *   warnings: Array<string>}} One pin per alias that binds a pool AND has at
 *   least one concrete local target, in alias order; `warnings` names every
 *   alias whose binding could not be applied and why.
 */
export function aliasPinTargets(aliases, pools) {
  const table = aliases && typeof aliases === 'object' && !Array.isArray(aliases) ? aliases : {};
  const list = Array.isArray(pools) ? pools : [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const pins = [];
  const warnings = [];

  for (const [alias, entry] of Object.entries(table)) {
    let binding;
    try {
      binding = normalizeAliasGpu(alias, entry, [...byId.keys()]);
    } catch (err) {
      warnings.push(`${err.message}; its GPU binding is ignored`);
      continue;
    }
    if (!binding.gpu) continue;

    const pool = byId.get(binding.gpu);
    const models = [];
    for (const target of Array.isArray(entry.targets) ? entry.targets : []) {
      if (!target || typeof target !== 'object') continue;
      if (target.host !== LOCAL_HOST) continue;
      const model = typeof target.model === 'string' ? target.model.trim() : '';
      if (!model) continue;
      if (model.includes('*') || model.includes('?')) {
        // A pin names one concrete model in the engine's preset; a glob would be
        // written through as a literal name and match nothing at all.
        warnings.push(`alias "${alias}" local target "${model}" is a glob, and a GPU pin names a concrete model, so it is not pinned to "${binding.gpu}"`);
        continue;
      }
      if (!models.includes(model)) models.push(model);
    }

    if (models.length === 0) {
      warnings.push(`alias "${alias}" is bound to GPU pool "${binding.gpu}" but has no concrete local target, so nothing is pinned; a pool is a local concept and remote targets are unaffected`);
      continue;
    }
    pins.push({ alias, pool: pool.id, models, priority: binding.gpuPriority ?? pool.defaultPriority });
  }

  return { pins, warnings };
}

/**
 * The complete set of model pins per pool, with every contest already decided.
 *
 * A pool's reservation is ONE lease on ONE card, so a pool that pins anything
 * holds it at a single priority: the highest that any claim on that pool asked
 * for. Where two claims want the same MODEL -- the pool's own `pinnedModels` and
 * an alias bound to a different pool being the case that matters -- the higher
 * priority takes the model outright and the loser is reported. An exact tie goes
 * to the earlier claim, which is the pool's own pin ahead of any alias and
 * config order among pools, matching `resolvePools`' tie-break: deterministic
 * and visible to the operator beats clever.
 *
 * With no alias bound to any pool the output is exactly each pool's
 * `pinnedModels` at its `defaultPriority` -- the behaviour before alias binding
 * existed, unchanged.
 *
 * @param {?Array<{id: string, pinnedModels?: Array<string>, defaultPriority: number}>} pools
 *   Resolved pools, in the operator's order.
 * @param {?Object<string, object>} aliases The alias table (`config.aliases`).
 * @returns {{pools: Array<{id: string, models: Array<string>, priority: number}>,
 *   notes: Array<string>, warnings: Array<string>}} `pools` holds only those
 *   pinning at least one model, in config order; `notes` explains every contest
 *   that was decided; `warnings` passes through {@link aliasPinTargets}.
 */
export function poolPinPlan(pools, aliases) {
  const list = Array.isArray(pools) ? pools : [];
  const { pins, warnings } = aliasPinTargets(aliases, list);

  // Claims in decision order: every pool's own pin first, in config order, then
  // the alias pins. Order is the tie-break, so it is established once, here.
  const claims = [];
  for (const pool of list) {
    for (const model of Array.isArray(pool.pinnedModels) ? pool.pinnedModels : []) {
      claims.push({ model, pool: pool.id, priority: pool.defaultPriority, source: `pool "${pool.id}" pinnedModels` });
    }
  }
  for (const pin of pins) {
    for (const model of pin.models) {
      claims.push({ model, pool: pin.pool, priority: pin.priority, source: `alias "${pin.alias}"` });
    }
  }

  const notes = [];
  const winners = [];
  const byModel = new Map();
  for (const claim of claims) {
    if (!byModel.has(claim.model)) byModel.set(claim.model, []);
    byModel.get(claim.model).push(claim);
  }
  for (const [model, contenders] of byModel) {
    const winner = contenders.reduce((best, c) => (c.priority > best.priority ? c : best));
    winners.push(winner);
    if (contenders.length > 1) {
      const losers = contenders.filter((c) => c !== winner).map((c) => `${c.source} on "${c.pool}" at ${c.priority}`);
      notes.push(`GPU pin for "${model}": ${winner.source} wins the model on pool "${winner.pool}" at priority ${winner.priority}, ahead of ${losers.join(' and ')}`);
    }
  }

  // Rebuild per pool in config order, keeping each pool's models in claim order.
  const planned = [];
  for (const pool of list) {
    const mine = winners.filter((w) => w.pool === pool.id);
    if (mine.length === 0) continue;
    planned.push({
      id: pool.id,
      models: mine.map((w) => w.model),
      priority: mine.reduce((max, w) => Math.max(max, w.priority), mine[0].priority),
    });
  }

  return { pools: planned, notes, warnings };
}
