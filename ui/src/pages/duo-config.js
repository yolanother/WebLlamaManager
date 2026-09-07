// Llama Manager — duo mode config panel state.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure state and validation behind the Settings > Duo panel: decides which sections the
// panel renders for THIS machine, supplies hardware-derived defaults, and validates an
// operator's edits before they are saved. Contains no React and performs no I/O — the
// component owns every fetch and all component state.
//
// The governing rule is that duo is hardware-aware: the CPU+APU path is the product and
// the discrete NVIDIA accelerator is optional. Where no NVIDIA card exists the
// accelerator controls are ABSENT rather than disabled, so an operator is never offered
// a switch that cannot do anything on their box.
//
// The thread validation encodes a measured cliff rather than a style preference. On a
// 16-physical/32-logical Strix Halo box, running one thread per LOGICAL core dropped
// Qwen3.8-Flash-Next decode from 17.9 tok/s to 0.77 — a 23x collapse, measured with the
// model fully resident in RAM and zero I/O wait, so it is pure CPU spin-wait rather than
// paging. The cliff sits at the logical count specifically: 24 threads (1.5x physical)
// still measured 17.2 tok/s.

/** Priority policies for sharing a discrete GPU with the pods agent. */
export const ACCELERATOR_PRIORITIES = ['agent-first', 'llama-first'];

/**
 * Whether this machine can offer the discrete-GPU accelerator, and why not when it
 * cannot. The reason is surfaced to the operator so an absent control is explicable
 * rather than mysterious.
 * @param {{hasNvidia?: boolean}|null|undefined} profile Hardware profile from the server.
 * @returns {{available: boolean, reason?: string}}
 */
export function acceleratorAvailability(profile) {
  if (!profile?.hasNvidia) {
    return { available: false, reason: 'no NVIDIA GPU detected on this machine' };
  }
  return { available: true };
}

/**
 * The sections the duo panel should render on this machine, in display order.
 * The accelerator section is omitted entirely on a box with no NVIDIA card.
 * @param {object|null|undefined} profile Hardware profile from the server.
 * @returns {Array<{id: string, title: string}>}
 */
export function duoConfigSections(profile) {
  const sections = [
    { id: 'models', title: 'Models' },
    { id: 'threads', title: 'CPU threads' },
    { id: 'exclusivity', title: 'Exclusivity' },
  ];
  if (acceleratorAvailability(profile).available) {
    sections.push({ id: 'accelerator', title: 'GPU acceleration' });
  }
  return sections;
}

/**
 * Hardware-derived defaults for a fresh duo configuration.
 *
 * `threads` follows the profile's physical-core figure rather than any constant, so the
 * same code is correct on every box. The accelerator defaults to off and, when present,
 * to leaving the card to the pods agent — asset generation and TTS are that card's
 * normal job, and duo borrowing it must be a deliberate act.
 *
 * @param {{threads?: number}|null|undefined} profile Hardware profile from the server.
 * @returns {{threads: number, useAccelerator: boolean, acceleratorPriority: string}}
 */
export function defaultDuoSettings(profile) {
  return {
    threads: Number(profile?.threads) > 0 ? Number(profile.threads) : 1,
    useAccelerator: false,
    acceleratorPriority: 'agent-first',
  };
}

/**
 * Validate an operator's duo settings against this machine.
 *
 * Rejects only what cannot work (an accelerator that is not present, a nonsensical
 * thread count). A thread count equal to the logical core count is permitted but warned
 * about: it is the measured 23x collapse, and the operator may still have a reason.
 *
 * @param {{threads?: number, useAccelerator?: boolean}} settings Edited settings.
 * @param {object|null|undefined} profile Hardware profile from the server.
 * @returns {{ok: boolean, error?: string, warning?: string}}
 */
export function validateDuoSettings(settings, profile) {
  const threads = Number(settings?.threads);
  const logical = Number(profile?.logicalCores) || 0;
  const physical = Number(profile?.physicalCores) || 0;

  if (!Number.isFinite(threads) || threads < 1) {
    return { ok: false, error: 'Thread count must be at least 1.' };
  }
  if (logical && threads > logical) {
    return { ok: false, error: `Thread count cannot exceed this machine's ${logical} logical cores.` };
  }
  if (settings?.useAccelerator) {
    const avail = acceleratorAvailability(profile);
    if (!avail.available) {
      return { ok: false, error: `GPU acceleration is unavailable: ${avail.reason}.` };
    }
  }
  if (logical && threads === logical && physical && physical < logical) {
    return {
      ok: true,
      warning:
        `Using all ${logical} logical cores collapses large-model throughput ` +
        `(measured 23x slower than ${physical} threads). Prefer ${physical}, one per physical core.`,
    };
  }
  return { ok: true };
}
