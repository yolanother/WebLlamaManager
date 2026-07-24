---
name: orch-sessions
description: "Manage orchestrator sessions: list, inspect, and monitor AI agent sessions. Use when the user asks about running agents, active sessions, session status, agent output, or wants to dispatch a task to an agent node."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "list | show <id>"
---

# Session Management Skill

List and inspect orchestrator AI agent sessions.

## Commands

| Action | Command |
|--------|---------|
| List active sessions | `orch sessions list --json` |
| List all sessions | `orch sessions list --all --json` |
| Show session details | `orch sessions show <id> --json` |

## Task Dispatch

To dispatch a task as a new agent session, use the tasks dispatch command:

```bash
# Dispatch to any available node
orch tasks dispatch <taskId> --json

# Dispatch with specific backend
orch tasks dispatch <taskId> --backend opencode --json

# Dispatch in host mode (not Docker)
orch tasks dispatch <taskId> --mode host --json

# Dispatch to specific node
orch tasks dispatch <taskId> --node <nodeId> --json

# List available providers first
orch tasks dispatch <taskId> --list-providers
```

### Dispatch Options

| Flag | Description | Default |
|------|-------------|---------|
| `-b, --backend <backend>` | Agent backend (`claude_code`, `opencode`) | `claude_code` |
| `-m, --mode <mode>` | Execution mode (`docker`, `host`) | `docker` |
| `-n, --node <nodeId>` | Target node (auto-selects if omitted) | — |
| `--provider <provider>` | Model provider ID | auto |
| `--submit-mode <mode>` | `pr` or `direct` | — |

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine the session operation. Always use `--json` flag.

## Output Guidelines

- For list: Show table of ID, task title, status, node, duration
- For show: Show session details including task, node, backend, status, logs
- Don't dump raw JSON — extract and format the relevant data
