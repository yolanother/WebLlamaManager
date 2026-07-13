// Llama Manager — unit tests for api/ds4-updater.js (ds4 auto-update pipeline).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Exercises the update state machine (up-to-date short-circuit, new-commit →
// build → smoke → swap, smoke failure → no-swap + alert, model-incompat →
// needs-model-redownload, busy → deferred, build failure → error) with a fully
// faked exec/fs/clock so no real GPU build, git repo, or 81GB model is touched,
// plus the atomic symlink-flip helper against a real temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, readlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDs4Updater, atomicSymlinkSwap, DS4_UPDATE_STATE } from './ds4-updater.js';

const BUILT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UPSTREAM = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MODEL = '/models-ds4/model.gguf';

/** In-memory state-file store backed by a tiny fs shim usable by the updater. */
function memFs(initial = {}) {
  const files = new Map();
  const dirs = new Set(['/']);
  if (initial.state) files.set('/state/state.json', JSON.stringify(initial.state));
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, String(data)); },
    mkdirSync: (p) => { dirs.add(p); },
    symlinkSync: (target, link) => { files.set(link, `->${target}`); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readlinkSync: (p) => {
      const v = files.get(p);
      if (v == null || !v.startsWith('->')) { const e = new Error('EINVAL'); e.code = 'EINVAL'; throw e; }
      return v.slice(2);
    },
    rmSync: (p) => { files.delete(p); dirs.delete(p); },
  };
}

/**
 * Fake exec that routes on command substrings. `overrides` maps a step key to a
 * result object ({code,stdout,stderr}); anything unspecified succeeds (code 0).
 * Records every command in `calls`.
 */
function makeExec(overrides = {}, calls = []) {
  return async (cmd) => {
    calls.push(cmd);
    const ret = (o) => ({ code: 0, stdout: '', stderr: '', ...o });
    if (cmd.includes('rev-parse')) return ret({ stdout: (overrides.upstream || UPSTREAM) + '\n' });
    if (cmd.includes('fetch')) return ret(overrides.fetch);
    if (cmd.includes('worktree add')) return ret(overrides.worktreeAdd);
    if (cmd.includes('make strix-halo')) return ret(overrides.build);
    if (cmd.includes('worktree remove')) return ret(overrides.worktreeRemove);
    if (cmd.includes('/ds4 -m') || cmd.includes('ds4-smoke')) return ret(overrides.smoke ?? { stdout: 'pong' });
    return ret();
  };
}

/** Build an updater over the mem fs + fake exec with sensible test defaults. */
function makeUpdater(over = {}) {
  const calls = over.calls || [];
  const fs = over.fs || memFs({ state: over.state });
  const alerts = [];
  const up = createDs4Updater({
    exec: over.exec || makeExec(over.execOverrides, calls),
    fs,
    clock: over.clock || (() => 1000),
    isIdle: over.isIdle ?? (() => true),
    restartDs4: over.restartDs4 || (async () => { calls.push('restartDs4'); }),
    alert: (msg, meta) => alerts.push({ msg, meta }),
    log: () => {},
    addLog: () => {},
    paths: {
      repoDir: '/repo',
      stateDir: '/state',
      buildsDir: '/state/builds',
      currentLink: '/state/current',
      statePath: '/state/state.json',
      modelPath: MODEL,
    },
    ...over.ctor,
  });
  return { up, calls, fs, alerts };
}

test('check: up-to-date when built commit equals upstream', async () => {
  const { up } = makeUpdater({ state: { builtCommit: UPSTREAM }, execOverrides: { upstream: UPSTREAM } });
  const r = await up.check();
  assert.equal(r.upToDate, true);
  assert.equal(r.builtCommit, UPSTREAM);
  assert.equal(r.upstreamCommit, UPSTREAM);
});

test('check: new commit detected when upstream differs from built', async () => {
  const { up } = makeUpdater({ state: { builtCommit: BUILT }, execOverrides: { upstream: UPSTREAM } });
  const r = await up.check();
  assert.equal(r.upToDate, false);
  assert.equal(r.builtCommit, BUILT);
  assert.equal(r.upstreamCommit, UPSTREAM);
});

test('apply: up-to-date short-circuits without building', async () => {
  const { up, calls } = makeUpdater({ state: { builtCommit: UPSTREAM }, execOverrides: { upstream: UPSTREAM } });
  const r = await up.apply();
  assert.equal(r.state, DS4_UPDATE_STATE.UP_TO_DATE);
  assert.equal(calls.some((c) => c.includes('make strix-halo')), false);
});

test('apply: new commit builds, smokes ok, swaps and restarts', async () => {
  const { up, calls, fs } = makeUpdater({ state: { builtCommit: BUILT, currentBuildDir: '/state/builds/' + BUILT } });
  const r = await up.apply();
  assert.equal(r.state, DS4_UPDATE_STATE.SWAPPED);
  assert.equal(r.builtCommit, UPSTREAM);
  // built out of place at builds/<upstream>
  assert.ok(calls.some((c) => c.includes('worktree add')));
  assert.ok(calls.some((c) => c.includes('make strix-halo')));
  // symlink flipped to the new build dir
  assert.equal(fs.readlinkSync('/state/current'), '/state/builds/' + UPSTREAM);
  // supervised restart happened after the flip
  assert.ok(calls.includes('restartDs4'));
  // state file records the new built commit
  const st = JSON.parse(fs.readFileSync('/state/state.json'));
  assert.equal(st.builtCommit, UPSTREAM);
});

test('apply: smoke failure keeps old build, no swap, raises alert', async () => {
  const oldDir = '/state/builds/' + BUILT;
  const { up, calls, fs, alerts } = makeUpdater({
    state: { builtCommit: BUILT, currentBuildDir: oldDir },
    execOverrides: { smoke: { code: 1, stderr: 'generation stalled' } },
  });
  // seed the pre-existing current symlink
  fs.symlinkSync(oldDir, '/state/current');
  const r = await up.apply();
  assert.equal(r.state, DS4_UPDATE_STATE.SMOKE_FAILED);
  // symlink still points at the old build
  assert.equal(fs.readlinkSync('/state/current'), oldDir);
  assert.equal(calls.includes('restartDs4'), false);
  assert.equal(alerts.length, 1);
  const st = JSON.parse(fs.readFileSync('/state/state.json'));
  assert.equal(st.builtCommit, BUILT); // unchanged
});

test('apply: model-incompat smoke failure → needs-model-redownload + alert with commit range', async () => {
  const { up, alerts, fs } = makeUpdater({
    state: { builtCommit: BUILT, currentBuildDir: '/state/builds/' + BUILT },
    execOverrides: { smoke: { code: 1, stderr: 'error: failed to load model: unknown tensor arrangement' } },
  });
  const r = await up.apply();
  assert.equal(r.state, DS4_UPDATE_STATE.NEEDS_MODEL_REDOWNLOAD);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].msg, /model/i);
  // alert references the upstream commit range so the operator can inspect
  assert.ok(alerts[0].meta && alerts[0].meta.commitRange);
  const st = JSON.parse(fs.readFileSync('/state/state.json'));
  assert.equal(st.builtCommit, BUILT); // old build retained
});

test('apply: build failure → error, no swap, alert', async () => {
  const { up, calls, alerts } = makeUpdater({
    state: { builtCommit: BUILT },
    execOverrides: { build: { code: 2, stderr: 'ld.lld: error' } },
  });
  const r = await up.apply();
  assert.equal(r.state, DS4_UPDATE_STATE.ERROR);
  assert.equal(calls.includes('restartDs4'), false);
  assert.equal(alerts.length, 1);
});

test('apply: busy box defers smoke+swap (build still completes)', async () => {
  const { up, calls } = makeUpdater({
    state: { builtCommit: BUILT },
    isIdle: () => false,
  });
  const r = await up.apply();
  assert.equal(r.state, DS4_UPDATE_STATE.DEFERRED);
  // build happened (safe during serving) but no smoke/swap/restart
  assert.ok(calls.some((c) => c.includes('make strix-halo')));
  assert.equal(calls.some((c) => c.includes('/ds4 -m')), false);
  assert.equal(calls.includes('restartDs4'), false);
});

test('apply: force rebuilds even when up-to-date', async () => {
  const { up, calls } = makeUpdater({ state: { builtCommit: UPSTREAM }, execOverrides: { upstream: UPSTREAM } });
  const r = await up.apply({ force: true });
  assert.equal(r.state, DS4_UPDATE_STATE.SWAPPED);
  assert.ok(calls.some((c) => c.includes('make strix-halo')));
});

test('getStatus: reports current/upstream commits and last result', async () => {
  const { up } = makeUpdater({
    state: { builtCommit: BUILT, upstreamCommit: UPSTREAM, lastCheck: 500, lastResult: 'up-to-date' },
  });
  const s = up.getStatus();
  assert.equal(s.builtCommit, BUILT);
  assert.equal(s.upstreamCommit, UPSTREAM);
  assert.equal(s.lastResult, 'up-to-date');
  assert.equal(s.model, MODEL);
});

// ── Atomic symlink flip (real temp dir) ──────────────────────────────────────

test('atomicSymlinkSwap: current always points at a complete build after flip', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds4swap-'));
  try {
    const a = join(root, 'builds', 'A');
    const b = join(root, 'builds', 'B');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const link = join(root, 'current');
    symlinkSync(a, link);
    assert.equal(readlinkSync(link), a);
    atomicSymlinkSwap({ linkPath: link, target: b });
    assert.equal(readlinkSync(link), b);
    // old build dir untouched (last-known-good preserved for rollback)
    assert.ok(existsSync(a));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('atomicSymlinkSwap: interrupted rename leaves last-good intact and cleans temp', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds4swap-'));
  try {
    const a = join(root, 'builds', 'A');
    const b = join(root, 'builds', 'B');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const link = join(root, 'current');
    symlinkSync(a, link);
    // fs wrapper whose renameSync throws to simulate a crash mid-flip
    const boom = {
      existsSync,
      symlinkSync,
      renameSync: () => { throw new Error('EIO simulated'); },
      rmSync,
    };
    assert.throws(() => atomicSymlinkSwap({ linkPath: link, target: b, fs: boom }), /EIO/);
    // original symlink still points at A (never partially updated)
    assert.equal(readlinkSync(link), a);
    // no leftover temp symlinks in the dir
    const leftovers = readdirSync(root).filter((f) => f.startsWith('current.tmp'));
    assert.equal(leftovers.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('atomicSymlinkSwap: refuses to point at a missing target', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds4swap-'));
  try {
    const link = join(root, 'current');
    assert.throws(() => atomicSymlinkSwap({ linkPath: link, target: join(root, 'nope') }), /target/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
