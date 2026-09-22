// Llama Manager decision engine card helper.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure helper for the dashboard's server registry: chooses the lifecycle button
// shown on the Decision (Laya) card — Stop while the container runs, Start when
// it is idle but runnable (it also starts lazily on the first request) — and
// returns null for a disabled engine or any other server card.

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
