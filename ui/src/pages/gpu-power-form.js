// Llama Manager — GPU power-cap schedule form state mapping.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Converts the stored `gpuPower` setting (see api/gpu-power.js) into the text
// fields the Settings > GPUs power-cap form edits, and the form back into the
// body POST /api/settings expects. Validation stays on the server, which knows
// the card's own power range; this module only shapes values.

/** Day keys, in the order the form shows them; identical to the server's. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Builds editable form state from the stored setting.
 * @param {object|undefined} gpuPower Stored `settings.gpuPower`.
 * @returns {{enabled: boolean, defaultWatts: string, timezone: string, windows: Array<{start: string, end: string, watts: string, days: string[]}>}}
 *   An empty `days` list means every day.
 */
export function formFromSettings(gpuPower) {
  const g = gpuPower || {};
  return {
    enabled: !!g.enabled,
    defaultWatts: g.defaultWatts == null ? '' : String(g.defaultWatts),
    timezone: g.timezone || '',
    windows: (g.windows || []).map((w) => ({
      start: w.start, end: w.end, watts: String(w.watts), days: w.days ? [...w.days] : [],
    })),
  };
}

/**
 * Builds the `gpuPower` body for POST /api/settings from form state.
 * @param {ReturnType<typeof formFromSettings>} form Form state.
 * @returns {{enabled: boolean, defaultWatts: number|null, timezone: string, windows: Array<object>}}
 */
export function bodyFromForm(form) {
  const watts = (v) => (String(v).trim() === '' ? null : Number(v));
  return {
    enabled: form.enabled,
    defaultWatts: watts(form.defaultWatts),
    timezone: form.timezone.trim(),
    windows: form.windows.map((w) => ({
      start: w.start, end: w.end, watts: watts(w.watts), ...(w.days.length ? { days: w.days } : {}),
    })),
  };
}
