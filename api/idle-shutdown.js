/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Decides whether the llama.cpp router has been idle long enough to be stopped.
 * Extracted from the idle timer in server.js so the rule can be specified
 * directly, because its interesting case is invisible in production until an
 * appliance boots and nobody notices the engine dying a minute later.
 */

/**
 * Reports whether an idle engine may be stopped.
 *
 * Idleness is measured from the LATER of "last request served" and "engine
 * started". Measuring from last-request alone is wrong for an engine that has
 * never served one: `lastUsedAt` is 0 there, so the elapsed time becomes the
 * time since the epoch and the engine is stopped almost immediately after it
 * starts. That is the state EVERY freshly booted appliance is in -- the kiosk
 * comes up, the router comes up, and nothing has been asked of it yet -- so the
 * bug guaranteed a dead engine on exactly the machines that most needed a live
 * one.
 *
 * When neither timestamp is known the answer is "not idle". An unknown clock is
 * not evidence of idleness, and shutting down on it would repeat the original
 * defect in a quieter form.
 *
 * @param {object} params
 * @param {number} params.now Current epoch milliseconds.
 * @param {number} params.lastUsedAt Epoch ms of the last request, 0 if never.
 * @param {number} params.startedAt Epoch ms the engine started, 0 if unknown.
 * @param {number} params.idleMinutes Minutes of inactivity before shutdown.
 * @returns {boolean} True when the engine may be stopped.
 */
export function shouldIdleShutdown({ now, lastUsedAt = 0, startedAt = 0, idleMinutes }) {
  const since = Math.max(Number(lastUsedAt) || 0, Number(startedAt) || 0);
  if (since <= 0) return false;
  return now - since >= idleMinutes * 60_000;
}
