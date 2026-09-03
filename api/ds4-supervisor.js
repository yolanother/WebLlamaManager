// Llama Manager — ds4-server process supervisor (DeepSeek V4 Flash engine).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// A dependency-injected supervisor for the ds4-server process, modeled on the
// existing embed-server supervisor in server.js but extracted into its own module
// so its start/stop/restart/exit→restart state machine is unit-testable without
// booting the HTTP server. Owns a single ds4-server child process: spawns it via
// start-ds4.sh with the ds4 launch env (bin, port, model resolved under the ds4
// ggufDir, ctx, power, KV-disk cache flags), probes readiness/health against ds4's
// GET /v1/models (ds4 has NO /health), auto-restarts on unexpected exit through the
// shared restart governor (debounce + circuit breaker), and on owned stop kills
// the process plus frees the ds4 port via an injected external-kill hook. A
// supervisor that never spawned DS4 performs no host-wide cleanup. All I/O
// (spawn, fetch, timers, sleeps, external kill) is injected so tests can drive the
// machine deterministically. Also buffers the process's last output lines and
// attaches them (via addLog, not just console) to the exit log line, since a
// non-zero exit was previously undiagnosable after the fact — see the
// RECENT_OUTPUT_LINES constant below.

import { resolveDs4Config, resolveDs4ModelPath } from './engines.js';

/** How many trailing stdout/stderr lines to keep and attach to the exit log
 *  line — enough to catch a CLI arg-parse error message (ds4-server's own
 *  exit(2) reason) without accumulating unbounded output for a long-lived
 *  process. */
const RECENT_OUTPUT_LINES = 20;

/**
 * Create a ds4-server supervisor.
 *
 * @param {object} deps
 * @param {Function} deps.spawn Node child_process spawn (or a fake). Signature (cmd, args, opts) → ChildProcess.
 * @param {Function} [deps.fetchFn] fetch implementation for the health probe.
 * @param {Function} deps.getConfig () => parsed config.json (read fresh each call).
 * @param {object} [deps.env] Environment object merged into the child's env.
 * @param {string} deps.projectRoot Absolute repo root (holds start-ds4.sh).
 * @param {Function} deps.restartDecision Pure governor decision fn (from restart-governor.js).
 * @param {object} [deps.restartDefaults] Governor default knobs.
 * @param {Function} [deps.log] console-style logger.
 * @param {Function} [deps.addLog] UI log sink (channel, msg).
 * @param {Function} [deps.runKill] async () => void — host-side pkill of ds4-server + free the port.
 * @param {Function} [deps.getWedged] () => boolean — true when the exec/GPU layer is wedged
 *   (un-killable D-state). Forwarded to the shared restart governor so ds4 auto-restarts honor
 *   the wedged-GPU hold (probing a locked GPU with a fresh 81GB load would freeze the host).
 * @param {Function} [deps.now] () => ms clock (Date.now).
 * @param {Function} [deps.sleep] async (ms) => void — grace delay between SIGTERM and SIGKILL.
 * @param {Function} [deps.setTimeoutFn] setTimeout (or a fake) for scheduling auto-restart.
 * @param {Function} [deps.onRestartBegin] () => void, called the instant a restart the
 *   REQUEST-triggered activation flow does not know about is about to happen — a
 *   crash-driven auto-restart, or an explicit restart() (e.g. the ds4 auto-updater).
 *   server.js's activateDs4Exclusive/deactivateDs4Exclusive gate concurrent requests on
 *   its own ds4SwapPromise, but neither of THOSE restarts ever touched it: currentEngine
 *   stays ds4 throughout, so the gate stayed a no-op and requests were routed straight at
 *   a ds4-server that was mid-restart (not yet holding the model), landing a raw
 *   "model not found" instead of queueing. server.js wires this hook to arm the same gate.
 * @returns {{start:Function, stop:Function, restart:Function, health:Function,
 *   isRunning:Function, getPid:Function, getActivePreset:Function,
 *   getActiveOverride:Function, endPlan:Function}}
 */
export function createDs4Supervisor({
  spawn,
  fetchFn = fetch,
  getConfig,
  env = {},
  projectRoot,
  restartDecision,
  restartDefaults = {},
  log = () => {},
  addLog = () => {},
  runKill = async () => {},
  getWedged = () => false,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeoutFn = setTimeout,
  onRestartBegin = () => {},
}) {
  let proc = null;
  let ownsEngine = false;
  let activePreset = null;
  let intentionalStop = false;
  let restartInProgress = false;
  let restartHistory = [];
  // Load-failure circuit breaker: ds4 OOMing at the ~80GB weight-load tail exits
  // non-zero WITHOUT ever serving /v1/models. Re-loading the same 80GB with the same
  // config just OOMs again (slow restart-thrash). `sawReady` flips true once health
  // reports ok; a non-zero exit while still !sawReady counts a load failure, and we
  // stop auto-restarting after `ds4MaxLoadFailures` consecutive ones. Reset on a
  // fresh (non-auto) activation and on a successful serve.
  let sawReady = false;
  let consecutiveLoadFailures = 0;
  // Adaptive activation: the exclusive-DS4 controller (server.js) drives a ladder of
  // load attempts (context step-down → SSD-streaming fallback). While a plan is in
  // progress the CONTROLLER owns retries, so an exit must NOT trigger the supervisor's
  // own auto-restart or circuit breaker. `activeOverride` carries the per-attempt
  // context + streaming config into buildEnv; endPlan() locks in the SETTLED config so
  // a later (post-settle) auto-restart reuses what actually worked.
  let planInProgress = false;
  let activeOverride = null;

  /** @returns {boolean} whether the ds4 child is currently alive. */
  function isRunning() {
    return !!(proc && !proc.killed);
  }

  /** @returns {number|null} current child PID, or null. */
  function getPid() {
    return proc?.pid ?? null;
  }

  /** @returns {object|null} the preset the ds4 server is serving (or last served). */
  function getActivePreset() {
    return activePreset;
  }

  /** @returns {object|null} the active per-attempt/settled ctx+streaming override, or null. */
  function getActiveOverride() {
    return activeOverride;
  }

  /**
   * Build the launch environment for start-ds4.sh from the resolved ds4 config
   * and the preset's model/context and ds4 launch knobs (under preset.config).
   * When an adaptive override is active it wins for context and drives the SSD
   * expert-streaming flags (DS4_SSD_STREAMING 0/1 + cache-experts size).
   */
  function buildEnv(preset) {
    const ds4 = resolveDs4Config(getConfig() || {}, env);
    const modelAbs = resolveDs4ModelPath(preset.modelPath || '', ds4.ggufDir);
    const pc = preset.config || {};
    const e = {
      ...env,
      DS4_SERVER_BIN: ds4.binPath,
      DS4_PORT: String(ds4.port),
      DS4_GGUF_DIR: ds4.ggufDir,
      DS4_CONTAINER: ds4.container,
      DS4_IN_DISTROBOX: ds4.runInDistrobox ? '1' : '0',
      DS4_MODEL: modelAbs,
      DS4_CTX: String(preset.context || 0),
    };
    // Adaptive override: the controller sets the per-attempt context + streaming.
    if (activeOverride) {
      if (activeOverride.context !== undefined && activeOverride.context !== null) {
        e.DS4_CTX = String(activeOverride.context);
      }
      if (activeOverride.ssdStreaming) {
        e.DS4_SSD_STREAMING = '1';
        const ce = activeOverride.cacheExperts || ds4.ssdStreamingCacheExperts;
        if (ce) e.DS4_SSD_STREAMING_CACHE_EXPERTS = String(ce);
      } else {
        e.DS4_SSD_STREAMING = '0';
      }
    }
    if (pc.power !== undefined && pc.power !== null && pc.power !== '') e.DS4_POWER = String(pc.power);
    if (pc.kvDiskDir) e.DS4_KV_DISK_DIR = String(pc.kvDiskDir);
    if (pc.kvDiskSpaceMb !== undefined && pc.kvDiskSpaceMb !== null && pc.kvDiskSpaceMb !== '') {
      e.DS4_KV_DISK_SPACE_MB = String(pc.kvDiskSpaceMb);
    }
    if (pc.extraSwitches) e.DS4_EXTRA_SWITCHES = String(pc.extraSwitches);
    return e;
  }

  /** Schedule a governed auto-restart after an unexpected exit. */
  function scheduleAutoRestart() {
    const knobs = { ...restartDefaults, ...(getConfig()?.guard?.restart || {}) };
    // Forward the wedged-GPU signal so a locked exec/GPU layer holds ds4 restarts
    // for the long wedgedCooldownMs (15m) instead of probing a fresh 81GB load
    // onto the locked GPU every cooldown — the same protection llama-server gets.
    const decision = restartDecision({ history: restartHistory, now: now(), wedged: !!getWedged(), ...knobs });
    if (!decision.allow) {
      log(`[ds4] auto-restart suppressed by governor (${decision.reason})`);
      addLog('system', `ds4-server restart suppressed (${decision.reason}); backing off`);
      return;
    }
    restartHistory = decision.history;
    setTimeoutFn(() => {
      if (!isRunning() && !intentionalStop) {
        onRestartBegin();
        start(activePreset, { isAutoRestart: true });
      }
    }, 3000);
  }

  /**
   * Spawn the ds4 server for `preset`. Idempotent: a no-op if already running.
   * @param {object} [preset] Defaults to the last active preset (used by auto-restart).
   * @param {object} [opts]
   * @param {boolean} [opts.isAutoRestart=false] Governed auto-restart (accumulates toward the breaker).
   * @param {boolean} [opts.planMode=false] Enter adaptive-plan mode: the controller drives retries,
   *   so an exit while a plan is in progress does NOT auto-restart or count a load failure here.
   * @param {object} [opts.override] Per-attempt context/streaming override for buildEnv
   *   ({ context, ssdStreaming, cacheExperts }). Passing it replaces the active override; omit it
   *   (e.g. on auto-restart) to reuse the settled override.
   * @returns {object|undefined} the spawned child, or undefined when skipped.
   */
  function start(preset = activePreset, { isAutoRestart = false, planMode = false, override = undefined } = {}) {
    if (!preset) {
      log('[ds4] start called with no preset; ignoring');
      return;
    }
    activePreset = preset;
    if (override !== undefined) activeOverride = override;
    if (planMode) planInProgress = true;
    if (isRunning()) return proc;
    intentionalStop = false;
    // A fresh (operator/user) activation gets a clean slate of load attempts; only
    // auto-restarts accumulate toward the circuit breaker.
    if (!isAutoRestart) consecutiveLoadFailures = 0;
    sawReady = false;

    const startScript = `${projectRoot}/start-ds4.sh`;
    const child = spawn('bash', [startScript], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildEnv(preset),
      detached: false,
    });
    proc = child;
    ownsEngine = true;
    const ds4 = resolveDs4Config(getConfig() || {}, env);
    log(`[ds4] Starting ds4-server on :${ds4.port} (preset: ${preset.id})`);
    addLog('system', `Starting ds4-server on :${ds4.port} (preset: ${preset.id})`);
    // Bounded trailing-line buffer for THIS attempt, so a crash's own stderr
    // (e.g. ds4-server's CLI arg-parser naming the bad flag) can be attached to
    // the exit log line below instead of vanishing once the process is gone.
    const recentLines = [];
    const captureOutput = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        recentLines.push(trimmed);
        if (recentLines.length > RECENT_OUTPUT_LINES) recentLines.shift();
      }
    };
    child.stdout?.on('data', (d) => { addLog('ds4', d); captureOutput(d); });
    child.stderr?.on('data', (d) => { addLog('ds4', d); captureOutput(d); });
    child.on('exit', (code) => {
      if (proc !== child) return; // superseded; ignore late exit
      const tail = recentLines.length
        ? ` — last output:\n${recentLines.join('\n')}`
        : ' — no stdout/stderr captured before exit';
      log(`[ds4] ds4-server exited (code ${code})${tail}`);
      addLog('system', `ds4-server exited (code ${code})${tail}`);
      const wasIntentional = intentionalStop;
      proc = null;
      if (wasIntentional) return;
      // During an adaptive plan the controller owns retries (context step-down / SSD
      // streaming fallback), so do NOT auto-restart or count a load failure here — the
      // controller advances to the next attempt itself. The breaker is the BACKSTOP
      // only after the plan settles (planInProgress cleared by endPlan()).
      if (planInProgress) {
        log('[ds4] ds4-server exited during adaptive plan; controller drives the next attempt');
        return;
      }
      // Load-failure circuit breaker: exited non-zero before ever serving = an OOM/
      // crash during the ~80GB load. Retrying the same config just thrashes, so stop
      // after ds4MaxLoadFailures consecutive load failures and surface the cause.
      if (!sawReady && code !== 0) {
        consecutiveLoadFailures++;
        const max = getConfig()?.guard?.ds4MaxLoadFailures ?? 2;
        if (consecutiveLoadFailures >= max) {
          log(`[ds4] ds4-server failed to load ${consecutiveLoadFailures}x without serving (exit ${code}, likely OOM at the weight-load tail); NOT auto-restarting. Lower ds4 context, free RAM, or drop the embed server, then re-activate.`);
          addLog('system', `ds4-server failed to load ${consecutiveLoadFailures}x (likely OOM before ready); auto-restart stopped. Lower ctx / free memory and re-activate.`);
          return;
        }
      }
      scheduleAutoRestart();
    });
    return child;
  }

  /**
   * Stop the ds4 server (no auto-restart). SIGTERM, grace, then SIGKILL, then a
   * host-side external kill to reap any container-side worker and free the port.
   *
   * Propagates runKill()'s confirmation rather than discarding it: a caller (the
   * adaptive plan's stopAttempt) needs to know whether the old process/port was
   * actually confirmed gone before it is safe to spawn a new ds4-server on top of
   * it — advancing regardless is how two engines end up fighting over the same
   * port and GPU. A runKill() that reports nothing (legacy/unknown) is treated as
   * confirmed, matching the prior behavior.
   * @returns {Promise<{ok:boolean, remainingPids:number[]}>}
   */
  async function stop() {
    intentionalStop = true;
    if (!ownsEngine) return { ok: true, remainingPids: [] };
    const child = proc;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await sleep(1500);
      if (child && !child.killed) child.kill('SIGKILL');
    }
    proc = null;
    const killed = await runKill();
    ownsEngine = false;
    return { ok: killed?.ok !== false, remainingPids: killed?.remainingPids || [] };
  }

  /**
   * Restart the ds4 server in place (used after model/preset change or by the
   * activate path). Serializes against itself.
   * @param {object} [preset] Defaults to the active preset.
   */
  async function restart(preset = activePreset) {
    if (restartInProgress) return;
    restartInProgress = true;
    try {
      onRestartBegin();
      await stop();
      intentionalStop = false;
      start(preset);
    } finally {
      restartInProgress = false;
    }
  }

  /**
   * Leave adaptive-plan mode. Called by the controller once the ladder settles (or is
   * exhausted). When a `settled` attempt is given, it becomes the active override so a
   * later post-settle auto-restart reuses the context + streaming config that actually
   * worked; an exhausted plan (settled=null) clears the override.
   * @param {object} [args]
   * @param {object|null} [args.settled] The settled { context, ssdStreaming, cacheExperts }, or null.
   */
  function endPlan({ settled = null } = {}) {
    planInProgress = false;
    activeOverride = settled
      ? { context: settled.context, ssdStreaming: !!settled.ssdStreaming, cacheExperts: settled.cacheExperts }
      : null;
  }

  /**
   * Probe ds4 health via GET /v1/models (ds4 has no /health).
   * @returns {Promise<{status:string, port:number, model:(string|null)}>}
   */
  async function health() {
    const ds4 = resolveDs4Config(getConfig() || {}, env);
    const model = activePreset?.id || null;
    if (!isRunning()) return { status: 'stopped', port: ds4.port, model };
    try {
      const r = await fetchFn(`http://127.0.0.1:${ds4.port}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { sawReady = true; consecutiveLoadFailures = 0; }
      return { status: r.ok ? 'ok' : 'error', port: ds4.port, model };
    } catch {
      return { status: 'unavailable', port: ds4.port, model };
    }
  }

  return { start, stop, restart, health, isRunning, getPid, getActivePreset, getActiveOverride, endPlan };
}
