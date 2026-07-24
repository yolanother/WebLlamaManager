---
name: orch-progress
description: "Quick progress reporting on orchestrator tasks. Fire-and-forget pattern for recording milestones, decisions, and commit references. Use when reporting what was done, logging a decision, noting a commit, flagging a blocker, or any 'update the task' request that doesn't change status."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "<taskId> <message>"
---

# Progress Reporting Skill

Report progress on orchestrator tasks. Minimal context footprint — fire-and-forget.

## Usage

```bash
orch tasks progress <taskId> "<message>" --json
```

## Message Patterns

| Pattern | Example |
|---------|---------|
| Milestone | `"Completed: DB schema. Next: API routes"` |
| Decision | `"Decision: Using JWT auth. Reason: simpler than sessions. Alternatives: session-based, OAuth-only"` |
| Commit | `"Committed abc1234: Add user authentication routes"` |
| Bug found | `"Bug found: race condition in dispatch. Created task <id>"` |
| Blocker | `"Blocked: waiting on API spec from team. Pausing implementation"` |

## How to Use

Parse `$ARGUMENTS` as `<taskId> <message>` and run the progress command.

Report success briefly: "Progress recorded on task <id>."
