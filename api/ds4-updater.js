// Llama Manager — ds4 auto-update pipeline (track upstream, rebuild, smoke, swap).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Keeps the local antirez/ds4 build current with github.com/antirez/ds4 without
// ever serving a broken binary. A dependency-injected state machine that: fetches
// upstream and compares origin/main against the commit our current build was made
// from (recorded in a small state file); when a new commit lands, rebuilds the
// strix-halo target OUT OF PLACE (a detached git worktree of the ds4 repo built in
// the ROCm-7rc container into a versioned builds/<commit>/ dir — never over the
// live binaries); smoke-tests the new binary against the real model (asserting a
// coherent completion + clean exit, and distinguishing a GGUF-incompatibility load
// failure from a generic smoke failure); and, only on success and only in an idle
// window, atomically flips a `current` symlink to the new build and restarts
// ds4-server through the supervised restart path so the restart governor sees it.
// A failed smoke keeps the last-known-good build and raises an alert; a model
// incompatibility raises a prominent "model may need re-download" alert with the
// upstream commit range. All GPU/IO (git, build, smoke, restart, fs, clock,
// idle-probe) is injected so the state machine + symlink-flip atomicity are
// unit-testable without a real GPU build or the 81GB model.
//
// LIVE VERIFICATION PENDING: the exact ds4 one-shot smoke flags and the make
// invocation are exercised end-to-end once in an operator maintenance window; the
// state machine, command construction, and swap atomicity are covered by unit
// tests.

import * as realFs from 'node:fs';

/** Terminal/interim results of an update cycle (surfaced via getStatus/apply). */
export const DS4_UPDATE_STATE = {
  UP_TO_DATE: 'up-to-date',           // upstream == built commit; nothing to do
  BUILDING: 'building',               // new commit found, build in progress
  SMOKE_FAILED: 'smoke-failed',       // built ok but the new binary failed smoke
  SWAPPED: 'swapped',                 // smoke ok, symlink flipped, ds4 restarted
  NEEDS_MODEL_REDOWNLOAD: 'needs-model-redownload', // new binary can't load the GGUF
  DEFERRED: 'deferred',               // built, but box busy — smoke+swap postponed
  ERROR: 'error',                     // build/git failure — no swap
};

/** A git object name is a 7–40 char lowercase hex string. We refuse to
 *  interpolate anything else into a shell command (defense-in-depth: the injected
 *  exec runs through a shell, and the commit originates from `git rev-parse`). */
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** Substrings in ds4 output that indicate a model/GGUF incompatibility (not a
 *  generic runtime failure). Kept conservative — a false positive only downgrades
 *  a smoke failure into a louder "re-download the model" alert. */
const MODEL_INCOMPAT_MARKERS = [
  /failed to load model/i,
  /unknown (tensor|architecture|arch|magic)/i,
  /unsupported (model|gguf|format|version)/i,
  /wrong number of tensors/i,
  /invalid (gguf|magic)/i,
  /tensor .* not found/i,
];

/**
 * Atomically repoint a `current` symlink at a completed build directory.
 * Creates a temporary symlink then renames it over the target — rename(2) over an
 * existing symlink is atomic on POSIX, so a reader either sees the old build or the
 * new one, never a partial state. On any failure the temp link is removed and the
 * pre-existing symlink is left untouched (last-known-good preserved).
 *
 * @param {object} args
 * @param {string} args.linkPath Absolute path of the `current` symlink to update.
 * @param {string} args.target   Absolute path of the completed build dir to point at.
 * @param {object} [args.fs]     fs implementation (defaults to node:fs).
 * @throws if `target` does not exist or the flip fails.
 */
export function atomicSymlinkSwap({ linkPath, target, fs = realFs }) {
  if (!fs.existsSync(target)) {
    throw new Error(`atomicSymlinkSwap: refusing to point ${linkPath} at missing target ${target}`);
  }
  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  fs.symlinkSync(target, tmp);
  try {
    fs.renameSync(tmp, linkPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Create the ds4 auto-updater.
 *
 * @param {object} deps
 * @param {Function} deps.exec async (cmd, opts?) => {code,stdout,stderr}. Never throws on nonzero exit.
 * @param {object}   [deps.fs] fs implementation (node:fs subset).
 * @param {Function} [deps.clock] () => ms clock (Date.now).
 * @param {Function} [deps.isIdle] () => boolean — true when no in-flight requests (safe to smoke+swap).
 * @param {Function} [deps.restartDs4] async () => void — supervised ds4-server restart (resolves the `current` symlink).
 * @param {Function} [deps.alert] (msg, meta?) => void — prominent alert sink for failures.
 * @param {Function} [deps.log] console-style logger.
 * @param {Function} [deps.addLog] UI log sink (channel, msg).
 * @param {object}   deps.paths { repoDir, stateDir, buildsDir, currentLink, statePath, modelPath }.
 * @param {string}   [deps.buildContainer] distrobox for building (rocwmma toolchain).
 * @param {string}   [deps.runContainer] distrobox for running/smoke (working HSA runtime).
 * @param {string}   [deps.smokePrompt] short prompt used for the smoke completion.
 * @param {number}   [deps.smokeTokens] max tokens for the smoke completion.
 * @param {number}   [deps.buildTimeoutMs] timeout for the build step.
 * @param {number}   [deps.smokeTimeoutMs] timeout for the smoke step.
 * @returns {{check:Function, apply:Function, runCycle:Function, getStatus:Function}}
 */
export function createDs4Updater({
  exec,
  fs = realFs,
  clock = () => Date.now(),
  isIdle = () => true,
  restartDs4 = async () => {},
  alert = () => {},
  log = () => {},
  addLog = () => {},
  paths,
  buildContainer = 'llama-rocm-7rc-rocwmma',
  runContainer = 'llama-rocm-7.2.4',
  smokePrompt = 'Reply with exactly one word: pong.',
  smokeTokens = 24,
  buildTimeoutMs = 30 * 60_000,
  smokeTimeoutMs = 15 * 60_000,
}) {
  const { repoDir, stateDir, buildsDir, currentLink, statePath, modelPath } = paths;
  const HISTORY_CAP = 20;

  // ── State file ────────────────────────────────────────────────────────────
  /** Read the persisted updater state, or a fresh default if none exists. */
  function readState() {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch {
      return {
        builtCommit: null, currentBuildDir: null, prevBuildDir: null,
        upstreamCommit: null, lastCheck: null, lastApply: null,
        lastResult: null, lastError: null, history: [],
      };
    }
  }

  /** Persist a patch onto the state file (merged over the current state). */
  function writeState(patch) {
    const next = { ...readState(), ...patch };
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(next, null, 2));
    } catch (err) {
      log(`[ds4-update] failed to persist state: ${err.message}`);
    }
    return next;
  }

  /** Append a capped history entry describing an update transition. */
  function pushHistory(entry) {
    const st = readState();
    const history = [...(st.history || []), { at: clock(), ...entry }].slice(-HISTORY_CAP);
    writeState({ history });
  }

  // ── Git check ───────────────────────────────────────────────────────────
  /**
   * Fetch upstream and compare origin/main against the built commit.
   * @returns {Promise<{ok:boolean, upToDate:boolean, builtCommit:(string|null), upstreamCommit:(string|null), error?:string}>}
   */
  async function check() {
    const st = readState();
    const builtCommit = st.builtCommit || null;
    const fetchRes = await exec(`git -C ${repoDir} fetch --quiet origin main`, { timeoutMs: 120_000 });
    if (fetchRes.code !== 0) {
      const error = `git fetch failed: ${(fetchRes.stderr || '').trim() || 'exit ' + fetchRes.code}`;
      writeState({ lastCheck: clock(), lastResult: DS4_UPDATE_STATE.ERROR, lastError: error });
      return { ok: false, upToDate: false, builtCommit, upstreamCommit: st.upstreamCommit || null, error };
    }
    const rev = await exec(`git -C ${repoDir} rev-parse origin/main`, { timeoutMs: 30_000 });
    const raw = (rev.stdout || '').trim();
    // Reject anything that isn't a plain git object name before it can ever reach
    // a build command line.
    const upstreamCommit = COMMIT_RE.test(raw) ? raw : null;
    if (raw && !upstreamCommit) {
      const error = `refusing to act on non-hex upstream ref '${raw.slice(0, 40)}'`;
      writeState({ lastCheck: clock(), lastResult: DS4_UPDATE_STATE.ERROR, lastError: error });
      return { ok: false, upToDate: false, builtCommit, upstreamCommit: st.upstreamCommit || null, error };
    }
    // A null builtCommit means we've never taken over management of the install;
    // treat that as "not up to date" so an explicit apply can adopt it.
    const upToDate = !!builtCommit && !!upstreamCommit && builtCommit === upstreamCommit;
    writeState({
      lastCheck: clock(), upstreamCommit,
      lastResult: upToDate ? DS4_UPDATE_STATE.UP_TO_DATE : st.lastResult,
    });
    return { ok: true, upToDate, builtCommit, upstreamCommit };
  }

  // ── Build (out of place) ─────────────────────────────────────────────────
  /**
   * Build `commit` into buildsDir/<commit>/ via a detached worktree of the ds4
   * repo, compiled in the rocwmma container with the required -fPIC injection, then
   * the produced binaries copied into the versioned build dir. Never touches the
   * live binaries. Cleans up the worktree regardless of outcome.
   * @returns {Promise<{ok:boolean, buildDir:string, error?:string}>}
   */
  async function build(commit) {
    if (!COMMIT_RE.test(commit)) {
      return { ok: false, buildDir: `${buildsDir}/invalid`, error: `invalid commit '${commit}'` };
    }
    const buildDir = `${buildsDir}/${commit}`;
    const srcDir = `${buildsDir}/.src-${commit}`;
    fs.mkdirSync(buildsDir, { recursive: true });

    // Fresh detached worktree at the target commit (force-recreate if a stale one lingers).
    await exec(`git -C ${repoDir} worktree remove --force ${srcDir}`, { timeoutMs: 60_000 }).catch(() => {});
    const wt = await exec(`git -C ${repoDir} worktree add --detach --force ${srcDir} ${commit}`, { timeoutMs: 120_000 });
    if (wt.code !== 0) {
      return { ok: false, buildDir, error: `worktree add failed: ${(wt.stderr || '').trim()}` };
    }

    // Build in the rocwmma toolchain container. The -fPIC (via DEBUG_FLAGS) is
    // REQUIRED or the link fails (see docs/ds4-build.md).
    const makeCmd =
      `distrobox enter ${buildContainer} -- bash -c ` +
      `'cd ${srcDir} && make strix-halo -j"$(nproc)" DEBUG_FLAGS="-g -fPIC"'`;
    const mk = await exec(makeCmd, { timeoutMs: buildTimeoutMs });
    let error = null;
    if (mk.code !== 0) {
      error = `make strix-halo failed: ${(mk.stderr || '').trim().slice(0, 500)}`;
    } else {
      // Stage the freshly built binaries into the versioned build dir.
      fs.mkdirSync(buildDir, { recursive: true });
      const cp = await exec(
        `bash -c 'cp -f ${srcDir}/ds4 ${srcDir}/ds4-server ${srcDir}/ds4-bench ${srcDir}/ds4-eval ${srcDir}/ds4-agent ${buildDir}/'`,
        { timeoutMs: 60_000 },
      );
      if (cp.code !== 0) error = `staging binaries failed: ${(cp.stderr || '').trim()}`;
    }

    // Always remove the worktree.
    await exec(`git -C ${repoDir} worktree remove --force ${srcDir}`, { timeoutMs: 60_000 }).catch(() => {});
    return error ? { ok: false, buildDir, error } : { ok: true, buildDir };
  }

  // ── Smoke test ─────────────────────────────────────────────────────────
  /**
   * Run the freshly built one-shot `ds4` binary against the real model with a short
   * prompt and assert a coherent completion + clean exit. Distinguishes a GGUF
   * load/compat failure from a generic runtime failure.
   * @returns {Promise<{ok:boolean, modelIncompat:boolean, detail:string}>}
   */
  async function smoke(buildDir) {
    // ds4 one-shot generation. Flags are provisional pending LIVE verification;
    // the unit tests stub exec so the exact flags don't gate the state machine.
    const smokeCmd =
      `distrobox enter ${runContainer} -- bash -c ` +
      `'export LD_LIBRARY_PATH=/opt/rocm/lib:$LD_LIBRARY_PATH; ` +
      `export HSA_OVERRIDE_GFX_VERSION=11.5.1; ` +
      `${buildDir}/ds4 -m ${modelPath} -n ${smokeTokens} --rocm -p "${smokePrompt}"'`;
    const r = await exec(smokeCmd, { timeoutMs: smokeTimeoutMs });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const modelIncompat = MODEL_INCOMPAT_MARKERS.some((re) => re.test(out));
    // Coherent = clean exit AND some non-whitespace generated text.
    const coherent = r.code === 0 && /\S/.test(r.stdout || '');
    if (coherent) return { ok: true, modelIncompat: false, detail: 'clean exit, non-empty completion' };
    return { ok: false, modelIncompat, detail: (out.trim().slice(0, 500) || `exit ${r.code}`) };
  }

  // ── Swap ────────────────────────────────────────────────────────────────
  /** Flip the `current` symlink to the new build and restart ds4 (supervised). */
  async function swap(commit, buildDir) {
    const st = readState();
    const prevBuildDir = st.currentBuildDir || null;
    atomicSymlinkSwap({ linkPath: currentLink, target: buildDir, fs });
    writeState({
      builtCommit: commit, currentBuildDir: buildDir, prevBuildDir,
      lastApply: clock(), lastResult: DS4_UPDATE_STATE.SWAPPED, lastError: null,
    });
    pushHistory({ from: prevBuildDir, to: buildDir, result: DS4_UPDATE_STATE.SWAPPED });
    await restartDs4();
  }

  // ── Orchestration ─────────────────────────────────────────────────────────
  /**
   * Run one full update cycle: check → (if new/forced) build → (idle-gated)
   * smoke → swap. Rolls nothing forward on failure; the last-known-good build keeps
   * serving. Returns the resulting state and the commits involved.
   * @param {object} [opts]
   * @param {boolean} [opts.force] Rebuild+swap even if already up to date.
   * @returns {Promise<{state:string, builtCommit:(string|null), upstreamCommit:(string|null), buildDir?:string, error?:string}>}
   */
  async function apply({ force = false } = {}) {
    const chk = await check();
    if (!chk.ok) {
      alert(`ds4 update check failed: ${chk.error}`, { stage: 'check' });
      return { state: DS4_UPDATE_STATE.ERROR, builtCommit: chk.builtCommit, upstreamCommit: chk.upstreamCommit, error: chk.error };
    }
    const from = chk.builtCommit;
    const target = chk.upstreamCommit;
    if (chk.upToDate && !force) {
      return { state: DS4_UPDATE_STATE.UP_TO_DATE, builtCommit: from, upstreamCommit: target };
    }
    if (!target) {
      const error = 'no upstream commit resolved; cannot update';
      alert(`ds4 update: ${error}`, { stage: 'check' });
      return { state: DS4_UPDATE_STATE.ERROR, builtCommit: from, upstreamCommit: target, error };
    }

    // BUILD — memory-light, safe to run while the box is serving.
    log(`[ds4-update] building ${target} (from ${from || 'unmanaged'})`);
    addLog('system', `ds4 auto-update: building upstream ${target.slice(0, 12)} out of place`);
    writeState({ lastResult: DS4_UPDATE_STATE.BUILDING, upstreamCommit: target, lastError: null });
    const b = await build(target);
    if (!b.ok) {
      writeState({ lastResult: DS4_UPDATE_STATE.ERROR, lastError: b.error });
      pushHistory({ from, to: target, result: DS4_UPDATE_STATE.ERROR });
      alert(`ds4 auto-update build FAILED for ${target}: ${b.error}`, { stage: 'build', commit: target });
      return { state: DS4_UPDATE_STATE.ERROR, builtCommit: from, upstreamCommit: target, error: b.error };
    }

    // SMOKE + SWAP need the box's memory — the 81GB model cannot coexist with a
    // resident big model, and we never run two instances. Defer to an idle window.
    if (!isIdle()) {
      writeState({ lastResult: DS4_UPDATE_STATE.DEFERRED });
      addLog('system', `ds4 auto-update: build ${target.slice(0, 12)} ready; deferring smoke+swap until idle`);
      return { state: DS4_UPDATE_STATE.DEFERRED, builtCommit: from, upstreamCommit: target, buildDir: b.buildDir };
    }

    // SMOKE
    const s = await smoke(b.buildDir);
    if (!s.ok) {
      const commitRange = from ? `${from}..${target}` : target;
      if (s.modelIncompat) {
        writeState({ lastResult: DS4_UPDATE_STATE.NEEDS_MODEL_REDOWNLOAD, lastError: s.detail });
        pushHistory({ from, to: target, result: DS4_UPDATE_STATE.NEEDS_MODEL_REDOWNLOAD });
        alert(
          `ds4 auto-update: new build ${target.slice(0, 12)} FAILED to load the model — a model re-download may be required. Keeping the old build. Upstream changes: ${commitRange}`,
          { stage: 'smoke', commit: target, commitRange, detail: s.detail },
        );
        return { state: DS4_UPDATE_STATE.NEEDS_MODEL_REDOWNLOAD, builtCommit: from, upstreamCommit: target, buildDir: b.buildDir, error: s.detail };
      }
      writeState({ lastResult: DS4_UPDATE_STATE.SMOKE_FAILED, lastError: s.detail });
      pushHistory({ from, to: target, result: DS4_UPDATE_STATE.SMOKE_FAILED });
      alert(
        `ds4 auto-update: new build ${target.slice(0, 12)} FAILED smoke test — keeping the old build. Detail: ${s.detail}`,
        { stage: 'smoke', commit: target, commitRange, detail: s.detail },
      );
      return { state: DS4_UPDATE_STATE.SMOKE_FAILED, builtCommit: from, upstreamCommit: target, buildDir: b.buildDir, error: s.detail };
    }

    // SWAP (atomic symlink flip + supervised restart)
    log(`[ds4-update] smoke ok; swapping to ${target}`);
    addLog('system', `ds4 auto-update: smoke passed — swapping to ${target.slice(0, 12)} and restarting ds4-server`);
    await swap(target, b.buildDir);
    return { state: DS4_UPDATE_STATE.SWAPPED, builtCommit: target, upstreamCommit: target, buildDir: b.buildDir };
  }

  /**
   * Scheduled entry point: check, and (when autoApply is on and a new commit is
   * present) apply. Safe to call on a timer.
   * @param {object} [opts]
   * @param {boolean} [opts.autoApply] Apply automatically when a new commit lands.
   */
  async function runCycle({ autoApply = true } = {}) {
    const chk = await check();
    if (!chk.ok) return { state: DS4_UPDATE_STATE.ERROR, ...chk };
    if (chk.upToDate) return { state: DS4_UPDATE_STATE.UP_TO_DATE, ...chk };
    if (!chk.builtCommit) {
      // Unmanaged install: don't surprise-build. Require an explicit apply to adopt.
      addLog('system', `ds4 auto-update: upstream ${(chk.upstreamCommit || '').slice(0, 12)} available but no managed build recorded — run apply to adopt.`);
      return { state: 'unmanaged', ...chk };
    }
    if (!autoApply) return { state: 'update-available', ...chk };
    return apply();
  }

  /** Snapshot of updater state for the status endpoint. */
  function getStatus() {
    const st = readState();
    return {
      builtCommit: st.builtCommit || null,
      currentBuildDir: st.currentBuildDir || null,
      upstreamCommit: st.upstreamCommit || null,
      lastCheck: st.lastCheck || null,
      lastApply: st.lastApply || null,
      lastResult: st.lastResult || null,
      lastError: st.lastError || null,
      model: modelPath,
      repoDir,
      currentLink,
      history: st.history || [],
    };
  }

  return { check, apply, runCycle, getStatus };
}
