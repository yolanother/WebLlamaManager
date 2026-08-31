/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Decides which GPU inference runs on and describes every other card in the
 * machine, from values a caller has already read out of sysfs and rocm-smi.
 * Pure: it performs no I/O, so the awkward cases -- a discrete card enumerating
 * ahead of the APU, a card with no driver bound, a size nothing can measure --
 * are testable on hardware that does not have them.
 *
 * This exists because reporting was first-card-wins, which on a two-GPU box is
 * WRONG rather than merely incomplete: DRM cards enumerate in kernel order, so
 * an OCuLink-attached discrete card can sort ahead of the integrated one and its
 * temperature, power and memory then appear under the iGPU's label -- and the
 * thermal governor reads the same numbers. The kiosk agent (respin repo,
 * kiosk/agent/kiosk-agent.py read_gpus) already resolved this; this module
 * mirrors its contract so the dashboard and the kiosk cannot disagree about what
 * is in the machine.
 */

/**
 * Share of system RAM a card's GTT window must cover to read as integrated.
 * An APU addresses most of host memory through GTT; a discrete card's window is
 * a small aperture. Mirrors INTEGRATED_GTT_FRACTION in the kiosk agent -- the
 * two must not drift, or the panel and the dashboard will disagree about which
 * card is which.
 * @type {number}
 */
export const INTEGRATED_GTT_FRACTION = 0.75;

/**
 * Classifies one card as integrated or discrete from its GTT window.
 *
 * @param {{gttBytes:?number, systemBytes:?number}} card Card's GTT window and
 *   the machine's total RAM, in bytes. Either may be null when unknown.
 * @returns {'integrated'|'discrete'} `integrated` only when the GTT window
 *   covers at least INTEGRATED_GTT_FRACTION of system RAM; unknown reads as
 *   discrete, because claiming a card can reach host memory when nothing says
 *   so is the more damaging error.
 */
export function classifyCard({ gttBytes, systemBytes } = {}) {
  if (!gttBytes || !systemBytes) return 'discrete';
  return gttBytes >= systemBytes * INTEGRATED_GTT_FRACTION ? 'integrated' : 'discrete';
}

/**
 * Builds the ordered GPU inventory, inference card first.
 *
 * @param {Array<object>} cards One entry per card as read from sysfs. Recognised
 *   keys: `card`, `name`, `driver`, `vramBytes`, `gttBytes`, `available`,
 *   `temperature`, `usage`, `power`, `coreClock`, `memClock`.
 * @param {?number} systemBytes Total system memory in bytes.
 * @returns {Array<object>} One entry per card, inference card first, each with
 *   `card`, `name`, `driver`, `kind`, `inference`, `available`, `reason`,
 *   `vramBytes`, `gttBytes`, `systemBytes` and the telemetry fields. An empty
 *   array when the machine has no GPU -- never a placeholder card.
 */
export function buildInventory(cards, systemBytes) {
  if (!Array.isArray(cards) || cards.length === 0) return [];

  const described = cards.map((raw) => {
    const available = raw.available !== false;
    const kind = classifyCard({ gttBytes: raw.gttBytes, systemBytes });
    return {
      card: raw.card || '',
      name: raw.name || '',
      driver: raw.driver || '',
      kind,
      inference: false,
      available,
      reason: '',
      // Unknown is null, never 0. A confident zero and a silent omission are
      // both worse than an honest "unknown", and this readout has shipped both.
      vramBytes: raw.vramBytes ?? null,
      gttBytes: raw.gttBytes ?? null,
      systemBytes: systemBytes ?? null,
      temperature: raw.temperature ?? null,
      usage: raw.usage ?? null,
      power: raw.power ?? null,
      coreClock: raw.coreClock ?? null,
      memClock: raw.memClock ?? null,
    };
  });

  // Inference runs on the integrated GPU. With none detected the first card is
  // still where a model would land, so it keeps the label rather than leaving
  // the machine reporting that nothing runs anything.
  const inference = described.find((c) => c.kind === 'integrated' && c.available)
    || described.find((c) => c.available)
    || described[0];
  inference.inference = true;

  for (const entry of described) {
    // Only the inference card can reach host memory. A discrete card's GTT and
    // system pools stay null: absent, never a share of host RAM.
    if (entry !== inference) {
      entry.gttBytes = null;
      entry.systemBytes = null;
    }
    if (!entry.available) {
      entry.reason = 'no kernel driver is bound to it, so it cannot be used and its memory size is unknown';
    } else if (entry !== inference && entry.vramBytes === null) {
      entry.reason = 'no driver or vendor tool on this machine reports its memory size';
    }
  }

  return [inference, ...described.filter((c) => c !== inference)];
}

/**
 * Parses rocm-smi's JSON into a per-card map.
 *
 * rocm-smi reports `card0`, `card1`, `card2` ... The reader this replaces looked
 * only at `card0`, so every additional AMD card was parsed and then discarded.
 *
 * @param {?object} data Decoded rocm-smi JSON, or null when it returned nothing
 *   (which is normal on Strix Halo, where sysfs is the real source).
 * @returns {Object<string,{temperature:?number, vramBytes:?number,
 *   vramUsedBytes:?number, power:?number, usage:?number}>} Keyed by card id;
 *   empty when there is nothing to read.
 */
export function parseRocmSmiCards(data) {
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [key, card] of Object.entries(data)) {
    if (!/^card\d+$/.test(key) || !card || typeof card !== 'object') continue;
    const num = (value) => {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    out[key] = {
      temperature: num(card['Temperature (Sensor edge) (C)'] ?? card.temperature),
      vramBytes: num(card['VRAM Total Memory (B)']),
      vramUsedBytes: num(card['VRAM Total Used Memory (B)']),
      power: num(card['Current Socket Graphics Package Power (W)']
        ?? card['Average Graphics Package Power (W)']),
      usage: num(card['GPU use (%)'] ?? card.gpu_use),
    };
  }
  return out;
}
