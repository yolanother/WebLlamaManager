// Llama Manager — fleet-wide model presence and download targeting.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Phase 4 of the federation epic: from the main node's screen, pull a model onto
// any node or all of them. This module owns the view that makes that possible —
// a model does not have a presence, it has a presence PER NODE, so the operator
// acts on the fleet rather than on a box.
//
// The distinction this exists to preserve is between "that node does not have
// the model" and "that node did not answer". They look the same in a naive
// merge and they are not remotely the same to an operator: showing an
// unreachable node as missing a model invites a redundant multi-gigabyte
// download onto a box that already holds the file. A half-finished download is
// likewise not a model — counting it as present is how work gets routed to a
// node that cannot serve it yet.
//
// Targeting is deliberately explicit. An unspecified target resolves to NOTHING,
// never to "all", because defaulting a mis-typed request to the whole fleet
// turns a typo into simultaneous downloads on every box.

/**
 * Reduce a model entry to the id the fleet agrees on.
 *
 * Nodes spell their model lists differently depending on which engine produced
 * them, so a bare string, an `id`, a `name`, and a `model` all resolve the same
 * way. Anything unusable resolves to null rather than to an empty string, since
 * an empty key would collapse every unreadable entry into one row claiming to be
 * present everywhere.
 *
 * @param {unknown} entry A model as some node reported it.
 * @returns {string|null} The model id, or null when there is not one.
 */
export function modelKey(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (!entry || typeof entry !== 'object') return null;
  for (const field of ['id', 'name', 'model']) {
    const value = entry[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Report whether a download record describes one still in flight.
 *
 * @param {Object} record A node's download entry.
 * @returns {boolean} True while the download is still running.
 */
function isInFlight(record) {
  const status = record?.status;
  return !!status && status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

/**
 * Build the per-model, per-node view the fleet screen renders.
 *
 * A node marked unreachable contributes to `unknownOn` and to neither
 * `presentOn` nor `missingFrom`, because it has told us nothing.
 *
 * @param {Array<{id:string, models?:Array<*>, downloads?:Object, reachable?:boolean}>} nodes
 *   Every node in the fleet, including this one.
 * @returns {Array<{id:string, presentOn:string[], missingFrom:string[],
 *   unknownOn:string[], downloadingOn:Array<{node:string, progress:number}>}>}
 *   One row per distinct model, in stable id order.
 */
export function mergeFleetModels(nodes) {
  if (!Array.isArray(nodes)) return [];

  const reachable = nodes.filter((node) => node?.reachable !== false);
  const unreachable = nodes.filter((node) => node?.reachable === false).map((node) => node.id);

  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) {
      rows.set(id, {
        id,
        presentOn: [],
        missingFrom: [],
        unknownOn: [...unreachable],
        downloadingOn: [],
      });
    }
    return rows.get(id);
  };

  for (const node of reachable) {
    for (const entry of Array.isArray(node?.models) ? node.models : []) {
      const id = modelKey(entry);
      if (id) row(id).presentOn.push(node.id);
    }
    for (const [id, record] of Object.entries(node?.downloads || {})) {
      if (!id || !isInFlight(record)) continue;
      row(id).downloadingOn.push({ node: node.id, progress: Number(record.progress) || 0 });
    }
  }

  // Absence is only meaningful for a node that answered, so this is filled in
  // once every node's contribution is known rather than as we go.
  for (const entry of rows.values()) {
    for (const node of reachable) {
      if (!entry.presentOn.includes(node.id)) entry.missingFrom.push(node.id);
    }
  }

  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Decide which nodes a fleet-wide action applies to.
 *
 * @param {'all'|string[]|undefined} targets What the caller asked for.
 * @param {Array<{id:string}>} fleet Every known node.
 * @returns {string[]} Node ids to act on, de-duplicated and order-preserving.
 */
export function resolveTargets(targets, fleet) {
  const known = new Set((Array.isArray(fleet) ? fleet : []).map((node) => node?.id).filter(Boolean));
  if (targets === 'all') return [...known];
  if (!Array.isArray(targets)) return [];

  const chosen = [];
  for (const id of targets) {
    // A node we cannot see is not a request we can honour, and accepting it
    // silently would leave the operator waiting on a download that never starts.
    if (known.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  return chosen;
}
