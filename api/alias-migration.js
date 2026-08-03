// Llama Manager — one-time migration of per-backend modelMapping into alias groups.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Bridges the pre-alias configuration shape to the unified `config.aliases` table.
// `migrateModelMappings()` runs once at config load: it folds every remote backend's
// `modelMapping` into global alias groups, diverts the `"*"` catch-all key to
// `backend.acceptsAny` (which was never an alias, only a host policy), seeds the
// `default-big` / `default-small` groups from the legacy `defaultBigModel` /
// `defaultSmallModel` keys, and deletes all three legacy sources so the alias table
// becomes the single source of truth. It is idempotent, keyed on `config.aliases`
// already being present, because it runs on every server boot.
//
// The other two exports back the deprecation shim that keeps `GET /api/backends` and
// `PUT /api/backends/:id` speaking `modelMapping` for a release cycle:
// `synthesizeModelMapping()` projects the alias table back down to one backend's flat
// mapping, and `foldModelMapping()` merges an incoming flat mapping into the alias
// table without disturbing targets that belong to other hosts.
//
// This module is deliberately separate from `api/model-aliases.js`: this code is
// one-time and legacy-facing, while that module sits on the hot request path. Pure
// helpers only — no I/O, no imports from server.js; the caller owns reading and
// writing the config file.

/** Alias name seeded from the legacy `config.defaultBigModel` key. */
const BIG_ALIAS = 'default-big';

/** Alias name seeded from the legacy `config.defaultSmallModel` key. */
const SMALL_ALIAS = 'default-small';

/** The `modelMapping` key that means "this host accepts anything", not an alias. */
const CATCH_ALL_KEY = '*';

/**
 * Returns true when the value is a usable mapping target: a string with
 * non-whitespace content. Today's resolver treats `''` as "no mapping", so a blank
 * target must never be folded into an alias — doing so would invent routing that
 * never existed.
 *
 * @param {*} target candidate mapping target
 * @returns {boolean} true when the target names a real model
 */
function isUsableTarget(target) {
  return typeof target === 'string' && target.trim().length > 0;
}

/**
 * Returns true when an alias name contains glob metacharacters. Alias names are
 * exact under the new contract, so such a key migrates under its literal name and
 * earns a warning.
 *
 * @param {string} key alias name taken from a legacy `modelMapping` key
 * @returns {boolean} true when the key contains `*` or `?`
 */
function isGlobKey(key) {
  return key.includes('*') || key.includes('?');
}

/**
 * Locate a backend entry in `config.backends.directory` by id.
 *
 * @param {{backends?: {directory?: Array<object>}}|null|undefined} config server config
 * @param {string} backendId backend id to find
 * @returns {object|null} the backend object, or null when absent
 */
function findBackend(config, backendId) {
  const directory = config?.backends?.directory;
  if (!Array.isArray(directory)) return null;
  return directory.find((b) => b && b.id === backendId) ?? null;
}

/**
 * Append a target to an alias group, creating the group when it does not exist yet.
 * Insertion order of both the group and its targets is preserved, since target order
 * is authored intent and is the final tiebreak when routing ranks candidates.
 *
 * @param {Object<string, {targets: Array<{host: string, model: string}>}>} aliases the alias table
 * @param {string} name alias name
 * @param {string} host `'local'` or a backend id
 * @param {string} model target model name (may be a glob)
 * @returns {void}
 */
function appendTarget(aliases, name, host, model) {
  if (!aliases[name] || !Array.isArray(aliases[name].targets)) {
    aliases[name] = { targets: [] };
  }
  aliases[name].targets.push({ host, model });
}

/**
 * Fold every per-backend `modelMapping` and the legacy default-model keys into a
 * single global `config.aliases` table, in place.
 *
 * Idempotency is keyed on `config.aliases` already being present: this function runs
 * on every server boot, and a second pass must not double-fold. When the key exists
 * the call is a no-op reporting `migrated: false`.
 *
 * Otherwise, for each backend in `config.backends.directory` (in order) and each
 * `[key, target]` of its `modelMapping` (in insertion order):
 *   - `key === '*'` is not an alias — it becomes `backend.acceptsAny` when the target
 *     is a non-blank string, and creates no alias group.
 *   - a falsy or blank target is skipped with a warning.
 *   - anything else appends `{host: backend.id, model: target}` to the alias group
 *     named by the key, creating it when needed. A key containing `*` or `?` still
 *     migrates under its literal name, with a warning that alias names no longer glob.
 * The backend's `modelMapping` is then deleted.
 *
 * Finally `defaultBigModel` / `defaultSmallModel`, when set and non-blank, seed
 * `default-big` / `default-small` with a single `local` target (appending, with a
 * warning, if a group of that name was already built from a mapping), and both legacy
 * keys are deleted.
 *
 * @param {{aliases?: object, backends?: {directory?: Array<object>}, defaultBigModel?: string, defaultSmallModel?: string}|null|undefined} config
 *   the persisted server configuration; MUTATED in place.
 * @returns {{migrated: boolean, warnings: string[]}} `migrated` is false when the
 *   config was already migrated (or unusable); `warnings` describes every skipped or
 *   surprising entry encountered.
 */
export function migrateModelMappings(config) {
  if (!config || typeof config !== 'object') return { migrated: false, warnings: [] };
  if (config.aliases) return { migrated: false, warnings: [] };

  const warnings = [];
  config.aliases = {};

  const directory = Array.isArray(config.backends?.directory) ? config.backends.directory : [];
  for (const backend of directory) {
    if (!backend || typeof backend !== 'object') continue;
    const mapping = backend.modelMapping;
    if (mapping && typeof mapping === 'object') {
      for (const [key, target] of Object.entries(mapping)) {
        if (key === CATCH_ALL_KEY) {
          if (isUsableTarget(target)) {
            backend.acceptsAny = target;
          } else {
            warnings.push(`backend '${backend.id}': blank '*' mapping target dropped; acceptsAny left unset`);
          }
          continue;
        }
        if (!isUsableTarget(target)) {
          warnings.push(`backend '${backend.id}': mapping '${key}' has a blank target and was skipped`);
          continue;
        }
        if (isGlobKey(key)) {
          warnings.push(`backend '${backend.id}': mapping key '${key}' looks like a glob; alias names no longer glob, so it migrated under that literal name`);
        }
        appendTarget(config.aliases, key, backend.id, target);
      }
    }
    delete backend.modelMapping;
  }

  seedDefaultAlias(config, warnings, BIG_ALIAS, config.defaultBigModel, 'defaultBigModel');
  seedDefaultAlias(config, warnings, SMALL_ALIAS, config.defaultSmallModel, 'defaultSmallModel');
  delete config.defaultBigModel;
  delete config.defaultSmallModel;

  return { migrated: true, warnings };
}

/**
 * Seed one legacy default-model key into its alias group. A set, non-blank value
 * becomes a single trimmed `local` target. When a group of that name already exists
 * (built from a backend mapping in the fold above) the target is appended rather than
 * overwriting the operator's mapping, and a warning is recorded.
 *
 * @param {{aliases: Object<string, {targets: Array<{host: string, model: string}>}>}} config config being migrated; MUTATED.
 * @param {string[]} warnings warning accumulator; MUTATED.
 * @param {string} name alias name to seed (`default-big` or `default-small`).
 * @param {*} raw the legacy configured value.
 * @param {string} sourceKey the legacy config key name, for the warning text.
 * @returns {void}
 */
function seedDefaultAlias(config, warnings, name, raw, sourceKey) {
  if (!isUsableTarget(raw)) return;
  const model = raw.trim();
  if (config.aliases[name]) {
    warnings.push(`${sourceKey} ('${model}') was appended to the existing '${name}' alias built from a backend modelMapping`);
    appendTarget(config.aliases, name, 'local', model);
    return;
  }
  config.aliases[name] = { targets: [{ host: 'local', model }] };
}

/**
 * Project the alias table back down to one backend's flat `modelMapping`, the
 * deprecated view still served by `GET /api/backends`.
 *
 * Every alias group holding a target on `backendId` contributes one entry keyed by
 * the alias name; when a group has several targets on the same backend the first
 * wins. The backend's `acceptsAny` policy, when set, is appended as the `'*'` key so
 * existing clients see the shape they always saw.
 *
 * @param {{aliases?: object, backends?: {directory?: Array<object>}}|null|undefined} config server config (not mutated).
 * @param {string} backendId the backend whose mapping view is wanted.
 * @returns {Object<string, string>} alias name → model name, possibly empty.
 */
export function synthesizeModelMapping(config, backendId) {
  const mapping = {};
  if (!config || typeof config !== 'object') return mapping;
  if (typeof backendId !== 'string' || !backendId) return mapping;

  const aliases = config.aliases;
  if (aliases && typeof aliases === 'object') {
    for (const [name, group] of Object.entries(aliases)) {
      const targets = group?.targets;
      if (!Array.isArray(targets)) continue;
      const hit = targets.find((t) => t && t.host === backendId && typeof t.model === 'string');
      if (hit) mapping[name] = hit.model;
    }
  }

  const backend = findBackend(config, backendId);
  if (backend && isUsableTarget(backend.acceptsAny)) {
    mapping[CATCH_ALL_KEY] = backend.acceptsAny;
  }
  return mapping;
}

/**
 * Merge an incoming flat `modelMapping` for one backend into the alias table, the
 * deprecated write path still accepted by `PUT /api/backends/:id`.
 *
 * `mapping` is treated as the complete mapping view for `backendId`, so it both adds
 * and removes:
 *   - each non-`'*'` key replaces this backend's target inside the alias group of
 *     that name (creating the group when needed) and leaves targets belonging to
 *     other hosts untouched;
 *   - an alias group that previously carried a target on this backend, but whose name
 *     is absent from `mapping`, loses that target — and the group is dropped entirely
 *     only when it becomes empty;
 *   - `'*'` sets `backend.acceptsAny`, and its absence (or a blank value) clears it.
 * Blank targets are skipped with a warning, exactly as during migration.
 *
 * @param {{aliases?: object, backends?: {directory?: Array<object>}}|null|undefined} config server config; MUTATED in place.
 * @param {string} backendId the backend the mapping belongs to.
 * @param {Object<string, string>|null|undefined} mapping the deprecated flat mapping.
 * @returns {{warnings: string[]}} always at least the `modelMapping` deprecation
 *   warning, plus one per skipped or glob-shaped key.
 */
export function foldModelMapping(config, backendId, mapping) {
  const warnings = [
    'modelMapping is deprecated and is now folded into the global alias table; use the /api/aliases API instead',
  ];
  if (!config || typeof config !== 'object') return { warnings };
  if (typeof backendId !== 'string' || !backendId) return { warnings };
  if (!mapping || typeof mapping !== 'object') return { warnings };

  if (!config.aliases || typeof config.aliases !== 'object') config.aliases = {};

  /** @type {Map<string, string>} alias name → target model for this backend. */
  const desired = new Map();
  /** @type {string|null} the requested catch-all target, null when cleared. */
  let catchAll = null;

  for (const [key, target] of Object.entries(mapping)) {
    if (key === CATCH_ALL_KEY) {
      if (isUsableTarget(target)) catchAll = target;
      else warnings.push(`backend '${backendId}': blank '*' mapping target dropped; acceptsAny cleared`);
      continue;
    }
    if (!isUsableTarget(target)) {
      warnings.push(`backend '${backendId}': mapping '${key}' has a blank target and was skipped`);
      continue;
    }
    if (isGlobKey(key)) {
      warnings.push(`backend '${backendId}': mapping key '${key}' looks like a glob; alias names no longer glob, so it was stored under that literal name`);
    }
    desired.set(key, target);
  }

  // Removals first: a group this backend used to appear in, no longer named by the
  // incoming mapping, loses only this backend's target.
  for (const [name, group] of Object.entries(config.aliases)) {
    if (desired.has(name)) continue;
    const targets = group?.targets;
    if (!Array.isArray(targets)) continue;
    const kept = targets.filter((t) => !t || t.host !== backendId);
    if (kept.length === targets.length) continue;
    if (kept.length === 0) delete config.aliases[name];
    else group.targets = kept;
  }

  // Upserts: replace this backend's existing target in place so authored target order
  // survives an edit; otherwise append to the end of the group.
  for (const [name, model] of desired) {
    if (!config.aliases[name] || !Array.isArray(config.aliases[name].targets)) {
      config.aliases[name] = { targets: [] };
    }
    const targets = config.aliases[name].targets;
    const idx = targets.findIndex((t) => t && t.host === backendId);
    if (idx === -1) {
      targets.push({ host: backendId, model });
    } else {
      targets[idx] = { host: backendId, model };
      // Collapse any stray duplicates left by an earlier hand-edited config.
      config.aliases[name].targets = targets.filter((t, i) => i <= idx || !t || t.host !== backendId);
    }
  }

  const backend = findBackend(config, backendId);
  if (backend) {
    if (catchAll) backend.acceptsAny = catchAll;
    else delete backend.acceptsAny;
  }

  return { warnings };
}
