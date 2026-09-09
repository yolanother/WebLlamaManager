// Llama Manager — model alias group editor state.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides the pure state transforms behind the Settings > Aliases tab. Flattens
// the `config.aliases` table into flat, editable target rows; regroups those rows
// back into per-alias groups so the alias-level settings render once per alias
// rather than once per target; folds edited rows back into alias groups; computes
// which aliases a save must PUT and which it must DELETE; and validates rows
// against the local inventory using the same rules the server's validateAlias()
// applies. Contains no React and performs no I/O — the Settings component owns
// every fetch and all component state.
//
// The shape problem this module solves: targets are per-ROW but `gpu` and
// `gpuPriority` are per-ALIAS, and an alias with three targets must show one GPU
// control, not three. Rather than splitting state into two stores that can drift,
// the alias-level fields are carried denormalized on every row of the alias and
// resolved by {@link aliasGroups}, which is the single definition of "what this
// alias's GPU is" that both the editor and {@link rowsToAliases} read.

/**
 * Alias names owned by the chat-router classifier. Mirrors `RESERVED_ALIAS_NAMES`
 * in `api/model-aliases.js`; duplicated because the UI bundle cannot import from
 * the server tree.
 * @type {string[]}
 */
const RESERVED_ALIAS_NAMES = ['auto', 'default-router'];

/** Host value that means "this manager", as opposed to a backend id. */
const LOCAL_HOST = 'local';

/**
 * Coerces an inventory list into a set of names. Accepts an array of strings or
 * of objects carrying an `id`, so callers can pass `/api/backends` rows or bare
 * id lists interchangeably.
 *
 * @param {Array<string|{id?: string}>|null|undefined} value The list to coerce.
 * @returns {Set<string>} The non-empty names found in `value`.
 */
function nameSet(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map(entry => (typeof entry === 'string' ? entry : entry?.id))
      .filter(name => typeof name === 'string' && name !== '')
  );
}

/**
 * Coerces a preset inventory into a set of preset ids. Accepts the keyed
 * `config.presets` object (the server-side shape) as well as the array form
 * `GET /api/presets` returns.
 *
 * @param {Object<string, object>|Array<string|{id?: string}>|null|undefined} presets
 *   The preset inventory in either supported shape.
 * @returns {Set<string>} The known preset ids.
 */
function presetIdSet(presets) {
  if (!presets) return new Set();
  if (Array.isArray(presets)) return nameSet(presets);
  return new Set(Object.keys(presets));
}

/**
 * Builds an order-sensitive signature for an alias group so two groups can be
 * compared without depending on key order inside each target object. Target
 * order is authored intent (it is the ranking tiebreak), so a reorder is a
 * genuine change and the signature reflects it.
 *
 * The alias-level `gpu` and `gpuPriority` are part of the signature too: changing
 * only which pool an alias runs on, without touching a target, is a real change and
 * a save that ignored it would silently discard the operator's edit.
 *
 * @param {{targets?: Array<{host?: string, model?: string}>, gpu?: string,
 *   gpuPriority?: number}|null|undefined} group The alias group to fingerprint.
 * @returns {string} A signature that is equal iff the ordered targets and the
 *   alias-level GPU settings are equal.
 */
function groupSignature(group) {
  const targets = Array.isArray(group?.targets) ? group.targets : [];
  const gpu = group?.gpu == null ? '' : String(group.gpu);
  const priority = group?.gpuPriority == null ? '' : String(group.gpuPriority);
  return [
    targets.map(t => `${t?.host ?? ''}\u0000${t?.model ?? ''}`).join('\u0001'),
    gpu,
    priority,
  ].join('\u0002');
}

/**
 * Flattens an alias table into the flat target rows the editor renders. Emits
 * one row per target, in alias insertion order and then authored target order,
 * so the rendered order round-trips through {@link rowsToAliases}. An alias with
 * no targets contributes no rows.
 *
 * `rowId` is a per-call counter starting at 1, which keeps the function pure
 * (the same input always yields the same ids) while guaranteeing the uniqueness
 * React keys need. The component allocates ids above the returned maximum for
 * rows the user adds.
 *
 * The alias-level `gpu` and `gpuPriority` are copied onto EVERY row of the alias.
 * They are one value per alias, not per target, and {@link aliasGroups} is what
 * reads them back out — carrying them on the rows keeps the editor's state a
 * single flat list, which is what makes rename, reorder and delete one-liners.
 * Both are held as strings because they are edited in inputs, and both are `''`
 * when the stored alias has no such field.
 *
 * @param {Object<string, {targets?: Array<{host?: string, model?: string}>,
 *   gpu?: string, gpuPriority?: number}>|null|undefined} aliases
 *   The alias table, as stored in `config.aliases`.
 * @returns {Array<{rowId: number, aliasName: string, host: string, model: string,
 *   gpu: string, gpuPriority: string}>} One row per alias target, in authored order.
 */
export function aliasesToRows(aliases) {
  if (!aliases || typeof aliases !== 'object') return [];

  const rows = [];
  let nextRowId = 1;
  for (const [aliasName, group] of Object.entries(aliases)) {
    const targets = Array.isArray(group?.targets) ? group.targets : [];
    const gpu = group?.gpu == null ? '' : String(group.gpu);
    const gpuPriority = group?.gpuPriority == null ? '' : String(group.gpuPriority);
    for (const target of targets) {
      rows.push({
        rowId: nextRowId++,
        aliasName,
        host: String(target?.host ?? ''),
        model: String(target?.model ?? ''),
        gpu,
        gpuPriority
      });
    }
  }
  return rows;
}

/**
 * Regroups flat target rows into one entry per alias — the transform the whole
 * alias-level-settings problem turns on.
 *
 * Every row of an alias carries a copy of that alias's `gpu` and `gpuPriority`, so
 * a group's value is resolved as the FIRST NON-BLANK among its rows rather than
 * simply the first row's. That rule is what makes a freshly added target safe: a
 * new row starts blank, and reading position 0 blindly would silently clear the
 * alias's GPU the moment the operator added a target above the existing ones.
 *
 * `key` is the first row's id rather than the alias name, so renaming an alias
 * does not remount (and unfocus) its name input on every keystroke.
 *
 * @param {Array<{rowId?: number|string, aliasName?: string, gpu?: string,
 *   gpuPriority?: string}>|null|undefined} rows The editor rows.
 * @returns {Array<{key: (number|string|undefined), name: string, rows: object[],
 *   gpu: string, gpuPriority: string}>} One entry per alias name, in
 *   first-appearance order, each with its rows in row order.
 */
export function aliasGroups(rows) {
  if (!Array.isArray(rows)) return [];

  const byName = new Map();
  for (const row of rows) {
    const name = String(row?.aliasName ?? '');
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(row);
  }

  const firstNonBlank = (groupRows, field) => {
    for (const row of groupRows) {
      const value = String(row?.[field] ?? '').trim();
      if (value) return value;
    }
    return '';
  };

  return [...byName.entries()].map(([name, groupRows]) => ({
    key: groupRows[0]?.rowId,
    name,
    rows: groupRows,
    gpu: firstNonBlank(groupRows, 'gpu'),
    gpuPriority: firstNonBlank(groupRows, 'gpuPriority'),
  }));
}

/**
 * Folds edited rows back into an alias table. Rows are grouped by `aliasName`,
 * preserving each name's first-appearance order and the row order within it, so
 * authored target order survives the round trip. Names, hosts, and models are
 * trimmed to match the server's normalization, and each target is reduced to
 * `{host, model}` so editor-only fields never reach the API. A row is dropped
 * unless its alias name, host, and model are all non-blank after trimming: a
 * blank name has no group to belong to, and a blank host or model would be
 * serialized into `config.aliases` only for the server's `validateAlias()` to
 * reject the PUT, surfacing a confusing save failure instead of the row simply
 * being filtered out. An alias whose every row is dropped is omitted entirely.
 *
 * Duplicate targets are preserved rather than collapsed; detecting them is
 * {@link validateRows}'s job, and a save is expected to be blocked before this
 * runs.
 *
 * `gpu` and `gpuPriority` are emitted ONLY when set, resolved once per alias by
 * {@link aliasGroups}. An alias the operator never gave a GPU therefore produces
 * exactly `{targets}` — the same object this function has always produced — so the
 * body a save PUTs for such an alias is byte-identical to the pre-GPU one.
 *
 * @param {Array<{aliasName?: string, host?: string, model?: string, gpu?: string,
 *   gpuPriority?: string}>|null|undefined} rows The editor rows to fold.
 * @returns {Object<string, {targets: Array<{host: string, model: string}>,
 *   gpu?: string, gpuPriority?: number}>} The alias table the API accepts.
 */
export function rowsToAliases(rows) {
  const aliases = {};
  if (!Array.isArray(rows)) return aliases;

  for (const group of aliasGroups(rows)) {
    const aliasName = group.name.trim();
    if (!aliasName) continue;

    for (const row of group.rows) {
      const host = String(row?.host ?? '').trim();
      const model = String(row?.model ?? '').trim();
      if (!host || !model) continue;
      if (!aliases[aliasName]) aliases[aliasName] = { targets: [] };
      aliases[aliasName].targets.push({ host, model });
    }

    const alias = aliases[aliasName];
    if (!alias) continue;
    if (group.gpu) alias.gpu = group.gpu;
    if (group.gpuPriority !== '' && Number.isInteger(Number(group.gpuPriority))) {
      alias.gpuPriority = Number(group.gpuPriority);
    }
  }
  return aliases;
}

/**
 * Determines the writes a save must issue. An alias counts as changed when it is
 * new or when its ordered target list differs from the original; it counts as
 * removed when the original had it and the edited table does not. A rename
 * therefore reports the old name as removed and the new name as changed.
 *
 * @param {Object<string, {targets?: Array<{host?: string, model?: string}>}>|null|undefined} original
 *   The alias table as loaded from the server.
 * @param {Object<string, {targets?: Array<{host?: string, model?: string}>}>|null|undefined} edited
 *   The alias table produced by {@link rowsToAliases}.
 * @returns {{changed: string[], removed: string[]}} Names to PUT (in edited
 *   order) and names to DELETE (in original order).
 */
export function diffAliases(original, edited) {
  const before = original && typeof original === 'object' ? original : {};
  const after = edited && typeof edited === 'object' ? edited : {};

  const changed = Object.keys(after).filter(name => (
    !Object.prototype.hasOwnProperty.call(before, name)
      || groupSignature(before[name]) !== groupSignature(after[name])
  ));
  const removed = Object.keys(before).filter(
    name => !Object.prototype.hasOwnProperty.call(after, name)
  );
  return { changed, removed };
}

/**
 * Validates editor rows against the local inventory, mirroring the server's
 * `validateAlias()` so the UI blocks exactly what the API would reject.
 *
 * Errors (a save must not proceed): a blank alias name, a name reserved by the
 * chat-router classifier (`auto`, `default-router`), a blank host, a blank
 * model, and a target that repeats an earlier `host` + `model` pair within the
 * same alias.
 *
 * Warnings (shown, but a save proceeds): a name that collides with a preset id
 * or a known local model — the alias shadows the real model — and a host that is
 * neither `local` nor a configured backend id.
 *
 * The alias-level GPU settings are validated once per alias, not once per row, and
 * reported against the alias's FIRST row so the editor can render them beside the
 * one control that produced them. `gpu` naming a pool that does not exist is an
 * error because the server rejects it rather than ignoring it, and a non-integer
 * `gpuPriority` is an error for the same reason. GPU checks are skipped entirely
 * unless `gpuIds` is supplied, so an alias is not accused of naming an unknown pool
 * merely because the pool list has not finished loading.
 *
 * Alias-level issues are returned first, in alias order; the per-target issues
 * follow in row order, and within a row in alias-name, host, model order.
 *
 * @param {Array<{rowId?: number|string, aliasName?: string, host?: string,
 *          model?: string, gpu?: string, gpuPriority?: string}>|null|undefined} rows
 *   The editor rows to validate.
 * @param {{presets?: (Object<string, object>|Array<string|{id?: string}>),
 *          localModels?: Array<string|{id?: string}>,
 *          backendIds?: Array<string|{id?: string}>,
 *          gpuIds?: Array<string|{id?: string}>}} [inventory]
 *   What exists locally: preset ids, bare local model names, configured backend
 *   ids, and configured GPU pool ids. Omitted fields are treated as empty, except
 *   `gpuIds`, whose absence disables the GPU checks.
 * @returns {Array<{rowId: (number|string|undefined),
 *          field: ('aliasName'|'gpu'|'gpuPriority'|'host'|'model'),
 *          level: ('error'|'warning'), message: string}>}
 *   Every issue found, in row order.
 */
export function validateRows(rows, inventory = {}) {
  if (!Array.isArray(rows)) return [];

  const presets = presetIdSet(inventory?.presets);
  const localModels = nameSet(inventory?.localModels);
  const backendIds = nameSet(inventory?.backendIds);

  const issues = [];
  const seenTargets = new Set();

  // Alias-level settings, checked once per alias and pinned to its first row.
  if (Array.isArray(inventory?.gpuIds)) {
    const gpuIds = nameSet(inventory.gpuIds);
    for (const group of aliasGroups(rows)) {
      if (group.gpu && !gpuIds.has(group.gpu)) {
        issues.push({
          rowId: group.key,
          field: 'gpu',
          level: 'error',
          message: `"${group.gpu}" is not a configured GPU pool — add it on the GPUs tab or pick another.`
        });
      }
      if (group.gpuPriority !== '' && !Number.isInteger(Number(group.gpuPriority))) {
        issues.push({
          rowId: group.key,
          field: 'gpuPriority',
          level: 'error',
          message: `GPU priority must be a whole number (0 is the baseline), got "${group.gpuPriority}".`
        });
      }
      if (!group.gpu && group.gpuPriority !== '') {
        issues.push({
          rowId: group.key,
          field: 'gpuPriority',
          level: 'warning',
          message: 'A priority has no effect while this alias may run anywhere — pick a GPU pool for it.'
        });
      }
    }
  }

  for (const row of rows) {
    const rowId = row?.rowId;
    const aliasName = String(row?.aliasName ?? '').trim();
    const host = String(row?.host ?? '').trim();
    const model = String(row?.model ?? '').trim();

    if (!aliasName) {
      issues.push({ rowId, field: 'aliasName', level: 'error', message: 'Alias name is required.' });
    } else if (RESERVED_ALIAS_NAMES.includes(aliasName)) {
      issues.push({
        rowId,
        field: 'aliasName',
        level: 'error',
        message: `"${aliasName}" is reserved by the chat router and cannot be used as an alias name.`
      });
    } else if (presets.has(aliasName) || localModels.has(aliasName)) {
      issues.push({
        rowId,
        field: 'aliasName',
        level: 'warning',
        message: `"${aliasName}" is also a real model or preset — this alias will shadow it.`
      });
    }

    if (!host) {
      issues.push({ rowId, field: 'host', level: 'error', message: 'A target must name a host.' });
    } else if (host !== LOCAL_HOST && !backendIds.has(host)) {
      issues.push({
        rowId,
        field: 'host',
        level: 'warning',
        message: `"${host}" is not a configured backend — this target will not resolve.`
      });
    }

    if (!model) {
      issues.push({ rowId, field: 'model', level: 'error', message: 'A target must name a model.' });
    }

    if (aliasName && host && model) {
      const key = `${aliasName}\u0000${host}\u0000${model}`;
      if (seenTargets.has(key)) {
        issues.push({
          rowId,
          field: 'model',
          level: 'error',
          message: `"${host} / ${model}" is already a target of "${aliasName}".`
        });
      } else {
        seenTargets.add(key);
      }
    }
  }
  return issues;
}
