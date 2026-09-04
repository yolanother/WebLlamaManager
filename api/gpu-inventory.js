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
 *   keys: `card`, `name`, `driver`, `vramBytes`, `vramSource`, `gttBytes`, `available`,
 *   `temperature`, `usage`, `power`, `coreClock`, `memClock`.
 * @param {?number} systemBytes Total system memory in bytes.
 * @returns {Array<object>} One entry per card, inference card first, each with
 *   `card`, `name`, `driver`, `kind`, `inference`, `available`, `reason`,
 *   `vramBytes`, `vramSource`, `gttBytes`, `systemBytes` and the telemetry
 *   fields. An empty
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
      // WHICH source answered for vramBytes, so a caller can say so. An
      // aperture figure over-reports (a 24 GiB card shows a 32 GiB BAR) and
      // must be presented as an estimate rather than a measurement.
      vramSource: raw.vramSource ?? null,
      gttBytes: raw.gttBytes ?? null,
      systemBytes: systemBytes ?? null,
      temperature: raw.temperature ?? null,
      // The kernel's busy counter reaches this reader as `busyPercent`.
      // Reading only `usage` left this null on every card ever built.
      usage: raw.usage ?? raw.busyPercent ?? null,
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

/**
 * PCI vendor ids to the vendor name a readout should show. Mirrors PCI_VENDORS
 * in the kiosk agent -- the two must not drift, or the panel and the dashboard
 * will name the same card differently.
 * @type {Object<string,string>}
 */
export const PCI_VENDORS = {
  '0x1002': 'AMD',
  '0x10de': 'NVIDIA',
  '0x8086': 'Intel',
};

/**
 * PCI vendor id NVIDIA cards answer to. `nvidia-smi` is asked about those and
 * only those, so a card from another vendor can never be handed an NVIDIA
 * card's VRAM figure.
 * @type {string}
 */
export const NVIDIA_VENDOR_ID = '0x10de';

/**
 * Smallest BAR that can plausibly BE a card's VRAM aperture. Below this the BAR
 * is a window onto a fraction of VRAM -- a card without resizable BAR shows
 * 256 MiB -- and reporting it would be confidently wrong, which is worse than
 * saying nothing. Mirrors MIN_VRAM_BAR_BYTES in the kiosk agent.
 * @type {number}
 */
export const MIN_VRAM_BAR_BYTES = 1024 ** 3;

/** PCI resource flag: the BAR is memory. From include/linux/ioport.h. */
const PCI_RESOURCE_MEM = 0x200;

/** PCI resource flag: the BAR is prefetchable. From include/linux/ioport.h. */
const PCI_RESOURCE_PREFETCH = 0x2000;

/**
 * Sizes a card's largest prefetchable memory BAR from its sysfs `resource` file.
 *
 * This is the vendor-neutral last resort for a discrete card's dedicated VRAM:
 * it needs no driver-specific sysfs and no vendor tool, so it answers for a
 * card on nouveau that publishes neither. It OVER-reports -- a 24 GiB RTX 3090
 * exposes a 32 GiB BAR -- which is why the caller records `vramSource` and the
 * dashboard labels an aperture figure an estimate rather than a measurement.
 *
 * @param {?string} resourceText Contents of the card's `device/resource` file,
 *   one `start end flags` triplet of hex values per line. Null or empty when
 *   the file is absent.
 * @returns {?number} Aperture size in bytes, or null when there is no
 *   prefetchable memory BAR of at least MIN_VRAM_BAR_BYTES.
 */
export function parsePciApertureBytes(resourceText) {
  if (!resourceText || typeof resourceText !== 'string') return null;
  let largest = 0;
  for (const line of resourceText.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const start = Number.parseInt(fields[0], 16);
    const end = Number.parseInt(fields[1], 16);
    const flags = Number.parseInt(fields[2], 16);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(flags)) continue;
    if (end <= start) continue;
    if (!(flags & PCI_RESOURCE_MEM) || !(flags & PCI_RESOURCE_PREFETCH)) continue;
    largest = Math.max(largest, end - start + 1);
  }
  return largest >= MIN_VRAM_BAR_BYTES ? largest : null;
}

/**
 * Maps PCI slot addresses to device names from `lspci -mm` output.
 *
 * Names are whatever the local PCI ID database resolves, which may be a bare
 * `Device 1586` for silicon newer than that database. Mirrors
 * lspci_device_names in the kiosk agent.
 *
 * @param {?string} stdout Raw `lspci -mm` stdout, or null when the tool is
 *   absent -- an ordinary outcome on an appliance that never installs it.
 * @returns {Object<string,string>} Slot-to-name mapping; empty when there is
 *   nothing to read.
 */
export function parseLspciNames(stdout) {
  if (!stdout || typeof stdout !== 'string') return {};
  const names = {};
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const slot = line.slice(0, space);
    const fields = [...line.slice(space + 1).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (fields.length >= 3) names[slot] = fields[2];
  }
  return names;
}

/**
 * Names one card from its PCI identity and whatever label resolved for it.
 *
 * Mirrors describe_card's naming in the kiosk agent: the vendor as a readable
 * word when it is one we know, then the lspci label, then the raw device id,
 * and only when nothing at all is known a generic description. A raw id is
 * shown rather than a guess -- silicon newer than the local PCI database is the
 * normal case on this hardware, not an error.
 *
 * @param {{vendorId:?string, deviceId:?string, lspciName:?string}} identity
 *   The card's `device/vendor` and `device/device` sysfs values (`0x`-prefixed)
 *   and the name lspci resolved for its slot, if any.
 * @returns {string} A display name, never empty.
 */
export function describeCardName({ vendorId, deviceId, lspciName } = {}) {
  let label = lspciName || '';
  if (!label && deviceId) label = `Device ${deviceId.replace(/^0x/, '')}`;
  const vendor = vendorId ? (PCI_VENDORS[vendorId] || vendorId) : '';
  return [vendor, label || 'Graphics adapter'].filter(Boolean).join(' ');
}
