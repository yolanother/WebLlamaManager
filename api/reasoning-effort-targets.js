// Llama Manager — model names a reasoning-effort pattern must be tested against.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Per-model reasoning bounds are keyed by model FAMILY (e.g. `*qwen3.6-35b*`), but callers
// normally request an ALIAS (`default-big`, `default-small`). An alias name shares no
// substring with the family it resolves to, so matching only the requested name silently
// skipped the bound for every alias-based caller. This module answers the one question
// that fixes it: which concrete model names does this request actually stand for?

/**
 * Every model name a reasoning-effort pattern should be tested against.
 *
 * Returns the requested name first (so a literal model id keeps matching exactly as it
 * did), followed by each concrete target the alias resolves to. Remote targets are
 * included as well as local ones: an alias may resolve only to a remote backend, and that
 * model needs the same bound as if it had been asked for by name.
 *
 * Pure: the alias lookup is injected, so this is testable without a server, config, or
 * model inventory.
 *
 * @param {string} model The model name exactly as the client requested it.
 * @param {(name: string) => ({candidates?: Array<{model?: string}>}|null|undefined)} resolveRouting
 *   Alias resolver; returns routing whose `candidates` carry concrete `model` names.
 * @returns {string[]} The requested name plus each distinct alias target.
 */
export function reasoningEffortMatchNames(model, resolveRouting) {
  const requested = typeof model === 'string' ? model : '';
  const names = [requested];
  let routing;
  try {
    routing = resolveRouting?.(requested);
  } catch {
    // Alias inventory unavailable (early boot, config error). The literal name still
    // matches exactly as before, so this degrades to the previous behaviour.
    return names;
  }
  for (const candidate of routing?.candidates ?? []) {
    const target = candidate?.model;
    if (typeof target === 'string' && target && !names.includes(target)) names.push(target);
  }
  return names;
}
