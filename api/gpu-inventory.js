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
      // How much of the card's OWN memory is in use, so a per-card memory
      // chart has a series per GPU rather than one for the inference card.
      vramUsedBytes: raw.vramUsedBytes ?? null,
      // WHICH source answered for vramBytes, so a caller can say so. An
      // aperture figure over-reports (a 24 GiB card shows a 32 GiB BAR) and
      // must be presented as an estimate rather than a measurement.
      vramSource: raw.vramSource ?? null,
      gttBytes: raw.gttBytes ?? null,
      // How much of that window is in use. Dropped here originally, which left
      // the APU with no point on the per-card memory chart.
      gttUsedBytes: raw.gttUsedBytes ?? null,
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
      entry.gttUsedBytes = null;
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

/**
 * Field order this module expects from nvidia-smi, and the query that produces
 * it. Exported so the caller cannot drift from the parser: one edited without
 * the other silently shifts every column.
 *
 * `name` is deliberately NOT queried. The card is already named from sysfs or
 * lspci, and a vendor string arriving inside comma-separated output is a
 * parsing hazard for no gain.
 * @type {string}
 */
export const NVIDIA_SMI_QUERY =
  'pci.bus_id,temperature.gpu,power.draw,utilization.gpu,memory.total,memory.used,'
  + 'clocks.current.graphics,clocks.current.memory';

/**
 * Parses `nvidia-smi --format=csv,noheader,nounits` output into per-card
 * telemetry.
 *
 * This is the ONLY source of these numbers for an NVIDIA card: the open driver
 * registers no hwmon, verified on the appliance after installing 610, so the
 * sysfs path that serves every AMD card reports nothing here.
 *
 * @param {?string} stdout Raw output, one card per line, fields in
 *   NVIDIA_SMI_QUERY order.
 * @returns {Object<string,{temperature:?number, power:?number, usage:?number,
 *   vramBytes:?number, vramUsedBytes:?number, coreClock:?number,
 *   memClock:?number}>} Keyed by the card's `bus:device.function` tail --
 *   nvidia-smi zero-pads the PCI domain to eight digits where sysfs uses four,
 *   so the tail is the only part that matches a sysfs slot. Empty when the tool
 *   is absent or said nothing, which is the normal case on an AMD appliance.
 */
export function parseNvidiaSmi(stdout) {
  if (!stdout || typeof stdout !== 'string') return {};
  const out = {};
  // "[N/A]" is what nvidia-smi prints for a sensor the board does not have.
  // It must read as null: zero would claim the card draws no power or is at 0 C.
  const num = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const mib = (value) => {
    const parsed = num(value);
    return parsed === null ? null : Math.round(parsed) * 1024 * 1024;
  };
  for (const line of stdout.split('\n')) {
    const f = line.split(',').map((v) => v.trim());
    // Eight fields or it is not a row we understand. A short row is skipped
    // rather than half-parsed into columns that have shifted.
    if (f.length < 8 || !f[0]) continue;
    const tail = f[0].toLowerCase().split(':').slice(-2).join(':');
    if (!tail) continue;
    out[tail] = {
      temperature: num(f[1]),
      power: num(f[2]),
      usage: num(f[3]),
      vramBytes: mib(f[4]),
      vramUsedBytes: mib(f[5]),
      coreClock: num(f[6]),
      memClock: num(f[7]),
    };
  }
  return out;
}

/**
 * Describes the extra chart series a multi-GPU machine needs.
 *
 * Every analytics sample used to record one scalar per metric, taken from the
 * inference card, so a second GPU's temperature, power, utilisation and memory
 * appeared on no graph at all. This names one series per card so each metric
 * can carry a value for every GPU.
 *
 * Returns EMPTY for a single-GPU machine -- almost every appliance -- so its
 * samples gain no keys and its charts keep drawing exactly the lines they
 * always drew. The multi-card case is additive, never a rewrite of the common
 * one.
 *
 * @param {?Array<object>} gpus The `gpus[]` inventory.
 * @returns {Array<{key:string, card:string, label:string, name:string,
 *   inference:boolean}>} Inference card first -- DRM order is not meaningful to
 *   a reader, and on this appliance the discrete card enumerates ahead of the
 *   APU, so ordering by the array would label the wrong card "GPU 1". `key` is
 *   both the sample field and the chart's dataKey.
 */
export function resolveGpuSeries(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  if (list.length <= 1) return [];
  const inference = list.find((g) => g.inference) || list[0];
  const ordered = [inference, ...list.filter((g) => g !== inference)];
  return ordered.map((gpu, i) => ({
    key: `gpu_${gpu.card || i}`,
    card: gpu.card || '',
    // "GPU 1"/"GPU 2" matches the thermal tile's rows, so one machine speaks
    // one language about its cards across the whole dashboard.
    label: `GPU ${i + 1}`,
    name: gpu.name || '',
    inference: Boolean(gpu.inference),
  }));
}

/**
 * How full one card's own memory pool is, as a percentage.
 *
 * An APU's usable pool is its GTT window, not the token VRAM carve-out (1 GiB
 * on Strix Halo), so reporting VRAM for it would understate the machine by two
 * orders of magnitude. A discrete card has no GTT and its VRAM is the answer.
 * This mirrors the panel's own formatter so the chart and the card cannot
 * disagree about which pool a GPU has.
 *
 * @param {?{kind:string, gttBytes:?number, gttUsedBytes:?number,
 *   vramBytes:?number, vramUsedBytes:?number}} gpu One entry from `gpus[]`.
 * @returns {?number} 0-100, or null when either half of the ratio is unknown --
 *   never 0, which would claim the card's memory is empty rather than
 *   unmeasured.
 */
export function gpuMemoryUsagePercent(gpu) {
  if (!gpu) return null;
  const integrated = gpu.kind === 'integrated';
  const total = integrated ? gpu.gttBytes : gpu.vramBytes;
  const used = integrated ? gpu.gttUsedBytes : gpu.vramUsedBytes;
  if (!total || total <= 0 || used === null || used === undefined) return null;
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

/**
 * The per-card field names present in a set of analytics samples.
 *
 * Card ids differ per machine and a card can be fitted or removed at any time,
 * so the key set is discovered from the data rather than hardcoded.
 *
 * @param {?Array<object>} points Samples from one analytics buffer.
 * @returns {Array<string>} Every `gpu_<card>` key seen, deduplicated.
 */
export function perCardKeys(points) {
  if (!Array.isArray(points)) return [];
  const keys = new Set();
  for (const point of points) {
    for (const key of Object.keys(point || {})) {
      if (key.startsWith('gpu_')) keys.add(key);
    }
  }
  return [...keys];
}

/**
 * The per-card field names one metric contributes to a set of history records.
 *
 * The persisted history is append-only, so records written before a card was
 * fitted simply lack its keys; the union across the range is what a chart must
 * be prepared to draw, with gaps where a record had nothing.
 *
 * @param {?Array<object>} records Minute records in range.
 * @param {string} prefix The metric's record key, e.g. `pwr`, `tg`, `mg`.
 * @returns {Array<string>} Keys shaped `<prefix>_<card>`. The underscore is
 *   required, so asking for `ms` can never harvest `mg_card1` -- or `mv`.
 */
export function historyCardKeys(records, prefix) {
  if (!Array.isArray(records) || !prefix) return [];
  const lead = `${prefix}_`;
  const keys = new Set();
  for (const record of records) {
    for (const key of Object.keys(record || {})) {
      if (key.startsWith(lead)) keys.add(key);
    }
  }
  return [...keys];
}
