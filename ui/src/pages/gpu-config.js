// Llama Manager — GPU pool editor state.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides the pure state transforms behind the Settings > GPUs tab. Flattens the
// `settings.gpus` pool array into flat editable rows (one row per pool, with the
// `match` selectors split into their own fields), folds rows back into the array
// `POST /api/settings` accepts, validates them with the same rules the server's
// normalizePoolConfig() applies, joins each pool against the live readout from
// `GET /api/gpus` so a pool that resolved to nothing reads as a problem rather
// than as a blank, and builds the pool choices the alias editor's GPU picker
// offers. Contains no React and performs no I/O — the Settings component owns
// every fetch and all component state.

/**
 * The selectors a pool's `match` may name, in display order. Mirrors
 * `MATCH_SELECTORS` in `api/gpu-pools.js`; duplicated because the UI bundle
 * cannot import from the server tree.
 * @type {string[]}
 */
export const GPU_MATCH_SELECTORS = ['pciId', 'name', 'pci'];

/** Human labels and placeholders for each selector, for the editor's inputs. */
export const GPU_MATCH_FIELDS = [
  { key: 'pciId', label: 'PCI class id', placeholder: 'e.g. 10de:2204', hint: 'vendor:device — survives a re-plug' },
  { key: 'name', label: 'Product name contains', placeholder: 'e.g. RTX 3090', hint: 'case-insensitive substring' },
  { key: 'pci', label: 'PCI address', placeholder: 'e.g. 0000:c6:00.0', hint: 'exact slot — changes if re-plugged' },
];

/** A `vendor:device` class id, with sysfs's `0x` prefix optional on either half. */
const PCI_ID_RE = /^(0x)?[0-9a-f]{4}:(0x)?[0-9a-f]{4}$/i;

/** The value the alias GPU picker uses for "no GPU restriction". */
export const GPU_ANYWHERE = '';

/**
 * Flattens the settings pool array into the rows the editor renders. One row per
 * pool, in settings order — which is meaningful, because a card matched by two
 * pools goes to whichever is first. The `match` selectors become their own string
 * fields so each gets a labelled input instead of a JSON blob, and every value is
 * a string so an input can hold a half-typed one.
 *
 * `rowId` is a per-call counter starting at 1, which keeps the function pure while
 * giving React the unique keys it needs. The component allocates ids above the
 * returned maximum for pools the operator adds.
 *
 * @param {Array<object>|null|undefined} gpus The `settings.gpus` array.
 * @returns {Array<{rowId: number, id: string, label: string, pciId: string,
 *   name: string, pci: string, pinnedModels: string, defaultPriority: string}>}
 *   One row per pool, in settings order.
 */
export function poolsToRows(gpus) {
  if (!Array.isArray(gpus)) return [];
  let nextRowId = 1;
  return gpus.map(pool => ({
    rowId: nextRowId++,
    id: String(pool?.id ?? ''),
    label: String(pool?.label ?? ''),
    pciId: String(pool?.match?.pciId ?? ''),
    name: String(pool?.match?.name ?? ''),
    pci: String(pool?.match?.pci ?? ''),
    pinnedModels: formatPinnedModels(pool?.pinnedModels),
    defaultPriority: pool?.defaultPriority === undefined || pool?.defaultPriority === null
      ? ''
      : String(pool.defaultPriority),
  }));
}

/**
 * Folds editor rows back into the array `POST /api/settings` accepts. A row with
 * a blank id is dropped: it has no handle, so the server would reject the whole
 * save for it and the operator would lose every other edit in the batch.
 *
 * Optional fields are OMITTED rather than sent empty, so a pool the operator
 * never gave a label, a pin list or a priority round-trips byte-identical to
 * what was loaded instead of gaining three defaulted keys on every save.
 *
 * @param {Array<object>|null|undefined} rows The editor rows to fold.
 * @returns {Array<{id: string, label?: string, match: Object<string,string>,
 *   pinnedModels?: string[], defaultPriority?: number}>} The pool array, in row order.
 */
export function rowsToPools(rows) {
  if (!Array.isArray(rows)) return [];
  const pools = [];
  for (const row of rows) {
    const id = String(row?.id ?? '').trim();
    if (!id) continue;

    const match = {};
    for (const selector of GPU_MATCH_SELECTORS) {
      const value = String(row?.[selector] ?? '').trim();
      if (value) match[selector] = value;
    }

    const pool = { id, match };
    const label = String(row?.label ?? '').trim();
    if (label) pool.label = label;

    const pinnedModels = parsePinnedModels(row?.pinnedModels);
    if (pinnedModels.length) pool.pinnedModels = pinnedModels;

    const priority = String(row?.defaultPriority ?? '').trim();
    if (priority !== '' && Number.isInteger(Number(priority))) pool.defaultPriority = Number(priority);

    pools.push(pool);
  }
  return pools;
}

/**
 * Splits an operator's pinned-model text into model names. Commas and newlines
 * both separate, because a list pasted from anywhere uses one or the other.
 *
 * @param {string|string[]|null|undefined} text The field value, or an already-split list.
 * @returns {string[]} The non-blank names, trimmed, in order.
 */
export function parsePinnedModels(text) {
  const parts = Array.isArray(text) ? text : String(text ?? '').split(/[,\n]/);
  return parts.map(part => String(part ?? '').trim()).filter(Boolean);
}

/**
 * Renders a stored pin list back into the editor's text field.
 * @param {string[]|null|undefined} models The stored `pinnedModels`.
 * @returns {string} A comma-separated list, or `''`.
 */
export function formatPinnedModels(models) {
  return Array.isArray(models) ? models.filter(Boolean).join(', ') : '';
}

/**
 * Validates pool rows, mirroring the server's `normalizePoolConfig()` and the
 * duplicate-id check in `POST /api/settings` so the UI blocks exactly what the
 * API would reject.
 *
 * Errors (a save must not proceed): a blank id, an id used twice, a `pciId` that
 * is not a `vendor:device` pair, and a non-integer `defaultPriority`.
 *
 * Warnings (shown, save proceeds): a pool with no match selectors. The server
 * accepts it deliberately and reports it at resolution, where the pool can be
 * named alongside its capacity of 0 — but an operator must not have to save and
 * re-read to find that out, so it is said here too.
 *
 * @param {Array<object>|null|undefined} rows The editor rows to validate.
 * @returns {Array<{rowId: (number|string|undefined), field: string,
 *   level: ('error'|'warning'), message: string}>} Every issue, in row order.
 */
export function validatePoolRows(rows) {
  if (!Array.isArray(rows)) return [];

  const issues = [];
  const seenIds = new Set();

  for (const row of rows) {
    const rowId = row?.rowId;
    const id = String(row?.id ?? '').trim();

    if (!id) {
      issues.push({ rowId, field: 'id', level: 'error', message: 'A GPU pool needs an id — it is the handle the API, CLI and pins all use.' });
    } else if (seenIds.has(id)) {
      issues.push({ rowId, field: 'id', level: 'error', message: `Another pool already uses the id "${id}"; ids must be unique.` });
    } else {
      seenIds.add(id);
    }

    const pciId = String(row?.pciId ?? '').trim();
    if (pciId && !PCI_ID_RE.test(pciId)) {
      issues.push({ rowId, field: 'pciId', level: 'error', message: `"${pciId}" is not a vendor:device pair such as 10de:2204.` });
    }

    const priority = String(row?.defaultPriority ?? '').trim();
    if (priority !== '' && !Number.isInteger(Number(priority))) {
      issues.push({ rowId, field: 'defaultPriority', level: 'error', message: `Default priority must be a whole number, got "${priority}".` });
    }

    const selectors = GPU_MATCH_SELECTORS.filter(s => String(row?.[s] ?? '').trim());
    if (selectors.length === 0) {
      issues.push({
        rowId,
        field: 'pciId',
        level: 'warning',
        message: 'This pool names no selectors, so it will match no card. Give it a PCI class id, a name or an address.',
      });
    }
  }
  return issues;
}

/**
 * Joins one edited pool row against the live readout from `GET /api/gpus`.
 *
 * The three states are deliberately distinct. `unsaved` means the pool is not in
 * the live readout at all — normal for a pool the operator just added, and not a
 * fault. `problem` means the server resolved it and it came back with warnings or
 * with no usable card: the case this whole function exists to make visible, since
 * a pool matching nothing is otherwise indistinguishable from one matching a card
 * that happens to be idle. `ok` is a pool holding real capacity.
 *
 * @param {{id?: string}|string|null|undefined} row The edited row, or a bare pool id.
 * @param {Array<object>|null|undefined} liveGpus The `gpus` array from `GET /api/gpus`.
 * @returns {{status: ('ok'|'problem'|'unsaved'), id: string, capacity: number,
 *   free: number, cards: object[], warnings: string[], holders: object[],
 *   summary: string}} The live state, with a one-line summary for the readout.
 */
export function poolLiveState(row, liveGpus) {
  const id = String((typeof row === 'string' ? row : row?.id) ?? '').trim();
  const live = (Array.isArray(liveGpus) ? liveGpus : []).find(p => p?.id === id);

  if (!live) {
    return {
      status: 'unsaved', id, capacity: 0, free: 0, cards: [], warnings: [], holders: [],
      summary: id ? 'Not saved yet — save to resolve this pool against the machine.' : 'Give this pool an id.',
    };
  }

  const cards = Array.isArray(live.cards) ? live.cards : [];
  const warnings = Array.isArray(live.warnings) ? live.warnings : [];
  const holders = Array.isArray(live.held) ? live.held : [];
  const capacity = Number(live.capacity) || 0;
  const free = Number.isFinite(Number(live.free)) ? Number(live.free) : 0;
  const status = warnings.length > 0 || capacity === 0 ? 'problem' : 'ok';

  const summary = status === 'problem' && capacity === 0
    ? `No usable card — this pool has capacity 0${cards.length ? ` (matched ${cards.length} card(s), none usable)` : ''}.`
    : `${free} of ${capacity} card${capacity === 1 ? '' : 's'} free${holders.length ? `, held by ${holders.map(h => h.holder).join(', ')}` : ''}.`;

  return { status, id, capacity, free, cards, warnings, holders, summary };
}

/**
 * The options the alias editor's GPU picker offers, so a pool is always CHOSEN
 * rather than typed. "Anywhere" comes first and is the absent-field case.
 *
 * A pool named by an alias but absent from both settings and the live readout is
 * still offered, marked unknown: dropping it from the list would silently rewrite
 * the alias to "anywhere" the first time the operator touched an unrelated field.
 *
 * @param {Array<object>|null|undefined} liveGpus The `gpus` array from `GET /api/gpus`.
 * @param {Array<object>|null|undefined} [poolRows] The edited pool rows, so a pool
 *   added in this session is selectable before it has been saved.
 * @param {Array<string>|null|undefined} [namedIds] Pool ids the aliases already name.
 * @returns {Array<{value: string, label: string, problem: boolean, hint: string}>}
 *   The choices, in display order, "Anywhere" first.
 */
export function gpuPoolChoices(liveGpus, poolRows = [], namedIds = []) {
  const choices = [{ value: GPU_ANYWHERE, label: 'Anywhere (no GPU restriction)', problem: false, hint: '' }];
  const seen = new Set();

  const push = (id, label, problem, hint) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    choices.push({ value: id, label, problem, hint });
  };

  for (const pool of Array.isArray(liveGpus) ? liveGpus : []) {
    if (!pool?.id) continue;
    const state = poolLiveState(pool.id, liveGpus);
    const name = pool.label && pool.label !== pool.id ? `${pool.label} (${pool.id})` : pool.id;
    push(pool.id, `${name} — ${state.capacity} card${state.capacity === 1 ? '' : 's'}`, state.status === 'problem', state.summary);
  }

  for (const row of Array.isArray(poolRows) ? poolRows : []) {
    const id = String(row?.id ?? '').trim();
    push(id, `${id} — not saved yet`, true, 'This pool has not been saved, so it resolves to nothing yet.');
  }

  for (const id of Array.isArray(namedIds) ? namedIds : []) {
    push(String(id ?? '').trim(), `${id} — unknown pool`, true, 'No GPU pool with this id exists; the alias will be rejected on save.');
  }

  return choices;
}
