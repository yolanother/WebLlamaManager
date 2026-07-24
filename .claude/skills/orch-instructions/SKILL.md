---
name: orch-instructions
description: "Manage instruction profiles, config sections, and sync. Create, render, and deploy instruction configurations for CLAUDE.md, AGENTS.md, and other tool targets. Use when the user asks about instruction profiles, config sections, CLAUDE.md management, syncing instructions, or managing what goes into agent instruction files."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "list | show <slug> | render <slug> | search <query> | sync | sections list | sections show <slug> | user show | user set"
---

# Instruction Profiles & Sync Skill

Manage instruction profiles (composable CLAUDE.md/AGENTS.md configs), config sections, and synchronization.

## Instruction Profiles

| Action | Command |
|--------|---------|
| List profiles | `orch instructions list --json` |
| Show profile | `orch instructions show <id-or-slug> --json` |
| Create profile | `orch instructions create --slug <slug> --name "<name>" --tool-target claude_code --json` |
| Update profile | `orch instructions update <id-or-slug> --name "<name>" --json` |
| Render to markdown | `orch instructions render <slug> --json` |
| Search content | `orch instructions search "<query>" --json` |
| Delete profile(s) | `orch instructions delete <id-or-slug> --json` |

## Config Sections (CLAUDE.md Blocks)

Config sections are the building blocks of instruction profiles. Each section has a slug, content, category, and scope.

| Action | Command |
|--------|---------|
| List sections | `orch config sections list --json` |
| Show section | `orch config sections show <slug> --json` |
| Create section | `orch config sections create --slug <slug> --name "<name>" --category <cat> --file <path> --json` |
| Update section | `orch config sections update <slug> --file <path> --json` |
| Render full config | `orch config render --json` |

### Section Categories
`workflow`, `safety`, `tools`, `reporting`, `documentation`, `custom`, `user-instructions`

### Section Scopes
`global` (all projects), `project` (specific project), `user` (personal)

## User Instructions

| Action | Command |
|--------|---------|
| Show your instructions | `orch instructions user show --json` |
| Set from file | `orch instructions user set --file <path> --json` |
| Set from stdin | `echo "content" \| orch instructions user set --json` |

## Sync

| Action | Command |
|--------|---------|
| Sync with server | `orch sync --json` |
| Sync specific profile | `orch sync --profile <slug> --json` |
| Preview changes | `orch sync --dry-run --json` |
| Force sync | `orch sync --force --json` |

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine the operation. Always use `--json` flag.

## Output Guidelines

- For list: Show table of slug, name, tool target, active status
- For render: Show the rendered markdown (or summarize its sections)
- For sync: Report what changed (created/updated/skipped)
- For sections: Show slug, category, scope, active status
