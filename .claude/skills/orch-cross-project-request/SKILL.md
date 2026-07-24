---
name: orch-cross-project-request
description: "Dependent/downstream side of a cross-project task conversation. From a project that depends on another, file a task against the UPSTREAM (owner) project to get an issue fixed, then monitor that task and converse back-and-forth (re-test, answer questions, confirm) until it's resolved. Use when the user says 'open a task on the upstream project', 'ask the owning project to fix this', 'file this cross-project and track it', 'drive a dependency fix to resolution', or sets up the requesting side of a dependent-project debugging loop. The owning side uses orch-cross-project-respond."
visibility: public
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, Skill, TaskCreate, TaskUpdate, Monitor
argument-hint: "<upstream project id> <short issue title>"
---

# Orch Cross-Project Request (dependent side)

Your project depends on another (the "upstream" / owner). You've hit an issue
that the upstream must fix. This skill is the **requester** half of a live
cross-project conversation: file one well-scoped task against the upstream, then
track it and talk back-and-forth until the issue is resolved. The other half is
`orch-cross-project-respond`.

## Mental model

```
YOUR project ──creates task──▶ upstream project
      ▲                              │
      └──── you re-test / reply ◀────┘   (loop until completed)
```

Everything happens on **one task** in the upstream project: its description, its
comments, its status. `orch tasks monitor <id>` is how you hear back.

## Identity & echo avoidance

Get your identity once so you don't react to your own comments:

```bash
orch login status --json --get user.id        # or user.username
```

Pass it as `--exclude-author <you>` on every monitor call. If unsure which exact
string the server stamps as the author, post one comment then run
`orch tasks show <taskId>` and use the author value shown on your own comment.

## Phase 1 — Find the upstream project + reproduce

- Resolve the upstream project id: `orch projects list --json` (or the user
  gives it). You'll pass it as `-p <upstreamProjectId>` on create.
- Nail the repro in your own project first: exact command, error output,
  expected vs actual, and the suspected upstream file/area. A vague task gets a
  slow, wrong fix.

## Phase 2 — File the task (the request)

Write a self-contained description to `.orchestrator/tasks/<slug>.md`:

- **Goal** — one sentence: what must change in the upstream.
- **Why** — the downstream impact (what's broken for you).
- **Repro** — exact steps/command + full error.
- **Expected vs actual.**
- **Suspected area** — upstream file/symbol if known (they shouldn't have to
  guess).
- **Acceptance criteria** — how they (and you) will know it's fixed.

Then create it on the **upstream** project and capture the id:

```bash
orch tasks create "<title>" -p <upstreamProjectId> --file .orchestrator/tasks/<slug>.md --get data.id
```

Record which of YOUR tasks this blocks (link it in your own tracker / a progress
note) so the dependency is visible.

## Phase 3 — Monitor + converse until resolved (loop + goal)

Block on the task and react to each update the upstream posts:

```bash
orch tasks monitor <taskId> --loop --exclude-author <you>
```

Each emitted update is a new comment (their question / "pushed a fix, re-test")
or a field change (status → in_progress / completed, a PR opened). For each:

- **"Please re-test / pushed fix"** → pull the upstream change, re-run your
  repro, and comment the result: `orch tasks comment <taskId> "Re-tested on <sha>:
  fixed ✅"` or `"Still failing — now <new error>"`.
- **A question** → answer it with a comment.
- **status = completed** → verify once more on your side, post thanks/confirm,
  and unblock your downstream work. **This is the goal — stop the loop.**

### Running it as a self-paced loop

For hands-off tracking, drive it with `/loop` and a clear goal:

> /loop monitor upstream task <taskId> with
> `orch tasks monitor <taskId> --loop --exclude-author <me>`; for each reply,
> re-test my repro and comment the result; stop when the task is `completed` and
> my repro passes.

The monitor blocks on real activity, so the loop won't spin.

## Rules

- One issue = one upstream task = one thread. Don't open duplicates; keep
  commenting on the original.
- Always include enough context in each comment for a fresh upstream session:
  the sha you tested, the exact command, the new output. They don't share your
  context.
- Don't mark the upstream task `completed` yourself — that's the owner's call.
  You **confirm**; they **close**. (If the owner asks you to close it, do so.)
- Re-test before you claim it's fixed. "Looks fixed" without running the repro
  wastes a round trip.

## Red flags

- The monitor wakes instantly and repeatedly → missing `--exclude-author`.
- You're about to file a second task because the first "went quiet" → comment on
  the first and let the monitor block instead.
- You're fixing the upstream's code yourself from the downstream repo → stop;
  that's what the task/owner is for (unless the user explicitly wants a PR to the
  upstream, which is a different flow).
