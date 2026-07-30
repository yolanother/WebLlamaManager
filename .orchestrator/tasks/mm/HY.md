
---

## Worker hygiene (do not deviate)

- **Read the design doc first**: `docs/superpowers/specs/2026-07-30-multimodal-api-design.md`
  (on `main`, commit d775d74). It has the verified current state, the content-part
  contract, and the risk list. Do not re-derive facts already recorded there.
- **Isolation**: if you are a dispatched worker you are ALREADY in a worktree at
  `/workspace` — do NOT nest another (`git worktree add` is forbidden), and open your
  PR with `gh pr create --base "$TARGET_BRANCH"`. If you are a local interactive
  agent, create your own worktree (`git worktree add .claude/worktrees/<slug> -b <slug>`),
  get it green there, then merge into local `main` while holding the `.worktree-merge`
  lockfile in the repo root — create it, merge, remove it immediately. Wait if it exists.
- **Scope discipline**: before staging run `git status` and confirm the only changed
  files are those in "Files to touch". This repo has pre-existing dirty files that
  belong to other work — `git add <specific paths>`, never `git add -A`.
- **Both gates must pass before you hand off**:
  `./scripts/dev-build.sh check` and `./scripts/dev-build.sh container`.
  Do not silence errors with `@ts-ignore`/`as any` — fix the cause.
- **Tests first** (project rule): write the failing test before the implementation.
- **Headers**: every new file needs the copyright block + a self-contained purpose
  summary (see CLAUDE.md "Headers"); keep existing headers current if behaviour changes.
- **Report progress**: `orch tasks progress <ID> "<what/why/decisions>" --json` after
  every few edits, and `orch tasks add-diff <ID> <sha> "<title>" --json` after commits.
