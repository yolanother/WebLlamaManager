// Llama Manager — JSON assertion helper for the alias API smoke suite.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// A tiny dependency-free query tool the bash harness in tests/aliases/run-tests.sh
// uses to make assertions about config files and HTTP response bodies without
// hand-rolling JSON parsing in shell. Supports expression extraction (`get`),
// key-order-insensitive deep comparison of two documents (`equal`), a shape
// tolerant view of an alias listing (`aliases`), and a flattened view of a
// /v1/models catalog (`models`). Exits non-zero with a message on stderr when a
// document is missing or is not JSON, so a non-JSON error page (for example the
// SPA catch-all) fails the calling assertion instead of silently passing.

import { readFileSync } from 'fs';
import { deepStrictEqual } from 'assert';

/**
 * Read and parse a JSON document, failing loudly when it is unreadable.
 *
 * @param {string} file Path to the JSON document.
 * @returns {*} The parsed value.
 */
function load(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    console.error(`json-probe: cannot read ${file}: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`json-probe: ${file} is not JSON (${err.message}): ${raw.slice(0, 160)}`);
    process.exit(1);
  }
}

/**
 * Print a probe result in a shell-comparable form: strings raw, `undefined`
 * literally, everything else as compact JSON.
 *
 * @param {*} value The value produced by a probe mode.
 * @returns {void}
 */
function emit(value) {
  if (value === undefined) console.log('undefined');
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value));
}

/**
 * Normalize any reasonable alias-listing shape into `{name: [{host, model}]}`.
 *
 * The design spec fixes the alias endpoints but not the exact envelope of
 * `GET /api/aliases`, so this accepts an object map (`{aliases: {name: {...}}}`),
 * an array of records (`{aliases: [{name, targets}]}`), and a bare root map, and
 * tolerates a group given either as `{targets: [...]}` or as a bare target array.
 *
 * @param {*} doc The parsed response body or config document.
 * @returns {Object<string, Array<{host: string, model: string}>>} Alias name to targets.
 */
function normalizeAliases(doc) {
  const root = doc && typeof doc === 'object' && 'aliases' in doc ? doc.aliases : doc;
  const out = {};
  const targetsOf = (group) => {
    const list = Array.isArray(group) ? group : (group && group.targets) || [];
    return list
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({ host: String(t.host), model: String(t.model) }));
  };
  if (Array.isArray(root)) {
    for (const entry of root) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.name ?? entry.id ?? entry.alias;
      if (typeof name !== 'string') continue;
      out[name] = targetsOf(entry);
    }
  } else if (root && typeof root === 'object') {
    for (const [name, group] of Object.entries(root)) out[name] = targetsOf(group);
  }
  return out;
}

const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case 'get': {
    // get <file> <expr> — evaluate <expr> with the document bound to `d`.
    const [file, expr] = args;
    const d = load(file);
    try {
      // eslint-disable-next-line no-new-func
      emit(Function('d', `"use strict"; return (${expr});`)(d));
    } catch (err) {
      // Report the failure as a one-line value so a failing assertion stays
      // readable instead of printing a stack trace into the test output.
      console.log(`error: ${err.message}`);
    }
    break;
  }
  case 'equal': {
    // equal <a> <b> — key-order-insensitive deep comparison.
    const [a, b] = args;
    try {
      deepStrictEqual(load(a), load(b));
      console.log('same');
    } catch {
      console.log('different');
    }
    break;
  }
  case 'aliases': {
    // aliases <file> [name] — sorted alias names, or one alias's `host|model` targets.
    const [file, name] = args;
    const map = normalizeAliases(load(file));
    if (name === undefined) for (const k of Object.keys(map).sort()) console.log(k);
    else for (const t of map[name] || []) console.log(`${t.host}|${t.model}`);
    break;
  }
  case 'models': {
    // models <file> — one `id|status` line per entry of a /v1/models catalog.
    const [file] = args;
    const doc = load(file);
    for (const m of doc?.data || []) console.log(`${m.id}|${m.status}`);
    break;
  }
  default:
    console.error(`json-probe: unknown mode ${mode}`);
    process.exit(2);
}
