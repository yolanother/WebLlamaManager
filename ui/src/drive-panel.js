// Llama Manager — storage panel view model.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Turns the `drives[]` and `storageHealth` keys of the stats payload into drive
// tiles, operator alerts, and a plain-language last-crash readout. Pure, so
// failure states — an overheating drive, a wedged controller, an empty panic
// dump — are testable on a machine where none of them is happening.
//
// THE RULE THIS MODULE ENFORCES
// A storage readout must never err toward reassurance. Health fields are null
// when the privileged snapshot has not collected them, and `null > 0` is false
// in JavaScript — so a naive threshold check renders an *uncollected* drive as
// spotless. Every predicate here therefore tests for a real number first.
// Unknown reads as unknown. That distinction is the whole point of the panel.

/** NVMe temperature at which a drive is called out. NVMe self-throttles near here. */
export const DRIVE_WARN_C = 70;

/** Human labels for the panic causes `attributePanic` can return. */
const CAUSE_LABELS = {
  'nvme-controller-hang': 'Storage controller hang',
  'amdgpu-kfd-svm': 'GPU driver fault (amdgpu KFD SVM)',
};

/** True only for a real number — null/undefined/NaN are "not collected". */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A drive's display name. Model, never the node — nvmeXnY is not stable across boots. */
function driveTitle(drive) {
  return drive.model || drive.name || 'Drive';
}

/**
 * Build one tile per drive.
 *
 * @param {object} stats The stats payload.
 * @returns {Array<{key:string, title:string, detail:string, temperature:number|null,
 *   known:boolean}>} Tiles, empty when the machine reports no drives.
 */
export function resolveDrivePanel(stats) {
  const drives = Array.isArray(stats?.drives) ? stats.drives : [];
  return drives.map((d) => {
    const known = d.smartAvailable === true && num(d.percentageUsedPct);
    const parts = [];
    if (known) {
      parts.push(`${d.percentageUsedPct}% used`);
      if (num(d.powerOnHours)) parts.push(`${d.powerOnHours.toLocaleString()} h`);
      if (num(d.unsafeShutdowns) && d.unsafeShutdowns > 0) parts.push(`${d.unsafeShutdowns} unsafe stops`);
    } else {
      // Not "0% used". The privileged helper has not reported on this drive, and
      // saying so is more useful than a figure that looks like a clean result.
      parts.push('health unknown');
    }
    return {
      key: d.serial || d.name,
      title: driveTitle(d),
      detail: parts.join(' · '),
      temperature: num(d.temperatureC) ? d.temperatureC : null,
      known,
    };
  });
}

/**
 * Operator-facing alerts, most severe first.
 *
 * Live controller faults outrank everything: they are the only signals that
 * actually precede a lockup on this hardware, and when they appear the machine
 * may be minutes from going down. SMART wear indicators rank below them because
 * they move over months — and, as this box proved across five controller hangs,
 * stay perfectly clean right up to the failure.
 *
 * @param {object} stats The stats payload.
 * @returns {Array<{severity:'error'|'warning', message:string}>} Alerts, possibly empty.
 */
export function resolveDriveAlerts(stats) {
  const alerts = [];
  const health = stats?.storageHealth || null;
  const faults = health?.faults || null;

  if (faults && num(faults.total) && faults.total > 0) {
    const named = ['ioTimeout', 'hungTask', 'controllerNotReady', 'resetFailure', 'readOnlyRemount']
      .filter((k) => num(faults[k]) && faults[k] > 0);
    alerts.push({
      severity: 'error',
      message: `Storage controller faults detected (${named.join(', ')}) — the machine may be about to lock up.`,
    });
  }

  for (const d of Array.isArray(stats?.drives) ? stats.drives : []) {
    const name = driveTitle(d);
    if (num(d.criticalWarning) && d.criticalWarning !== 0) {
      alerts.push({ severity: 'error', message: `${name}: SMART critical warning (0x${d.criticalWarning.toString(16)}).` });
    }
    if (num(d.mediaErrors) && d.mediaErrors > 0) {
      // The healthy value is exactly zero, so one is already meaningful.
      alerts.push({ severity: 'error', message: `${name}: ${d.mediaErrors} media error(s).` });
    }
    if (num(d.availableSparePct) && num(d.availableSpareThresholdPct)
        && d.availableSparePct <= d.availableSpareThresholdPct) {
      alerts.push({ severity: 'error', message: `${name}: spare blocks down to ${d.availableSparePct}% (threshold ${d.availableSpareThresholdPct}%).` });
    }
    if (num(d.temperatureC) && d.temperatureC > DRIVE_WARN_C) {
      alerts.push({ severity: 'warning', message: `${name}: ${d.temperatureC}°C.` });
    }
  }

  if (health?.stale === true) {
    alerts.push({ severity: 'warning', message: 'Storage health snapshot is stale — figures below may be out of date.' });
  }
  return alerts;
}

/**
 * The last recorded kernel panic, in language an operator can act on.
 *
 * Reports an unattributed dump as unattributed. Most retained dumps on this box
 * are empty shells, and inferring a cause from one is precisely the misstep that
 * sent an earlier investigation chasing the GPU for weeks.
 *
 * @param {object} stats The stats payload.
 * @returns {{label:string, cause:string, isoTime:string|null}|null} Null if never panicked.
 */
export function resolveLastCrash(stats) {
  const panic = stats?.storageHealth?.lastPanic;
  if (!panic) return null;
  const label = CAUSE_LABELS[panic.cause]
    || (panic.hasDump === false ? 'Crash recorded, no dump retained' : 'Cause unknown');
  return { label, cause: panic.cause, isoTime: panic.isoTime ?? null };
}
