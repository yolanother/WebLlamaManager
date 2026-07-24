---
name: orch-dev-release
description: "Review, rebase, build, and publish orchestrator releases by promoting main to the release branch. Use when asked to release, publish release, push the release branch, or run the rebase/build/release workflow."
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[review|commit|publish|deploy]"
---

# Orch Dev Release

Use this project-local skill for orchestrator release work. The production release path tracks the `release` branch, so publishing usually means verifying `main`, fast-forwarding `release` to it, and pushing `release`.

## Workflow

1. Review dirty changes before staging anything.
   ```bash
   git status --short --branch
   git diff --stat
   ```
   Separate intentional source changes from generated files, runtime artifacts, caches, screenshots, and unrelated local edits.

2. Keep the work tracked.
   - Use `orch` for the task, milestones, decisions, and commit notes.
   - Do not read or print secret config files; use `.orchestrator/scripts/dev-config.sh` for config values.

3. Commit only the intended release scope.
   ```bash
   git add <intended-files>
   git commit -m "<type(scope): summary>"
   ```
   Avoid committing `.dev-logs`, `.playwright-mcp`, `__pycache__`, screenshots, derived cursors, or unrelated generated output.

4. Sync before publishing.
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   Rebase only from a clean worktree or after carefully stashing unrelated local edits. Resolve conflicts, then continue the rebase non-interactively when possible.

5. Verify.
   ```bash
   npm --workspace packages/orchestrator test -- <focused-tests>
   ./scripts/dev-build.sh build
   ```
   The build may update generated CLI bundle files and package metadata. Include those only when the release intentionally changes the CLI bundle.

6. Publish the release branch.
   If the current worktree has unrelated dirty files, use a temporary worktree:
   ```bash
   git worktree add /tmp/orch-release origin/release -b release-publish-$(date +%Y%m%d%H%M%S)
   cd /tmp/orch-release
   git merge --ff-only main
   git push origin HEAD:release
   ```
   If already on a clean release branch:
   ```bash
   git checkout release
   git merge --ff-only main
   git push origin release
   git checkout main
   ```

7. Deploy only when explicitly requested.
   ```bash
   csm-admin deploy orchestrator
   ```

## Review Notes

- Prefer `--ff-only` when promoting release so the release branch points at the exact verified commit from `main`.
- Do not use destructive cleanup commands to make a release worktree clean.
- If unrelated dirty changes are present, leave them untouched and publish from a temporary worktree.
- Record the final commit hashes and release push in `orch`.
