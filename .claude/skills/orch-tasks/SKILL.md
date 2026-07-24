---
name: orch-tasks
description: "Manage orchestrator tasks: create, list, update, dispatch, and report progress. Use this skill whenever the user mentions tasks, bugs, work items, issues, dispatch, subtasks, or wants to check project status. Also triggers for 'what's open', 'create a bug', 'mark as done', 'assign to', 'dispatch this', or any task-related operation."
visibility: public
allowed-tools: Bash, Read, Write, Edit, Glob
context: fork
argument-hint: "list | show <id> | create <title> | update <id> | dispatch <id> | progress <id> <msg> | bug <title> | summary | batch-show <ids> | batch-update <ids> | delete <id>"
---

# Task Management Skill

Manage orchestrator tasks using the `orch` CLI. Run commands and summarize results concisely.

## Extracting Data with `--get` (REQUIRED)

**NEVER pipe orch output through `python3`, `jq`, or other parsers.** Use the global `--get <path>` flag:

```bash
# Extract specific fields (implicitly enables --json)
orch --get data.title tasks show <id>           # → task title as raw text
orch --get data.id tasks create "New task"      # → ID of newly created task
orch --get data.status tasks show <id>          # → "in_progress"
orch --get data.*.title tasks list --status open # → one title per line
orch --get data.length tasks list               # → count of tasks
orch --get data.0.id tasks list --status open   # → first task's ID
orch --get success tasks update <id> -s completed # → "true"

# Use in shell variables
TASK_ID=$(orch --get data.id tasks create "My task" 2>/dev/null)
```

## File-Based Descriptions (REQUIRED for long content)

**NEVER use heredocs or complex bash escaping for task descriptions.** Write to a file first:

```bash
# 1. Write description using Write/Edit tools to .orchestrator/tasks/<name>.md
# 2. Pass --file to create or update:
orch tasks create "My task" --file .orchestrator/tasks/my-feature.md --json
orch tasks update <id> --file .orchestrator/tasks/my-feature.md --json
orch tasks bug "Bug title" --file .orchestrator/tasks/bug-desc.md --json
```

## Quick Reference

| Action | Command |
|--------|---------|
| List open tasks | `orch tasks list --status open --json` |
| List all tasks | `orch tasks list --all --json` |
| Show task detail | `orch tasks show <id> --json` |
| Show with children | `orch tasks show <id> --children --json` |
| Create task | `orch tasks create "<title>" --json` |
| Create with file desc | `orch tasks create "<title>" --file <path> --json` |
| Create subtask | `orch tasks create "<title>" --parent <parentId> --json` |
| Create with deps | `orch tasks create "<title>" --depends-on <depId> --json` |
| Update status | `orch tasks update <id> --status in_progress --json` |
| Update description | `orch tasks update <id> --file <path> --json` |
| Complete task | `orch tasks update <id> --status completed --json` |
| Report progress | `orch tasks progress <id> "<message>" --json` |
| Report bug | `orch tasks bug "<title>" --json` |
| Extract field | `orch --get data.title tasks show <id>` |
| Extract from list | `orch --get data.*.title tasks list` |
| Count results | `orch --get data.length tasks list` |
| Summary | `orch tasks summary --json` |
| Summary by review | `orch tasks summary --by-review --json` |
| Batch show | `orch tasks batch-show <id1> <id2> --json` |
| Batch show (specs) | `orch tasks batch-show <id1> <id2> --specs --json` |
| Batch update | `orch tasks batch-update <id1> <id2> -s completed --json` |
| Dispatch to node | `orch tasks dispatch <id> --json` |
| Delete task | `orch tasks delete <id> --json` |
| Attach commit diff | `orch tasks add-diff <id> <sha> "<title>" --json` |

## Sandbox Connectivity Rule

Agent sandboxes can block localhost or host-network access even when the orchestrator server is up. If an `orch` command fails with `ECONNREFUSED`, `fetch failed`, `Failed to reach`, DNS/host resolution errors, or another localhost/network-looking failure:

1. Treat it as a sandbox connectivity issue first.
2. Rerun the same `orch` command outside the sandbox using the approved/escalated command path.
3. If the escalated command succeeds, continue using that path for required `orch` commands in the session.
4. If the escalated command also fails, then investigate server health (`csm-admin status`, service logs, dev-server scripts).
5. Record the conclusion with `orch tasks progress <taskId> "Decision: <sandbox/server conclusion>. Reason: <evidence>." --json`.

## Create Options

| Flag | Description |
|------|-------------|
| `-p, --project <id>` | Project ID (auto-detected if linked) |
| `-d, --description <text>` | Task description (inline, short only) |
| `--file <path>` | Read description from a markdown file (overrides -d) |
| `--priority <level>` | `critical`, `high`, `medium`, `low` |
| `--parent <taskId>` | Parent task ID (makes this a subtask) |
| `--assignee <id>` | Assignee ID |
| `--depends-on <ids>` | Comma-separated task IDs this depends on |

## Update Options

| Flag | Description |
|------|-------------|
| `-s, --status <status>` | `open`, `in_progress`, `completed` |
| `-d, --description <text>` | New description (inline, short only) |
| `--file <path>` | Read description from a markdown file (overrides -d) |
| `--title <text>` | New title |
| `--priority <level>` | `critical`, `high`, `medium`, `low` |
| `--depends-on <ids>` | Comma-separated task IDs (replaces existing) |
| `--review-status <status>` | `pending`, `passed`, `failed`, `needs_changes` |
| `--issue-type <type>` | `task`, `bug`, `feature`, `epic`, `chore` |

## List Filters

| Flag | Description |
|------|-------------|
| `-s, --status <status>` | `open`, `in_progress`, `completed` |
| `-r, --review-status <status>` | `pending`, `passed`, `failed`, `needs_changes` |
| `--parent <taskId>` | Filter by parent |
| `--issue-type <type>` | Comma-separated: `bug`, `feature`, `task`, `epic`, `chore` |
| `--assignee <id>` | Filter by assignee |
| `--all` | List from all projects |

## Dispatch Options

| Flag | Description | Default |
|------|-------------|---------|
| `-b, --backend <backend>` | `claude_code`, `opencode` | `claude_code` |
| `-m, --mode <mode>` | `docker`, `host` | `docker` |
| `-n, --node <nodeId>` | Target node | auto |
| `--provider <provider>` | Model provider ID | auto |
| `--submit-mode <mode>` | `pr`, `direct` | — |
| `--list-providers` | List available providers and exit | — |

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine which task operation to perform. Always use `--json` flag (or `--get` which implies it).

## Output Guidelines

- Summarize results concisely — don't dump raw JSON to the user
- For list commands: show a table of ID, title, status
- For create: confirm task created with ID and title
- For update: confirm what changed
- For progress: confirm progress recorded
- For dispatch: confirm task dispatched with session ID
