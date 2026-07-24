---
name: monitored-dispatch
description: "Dispatch an orchestrator task, monitor it to completion, review the PR, and merge it. One-shot fire-and-forget task execution. Use when the user says 'dispatch and monitor', 'run this task end-to-end', 'dispatch and merge', or wants fully automated task execution with PR review."
visibility: public
allowed-tools: Bash, Read, Grep, Glob, Edit, Agent
argument-hint: "<task-id> [--node <nodeId>] [--backend claude_code|opencode] [--no-merge]"
---

# Monitored Dispatch Skill

Dispatch a task to an agent node, monitor it through completion, review the resulting PR, and merge it.

## Arguments

- `<task-id>` (required): The orch task ID to dispatch
- `--node <nodeId>`: Target a specific node (auto-selects if omitted)
- `--backend <backend>`: Agent backend, default `claude_code`
- `--no-merge`: Review the PR but don't merge it

## Workflow

Execute these steps in order. Report progress at each stage.

### Step 1: Validate the task

```bash
orch tasks show <TASK_ID> --json
```

Confirm the task exists and is in a dispatchable state (open or in_progress). Print the task title.

### Step 2: Dispatch

```bash
orch tasks dispatch <TASK_ID> --backend <BACKEND> --mode docker [--node <NODE_ID>] --json
```

Extract and save the `sessionId` from the response. Print: session ID, target node, backend.

### Step 3: Monitor to completion

Poll the session status every 30 seconds until it reaches a terminal state (`offline`, `error`).

```bash
orch sessions show <SESSION_ID> --json
```

At each poll:
- Print a brief status update only when the status changes
- If `working` for more than 10 minutes, print a "still working" message with elapsed time

When terminal:
- Print final status
- If `error`: print the last 500 chars of output and **stop here** — do not proceed to review
- If `offline`: proceed to Step 4

### Step 4: Review the PR

Extract the PR URL/number from the session's `lastOutput` (look for the JSON result line with `prUrl`).

If `status` is `no_changes`:
```bash
orch tasks progress <TASK_ID> "Agent completed with no changes. Session <SESSION_ID>." --json
orch tasks update <TASK_ID> --status completed --json
```
Stop here — no PR to review.

For PRs, review the code AND check for existing comments:
```bash
gh pr view <PR_NUMBER> --json title,additions,deletions,changedFiles,mergeable,state
gh pr diff <PR_NUMBER>
# Check for review comments (code-level)
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/comments
# Check for PR conversation comments (top-level)
gh api repos/<OWNER>/<REPO>/issues/<PR_NUMBER>/comments
# Check for reviews with comments
gh pr view <PR_NUMBER> --json reviews
```

Review the diff for:
- **Correctness**: Does it match the task requirements?
- **Quality**: Clean code, no obvious bugs, no security issues
- **Scope**: No unrelated changes or excessive modifications
- **Build**: If TypeScript/Rust files changed, run `./scripts/dev-build.sh check` to verify

If there are existing PR comments:
- Read and evaluate each comment
- If comments raise valid concerns, address them before merging (fix code or note why they're not applicable)
- Summarize comment handling in the review output

Print a brief review summary.

### Step 5: Merge (unless --no-merge)

If the review passes:
```bash
gh pr merge <PR_NUMBER> --merge --delete-branch
```

Then record the review on the orch task and complete it:
```bash
orch tasks progress <TASK_ID> "Reviewed PR #<N>: <additions> additions, <deletions> deletions, <changedFiles> file(s). <brief summary of changes>. <comment status>. Merged and branch deleted." --json
orch tasks update <TASK_ID> --status completed --json
git pull origin main
```

Print: "Merged PR #N, task completed."

If the review has issues, print the concerns and ask the user what to do instead of merging.

## Error Handling

- If dispatch fails, print the error and stop
- If the session errors out, print output and stop (do not try to find a PR)
- If the PR has merge conflicts, report them and stop
- If `gh pr merge` fails, print the error

## Important Notes

- The repo owner/name for `gh` commands can be detected from `git remote get-url origin`
- Always use `--json` flag with orch commands
- Parse the docker result JSON from the last line of session output starting with `{"status":`
- Sleep intervals should use `sleep 30` between polls
- Do NOT use `--get` flags when you need to parse multiple fields from the same response
