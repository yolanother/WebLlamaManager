---
name: orch-workflows
description: "Manage orchestrator workflows: create, update, list, and compose workflow steps. Workflows are reusable step-by-step processes referenced in instruction profiles via template variables. Use when the user mentions workflows, step-by-step processes, or template composition."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "list | show <slug> | create --slug <slug> --name <name> --file <path> | render <slug> | delete <slug>"
---

# Workflow Management Skill

Manage orchestrator workflows — reusable step-by-step processes that can be referenced in instruction profiles via `{{workflow:slug}}` template variables.

## Commands

| Action | Command |
|--------|---------|
| List workflows | `orch workflows list --json` |
| Show workflow | `orch workflows show <id-or-slug> --json` |
| Render as markdown | `orch workflows render <id-or-slug> --json` |
| Delete workflow(s) | `orch workflows delete <id-or-slug> --json` |

## Create Workflow

```bash
# From a markdown file (### N. Title sections become steps)
orch workflows create --slug my-workflow --name "My Workflow" --file steps.md --json

# With options
orch workflows create \
  --slug deploy-flow \
  --name "Deployment Flow" \
  --file deploy-steps.md \
  --description "Standard deployment process" \
  --category deployment \
  --scope global \
  --tags "deploy,ci" \
  --json
```

### Create Options

| Flag | Description |
|------|-------------|
| `--slug <slug>` | Unique identifier |
| `--name <name>` | Display name |
| `--file <path>` | Markdown file with steps (### N. Title sections) |
| `--description <desc>` | Workflow description |
| `--category <cat>` | `general`, `development`, `review`, `deployment`, `testing` |
| `--scope <scope>` | `global` or `project` |
| `--project <id>` | Project ID (for project-scoped) |
| `--tags <tags>` | Comma-separated tags |

## Template Variables

Workflows are referenced in instruction profiles via:
```
{{workflow:my-workflow-slug}}
```

This renders the workflow steps as numbered markdown sections at render time.

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine the workflow operation. Always use `--json` flag.

## Output Guidelines

- For list: Show table of slug, name, category, step count
- For show: Show workflow details with step summaries
- For render: Show the rendered markdown steps
- For create: Confirm workflow created with slug and step count
