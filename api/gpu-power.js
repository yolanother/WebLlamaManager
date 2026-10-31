/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * GPU power-cap schedule for discrete NVIDIA cards. Validates the `gpuPower`
 * setting (a default cap plus optional time windows that allow a different cap,
 * evaluated in an IANA timezone), resolves which cap applies at an instant and
 * when it next changes, parses nvidia-smi power readings, and runs the
 * controller that enforces the cap: it touches the card only when the target
 * differs from the current power.limit, clamps to the card's own range, logs
 * every change, and falls back to the default cap when the schedule cannot be
 * evaluated. The privileged write itself is injected (see server.js), so this
 * module never needs root and is fully testable with a fake nvidia-smi. Also
 * holds the two access guards server.js applies: the strict unit-name builder
 * for the root oneshot, and the foreign-Origin (CSRF) check.
 */

/** Day keys in JavaScript getDay() order. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Fields asked of nvidia-smi, in the order parsePowerQuery expects them. */
export const POWER_QUERY_ARGS = [
  '--query-gpu=uuid,name,power.limit,power.min_limit,power.max_limit,power.draw',
  '--format=csv,noheader,nounits',
];

/** Generic sanity ceiling for a cap when the card's own range is unknown. */
const MAX_PLAUSIBLE_WATTS = 2000;
/** Minutes scanned for the next change: a week repeats, so 8 days is exhaustive. */
const NEXT_CHANGE_SCAN_MINUTES = 8 * 24 * 60;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

/**
 * Resolves an empty timezone to the system one and checks it is a real IANA name.
 * @param {string} timezone IANA name, or '' for the system timezone.
 * @returns {string} The effective timezone name.
 * @throws {RangeError} When the name is not a known timezone.
 */
function effectiveTimezone(timezone) {
  if (!timezone) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
}

/**
 * Local weekday and minute-of-day of an instant in a timezone.
 * @param {number} ms Epoch milliseconds.
 * @param {string} timezone Effective IANA timezone.
 * @returns {{day: number, minute: number}} day is 0 (Sunday) .. 6.
 */
function localTime(ms, timezone) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
    formatters.set(timezone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    day: WEEKDAYS.indexOf(parts.weekday.slice(0, 3).toLowerCase()),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** @param {string} hhmm "HH:MM". @returns {number} Minutes after midnight. */
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Whether a window covers a local day/minute. `days` names the day a window
 * STARTS on, so a 22:00-06:00 Friday window also covers Saturday 00:00-05:59.
 * A window whose start equals its end lasts a full 24 hours.
 * @param {{start: string, end: string, days?: string[]}} w Window.
 * @param {number} day Local weekday 0..6.
 * @param {number} minute Local minute of day.
 * @returns {boolean}
 */
function covers(w, day, minute) {
  const s = toMinutes(w.start);
  const e = toMinutes(w.end);
  const on = (d) => !w.days || w.days.includes(WEEKDAYS[d]);
  if (s < e) return on(day) && minute >= s && minute < e;
  return (on(day) && minute >= s) || (on((day + 6) % 7) && minute < e);
}

/**
 * The cap in force at one local day/minute: the highest-watts covering window,
 * else the default.
 * @returns {{watts: number, window: object|null}}
 */
function capAt(settings, day, minute) {
  let best = null;
  (settings.windows || []).forEach((w, index) => {
    if (covers(w, day, minute) && (!best || w.watts > best.watts)) best = { index, ...w };
  });
  return best ? { watts: best.watts, window: best } : { watts: settings.defaultWatts, window: null };
}

/**
 * Resolves the cap the schedule wants at an instant, and when it next changes.
 *
 * @param {{defaultWatts: number, timezone?: string, windows?: Array<object>}} settings Normalized setting.
 * @param {Date} [now] The instant to evaluate.
 * @returns {{watts: number, window: object|null, timezone: string, nextChange: {at: string, watts: number}|null}}
 *   `window` carries its `index` in the windows list.
 * @throws {RangeError} When the timezone is unknown (callers fall back to the default cap).
 */
export function resolveGpuPowerTarget(settings, now = new Date()) {
  const timezone = effectiveTimezone(settings.timezone);
  const t = now.getTime();
  const { day, minute } = localTime(t, timezone);
  const current = capAt(settings, day, minute);
  let nextChange = null;
  if ((settings.windows || []).length) {
    // ponytail: minute-by-minute scan (~40 ms per call); exact across DST jumps.
    // Replace with boundary arithmetic if it ever shows up in a profile.
    const first = Math.floor(t / 60000) * 60000 + 60000;
    for (let i = 0; i < NEXT_CHANGE_SCAN_MINUTES; i++) {
      const ms = first + i * 60000;
      const local = localTime(ms, timezone);
      const cap = capAt(settings, local.day, local.minute);
      if (cap.watts !== current.watts) {
        nextChange = { at: new Date(ms).toISOString(), watts: cap.watts };
        break;
      }
    }
  }
  return { watts: current.watts, window: current.window, timezone, nextChange };
}

/**
 * Checks a watts value is a positive integer inside the card range (when known).
 * @throws {Error} Naming the field and the allowed range.
 */
function checkWatts(value, field, limits) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_PLAUSIBLE_WATTS) {
    throw new Error(`${field} must be a whole number of watts between 1 and ${MAX_PLAUSIBLE_WATTS}`);
  }
  if (limits && Number.isFinite(limits.min) && Number.isFinite(limits.max)
      && (value < limits.min || value > limits.max)) {
    throw new Error(`${field} ${value} W is outside this card's range ${limits.min}-${limits.max} W`);
  }
}

/**
 * Validates and normalizes a `gpuPower` setting.
 *
 * @param {object} input Raw setting from the API or config.json.
 * @param {{limits?: {min: number, max: number}|null}} [options] Card range to validate against.
 * @returns {{enabled: boolean, defaultWatts: number|null, timezone: string, windows: Array<object>}}
 * @throws {Error} With a message naming the offending field, suitable for a 400.
 */
export function normalizeGpuPowerSettings(input, { limits = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('gpuPower must be an object');
  }
  const enabled = input.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new Error('gpuPower.enabled must be true or false');

  const defaultWatts = input.defaultWatts ?? null;
  if (defaultWatts === null) {
    if (enabled) throw new Error('gpuPower.defaultWatts is required when the schedule is enabled');
  } else {
    checkWatts(defaultWatts, 'gpuPower.defaultWatts', limits);
  }

  const timezone = input.timezone ?? '';
  if (typeof timezone !== 'string') throw new Error('gpuPower.timezone must be an IANA timezone name');
  try {
    effectiveTimezone(timezone);
  } catch {
    throw new Error(`gpuPower.timezone "${timezone}" is not a known IANA timezone`);
  }

  const rawWindows = input.windows ?? [];
  if (!Array.isArray(rawWindows)) throw new Error('gpuPower.windows must be an array');
  const windows = rawWindows.map((w, i) => {
    const field = `gpuPower.windows[${i}]`;
    if (!w || typeof w !== 'object') throw new Error(`${field} must be an object`);
    for (const key of ['start', 'end']) {
      if (typeof w[key] !== 'string' || !HHMM.test(w[key])) throw new Error(`${field}.${key} must be "HH:MM" (00:00-23:59)`);
    }
    checkWatts(w.watts, `${field}.watts`, limits);
    const out = { start: w.start, end: w.end, watts: w.watts };
    if (w.days !== undefined && w.days !== null) {
      const days = Array.isArray(w.days) ? w.days.map((d) => String(d).toLowerCase()) : null;
      if (!days || days.length === 0 || days.some((d) => !WEEKDAYS.includes(d))) {
        throw new Error(`${field}.days must be a non-empty list of ${WEEKDAYS.join(', ')}`);
      }
      out.days = days;
    }
    return out;
  });

  return { enabled, defaultWatts, timezone, windows };
}

/**
 * Builds the privileged unit name for a cap, refusing anything but an integer
 * inside the card's own range. This is the last check before a root action, so
 * it does not trust the caller to have validated: a value that reached here
 * malformed must not become part of a unit name.
 * @param {number} watts Cap to apply.
 * @param {{min: number, max: number}|null} range The cards' common min/max.
 * @returns {string} `llama-manager-gpu-power@<watts>.service`.
 * @throws {Error} When watts is not an integer in range, or the range is unknown.
 */
export function gpuPowerUnitName(watts, range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    throw new Error('refusing to set a power cap while the card range is unknown');
  }
  if (!Number.isInteger(watts) || watts < range.min || watts > range.max) {
    throw new Error(`refusing to set ${String(watts)} watts: not an integer within ${range.min}-${range.max} W`);
  }
  return `llama-manager-gpu-power@${watts}.service`;
}

/**
 * Whether a request carries a browser Origin other than the manager's own. A
 * page on another origin (or an opaque "null" origin) must not change or read
 * the power schedule through the visitor's browser; curl and the CLI send no
 * Origin and are unaffected.
 * @param {{headers: Record<string, string|undefined>}} req Incoming request.
 * @returns {boolean} True when an Origin is present and its host differs from Host.
 */
export function isForeignOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * Parses `nvidia-smi` output produced with POWER_QUERY_ARGS.
 * @param {string} stdout CSV without header or units.
 * @returns {Array<{uuid: string, name: string, limit: number|null, min: number|null, max: number|null, draw: number|null}>}
 */
export function parsePowerQuery(stdout) {
  const num = (v) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  return String(stdout).split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [uuid, name, limit, min, max, draw] = line.split(',').map((s) => s.trim());
    return { uuid, name, limit: num(limit), min: num(min), max: num(max), draw: num(draw) };
  });
}

/**
 * Creates the enforcement loop. Call tick() on start, after a settings change,
 * and every minute; each tick reads the cards, resolves the target, and applies
 * it only when a card's limit differs. Ticks are serialized.
 *
 * @param {object} deps
 * @param {() => object|undefined} deps.getSettings Current `gpuPower` setting.
 * @param {() => Promise<string>} deps.run Runs nvidia-smi with POWER_QUERY_ARGS; rejects when absent.
 * @param {(watts: number) => Promise<void>} deps.apply Privileged write of the cap to every NVIDIA card.
 * @param {(line: string) => void} deps.log Change/error log sink.
 * @param {() => Date} [deps.now] Clock.
 * @returns {{tick: (reason: string) => Promise<object>, status: () => object, limits: () => {min: number, max: number}|null}}
 */
export function createGpuPowerController({ getSettings, run, apply, log, now = () => new Date() }) {
  let status = { enabled: false, available: null, reason: 'not checked yet' };
  let range = null;
  let lastChange = null;
  let lastError = null;
  let chain = Promise.resolve();

  async function evaluate(reason) {
    const settings = getSettings() || {};
    const base = {
      enabled: !!settings.enabled,
      defaultWatts: settings.defaultWatts ?? null,
      windows: settings.windows || [],
      checkedAt: now().toISOString(),
    };

    let cards;
    try {
      cards = parsePowerQuery(await run());
    } catch (err) {
      return { ...base, available: false, reason: `nvidia-smi not available (${err.code || err.message})`, cards: [] };
    }
    const known = cards.filter((c) => c.min !== null && c.max !== null);
    range = known.length
      ? { min: Math.max(...known.map((c) => c.min)), max: Math.min(...known.map((c) => c.max)) }
      : null;
    const view = {
      ...base,
      available: cards.length > 0,
      reason: cards.length ? null : 'no NVIDIA GPU found',
      range,
      cards: cards.map((c) => ({ uuid: c.uuid, name: c.name, limitWatts: c.limit, minWatts: c.min, maxWatts: c.max, drawWatts: c.draw })),
    };
    if (!cards.length || !settings.enabled) return { ...view, lastChange, lastError };

    let resolved;
    try {
      resolved = resolveGpuPowerTarget(settings, now());
      lastError = null;
    } catch (err) {
      // Fail safe: an unreadable schedule never leaves a window's higher cap in place.
      lastError = `schedule could not be evaluated, using the default cap: ${err.message}`;
      resolved = { watts: settings.defaultWatts, window: null, timezone: settings.timezone || null, nextChange: null };
    }
    let target = resolved.watts;
    if (range) target = Math.min(Math.max(target, range.min), range.max);

    const stale = cards.filter((c) => c.limit === null || Math.round(c.limit) !== target);
    if (stale.length) {
      const old = stale.map((c) => (c.limit === null ? '?' : Math.round(c.limit))).join('/');
      const why = resolved.window
        ? `window ${resolved.window.index} ${resolved.window.start}-${resolved.window.end}`
        : 'default';
      try {
        await apply(target);
        // nvidia-smi accepted it, so the readout shows the new limit, not the pre-apply one.
        for (const c of view.cards) c.limitWatts = target;
        lastChange = { at: now().toISOString(), from: old, to: target, reason, window: resolved.window };
        log(`GPU power cap ${old} W -> ${target} W (${reason}; ${why})`);
      } catch (err) {
        lastError = `could not set ${target} W: ${err.message}`;
        log(`GPU power cap change ${old} W -> ${target} W failed (${reason}; ${why}): ${err.message}`);
      }
    }
    return {
      ...view,
      timezone: resolved.timezone,
      targetWatts: target,
      activeWindow: resolved.window,
      nextChange: resolved.nextChange,
      lastChange,
      lastError,
    };
  }

  return {
    tick(reason) {
      const next = chain.then(() => evaluate(reason)).then((s) => { status = s; return s; });
      chain = next.catch(() => {});
      return next;
    },
    status: () => status,
    limits: () => range,
  };
}
