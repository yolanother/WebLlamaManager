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
 * A figure derived from the PCI aperture is an OVER-estimate and says so: a
 * 24 GiB RTX 3090 exposes a 32 GiB resizable BAR, and an unqualified "32 GB" is
 * a number an operator would size a model against and be wrong by 8 GiB. Every
 * other source is a real measurement and is left unhedged, because qualifying a
 * figure that is exact is its own kind of lie.
 *
 * @param {{vramBytes:?number, gttBytes:?number, vramSource:?string}} gpu One
 *   entry from `gpus[]`. `vramSource` describes vramBytes only.
 * @returns {?string} Human-readable size, or null when nothing on this machine
 *   can measure it — never "0 B", which reads as "this card has no memory".
 */
export function formatGpuMemory(gpu) {
  const gtt = gpu?.gttBytes || null;
  const bytes = gtt || gpu?.vramBytes || null;
  if (!bytes || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const size = `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  // Only when the figure SHOWN is the aperture one. An integrated card reports
  // its usable pool from GTT, so a stray vramSource on its unused VRAM
  // carve-out must not make the APU's honest number read as a guess.
  return !gtt && gpu?.vramSource === 'aperture' ? `~${size} (aperture estimate)` : size;
}

/**
 * Explains an estimated memory figure to whoever hovers it.
 *
 * @param {{vramBytes:?number, gttBytes:?number, vramSource:?string}} gpu One
 *   entry from `gpus[]`.
 * @returns {?string} Tooltip text, or null when the figure is a measurement and
 *   there is therefore nothing to explain.
 */
export function gpuMemoryTitle(gpu) {
  if (gpu?.gttBytes || gpu?.vramSource !== 'aperture') return null;
  return 'No vendor tool on this machine reports this card\u2019s memory size, so this is the '
    + 'largest prefetchable PCI aperture instead. It is an upper bound: a card can expose a '
    + 'window larger than the memory behind it.';
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
 *   additional:Array<{card:string, title:string, detail:string,
 *   detailTitle:?string, driver:string, kind:string, available:boolean,
 *   inference:boolean, temperature:?number, power:?number}>}}
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
      // Null unless `detail` is an estimate. Only an estimate owes the reader
      // an explanation; attaching one to a measured figure invites doubt about
      // a number that deserves none.
      detailTitle: gpu.available && size ? gpuMemoryTitle(gpu) : null,
      // The bound driver, because nouveau vs nvidia is exactly the distinction
      // an operator asking "why is there no CUDA on this card" needs to see.
      driver: gpu.driver || '',
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

/**
 * Builds the stats-rail GPU gauge: one concentric ring per GPU.
 *
 * The rail used to draw a single ring for the inference card and label it
 * "1/2". That label was accurate and useless -- it said "you are looking at
 * card 1 of 2" while the second card's load appeared nowhere on the rail, so a
 * discrete card pinned at 100% was invisible until someone opened the
 * dashboard. One ring per card shows all of them in the same space.
 *
 * Rings are ordered outermost first, starting with the card inference runs on,
 * because DRM enumeration order is not meaningful to a reader: on this
 * appliance the OCuLink card enumerates ahead of the APU, so ordering by the
 * array would put the card that is NOT running the model on the outside.
 *
 * @param {?object} stats The /api/system payload. A payload with no `gpus`
 *   (an appliance whose manager predates the field) falls back to the headline
 *   `gpu` figure, so the tile keeps working rather than rendering empty.
 * @returns {{rings:Array<{card:string, value:?number, title:string}>,
 *   label:string, title:string}} `value` is null for a card nothing can
 *   measure -- the caller draws its track and no fill. `label` sits under the
 *   gauge; `title` is the hover text naming every card.
 */
export function resolveGpuRings(stats) {
  const gpus = Array.isArray(stats?.gpus) ? stats.gpus : [];

  if (gpus.length <= 1) {
    // One card, or an API that predates gpus[]. Either way this must render
    // exactly as the single ring always did: almost every appliance is here.
    const only = gpus[0] || null;
    const value = only ? (only.usage ?? null) : (stats?.gpu?.usage ?? 0);
    return {
      rings: [{ card: only?.card || '', value, title: only ? describeGpu(only) : 'GPU usage' }],
      label: 'GPU',
      title: 'GPU Usage',
    };
  }

  const inference = gpus.find((g) => g.inference) || gpus[0];
  const ordered = [inference, ...gpus.filter((g) => g !== inference)];

  const rings = ordered.map((gpu) => {
    const name = describeGpu(gpu);
    const usage = gpu.usage ?? null;
    let detail;
    // An unusable card's reason outranks its missing number, and a card that
    // simply has no counter is explained rather than shown as 0% -- which
    // would assert it is idle when the truth is that we cannot see it.
    if (gpu.available === false) detail = gpu.reason || 'unavailable';
    else if (usage === null) detail = 'no utilisation counter on this driver';
    else detail = `${Math.round(usage)}%`;
    return {
      card: gpu.card || '',
      value: usage,
      title: `${name} — ${detail}${gpu.inference ? ' (inference)' : ''}`,
    };
  });

  return {
    rings,
    // Not "1/N": that claimed to be showing one card of several, which stopped
    // being true the moment every card got its own ring.
    label: `GPU ×${gpus.length}`,
    title: rings.map((r) => r.title).join('\n'),
  };
}

/**
 * Builds the GPU rows of the stats-rail thermal tile.
 *
 * The tile used to carry exactly one GPU row, which on a multi-card machine
 * silently meant "the card inference runs on" -- so a discrete card cooking at
 * 90 C appeared nowhere on the rail. Every card that actually reports a
 * temperature now gets its own row.
 *
 * A card only earns a row when it HAS a sensor. Inventing a row for a card
 * whose driver publishes none (nouveau reports no temperature for an NVIDIA
 * card) would sit a zero or blank reading beside two real ones, in a tile
 * whose entire subject is heat. Absent is honest there; zero is not.
 *
 * @param {?object} stats The /api/system payload.
 * @returns {Array<{card:string, label:string, value:number}>} Inference card
 *   first, matching the ring order. Labels are numbered only when more than
 *   one card reports, so the common single-GPU tile still reads "GPU". Empty
 *   when nothing reports a temperature -- never a zero row.
 */
export function resolveGpuTempRows(stats) {
  const gpus = Array.isArray(stats?.gpus) ? stats.gpus : [];
  // The thermal governor's own reading is what it throttles on, so it wins for
  // the inference card: the rail must not show a different number from the
  // thing actually taking action.
  const guardC = stats?.guard?.gpuC ?? null;

  if (gpus.length === 0) {
    // An appliance whose manager predates gpus[]: the headline figure is the
    // only GPU temperature there is.
    const value = guardC ?? stats?.gpu?.temperature ?? null;
    return value > 0 ? [{ card: '', label: 'GPU', value }] : [];
  }

  const inference = gpus.find((g) => g.inference) || gpus[0];
  const ordered = [inference, ...gpus.filter((g) => g !== inference)];

  const rows = ordered
    .map((gpu) => {
      const own = gpu === inference ? (guardC ?? gpu.temperature) : gpu.temperature;
      return { card: gpu.card || '', value: own ?? null };
    })
    .filter((row) => row.value > 0);

  return rows.map((row, i) => ({
    ...row,
    // Numbered only when there is something to disambiguate from. A lone
    // "GPU 1" on a single-card appliance would imply a missing second card.
    label: rows.length > 1 ? `GPU ${i + 1}` : 'GPU',
  }));
}
