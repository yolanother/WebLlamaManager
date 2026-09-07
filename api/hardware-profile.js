// Llama Manager — hardware profile derivation for duo mode (physical cores + accelerator presence).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Single source of truth for the machine-shaped numbers duo mode needs, so that no
// preset, launcher, or UI ever hardcodes a value that is only correct on one box.
// It answers three questions: how many PHYSICAL cores this machine has (the thread
// count large-MoE decode should use), how much RAM and model-volume space there is
// (the co-residency budget), and whether an NVIDIA card is present (whether the
// optional CUDA accelerator path exists at all).
//
// Why physical cores specifically: on a large MoE with CPU-side experts, running one
// thread per LOGICAL core collapses throughput because the hyperthread siblings spend
// their time spin-waiting on each other rather than computing. The measured shape on a
// 6c/12t box was 13.6 tok/s at 12 threads versus 24.4 tok/s at 6 — roughly a 50%
// swing from this one setting. `nproc` reports logical cores and is therefore the
// wrong number; we parse `lscpu` instead and fall back to logical only when parsing
// fails, flagging that fallback so the caller can warn.
//
// Pure and side-effect-free: the caller reads /proc, runs `lscpu`, stats the models
// volume and globs /sys/class/drm, then passes the raw values in. Unit-tested in
// hardware-profile.test.js against verbatim lscpu output from both appliance boxes.

import { NVIDIA_VENDOR_ID } from './gpu-inventory.js';

/**
 * Read an integer field out of `lscpu` output by its label.
 * @param {string} text Raw `lscpu` stdout.
 * @param {string} label Field label, e.g. 'Core(s) per socket'.
 * @returns {number|null} The parsed value, or null when the field is absent or unparseable.
 */
function lscpuInt(text, label) {
  // Labels contain regex metacharacters ('Core(s) per socket'), so match literally.
  const idx = text.indexOf(label);
  if (idx === -1) return null;
  const line = text.slice(idx + label.length).split('\n')[0];
  const m = line.match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Derive the number of physical CPU cores from `lscpu` output.
 *
 * Computed as `Core(s) per socket` × `Socket(s)`, which is the count that matters for
 * MoE decode threading. Deliberately returns null rather than guessing when the output
 * cannot be parsed, so the caller decides what to fall back to and can say that it did.
 *
 * @param {string|null|undefined} lscpuText Raw `lscpu` stdout.
 * @returns {number|null} Physical core count, or null when it cannot be determined.
 */
export function physicalCoreCount(lscpuText) {
  if (!lscpuText || typeof lscpuText !== 'string') return null;
  const perSocket = lscpuInt(lscpuText, 'Core(s) per socket');
  if (perSocket === null) return null;
  const sockets = lscpuInt(lscpuText, 'Socket(s)') ?? 1;
  return perSocket * sockets;
}

/**
 * True when at least one NVIDIA GPU is present, based on PCI vendor ids read from
 * /sys/class/drm/card*&#47;device/vendor. Matching is trimmed and case-insensitive because
 * sysfs reads carry a trailing newline and casing varies by source.
 *
 * This gates the entire optional CUDA path: on a box where this is false, no RPC server
 * is started, no `--rpc` flag is emitted, and the accelerator UI is not rendered.
 *
 * @param {string[]|null|undefined} vendors PCI vendor ids, e.g. ['0x10de', '0x1002'].
 * @returns {boolean} Whether an NVIDIA card is present.
 */
export function hasNvidiaGpu(vendors) {
  if (!Array.isArray(vendors)) return false;
  return vendors.some((v) => String(v).trim().toLowerCase() === NVIDIA_VENDOR_ID);
}

/**
 * Assemble the full hardware profile duo mode reads from.
 *
 * `threads` is the value to hand llama.cpp's `--threads`. It follows the physical core
 * count when that could be derived; otherwise it falls back to the logical count and
 * sets `threadsDerived` to false so the caller can warn that the machine is running the
 * known-slow configuration.
 *
 * @param {object} params
 * @param {string} [params.lscpuText] Raw `lscpu` stdout.
 * @param {number} [params.logicalCores] Logical core count (os.cpus().length / nproc).
 * @param {number} [params.memTotalBytes] Total system RAM in bytes.
 * @param {number} [params.modelsFreeBytes] Free bytes on the volume holding the models dir.
 * @param {string[]} [params.vendors] PCI vendor ids from /sys/class/drm/card*.
 * @returns {{physicalCores:number|null, logicalCores:number, threads:number,
 *            threadsDerived:boolean, memTotalBytes:number, modelsFreeBytes:number,
 *            hasNvidia:boolean}} The resolved profile.
 */
export function buildHardwareProfile({
  lscpuText = '',
  logicalCores = 0,
  memTotalBytes = 0,
  modelsFreeBytes = 0,
  vendors = [],
} = {}) {
  const physicalCores = physicalCoreCount(lscpuText);
  const threadsDerived = physicalCores !== null;
  // Never emit 0 or a negative --threads; one thread always beats a broken flag.
  const threads = Math.max(1, threadsDerived ? physicalCores : logicalCores);

  return {
    physicalCores,
    logicalCores,
    threads,
    threadsDerived,
    memTotalBytes,
    modelsFreeBytes,
    hasNvidia: hasNvidiaGpu(vendors),
  };
}
