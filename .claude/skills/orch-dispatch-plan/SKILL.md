---
name: orch-dispatch-plan
description: "Convenience entry-point for dispatching an already-designed chunk of work to orch workers. Use when the user has already decided the tasks (in conversation, in a plan doc, or in .orchestrator/tasks/*.md files) and just wants to kick off the create-tasks → dispatch → review cycle without walking through requirements/recon again. Triggers on 'dispatch this plan', 'kick off the tasks', 'let's run these', 'send these to agents', 'dispatch what we designed', 'ship this plan', or any request to operationalize an existing plan. If the plan isn't decided yet, use orch-interactive-design-and-implement instead (that one handles the design phase)."
visibility: public
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, Skill, TaskCreate, TaskUpdate, Monitor
argument-hint: "<slug or short name for the plan, or omit and infer from conversation>"
---

# Orch Dispatch Plan

Turn an already-designed chunk of work into tracked orch tasks and
dispatch them. This skill **starts from a decided plan** — it does not
interview, recon, or design. If any of those are still open, use
`orch-interactive-design-and-implement` instead.

## When to use

- The user (or you and the user in this session) have already talked
  through what needs to be built.
- There are already task description drafts in `.orchestrator/tasks/`,
  or at minimum a clear enumeration of tasks with file scopes.
- The user says "dispatch this", "ship these", "kick it off", "run these
  tasks".

## When NOT to use

- Requirements are still fuzzy — use `orch-interactive-design-and-implement`.
- The work is a single-file fix — just edit directly.
- You're about to rewrite the plan from scratch — that's design, not
  dispatch.

## Principles

This skill inherits every principle from
`orch-interactive-design-and-implement`:
- One command at a time; no clever bash. No `for` loops over `orch tasks
  create`. No `$(...)` nesting to compose ids.
- Run autonomously after plan sign-off. Don't ask permission for each
  task-create / dispatch / merge step.
- Workers start with zero context — task descriptions must be
  self-contained with file paths, line refs, and explicit acceptance
  criteria.
- Parallelize by file, serialize by conflict (`--depends-on`).
- Worker hygiene boilerplate on every leaf task.

If any of the above sounds unfamiliar, read the main skill before
continuing.

---

## Workflow

### 1. Pin down the plan shape

Quick audit — answer four questions before creating anything:

- **Working branch name.** Every leaf's PR targets this.
- **Epic title + one-sentence goal.**
- **Leaf tasks.** For each: title, 1-3 target files, dependencies on
  other leaves.
- **Where are the task descriptions?** Either already in
  `.orchestrator/tasks/<slug>.md` files, or you need to write them
  next.

If any of the four is vague, stop and pin it down before creating
anything. A dispatched worker can't recover from a fuzzy task
description.

### 2. Write missing task descriptions

If the user already wrote `.orchestrator/tasks/<slug>.md` files with
the required structure (Goal, Why, Working branch, Files to touch,
Reference files, Acceptance, Worker hygiene), skip this step.

Otherwise, write one `.md` file per leaf task using the structure in
the main skill's section 5. Each file must end with the worker-hygiene
boilerplate block from the main skill.

Do not write a `for` loop that generates files. Write each file
explicitly with the Write tool. It's 4 tool calls for 4 tasks — that's
fine.

### 3. Create the working branch (if not already created)

```bash
git checkout -b feat/<slug> origin/main
git push -u origin feat/<slug>
```

Skip if the branch already exists.

### 4. Create the epic

```bash
orch tasks create "<epic title>" --file .orchestrator/tasks/<epic>.md --priority medium --get data.id
```

Capture the id. Paste the literal value into subsequent commands; don't
try to thread it through bash variables across tool calls.

### 5. Create each leaf — one command per leaf

No loops. One `orch tasks create` line per task, filled in with the
literal epic id from step 4:

```bash
orch tasks create "DM-1: …" --parent <epicId> --file .orchestrator/tasks/dm-1.md --priority high --get data.id
orch tasks create "DM-2: …" --parent <epicId> --file .orchestrator/tasks/dm-2.md --priority high --get data.id
orch tasks create "DM-3: …" --parent <epicId> --file .orchestrator/tasks/dm-3.md --priority medium --get data.id
# ...one line per task
```

Collect the returned ids as you go. Paste them literally into the
dependency step below.

### 6. Wire dependencies

One `orch tasks update` per edge:

```bash
orch tasks update <dm-2-id> --depends-on <dm-1-id>
orch tasks update <dm-3-id> --depends-on <dm-2-id>
```

### 7. Dispatch — prefer cascade

If the cascade dispatcher is available on the server (CD-1/2/3 landed
on your orch), set the epic's dispatch config and dispatch the epic
itself — the server will walk leaves as their deps clear:

```bash
orch tasks update <epicId> --dispatch-config '{"cascade":true,"node":"<nodeId>","backend":"claude_code","mode":"docker","submitMode":"pr"}'
orch tasks dispatch <epicId> -n <nodeId> -b claude_code -m docker --submit-mode pr
```

Otherwise, dispatch the deps-free leaves explicitly. One command per
leaf, in a single message for the ones that are truly independent:

```bash
orch tasks dispatch <tsk_dm1> -n <nodeId> -b claude_code -m docker --submit-mode pr
orch tasks dispatch <tsk_dm2> -n <nodeId> -b claude_code -m docker --submit-mode pr
```

Do not write a watcher loop. For blocked leaves, re-check on the next
user turn or use `orch tasks wait <id>` on a specific leaf when you
need to sequence the next dispatch behind it.

### 8. Review + merge

As each leaf lands `in_review`:

```bash
orch tasks merge <leafId> --dry-run   # show the plan
orch tasks merge <leafId>             # do it
```

`orch tasks merge` audits the PR's file scope against the task's
"Files to touch", picks cherry-pick vs straight-merge automatically,
rebases the base branch if needed, and marks the task completed.

**Merge & salvage checklist** — what `orch tasks merge` does for you, and
what to verify / fall back to when it refuses an edge case:

1. **Audit PR file scope** against the task's "Files to touch". If the PR
   bled extra files (a common dirty-mount symptom), do NOT merge as-is —
   cherry-pick only the in-scope files (step 4) and close the PR.
2. **Rebase the base branch** onto the working branch if it has drifted,
   so the merge is conflict-free.
3. **Merge or cherry-pick**, then **mark the task `completed`**
   (`orch tasks update <leafId> --status completed`).
4. **Salvage fallback** when `orch tasks merge` refuses, or the worker's
   branch push was corrupted (the `wl` pre-push hook wipes the tree in
   fresh worktrees — see memory). From the **main worktree**, cherry-pick
   the worker's commits by SHA onto the working branch one at a time, then
   build/verify and mark the task completed manually. Do not rely on the
   worktree's own push.

If the deliverable is missing entirely, the real work may be stranded in a
nested worktree — see the "nested-worktree trap" salvage steps in the main
skill.

### 9. Final PR

When every leaf is merged and the build is green on the working
branch:

```bash
gh pr create --base main --head feat/<slug> \
  --title "feat: <feature>" \
  --body "<summary + test plan>"
```

Hand to the user for final review.

---

## Decision tree

```
User asks to dispatch / ship / kick off an already-designed plan
  ↓
Is the plan decided?       → no → switch to orch-interactive-design-and-implement
  ↓ yes
All four pins set?         → no → pin them (branch, epic, leaves, task-desc location)
  ↓ yes
Write missing task .md files (one at a time, no loops)
  ↓
Create working branch (or skip if exists)
  ↓
Create epic, then each leaf (one command per task)
  ↓
Wire --depends-on edges
  ↓
Dispatch — prefer cascade epic; manual per-leaf as fallback
  ↓
For each leaf PR: `orch tasks merge <id>`
  ↓
Final PR feat/<slug> → main
```

---

## Red flags — stop and think

- You're about to write a bash loop to create tasks. Stop — write each
  command explicitly. The loop is a bug waiting to happen.
- A leaf task description has no "Files to touch" section. The worker
  will write out of scope. Fix the description before dispatch.
- Two leaves touch the same file with no `--depends-on` between them.
  You're about to ship a merge conflict. Fix the DAG.
- The plan keeps evolving mid-dispatch. Stop dispatching; finish the
  design pass first.

See `orch-interactive-design-and-implement` for the full workflow
including requirements interview, recon subagent, task description
template, utility commands reference, and edge cases (nested-worktree
trap, dirty-mount bleed, stale dispatches).
