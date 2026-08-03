// Llama Manager — model alias groups: resolution, warmth gating, validation.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Implements the unified alias table (`config.aliases`): a client-facing alias name
// maps to an ORDERED list of targets, each naming a host ('local' or a backend id)
// and a model (an exact name or a `*`/`?` glob). This module turns a requested alias
// into the ordered list of concrete candidates the existing `resolveBackend()` ranking
// consumes, and partitions those candidates into warm/cold tiers so a cold local load
// can never evict a resident model while a warm alternative exists.
//
// It supersedes `api/default-models.js` (two hardcoded single-target aliases) and the
// per-backend `modelMapping` glob resolver formerly inline in `api/server.js`, unifying
// local models, local llama/ds4 presets, and remote backend models behind one name.
//
// Pure and synchronous: the world (local models, presets, residency, per-backend model
// lists) arrives through the injected `inventory`, and the only import is the engine
// classifier. That is what makes routing unit-testable, mirroring `api/resource-guard.js`.

import { isDs4Preset } from './engines.js';

/** Names owned by the chat-router classifier; never valid alias names. */
export const RESERVED_ALIAS_NAMES = ['auto', 'default-router'];

/** Alias resolving to the operator's preferred large model. */
export const BIG_ALIAS = 'default-big';

/** Alias resolving to the operator's preferred small model. */
export const SMALL_ALIAS = 'default-small';

/**
 * @typedef {{host: string, model: string}} AliasTarget
 *   host  — 'local' or a backend id.
 *   model — an exact model name, or a glob using `*` (any run) and `?` (one char).
 *
 * @typedef {{targets: AliasTarget[]}} AliasGroup
 *
 * @typedef {{
 *   localModels?: string[],
 *   presets?: Object<string, object>,
 *   residentModels?: string[],
 *   backends?: Array<{
 *     id: string, enabled: boolean, tested: boolean,
 *     remoteModels?: string[], available?: boolean
 *   }>
 * }} Inventory the injected view of what exists right now; `available` defaults true.
 *
 * @typedef {{
 *   host: string,
 *   model: string,
 *   kind: ('model'|'preset'|'ds4'),
 *   backendId: (string|null),
 *   order: number
 * }} Candidate a concrete, glob-expanded routing candidate; `order` is the index of the
 *   authored target that produced it.
 */

/** Characters that make a pattern a glob rather than a literal name. */
const WILDCARD_PATTERN = /[*?]/;

/** Regex metacharacters to escape in a glob's literal parts (`*` and `?` excluded). */
const REGEX_METACHARS = /[.+^${}()|[\]\\]/g;

/**
 * Returns a non-empty trimmed string, or null when the value is unusable.
 * @param {*} v candidate string value
 * @returns {string|null}
 */
function cleanString(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

/** @returns {boolean} true when `obj` carries `key` as an own property. */
function hasOwn(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Translate a glob pattern into an anchored RegExp, matching the semantics of the
 * outgoing `resolveModelMapping()`: `*` → `.*`, `?` → `.`, anchored `^...$`. Regex
 * metacharacters in the literal part are escaped first, so `gemma4.1:*` cannot match
 * `gemma4X1:12b`.
 *
 * @param {string} pattern glob pattern
 * @returns {RegExp} anchored matcher
 */
function globToRegExp(pattern) {
  const literal = pattern.replace(REGEX_METACHARS, '\\$&');
  return new RegExp('^' + literal.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

/**
 * Classify a concrete local model name against the configured presets, following the
 * engine's existing rule: a preset id shadows a bare model of the same name.
 *
 * @param {Object<string, object>} presets the preset table (`inventory.presets`)
 * @param {string} model concrete local model or preset name
 * @returns {('ds4'|'preset'|'model')} 'ds4'/'preset' when the name is a preset, else 'model'
 */
function classifyLocal(presets, model) {
  if (!hasOwn(presets, model)) return 'model';
  const preset = presets[model];
  if (!preset) return 'model';
  return isDs4Preset(preset) ? 'ds4' : 'preset';
}

/**
 * Collect the local model names carried by `config`, used only for the
 * alias-shadows-a-real-model warning in {@link validateAlias}. Accepts either bare
 * strings or scanned records (`{name}` / `{id}`), and yields an empty list when the
 * caller did not inject one.
 *
 * @param {object|null|undefined} config server config, optionally carrying `localModels`
 * @returns {string[]} known local model names (possibly empty)
 */
function knownLocalModelNames(config) {
  const raw = config?.localModels;
  if (!Array.isArray(raw)) return [];
  const names = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? cleanString(entry) : cleanString(entry?.name ?? entry?.id);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Expand a target model pattern against a list of known names.
 *
 * A pattern containing no `*` or `?` is EXACT and is returned unconditionally as its own
 * single-element list — an exact target is never filtered against the inventory, because
 * a model can legitimately be requested before it appears in any listing. A pattern that
 * does contain a wildcard returns every entry of `names` it matches, in `names` order
 * (duplicates in `names` are preserved; de-duplication is the caller's job).
 *
 * @param {string} pattern exact model name or glob (`*` = any run, `?` = one char)
 * @param {string[]} names known model names to match a glob against
 * @returns {string[]} concrete model names (empty when the pattern is unusable or matches nothing)
 */
export function expandGlob(pattern, names) {
  if (typeof pattern !== 'string' || !pattern.length) return [];
  if (!WILDCARD_PATTERN.test(pattern)) return [pattern];
  if (!Array.isArray(names)) return [];
  const matcher = globToRegExp(pattern);
  return names.filter(n => typeof n === 'string' && matcher.test(n));
}

/**
 * Resolve an alias name into the ordered list of concrete routing candidates.
 *
 * The alias name is looked up EXACTLY in `config.aliases` (alias names never glob), so an
 * unknown name — or a group with no usable targets — yields `[]` and the caller proceeds
 * with the requested model unchanged. Each target is expanded in authored order:
 *
 * - `host: 'local'` expands against the local models plus the preset ids, and each result
 *   is classified 'ds4' / 'preset' / 'model' (a preset id shadows a bare model).
 * - any other host must name a backend that exists and is enabled AND tested — otherwise
 *   the whole target is dropped — and expands against that backend's `remoteModels`.
 *
 * Results are de-duplicated on the `(host, model)` pair keeping the FIRST occurrence, so
 * the returned `order` values reflect authored intent.
 *
 * @param {string} name the requested alias name
 * @param {{aliases?: Object<string, AliasGroup>}|null|undefined} config server config
 * @param {Inventory|null|undefined} inventory injected view of local/remote availability
 * @returns {Candidate[]} concrete candidates in authored order (possibly empty)
 */
export function resolveAliasCandidates(name, config, inventory) {
  if (typeof name !== 'string' || !name.length) return [];
  const aliases = config?.aliases;
  if (!hasOwn(aliases, name)) return [];
  const targets = Array.isArray(aliases[name]?.targets) ? aliases[name].targets : [];
  if (!targets.length) return [];

  const presets = inventory?.presets && typeof inventory.presets === 'object' ? inventory.presets : {};
  const localNames = [
    ...(Array.isArray(inventory?.localModels) ? inventory.localModels : []),
    ...Object.keys(presets)
  ];
  const backends = Array.isArray(inventory?.backends) ? inventory.backends : [];

  const candidates = [];
  const seen = new Set();
  const emit = candidate => {
    const key = `${candidate.host}\u0000${candidate.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  targets.forEach((target, order) => {
    const host = cleanString(target?.host);
    const model = cleanString(target?.model);
    if (!host || !model) return;
    if (host === 'local') {
      for (const concrete of expandGlob(model, localNames)) {
        emit({ host: 'local', model: concrete, kind: classifyLocal(presets, concrete), backendId: null, order });
      }
      return;
    }
    const backend = backends.find(b => b?.id === host);
    if (!backend || !backend.enabled || !backend.tested) return;
    const remoteModels = Array.isArray(backend.remoteModels) ? backend.remoteModels : [];
    for (const concrete of expandGlob(model, remoteModels)) {
      emit({ host, model: concrete, kind: 'model', backendId: host, order });
    }
  });

  return candidates;
}

/**
 * Split candidates into the warm and cold tiers of the routing gate, preserving input
 * order within each bucket. Ranking runs over `warm` and only falls through to `cold`
 * when `warm` is empty, which is what stops an alias from evicting a resident model.
 *
 * A local candidate is warm only while its model is resident. A REMOTE candidate is warm
 * whenever its backend is available (`available !== false`) — remote residency is the
 * remote host's concern, not the manager's, so a load-on-demand host still counts as warm.
 *
 * @param {Candidate[]} candidates candidates from {@link resolveAliasCandidates}
 * @param {Inventory|null|undefined} inventory injected view carrying `residentModels`/`backends`
 * @returns {{warm: Candidate[], cold: Candidate[]}} the two tiers, input order preserved
 */
export function partitionByWarmth(candidates, inventory) {
  const list = Array.isArray(candidates) ? candidates : [];
  const resident = new Set(
    (Array.isArray(inventory?.residentModels) ? inventory.residentModels : []).filter(m => typeof m === 'string')
  );
  const backends = Array.isArray(inventory?.backends) ? inventory.backends : [];

  const warm = [];
  const cold = [];
  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object') continue;
    let isWarm;
    if (candidate.host === 'local') {
      isWarm = resident.has(candidate.model);
    } else {
      const backend = backends.find(b => b?.id === (candidate.backendId ?? candidate.host));
      isWarm = !backend || backend.available !== false;
    }
    (isWarm ? warm : cold).push(candidate);
  }
  return { warm, cold };
}

/**
 * Validate an alias name and its target list for the alias CRUD API.
 *
 * Rejected outright: a non-string or blank name; one of {@link RESERVED_ALIAS_NAMES},
 * which the chat-router classifier owns; a `targets` value that is not a non-empty array;
 * a target that is not an object or lacks a non-empty string `host`/`model`; and two
 * targets sharing the same host + model.
 *
 * Accepted with warnings: a name colliding with a preset id or a known local model (the
 * alias shadows the real model, since alias resolution runs first), and a target naming a
 * host that is neither 'local' nor a configured backend id.
 *
 * @param {{presets?: Object<string, object>, backends?: {directory?: Array<{id?: string}>}, localModels?: Array<string|object>}|null|undefined} config server config
 * @param {*} name the proposed alias name
 * @param {*} targets the proposed target list
 * @returns {{ok: true, value: AliasGroup, warnings: string[]}|{ok: false, error: string}}
 *   on success `value.targets` are trimmed and normalized to `{host, model}` only.
 */
export function validateAlias(config, name, targets) {
  if (typeof name !== 'string') return { ok: false, error: 'alias name must be a string' };
  const alias = name.trim();
  if (!alias) return { ok: false, error: 'alias name must not be blank' };
  if (RESERVED_ALIAS_NAMES.includes(alias)) {
    return { ok: false, error: `'${alias}' is reserved by the chat router and cannot be used as an alias name` };
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, error: `alias '${alias}' must have at least one target` };
  }

  const normalized = [];
  const seen = new Set();
  for (const target of targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      return { ok: false, error: 'each target must be an object with a host and a model' };
    }
    const host = cleanString(target.host);
    if (!host) return { ok: false, error: 'each target must have a non-empty host' };
    const model = cleanString(target.model);
    if (!model) return { ok: false, error: 'each target must have a non-empty model' };
    const key = `${host}\u0000${model}`;
    if (seen.has(key)) return { ok: false, error: `duplicate target '${host}' / '${model}'` };
    seen.add(key);
    normalized.push({ host, model });
  }

  const warnings = [];
  if (hasOwn(config?.presets, alias)) {
    warnings.push(`alias '${alias}' shadows the preset of the same name`);
  }
  if (knownLocalModelNames(config).includes(alias)) {
    warnings.push(`alias '${alias}' shadows the local model of the same name`);
  }
  const backendIds = new Set(
    (Array.isArray(config?.backends?.directory) ? config.backends.directory : [])
      .map(b => cleanString(b?.id))
      .filter(Boolean)
  );
  for (const target of normalized) {
    if (target.host !== 'local' && !backendIds.has(target.host)) {
      warnings.push(`target host '${target.host}' is not a configured backend`);
    }
  }

  return { ok: true, value: { targets: normalized }, warnings };
}

/**
 * Build the synthetic `/v1/models` rows advertising every configured alias, one row per
 * alias holding at least one usable target, in `Object.keys(config.aliases)` order.
 *
 * Replaces `defaultModelListEntries()` and keeps its field shape — including the scalar
 * `aliasTarget` (the first target's model) that capability resolution reads — so existing
 * `/v1/models` consumers keep working; `targets` is additive and carries the full group.
 * `engine` is 'ds4' only when the FIRST target is a local ds4 preset.
 *
 * @param {{aliases?: Object<string, AliasGroup>, presets?: Object<string, object>}|null|undefined} config server config
 * @param {number} nowSeconds current unix time in seconds (passed in to keep this pure)
 * @returns {Array<object>} OpenAI-style model entries (possibly empty)
 */
export function aliasListEntries(config, nowSeconds) {
  const aliases = config?.aliases;
  if (!aliases || typeof aliases !== 'object') return [];

  const entries = [];
  for (const name of Object.keys(aliases)) {
    const raw = Array.isArray(aliases[name]?.targets) ? aliases[name].targets : [];
    const targets = [];
    for (const target of raw) {
      const host = cleanString(target?.host);
      const model = cleanString(target?.model);
      if (host && model) targets.push({ host, model });
    }
    if (!targets.length) continue;
    const first = targets[0];
    const firstPreset = first.host === 'local' && hasOwn(config?.presets, first.model)
      ? config.presets[first.model]
      : null;
    entries.push({
      id: name,
      object: 'model',
      created: nowSeconds,
      owned_by: 'llamacpp',
      meta: null,
      n_ctx: null,
      displayName: name,
      status: 'alias',
      alias: null,
      aliasTarget: first.model,
      engine: firstPreset && isDs4Preset(firstPreset) ? 'ds4' : 'llama',
      targets
    });
  }
  return entries;
}
