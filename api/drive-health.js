// Llama Manager — drive health parsers (SMART, kernel faults, crash attribution).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free parsing for the drive temperature/health panel and the
// last-crash readout. Turns `nvme smart-log` text into normalized health fields,
// counts the kernel-log signals that precede a storage lockup, and classifies a
// pstore panic dump by cause. All I/O — reading the privileged snapshot, sysfs,
// or /dev/kmsg — belongs to the caller; this module only ever sees strings.
//
// WHY THIS EXISTS
// Frostburn has hard-locked repeatedly (five confirmed SPCC NVMe controller
// hangs through 2026-09-09). Attributing each one meant hand-reading a pstore
// dump, and most retained dumps are empty, so several crashes are permanently
// unattributable. `attributePanic` automates the reading that was being done by
// hand; `parseKmsgFaults` counts the live precursors; `parseSmartLog` covers the
// ordinary wear-and-overheat case.
//
// A CAVEAT WORTH KEEPING: SMART on this box stayed pristine — media_errors 0,
// num_err_log_entries 0 — through all five hangs. A controller that stops
// answering never gets to log anything. So health fields are for genuine wear
// and heat; they will NOT predict a hang. Do not present them as if they will.

/** Cause returned by {@link attributePanic} when no known signature matched. */
export const CAUSE_UNKNOWN = 'unknown';
/** Cause: the storage controller stopped responding and took init down with it. */
export const CAUSE_NVME_HANG = 'nvme-controller-hang';
/** Cause: NULL deref in the amdgpu KFD SVM teardown path. */
export const CAUSE_AMDGPU_SVM = 'amdgpu-kfd-svm';

/**
 * Read one `label : value` integer out of an `nvme smart-log` dump.
 *
 * Values carry units the caller does not want (`31 °C (304 K)`, `100%`, `3%`),
 * so only the first integer after the colon is taken. Labels are anchored to the
 * start of a line and the colon must follow immediately, which is what keeps
 * `available_spare` from matching the `available_spare_threshold` line.
 *
 * @param {string} text Raw smart-log text.
 * @param {string} label Exact field label, e.g. `media_errors`.
 * @returns {number|null} The value, or null when the field is absent.
 */
function intField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped}[ \\t]*:[ \\t]*(-?\\d+)`, 'm'));
  return match ? parseInt(match[1], 10) : null;
}

/** Count non-overlapping matches of `re` in `text`. */
function count(text, re) {
  return (text.match(re) || []).length;
}

/**
 * Parse `nvme smart-log` output into normalized health fields.
 *
 * Every field is independently optional: a truncated log, a different firmware,
 * or a drive that omits a counter yields null for that field rather than a
 * fabricated zero. That distinction matters — reporting `unsafeShutdowns: 0` for
 * a drive whose log simply lacked the line is a falsely reassuring reading.
 *
 * @param {string} text Raw output of `nvme smart-log /dev/nvmeN`.
 * @returns {{criticalWarning:number|null, temperatureC:number|null,
 *   availableSparePct:number|null, availableSpareThresholdPct:number|null,
 *   percentageUsedPct:number|null, mediaErrors:number|null,
 *   numErrLogEntries:number|null, unsafeShutdowns:number|null,
 *   powerCycles:number|null, powerOnHours:number|null}}
 *   Normalized fields; null wherever the log did not say.
 */
export function parseSmartLog(text) {
  const t = typeof text === 'string' ? text : '';
  return {
    criticalWarning: intField(t, 'critical_warning'),
    temperatureC: intField(t, 'temperature'),
    availableSparePct: intField(t, 'available_spare'),
    availableSpareThresholdPct: intField(t, 'available_spare_threshold'),
    percentageUsedPct: intField(t, 'percentage_used'),
    mediaErrors: intField(t, 'media_errors'),
    numErrLogEntries: intField(t, 'num_err_log_entries'),
    unsafeShutdowns: intField(t, 'unsafe_shutdowns'),
    powerCycles: intField(t, 'power_cycles'),
    powerOnHours: intField(t, 'power_on_hours'),
  };
}

/**
 * Count the kernel-log signals that precede a storage lockup on this hardware.
 *
 * Ordered roughly by how much warning each one gives. `ioTimeout` is the
 * earliest (a ~30s NVMe command timeout) and `hungTask` the next (a task blocked
 * ≥122s); by the time `resetFailure` or `readOnlyRemount` appear the machine is
 * already lost. Note that in practice none of these reach journald, because
 * journald is writing to the disk that is disappearing — the caller must read
 * /dev/kmsg (the in-RAM ring buffer, needs CAP_SYSLOG) for these to ever be seen
 * live, and pstore for them to be seen after the fact.
 *
 * @param {string} text Kernel log text (from /dev/kmsg or a pstore dump).
 * @returns {{ioTimeout:number, hungTask:number, controllerNotReady:number,
 *   resetFailure:number, readOnlyRemount:number, total:number}}
 *   Per-signal counts plus their sum. All zero is the healthy, normal state.
 */
export function parseKmsgFaults(text) {
  const t = typeof text === 'string' ? text : '';
  const counts = {
    ioTimeout: count(t, /nvme[^\n]*timeout/gi),
    hungTask: count(t, /blocked for more than \d+ seconds/g),
    controllerNotReady: count(t, /Device not ready; aborting reset/g),
    resetFailure: count(t, /Disabling device after reset failure/g),
    readOnlyRemount: count(t, /Remounting filesystem read-only/g),
  };
  return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/**
 * Classify a kernel panic dump by cause.
 *
 * Two causes have been confirmed on this hardware and they share a fingerprint —
 * the kernel log stops mid-stream and a panic follows minutes later with nothing
 * in between — so the shared fingerprint discriminates nothing. Only these
 * markers do. Validated against the real 2026-09-09 dump, which scores 12 NVMe
 * markers against 0 amdgpu.
 *
 * The amdgpu side deliberately keys on specific symbols rather than the bare
 * string "amdgpu": a storage panic's call trace can mention the graphics driver
 * incidentally, and misfiling an NVMe hang as a GPU fault is precisely the
 * misdiagnosis that cost this project a previous investigation.
 *
 * An empty or unrecognized dump returns {@link CAUSE_UNKNOWN}. Most retained
 * dumps on this box are empty shells, and "unknown" is the honest reading —
 * never fold them into whichever cause was seen last.
 *
 * @param {string} text Decompressed pstore dmesg text.
 * @returns {{cause:string, markers:{nvme:number, amdgpu:number}}}
 *   The classification and the marker counts it rests on, so a caller can show
 *   its evidence rather than asking to be trusted.
 */
export function attributePanic(text) {
  const t = typeof text === 'string' ? text : '';
  const markers = {
    nvme: count(t, /Disabling device after reset failure|Device not ready; aborting reset|Read-error on swap-device/g),
    amdgpu: count(t, /amdgpu_hmm_range_valid|svm_range|kfd_/g),
  };
  let cause = CAUSE_UNKNOWN;
  if (markers.nvme > markers.amdgpu) cause = CAUSE_NVME_HANG;
  else if (markers.amdgpu > markers.nvme) cause = CAUSE_AMDGPU_SVM;
  return { cause, markers };
}
