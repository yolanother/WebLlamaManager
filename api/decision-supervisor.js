// Llama Manager — System 1 decision engine (laya-server) supervisor.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Dependency-injected, lazily started supervisor for the single laya-server
// Podman container behind the DECISION engine. ensureStarted() creates the
// weights cache dir, removes a stale container left by a crash, spawns
// `podman run` in the foreground (the child's lifetime is the container's), and
// polls GET /healthz until the weights are loaded or startTimeoutSec expires.
// Concurrent callers share one start. touch() records use and re-arms an idle
// timer; when it fires the container is stopped, and the next request starts it
// again. No auto-restart: an exit simply marks the engine down. All I/O (spawn,
// podman one-shots, fetch, clock, timers, mkdir) is injected for tests.

import { mkdirSync } from 'fs';
import { DECISION_CONTAINER_NAME, podmanRunArgs } from './decision.js';

/**
 * Create the decision engine supervisor.
 * @param {object} deps
 * @param {Function} deps.spawn child_process.spawn-compatible.
 * @param {(args:string[]) => Promise<void>} deps.runPodman Run a one-shot podman command.
 * @param {Function} [deps.fetchFn] fetch-compatible, used for /healthz.
 * @param {() => object} deps.getConfig Returns resolveDecisionConfig(...).
 * @param {string} deps.cacheDir Host weights cache dir mounted at /data.
 * @param {(dir:string) => void} [deps.ensureDir]
 * @param {() => number} [deps.now]
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 * @param {Function} [deps.setTimeoutFn]
 * @param {Function} [deps.clearTimeoutFn]
 * @param {(msg:string) => void} [deps.log]
 * @returns {{ensureStarted:() => Promise<void>, touch:() => void, stop:() => Promise<void>,
 *   status:() => {running:boolean, healthy:boolean, startedAt:number|null, lastUsedAt:number|null, lastError:string|null}}}
 */
export function createDecisionSupervisor({
  spawn,
  runPodman,
  fetchFn = fetch,
  getConfig,
  cacheDir,
  ensureDir = (dir) => mkdirSync(dir, { recursive: true }),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = () => {},
}) {
  let proc = null;
  let healthy = false;
  let starting = null;
  let idleTimer = null;
  let startedAt = null;
  let lastUsedAt = null;
  let lastError = null;

  /** One /healthz probe; any failure reads as not ready. */
  async function probe(port) {
    try {
      const r = await fetchFn(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Spawn the container and wait for health; rejects on exit or timeout. */
  async function start(cfg) {
    ensureDir(cacheDir);
    await runPodman(['rm', '-f', DECISION_CONTAINER_NAME]).catch(() => {});
    const p = spawn('podman', podmanRunArgs(cfg, { cacheDir }), { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
    healthy = false;
    startedAt = now();
    lastError = null;
    p.stdout?.on('data', (d) => log(String(d)));
    p.stderr?.on('data', (d) => log(String(d)));
    p.on('exit', (code) => {
      if (proc !== p) return; // stopped or superseded
      proc = null;
      healthy = false;
      lastError = `laya-server exited with code ${code}`;
      log(lastError);
    });
    const deadline = now() + cfg.startTimeoutSec * 1000;
    while (now() < deadline) {
      if (proc !== p) throw new Error(lastError || 'laya-server stopped during start');
      if (await probe(cfg.port)) { healthy = true; return; }
      await sleep(1000);
    }
    await stop();
    lastError = `laya-server not healthy after ${cfg.startTimeoutSec}s`;
    throw new Error(lastError);
  }

  /** Start if needed (shared across concurrent callers), then mark use. */
  async function ensureStarted() {
    const cfg = getConfig();
    if (!cfg.runnable) throw new Error(`decision engine not runnable: ${cfg.reason}`);
    if (!(proc && healthy)) {
      if (!starting) starting = start(cfg).finally(() => { starting = null; });
      await starting;
    }
    touch();
  }

  /** Record use and re-arm the idle stop. */
  function touch() {
    lastUsedAt = now();
    if (idleTimer) clearTimeoutFn(idleTimer);
    idleTimer = setTimeoutFn(() => stop().catch(() => {}), getConfig().idleTimeoutSec * 1000);
    idleTimer?.unref?.();
  }

  /** Stop the container (no restart). Safe when nothing is running. */
  async function stop() {
    if (idleTimer) { clearTimeoutFn(idleTimer); idleTimer = null; }
    const p = proc;
    proc = null;
    healthy = false;
    if (!p) return;
    await runPodman(['stop', '-t', '10', DECISION_CONTAINER_NAME]).catch(() => {});
    if (!p.killed) p.kill('SIGTERM');
  }

  /** Snapshot for /api/decision/status and the server registry. */
  function status() {
    return { running: !!proc, healthy, startedAt, lastUsedAt, lastError };
  }

  return { ensureStarted, touch, stop, status };
}
