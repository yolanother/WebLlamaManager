// Llama Manager — chat-first shell status pill label logic.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure derivation of the `StatusPill` component's health state and model
// label from live server stats. Kept free of DOM access so the branching
// (healthy/starting/stopped, single-model vs. router) is covered by
// `node --test` without mounting React.

import { formatModelName } from '../api.js';

/**
 * Health/state/model label shown by the chat-first shell's top-bar pill.
 * @typedef {object} StatusPillLabel
 * @property {boolean} healthy - True when the llama server or the ds4 engine
 *   is reporting `ok`.
 * @property {'Running'|'Starting'|'Stopped'} state - Coarse service state,
 *   mirroring `Sidebar.jsx`'s status indicator.
 * @property {string} modelLabel - The active model's display name in single
 *   mode, otherwise `'Router (Multi)'`.
 */

/**
 * Derive the StatusPill's health state and model label from live stats.
 * @param {object|null|undefined} stats - The websocket `stats` payload.
 * @returns {StatusPillLabel}
 */
export function statusPillLabel(stats) {
  const healthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';
  const state = healthy ? 'Running' : (stats?.mode ? 'Starting' : 'Stopped');
  const isSingleMode = stats?.mode === 'single';
  const modelLabel = (isSingleMode && stats?.activeModel)
    ? formatModelName({ id: stats.activeModel })
    : 'Router (Multi)';
  return { healthy, state, modelLabel };
}
