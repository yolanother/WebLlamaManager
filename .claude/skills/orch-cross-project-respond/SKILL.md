---
name: orch-cross-project-respond
description: "Owner/upstream side of a cross-project task conversation. Watch THIS project for incoming tasks (filed by a dependent project) and for new comments on tasks you're already working, then fix the issue and reply — in a back-and-forth loop until each task is resolved. Use when the user says 'watch this project for incoming work', 'respond to cross-project tasks', 'be the upstream responder', 'monitor my project and fix what comes in', or sets up the owning side of a dependent-project debugging loop. The requesting side uses orch-cross-project-request."
visibility: public
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, Skill, TaskUpdate, Monitor
argument-hint: "<this project's id or omit to use the linked project>"
---

# Orch Cross-Project Respond (owner side)

You own an upstream project. A dependent project files tasks against it when it
hits an issue your code must fix. This skill is the **responder** half of a live
cross-project conversation: watch for incoming work, fix it, reply, and keep
talking until the task is resolved. The other half is `orch-cross-project-request`.

## Mental model

```
dependent project ──creates task──▶ YOUR project
       ▲                                  │
       └──────── you comment / fix ◀──────┘   (loop until completed)
```

You communicate entirely through **one task** per issue: its status, its
comments, and its PR/review fields. `orch tasks monitor` is your inbox.

## Identity & echo avoidance

Find your identity once (so you don't react to your own messages):

```bash
orch login status --json --get user.id        # or user.username
```

Pass it as `--exclude-author <you>` to every monitor call. Without it the loop
wakes on its own replies and spins. If unsure which exact string the server
stamps as the author, post one comment then run `orch tasks show <id>` and use
the author value shown on your own comment.

## Phase 1 — Wait for incoming tasks

Resolve your project id (defaults to the linked project) and block until a new
task arrives:

```bash
orch tasks monitor -p <yourProjectId>            # one-shot: returns on first new task
orch tasks monitor -p <yourProjectId> --loop     # stream every new task
```

`monitor` (no task id) snapshots existing tasks and returns only tasks created
**after** it starts. Use `--json` if you're scripting the loop; the JSON is one
task object per new task.

## Phase 2 — Claim and work one task

For each incoming task:

1. **Claim it** so the requester sees progress:
   `orch tasks update <id> --status in_progress`
2. **Read the ask**: `orch tasks show <id>` — the description carries the repro,
   error, and acceptance criteria the requester wrote.
3. **Fix it** in a worktree (TDD; get the build/tests green) per this repo's
   normal flow. If you need more info, ask via a comment (Phase 3) and wait.
4. **Report back** with a comment as you go:
   `orch tasks comment <id> "Found the cause: … Pushed fix in <sha>. Can you re-test?"`

## Phase 3 — Converse until resolved (loop + goal)

After you reply, the requester will re-test and comment back. Watch that task
for their response and iterate:

```bash
orch tasks monitor <id> --loop --exclude-author <you>
```

Each emitted update is either a new comment (their reply) or a field change.
Read it, act (more fixes, clarifying questions, or "please verify"), comment,
and the monitor keeps streaming. **Goal:** drive the task to `completed`.

- When the fix is confirmed: `orch tasks update <id> --status completed` and post
  a closing comment.
- If you're blocked on the requester: comment what you need and let the monitor
  block until they answer — don't busy-poll.

### Running it as a self-paced loop

For a hands-off responder, drive the whole cycle with `/loop` and a goal:

> /loop watch project <yourProjectId> for new/updated cross-project tasks with
> `orch tasks monitor`; for each, claim → fix → comment → monitor for replies
> until the task is `completed`. Stop when there are no open cross-project tasks.

Use a poll cadence of a few seconds (`--poll-interval`) — the monitor already
blocks, so the loop only re-fires on real activity.

## Rules

- One task = one issue = one conversation thread. Don't open new tasks to reply;
  comment on the existing one.
- Always `--exclude-author <you>` so you never wake on your own comments.
- Move status deliberately: `in_progress` when you start, `completed` only when
  the requester has confirmed (or acceptance criteria are objectively met).
- Keep comments self-contained (sha, file:line, what you changed, what you need)
  — the requester's session has its own context, not yours.

## Red flags

- The loop fires immediately and repeatedly with no new content → you forgot
  `--exclude-author`, or you're monitoring without a baseline. Stop and re-arm.
- You're about to open a second task to "continue the discussion" → don't;
  comment on the original.
- You marked `completed` before the requester verified → reopen
  (`--status in_progress`) and confirm first.
