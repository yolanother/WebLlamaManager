---
name: orch-projects
description: "Manage orchestrator projects: list, link, configure, promote, and check project status. Use when the user mentions projects, project linking, local projects, temporary projects, project setup, init, or wants to see which project is linked."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "list | show <id> | link [id] | current | promote [id]"
---

# Project Management Skill

Manage orchestrator projects — list, link repos, and check project status.

## Commands

| Action | Command |
|--------|---------|
| List all projects | `orch projects list --json` |
| Show project details | `orch projects show <id> --json` |
| Link current repo | `orch projects link --json` |
| Link to specific project | `orch projects link <projectId> --json` |
| Show linked project | `orch projects current --json` |
| Promote local project | `orch projects promote [id] --json` |

## Project Init

Initialize a repo for orchestrator use (links project + installs skills + creates instruction file + configures MCP):

```bash
orch init --json                          # Full interactive setup
orch init --local --json                  # Create local project (no GitHub needed)
orch init --local --name "My Project" --json  # With custom name
orch init --skip-skills --json            # Skip skill installation
orch init --skip-mcp --json               # Skip MCP configuration
orch init --profile <slug> --json         # Use a specific instruction profile
orch init --dir <path> --json             # Initialize a different directory
```

## Local Projects

Create temporary/local projects without GitHub integration:

```bash
orch init --local --json                           # Create local project from current git repo
orch init --local --name "My Project" --json       # With custom name (defaults to directory name)
```

When `--local` is used:
- Auto-initializes git if the directory isn't a git repo
- Creates a project on the server with `isLocal: true`
- Links the repo to the new project
- Continues with normal init subsystems (skills, instructions, hooks, MCP)

### Promote a Local Project

Upgrade a local project to a full project:

```bash
orch projects promote --json                              # Promote the linked project
orch projects promote <id> --repository-url <url> --json  # With remote URL
```

## User Preferences

Manage local user preferences stored at `~/.orchestrator/preferences.json`:

```bash
orch config prefs set <key> <value>   # Set preference
orch config prefs get <key>           # Get preference
orch config prefs list                # List all preferences
orch config prefs delete <key>        # Delete preference
```

Known keys: `defaultProfile`, `defaultModelProvider`, `defaultDispatchBackend`, `defaultSubmitMode`, `defaultExecutionMode`

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine the project operation. Always use `--json` flag.

## Project Auto-Detection

The CLI auto-detects the linked project via (in priority order):
1. `-p` flag (explicit)
2. `ORCH_PROJECT_ID` env var
3. `~/.orchestrator/projects.json` (persisted link)
4. Git remote URL matching
5. Interactive prompt (TTY only)

## Output Guidelines

- For list: Show table of ID, name, repo URL
- For show: Show project details including linked repos and task counts
- For link: Confirm project linked with ID
- For current: Show the linked project name and ID
