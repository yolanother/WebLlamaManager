---
name: orch-query
description: "Query orchestrator system state: sessions, nodes, models, routing, config, reports, and health checks. Provides structured summaries. Use for 'what's the system status', 'show me connected nodes', 'what models are available', 'check routing rules', or any system monitoring query."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "sessions | nodes | models | routing | config | reports | status"
---

# Orchestrator System Query Skill

Query the orchestrator API for system status, configuration, and debugging information.

## Sessions & Nodes

| Query | Command |
|-------|---------|
| Active sessions | `orch sessions list --json` |
| All sessions | `orch sessions list --all --json` |
| Session detail | `orch sessions show <id> --json` |
| Connected nodes | `orch nodes list --json` |
| Node detail | `orch nodes show <id> --json` |

## Models & Routing

| Query | Command |
|-------|---------|
| Model providers | `orch models providers --json` |
| Provider detail | `orch models show <id> --json` |
| Routing rules | `orch models routing --json` |

## Configuration

| Query | Command |
|-------|---------|
| List config sections | `orch config sections list --json` |
| Show section | `orch config sections show <slug> --json` |
| Render full config | `orch config render --json` |

## Reports

| Query | Command |
|-------|---------|
| List reports | `orch reports list --json` |
| Show report | `orch reports show <id> --json` |
| Show with entries | `orch reports show <id> --entries --json` |
| Show with summary | `orch reports show <id> --summary --json` |
| Create report | `orch reports create "<title>" --json` |
| Complete report | `orch reports complete <id> --json` |
| Delete report | `orch reports delete <id> --json` |

## Server Status

| Query | Command |
|-------|---------|
| Server status | `orch status --json` |
| Auth check | `orch auth status --json` |

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine the query. Always use `--json` flag.

## Output Guidelines

- Summarize results in a human-readable format
- For sessions: show ID, project, status, duration
- For nodes: show ID, name, status, connected backends
- For models: show provider, tier, status
- For config: show section slug, category, scope
- For reports: show title, status, pass/fail counts
- Don't dump raw JSON — extract and format the relevant data
