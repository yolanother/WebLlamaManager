// Llama Manager — additional-GPU panel view model.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Turns the `gpus[]` array from /api/system into what the dashboard needs to
// render cards BESIDE the headline one, and decides whether to render anything
// extra at all. Pure, so the two-GPU cases are testable on a one-GPU machine.
//
// The headline figures keep reading `stats.gpu`, which is the inference GPU in
// its original shape. This module deliberately owns only the ADDITIONAL cards:
// a single-GPU appliance -- almost every appliance -- must look exactly as it
// did before gpus[] existed, and the cheapest way to guarantee that is for this
// to return "nothing to add" rather than for the panel to re-derive the
// headline from a list.

/**
 * Formats the memory pool a card actually has.
 *
 * An APU's usable pool is its GTT window, not the token VRAM carve-out (1 GiB
 * on Strix Halo), so reporting VRAM for it would understate the machine by two
 * orders of magnitude. A discrete card has no GTT and its VRAM is the answer.
 *
 * @param {{vramBytes:?number, gttBytes:?number}} gpu One entry from `gpus[]`.
 * @returns {?string} Human-readable size, or null when nothing on this machine
 *   can measure it — never "0 B", which reads as "this card has no memory".
 */
export function formatGpuMemory(gpu) {
  const bytes = gpu?.gttBytes || gpu?.vramBytes || null;
  if (!bytes || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * A readable name for a card, whatever sysfs was willing to tell us.
 *
 * Many amdgpu devices publish no `product_name` at all -- this appliance's own
 * iGPU does not -- so the raw fallback is a DRM node like "card1". That is a
 * correct identifier and a poor heading: it tells the operator nothing about
 * which card they are looking at. Naming it by what we DID determine (whether
 * it is the integrated part or a discrete board) is more use than the node
 * alone, and the node is kept alongside so it stays unambiguous when two
 * unnamed cards are present.
 *
 * @param {{name:?string, card:?string, kind:?string}} gpu One entry from gpus[].
 * @returns {string} Never empty.
 */
export function describeGpu(gpu) {
  if (gpu?.name) return gpu.name;
  const kind = gpu?.kind === 'integrated' ? 'Integrated GPU' : 'Discrete GPU';
  return gpu?.card ? `${kind} (${gpu.card})` : kind;
}

/**
 * Builds the view model for GPUs other than the one inference runs on.
 *
 * @param {?object} stats The /api/system payload, or any older shape without
 *   `gpus` — an appliance whose manager predates this field must not render as
 *   broken, so a missing or empty list is simply "one GPU, nothing to add".
 * @returns {{showAdditional:boolean, count:number, label:?string,
 *   additional:Array<{card:string, title:string, detail:string, kind:string,
 *   available:boolean, inference:boolean, temperature:?number, power:?number}>}}
 *   `label` is the inference card's name, for use as a heading, and is null
 *   when there is nothing to disambiguate it from.
 */
export function resolveGpuPanel(stats) {
  const gpus = Array.isArray(stats?.gpus) ? stats.gpus : [];
  if (gpus.length <= 1) {
    return { showAdditional: false, count: gpus.length || 1, label: null, additional: [] };
  }

  const inference = gpus.find((g) => g.inference) || gpus[0];
  const additional = gpus.filter((g) => g !== inference).map((gpu) => {
    const size = formatGpuMemory(gpu);
    // Order matters: an unusable card's reason outranks its size, and a size
    // nothing can measure is explained rather than shown as a number.
    let detail;
    if (!gpu.available) detail = gpu.reason || 'unavailable';
    else if (size) detail = size;
    else detail = gpu.reason || 'size unknown';
    return {
      card: gpu.card || '',
      // A nameless card is still identifiable by its DRM node. Rendering an
      // empty heading would make it look like a UI fault rather than a card.
      title: describeGpu(gpu),
      detail,
      kind: gpu.kind || 'discrete',
      available: gpu.available !== false,
      inference: false,
      temperature: gpu.temperature ?? null,
      power: gpu.power ?? null,
    };
  });

  return {
    showAdditional: additional.length > 0,
    count: gpus.length,
    label: describeGpu(inference),
    additional,
  };
}
