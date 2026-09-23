// Llama Manager decision engine card helper.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure helpers for the dashboard's Decision (Laya) server card: chooses the
// lifecycle button — Stop while the container runs, Start when it is idle but
// runnable (it also starts lazily on the first request), null for a disabled
// engine or any other server card — and, for the card's GPU variant/selection
// controls (W6-F1), parses the free-text GPU index field and builds the
// `{variant, gpus}` patch body POSTed to the existing loopback
// /api/decision/config route.

/** GPU stacks the decision engine can run under; anything else falls back to 'rocm'. */
const DECISION_VARIANTS = ['rocm', 'cuda'];

/**
 * @param {{id:string, state:string, running:boolean}} srv A /api/stats servers[] entry.
 * @returns {{label:'Start'|'Stop', path:string}|null} API path relative to API_BASE.
 */
export function decisionCardAction(srv) {
  if (srv?.id !== 'decision') return null;
  if (srv.running) return { label: 'Stop', path: '/decision/stop' };
  if (srv.state === 'idle') return { label: 'Start', path: '/decision/start' };
  return null;
}

/**
 * Parse the GPU-list text field into device index/id strings: splits on commas
 * and/or whitespace, trims each token, and drops empties.
 * @param {string|undefined} text
 * @returns {string[]}
 */
export function parseGpuList(text) {
  return String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the decision.config PATCH body for the card's variant select + GPU
 * list input. An unrecognized variant falls back to 'rocm'.
 * @param {{variant?:string, gpus?:string}} form Current control values.
 * @returns {{variant:'rocm'|'cuda', gpus:string[]}}
 */
export function decisionConfigPatch({ variant, gpus } = {}) {
  return { variant: DECISION_VARIANTS.includes(variant) ? variant : 'rocm', gpus: parseGpuList(gpus) };
}
