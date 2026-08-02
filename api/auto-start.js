// Llama Manager — inference engine auto-start scheduling boundary.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Converts the resolved auto-start configuration into one delayed engine-start
// action. Keeping this decision outside the HTTP listener makes passive manager
// instances observable and prevents truthiness mistakes from hiding in timers.

/**
 * Schedule the configured manager engine start exactly once when enabled.
 *
 * @param {{autoStart:unknown, start:() => void, schedule:(callback:() => void, delayMs:number) => unknown, delayMs?:number}} input Scheduling dependencies.
 * @param {unknown} input.autoStart Engine auto-start is enabled only by boolean true.
 * @param {() => void} input.start Action that posts the engine-start request.
 * @param {(callback:() => void, delayMs:number) => unknown} input.schedule Timer implementation.
 * @param {number} [input.delayMs=1000] Delay before starting the engine.
 * @returns {boolean} True when a start action was scheduled.
 */
export function scheduleAutoStart({ autoStart, start, schedule, delayMs = 1000 }) {
  if (autoStart !== true) return false;
  schedule(start, delayMs);
  return true;
}
