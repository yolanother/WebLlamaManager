# ds4 auto-update (track upstream, rebuild, smoke test, atomic swap)

Keeps the local [antirez/ds4](https://github.com/antirez/ds4) ("DwarfStar" /
DeepSeek V4 Flash) build current **without ever serving a broken binary**. ds4's
ROCm backend is days-old and fast-moving, so bug fixes and perf improvements land
frequently — this mechanism picks them up without manual babysitting, but only
promotes a new build after it passes a smoke test, with automatic rollback to the
last-known-good build on any failure.

Implemented as a dependency-injected state machine in
[`api/ds4-updater.js`](../api/ds4-updater.js) (unit-tested in
`api/ds4-updater.test.js`), wired into the manager in `api/server.js`, with the
`current`-symlink resolution in `start-ds4.sh`. See also
[`docs/ds4-build.md`](./ds4-build.md) for the underlying build/run facts.

## How it works

1. **Check** — `git -C /home/yolan/workspace/ai/ds4 fetch origin main`, then
   `git rev-parse origin/main`. Compare that to the commit our current build was
   made from (recorded in the state file). If they match, we're up to date.
2. **Build (out of place)** — for a new commit, create a **detached git worktree**
   of the ds4 repo at that commit under `~/.local/share/ds4/builds/.src-<commit>/`
   and run `make strix-halo -j"$(nproc)" DEBUG_FLAGS="-g -fPIC"` inside the
   **`llama-rocm-7rc-rocwmma`** container (the only one with the rocWMMA toolchain;
   the `-fPIC` is required or the link fails). The produced binaries are staged
   into a versioned `~/.local/share/ds4/builds/<commit>/` dir. The live binaries
   are never touched. Building is memory-light and safe while the box is serving.
3. **Smoke test** — run the freshly built one-shot `ds4` binary against the real
   model with a short prompt in the **`llama-rocm-7.2.4`** container (the one with
   a working HSA runtime on gfx1151) and assert a clean exit + a coherent, non-empty
   completion. Because the 81GB model can't coexist with a resident big model and
   we never run two instances, the smoke+swap are **idle-gated**: they only run when
   there are no in-flight requests. On a busy box the build still completes and the
   swap is **deferred** to the next idle window.
4. **Swap (atomic)** — flip the `~/.local/share/ds4/current` symlink to the new
   `builds/<commit>/` dir via a temp-symlink + `rename(2)` (atomic on POSIX; a
   reader sees either the old or the new build, never a partial state), record the
   new built commit, then restart ds4-server through the **supervised restart path**
   (`restartDs4Server`) so the restart governor sees it. The previous build dir is
   kept as the last-known-good.
5. **Rollback / alerts** — a failed smoke leaves the old build serving (no swap) and
   raises an alert. If the new binary fails to **load** the GGUF (format changed
   upstream), it's treated as a smoke failure with a **prominent "model may need
   re-download" alert** that includes the upstream commit range (`<from>..<to>`).

## State machine

`createDs4Updater({...}).apply()` returns one of these `state` values (also the
`lastResult` persisted to the state file), defined in `DS4_UPDATE_STATE`:

| State | Meaning |
|---|---|
| `up-to-date` | `origin/main` == built commit; nothing to do (short-circuit before any build). |
| `building` | Interim: a new commit was found and the out-of-place build is running. |
| `deferred` | Build succeeded but the box is busy; smoke+swap postponed to an idle window (build is cached in `builds/<commit>/`). |
| `swapped` | Smoke passed; `current` symlink flipped and ds4-server restarted onto the new build. |
| `smoke-failed` | Built ok but the new binary failed smoke; old build kept, alert raised. |
| `needs-model-redownload` | New binary couldn't load the existing GGUF; old build kept, prominent alert with the upstream commit range. |
| `error` | git/build failure; no swap, alert raised. |

Commit SHAs from `git rev-parse` are validated as git object names (`/^[0-9a-f]{7,40}$/`)
before ever being interpolated into a build command (defense-in-depth, since the
build steps run through a shell).

## Exported surface (`api/ds4-updater.js`)

- `createDs4Updater(deps)` → `{ check, apply, runCycle, getStatus }`
  - `check()` → `{ ok, upToDate, builtCommit, upstreamCommit, error? }` — fetch + compare only.
  - `apply({ force })` → the full cycle (build → idle-gated smoke → swap); returns the resulting `{ state, builtCommit, upstreamCommit, buildDir?, error? }`.
  - `runCycle({ autoApply })` → scheduler entry point: check, and (when `autoApply` and a new commit is present on a *managed* install) apply. An unmanaged install (no recorded built commit) is **not** surprise-built — it logs and waits for an explicit `apply`.
  - `getStatus()` → snapshot for the API (built/upstream commit, last check/apply/result/error, model, repoDir, currentLink, history).
- `atomicSymlinkSwap({ linkPath, target, fs? })` — standalone atomic symlink flip (validates the target exists; cleans its temp link and leaves the old symlink intact on failure).
- `DS4_UPDATE_STATE` — the state constants above.

Injected deps (`exec`, `fs`, `clock`, `isIdle`, `restartDs4`, `alert`, `log`,
`addLog`, `paths`, container names, smoke prompt/tokens, timeouts) make the state
machine and symlink atomicity fully unit-testable without a real GPU build or the
81GB model.

## API endpoints

- `GET /api/ds4/update/status` — current/upstream commit, last check, last result, history.
- `POST /api/ds4/update/check` — manual "check now" (fetch + compare, no build); runs synchronously and returns the check result + status.
- `POST /api/ds4/update/apply` — manual "update now". Body `{ "force": true }` rebuilds+swaps even when up to date. A build can take minutes, so this runs in the **background** and returns `202 { started: true, status }`; poll `/status` for progress. Returns `409` if an update is already in flight.

## Scheduler & config

A manager-internal timer (`setInterval`, following the existing periodic-job
pattern in `server.js`) evaluates every 30 minutes and runs a cycle once the
configured interval has elapsed. Configured under `config.ds4.update`:

```jsonc
{
  "ds4": {
    "update": {
      "enabled": true,        // false disables the scheduler entirely
      "intervalHours": 6,     // minimum hours between scheduled checks (default 6)
      "autoApply": true       // build+smoke+swap on a new commit (default true)
    }
  }
}
```

With `autoApply: false` the scheduler only checks and surfaces "update-available"
in the status; the operator applies via the endpoint. The manual apply endpoint
and the scheduler share a single in-flight guard so two updates never overlap.

## On-disk layout

`~/.local/share/ds4/` (override with `DS4_STATE_DIR`):

```
builds/<commit>/{ds4,ds4-server,ds4-bench,ds4-eval,ds4-agent}   versioned builds
current -> builds/<commit>                                       atomic `current` symlink
state.json                                                       built/upstream commit, last check/result, history
```

`start-ds4.sh` prefers `DS4_STATE_DIR/current/ds4-server` for the binary path when
that symlink exists. `config.ds4.binPath` (passed through as `DS4_SERVER_BIN`)
remains an explicit override: if it is set to a value **other** than the legacy
default (`~/.local/bin/ds4-server`), it wins, so an operator can still pin a
specific binary.

## Operator step — exercise a real update once (LIVE VERIFICATION PENDING)

The unit tests cover the state machine and swap atomicity, but the real GPU
build + smoke has to be exercised once in an operator maintenance window (the
smoke loads the 81GB model, which needs the box's memory — see the memory
coexistence notes in `docs/ds4-build.md`). To do it:

1. **Adopt the current install** — record the commit the live binary was built
   from so the updater is "managed":

   ```sh
   # commit the current ~/.local/bin/ds4* were built from
   git -C /home/yolan/workspace/ai/ds4 rev-parse HEAD
   ```

   Then either seed `~/.local/share/ds4/state.json` with that `builtCommit` (and
   a `current` symlink pointing at a `builds/<commit>/` dir holding the current
   binaries), or run `POST /api/ds4/update/apply` with the box idle to have the
   updater build+smoke+swap the newest commit from scratch.

2. **Pin an OLD commit to force an update** (acceptance test): set `builtCommit`
   in `state.json` to an older upstream commit, ensure the box is idle (no
   in-flight requests; big models unloaded / router stopped per `docs/ds4-build.md`),
   then:

   ```sh
   curl -s -X POST http://localhost:5250/api/ds4/update/apply | jq
   curl -s http://localhost:5250/api/ds4/update/status | jq   # poll: expect state "swapped"
   ```

   Confirm ds4-server comes back on the new build (`current` symlink points at
   `builds/<new-commit>/`, `state.json.builtCommit` == new commit) and serves.

3. **Force a smoke failure** (acceptance test): point the updater at a bogus model
   (e.g. temporarily set `DS4_MODEL` to a nonexistent path) and apply — expect
   `state: "smoke-failed"` (or `needs-model-redownload`), the old build still
   serving, and the alert in the manager log.

Confirm the smoke command's exact `ds4` one-shot flags during this window and
adjust `smokePrompt`/`smokeTokens`/the smoke argv in `api/ds4-updater.js` if
needed (they are provisional / `LIVE VERIFICATION PENDING`).

## Out of scope

- Auto-updating the **model** files (alert-only when the GGUF format breaks).
- Updating llama.cpp (that has its own `build-llama-cpp` flow).
