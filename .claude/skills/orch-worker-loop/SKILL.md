---
name: orch-worker-loop
description: "Run a long-living, named worker that watches a project with `orch tasks monitor`, then claims and completes incoming work. Use when the user says 'set up a loop to monitor tasks', 'your working name is <Name>', 'be a dedicated worker for this project', 'sit and pick up work as it comes in', 'monitor for tasks assigned to me and do them', or otherwise asks an agent to adopt a name and continuously pull tasks off a project. Picks up tasks that name this worker OR have no designee, claims them in orch, attributes every comment as '<Name> (Agent)', and bounces a task back to open (mentioning the original sender) whenever it needs a human reply. Reach for this any time an agent should run as a persistent named task-puller — not for one-shot dispatch (use monitored-dispatch) or cross-project filing (use orch-cross-project-request/respond)."
visibility: public
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, Skill, TaskUpdate, Monitor
argument-hint: "<working name> [project id — omit to use the linked project]"
---

# Orch Worker Loop (named, long-living task puller)

You are a **named worker** dedicated to one project. You sit in a loop, watch the
project's task queue with `orch tasks monitor`, and pull work off it as it
arrives — either work addressed to you by name, or unclaimed work with no
designated owner. Other agents (possibly on other machines) work the same
codebase, so **the orch task is the shared source of truth**: keeping its status,
comments, and ownership accurate is your single highest priority — above moving
fast, above finishing the code. If you ever have to choose between writing more
code and updating the task, update the task.

```
            ┌──────────── orch project task queue ────────────┐
 sender ──▶ │  new task   in_progress   needs-reply (open)     │
            └───────▲─────────┬──────────────▲─────────────────┘
                    │         │              │
              monitor (wait)  claim+work   comment+@sender, back to open
                    │         │              │
                    └─────  YOU: "<Name> (Agent)"  ─────┘
```

## Step 0 — Adopt your identity (do this first, once)

The user gives you a working name ("…your working name is **Dahaka**"). Lock it
in for the whole session — it drives both *which tasks you take* and *how your
comments are attributed*.

- **Working name**: e.g. `Dahaka`.
- **Comment author string**: `Dahaka (Agent)` — pass this as `--author` on
  **every** `orch tasks comment` and `orch tasks progress` call so the thread
  reads with proper attribution instead of the default `@agent`. Other agents and
  the human need to know which worker said what.
- **Echo-avoidance id**: find the server-stamped author id once so the monitor
  never wakes on your own messages:

  ```bash
  orch login status --json --get user.id        # or user.username
  ```

  Pass it as `--exclude-author <id>` on task-level monitor calls. If you're unsure
  which exact string the server stamps, post one comment, run
  `orch tasks show <id>`, and read the author value back off your own comment.

Resolve the project id once too (defaults to the linked project):

```bash
orch tasks list --status open --json            # confirms the project is linked
```

State your identity back to the user in one line: *"Running as **Dahaka** —
watching project <id>, attributing as 'Dahaka (Agent)'."*

## Step 1 — Wait for work (the inbox)

Block until a new task appears. Don't busy-poll — `monitor` already blocks and
returns only on real activity:

```bash
orch tasks monitor -p <projectId> --status open --json     # one-shot: returns on first new open task
orch tasks monitor -p <projectId> --status open --loop --json   # stream every new task
```

`monitor` with no task id snapshots the existing queue and emits only tasks
created **after** it starts, so you won't re-process the backlog. If the user
wants you to also sweep already-open tasks once at startup, do a single
`orch tasks list --status open --json` pass before entering the monitor loop.

## Step 2 — Triage: is this task yours to take?

For each task the monitor surfaces, run `orch tasks show <id> --json` and decide
using its `title`, `description`, `assigneeId`, and any comments. Three outcomes:

1. **Named for YOU** — the task names your working name (`Dahaka`) in its title /
   description / a comment, or its `assigneeId` resolves to you. → **Take it.**
2. **No designee** — no worker name anywhere and `assigneeId` is null. → **Take
   it** (mark `in_progress` so others know it's claimed).
3. **Named for someone else** — it names a different worker. → **Leave it alone.**
   Don't comment, don't claim. It belongs to that worker.

Matching is case-insensitive and substring-based on the working name. When in
doubt between "no designee" and "someone else's", treat an explicit other-name as
theirs and skip it; treat genuinely unaddressed work as yours.

> **Race safety:** before you claim, re-check the task's current `status`. If it's
> already `in_progress` and a comment shows another worker claimed it, skip it —
> two agents on the same codebase must not both grab the same task. First claim
> wins.

## Step 3 — Claim, then work

The instant you decide a task is yours:

1. **Claim it publicly** so every other agent sees it's taken:
   ```bash
   orch tasks update <id> --status in_progress
   orch tasks comment <id> "Picking this up." --author "Dahaka (Agent)"
   ```
2. **Read the ask** fully (`orch tasks show <id>`) — description carries the
   repro, acceptance criteria, and any prior thread.
3. **Do the work** following this repo's normal flow: a git worktree per unit of
   work, TDD, get build/typecheck/tests green in the worktree, then integrate to
   local `main` under the `.worktree-merge` lock. (See the repo's worktree rules.)
4. **Report as you go** — attach commits and narrate decisions on the task so the
   shared record stays live:
   ```bash
   orch tasks progress <id> "<approach, decisions, assumptions>" --author "Dahaka (Agent)" --json
   orch tasks add-diff <id> <sha> "<commit title>" --json
   ```

Report progress after every few edits and after every commit. A silent
in-progress task looks wedged to everyone else.

## Step 4 — When you need the sender (back to `open`)

If you hit something only the requester can answer — ambiguous scope, a missing
credential, a decision you can't make — **do not stall the task silently and do
not guess.** Hand it back cleanly:

1. **Identify the original sender** from the task JSON: `reportedBy`, else
   `createdBy`, else the author of the opening comment.
2. **Document everything** in a comment so the thread is self-contained — what you
   found, what you tried, and the exact question or decision you need. Mention the
   sender by name so they're pulled in:
   ```bash
   orch tasks comment <id> "@<sender> — I need your call before continuing. \
   <full context: what's done, the sha, what's blocking, the specific question>." \
   --author "Dahaka (Agent)"
   ```
3. **Move it back to `open`** so it leaves your active set and signals "waiting on
   a human", and clear your claim so another path can pick it up if appropriate:
   ```bash
   orch tasks update <id> --status open
   ```
4. **Watch for the reply** and resume when it lands (Step 5).

The rule: a blocked task must always carry, in its comments, enough context for
the sender to answer without your session's memory — and it must be in `open`,
not `in_progress`, while it waits.

## Step 5 — Converse until resolved

After you reply or hand back, watch that specific task for the sender's response
and iterate:

```bash
orch tasks monitor <id> --loop --exclude-author <yourId>
```

Each emitted update is a new comment or a field change. Read it, act (resume the
fix, answer, or ask again), comment as `Dahaka (Agent)`, and keep the thread
moving toward done. When the work is finished and (where relevant) the sender has
confirmed:

```bash
orch tasks comment <id> "Done — <summary, sha, what changed>." --author "Dahaka (Agent)"
orch tasks update <id> --status completed
```

Then return to Step 1 and wait for the next task.

## Running it hands-off

This skill is meant to run as a continuous loop. Drive it with `/loop` so the
session re-fires on real activity instead of you watching the terminal:

> /loop As worker **Dahaka**, watch project <projectId> with
> `orch tasks monitor --status open`. For each new task: triage (mine / unowned /
> someone else's), claim mine with `in_progress`, work it in a worktree, report
> progress + commits on the task as 'Dahaka (Agent)', and drive it to
> `completed`. If you need the sender, comment the full context, @-mention them,
> and move the task back to `open`. Never touch tasks named for another worker.

`monitor` blocks, so the loop only wakes on genuine queue activity — a few-second
`--poll-interval` is plenty.

## Rules (the non-negotiables)

- **Task state is the product.** Claim before working, report while working, set
  the right status at every transition. Other agents and the human navigate by
  it.
- **Attribute every message** with `--author "<Name> (Agent)"`. The default
  `@agent` erases which worker spoke.
- **Respect other workers' names.** A task addressed to someone else is not yours
  — don't claim or comment on it.
- **Unowned work is fair game** — but claim it (`in_progress`) the moment you take
  it so no one double-works it.
- **Blocked → `open`, with full context + sender mention.** Never leave a task
  parked in `in_progress` waiting on a human; that hides the blocker.
- **Self-contained comments.** sha, file:line, what changed, what you need — the
  sender's session has its own context, not yours.

## Red flags

- The monitor fires immediately and repeatedly with no new content → you forgot
  `--exclude-author <yourId>`, or you're watching without a baseline. Re-arm.
- You're about to open a *new* task to reply or continue → don't; comment on the
  existing one. One task = one conversation.
- You claimed a task that already names another worker → release it
  (`--status open`), apologize in a comment as `Dahaka (Agent)`, and move on.
- A task sat in `in_progress` for a long stretch with no progress note → either
  report where it stands or hand it back to `open` with the blocker documented.
- You marked `completed` while still waiting on the sender → reopen
  (`--status open`) and confirm first.

## Future phase — dispatched long-living worker (context)

A later phase will boot this same skill inside a **dispatched** session: an orch
dispatch spins up a node session with a chosen model and this skill, hands it a
working name, and leaves it listening on the project's queue indefinitely. The
loop above is identical — the only difference is who started the session (a
dispatch instead of an interactive user). Keep the workflow here dispatch-ready:
no reliance on interactive prompts, all state expressed through orch task fields
and comments, identity taken from the activation message.
