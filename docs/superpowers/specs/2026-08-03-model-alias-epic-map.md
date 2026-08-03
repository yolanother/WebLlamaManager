# Model Alias Groups — epic task map

**Epic:** `0DfIVlZNejtccWwVzOKYg`
**Spec:** `docs/superpowers/specs/2026-08-03-model-alias-groups-design.md` (commit `1401b5c`, branch `model-alias-groups`)
**Frozen module contract:** `docs/superpowers/specs/2026-08-03-model-alias-contract.md`

Read this file first after a reboot or any interruption. Every worktree branches
from `model-alias-groups` (which carries the spec), except `[5]` which branches
from `main`.

## Pattern

Each unit is **pair-programmed across two worktrees**: a TEST worker and an
IMPLEMENTATION worker code independently against the frozen contract, touching
**disjoint files**, then a CONVERGENCE task merges both branches and reconciles
them with the contract as arbiter. Contract disagreements found during
convergence are the highest-value output — each one is a place the spec was
underspecified, and they get recorded in task comments and folded back into the
spec by `[5]`.

The implementation chain intentionally races ahead of the test chain so the
feature is exercisable on the dev server before the test infrastructure is done.

## Tasks

| # | Task ID | Branch / worktree `.claude/worktrees/…` | Owns | Depends on |
|---|---|---|---|---|
| 1T | `rTwOSyi4sfpli5nfC0WZM` | `alias-core-tests` | `api/model-aliases.test.js` | — |
| 1I | `wV0tZ8OBbRZdfBbENvSSc` | `alias-core-impl` | `api/model-aliases.js` | — |
| 1C | `4vt-L-kwXSbFV3G6VnSDo` | `alias-core-converge` | both of the above | 1T, 1I |
| 2T | `6WCaTpJ2WPMtRBh8PLWFW` | `alias-migration-tests` | `api/alias-migration.test.js` | — |
| 2I | `4Rtr6XsfJcSJ9gAMKdYIg` | `alias-migration-impl` | `api/alias-migration.js` | — |
| 2C | `TCJkPBochPryEbBWBXtR6` | `alias-migration-converge` | both of the above | 2T, 2I |
| 3T | `M9bVVNZkJQB2cI7H6QMpt` | `alias-server-tests` | `tests/aliases/**` | — |
| 3I | `5jkbcj81kr0AL6yiSkHpi` | `alias-server-impl` | `api/server.js`, `api/chat-router.js`, `api/api-spec.js`; deletes `api/default-models*` | 1I, 2I |
| 3C | `2awNeMVjm8cwsvlwdAGok` | `alias-server-converge` | 3T + 3I files | 3T, 3I |
| 4T | `Hi1RYnqIKOCLEK0Q7skDZ` | `alias-ui-tests` | `ui/src/pages/alias-editor.test.js` | — |
| 4I | `hHZCkU25TZOuyU3XoDf0Q` | `alias-ui-impl` | `ui/src/pages/alias-editor.js`, `Settings.jsx` | — |
| 4C | `OnBqQjncoEzXQ3Aganq43` | `alias-ui-converge` | 4T + 4I files | 4T, 4I, 3C |
| 5 | `b_Fe1tMLbBB9h3iccS9Pv` | `alias-docs` (from `main`) | `docs/**` | 3C, 4C |

## Wave order

```
WAVE 1 (7 parallel, no deps)   1T  1I  2T  2I  3T  4T  4I
WAVE 2                         1C  2C  3I
WAVE 3                         3C  ──► operator can test on the dev server
WAVE 4                         4C
WAVE 5                         5
```

## Resume procedure

1. `orch tasks list --parent 0DfIVlZNejtccWwVzOKYg --graphql "{ id title status }" --json`
2. For anything `in_progress`, read its comments — each records the worktree path,
   branch, and what was done.
3. `git worktree list` to see which worktrees survived. Recreate a missing one
   with the command in that task's description.
4. Resume the lowest-numbered incomplete wave.

## Invariants

- Pair halves must NEVER edit each other's files. That disjointness is what makes
  them safe to run concurrently in separate worktrees.
- The frozen contract is the arbiter at convergence, not whichever side is easier
  to change. Amend the contract deliberately and record it; never silently.
- Never weaken or delete a test to reach green.
- Never write to the repo's real `config.json` — migration checks work on a copy.
