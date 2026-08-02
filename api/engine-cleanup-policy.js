// Llama Manager — host-wide engine cleanup authorization policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Centralizes the boundary between ownership-scoped shutdown and explicit
// recovery transitions. It prevents passive manager instances from sweeping
// another manager's engine while preserving deliberate stale-engine cleanup.

/**
 * Decide whether a manager operation may perform host-wide engine cleanup.
 *
 * @param {{ownsEngine:boolean, explicitReclaim?:boolean}} input Cleanup context.
 * @param {boolean} input.ownsEngine Whether this manager spawned the engine.
 * @param {boolean} [input.explicitReclaim=false] Whether the operator-facing
 *   operation explicitly takes supervision of the engine slot.
 * @returns {boolean} True when global PID/port cleanup is authorized.
 */
export function shouldRunGlobalEngineCleanup({ ownsEngine, explicitReclaim = false }) {
  return Boolean(ownsEngine || explicitReclaim);
}
