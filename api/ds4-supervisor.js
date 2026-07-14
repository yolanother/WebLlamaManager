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
// shared restart governor (debounce + circuit breaker), and on stop kills the
// process plus frees the ds4 port via an injected external-kill hook. All I/O
// (spawn, fetch, timers, sleeps, external kill) is injected so tests can drive the
// machine deterministically.

import { resolveDs4Config, resolveDs4ModelPath } from './engines.js';

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
 * @returns {{start:Function, stop:Function, restart:Function, health:Function,
 *   isRunning:Function, getPid:Function, getActivePreset:Function}}
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
}) {
  let proc = null;
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

  /**
   * Build the launch environment for start-ds4.sh from the resolved ds4 config
   * and the preset's model/context and ds4 launch knobs (under preset.config).
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
      if (!isRunning() && !intentionalStop) start(activePreset, { isAutoRestart: true });
    }, 3000);
  }

  /**
   * Spawn the ds4 server for `preset`. Idempotent: a no-op if already running.
   * @param {object} [preset] Defaults to the last active preset (used by auto-restart).
   * @returns {object|undefined} the spawned child, or undefined when skipped.
   */
  function start(preset = activePreset, { isAutoRestart = false } = {}) {
    if (!preset) {
      log('[ds4] start called with no preset; ignoring');
      return;
    }
    activePreset = preset;
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
    const ds4 = resolveDs4Config(getConfig() || {}, env);
    log(`[ds4] Starting ds4-server on :${ds4.port} (preset: ${preset.id})`);
    addLog('system', `Starting ds4-server on :${ds4.port} (preset: ${preset.id})`);
    child.stdout?.on('data', (d) => addLog('ds4', d));
    child.stderr?.on('data', (d) => addLog('ds4', d));
    child.on('exit', (code) => {
      if (proc !== child) return; // superseded; ignore late exit
      log(`[ds4] ds4-server exited (code ${code})`);
      const wasIntentional = intentionalStop;
      proc = null;
      if (wasIntentional) return;
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
   */
  async function stop() {
    intentionalStop = true;
    const child = proc;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await sleep(1500);
      if (child && !child.killed) child.kill('SIGKILL');
    }
    proc = null;
    await runKill();
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
      await stop();
      intentionalStop = false;
      start(preset);
    } finally {
      restartInProgress = false;
    }
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

  return { start, stop, restart, health, isRunning, getPid, getActivePreset };
}
