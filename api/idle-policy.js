/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Decides how long an idle llama.cpp router may sit before it is stopped, and
 * whether it should be stopped at all. Extracted so the appliance's "never idle
 * out" rule is stated in one testable place rather than buried in a timer.
 */

/** Minutes of inactivity before a source install stops its engine. */
export const DEFAULT_IDLE_MINUTES = 15;

/**
 * Resolves the idle-shutdown window for this installation.
 *
 * A packaged appliance defaults to NEVER idling out. It exists to answer: it
 * boots, starts its engine, and waits for somebody to walk up to it. Stopping
 * the engine after fifteen unattended minutes means the kiosk greets the first
 * visitor with "the engine is here but not answering yet", and their opening
 * question pays a ~29 second model load from USB. On a box with 124 GB of
 * system memory, holding a 5 GB model resident is the cheaper trade by far.
 *
 * A source install keeps the fifteen minute default, where the engine competes
 * with a developer's own workload and unloading it is usually welcome.
 *
 * An explicit IDLE_SHUTDOWN_MINUTES always wins, so either default can be
 * overridden per machine. Nonsense falls back to the default rather than
 * disabling shutdown silently: a typo should not strand a model in memory
 * forever, nor stop the engine every minute.
 *
 * @param {object} params
 * @param {Record<string,string|undefined>} params.env Process environment.
 * @returns {number} Minutes of inactivity before shutdown; 0 means never.
 */
export function resolveIdleMinutes({ env = {} } = {}) {
  const packaged = env.LLAMA_MANAGER_PACKAGED === '1' || env.LLAMA_MANAGER_PACKAGED === 'true';
  const fallback = packaged ? 0 : DEFAULT_IDLE_MINUTES;

  const raw = env.IDLE_SHUTDOWN_MINUTES;
  if (raw === undefined || raw === '') return fallback;

  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0) {
    return DEFAULT_IDLE_MINUTES;
  }
  return minutes;
}
