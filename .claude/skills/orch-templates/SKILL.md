---
name: orch-templates
description: "Browse, search, and manage project templates — reusable compositions of feature packages + project configuration. Use when: user says 'browse templates', 'list templates', 'show template', 'search templates', 'create template', 'template marketplace', 'template categories', 'delete template', 'update template', 'template plan'."
visibility: public
allowed-tools: Bash, Read, Write, Edit, Glob
context: fork
argument-hint: "list | show <slug> | search <query> | create <name> | update <id> | delete <id> | plan <slug> | apply <slug>"
---

# Project Templates Skill

Browse, search, and manage project templates using the `orch` CLI. Templates are compositions of feature packages + project configuration that can be applied to projects.

## Commands

### Browse & Search Templates

```bash
orch templates list --json                        # All available templates
orch templates list --category backend --json     # Filter by category
orch templates show <slug> --json                 # Full template details
orch templates search "nextjs saas" --json        # Text search
```

### Create Templates (admin)

```bash
orch templates create "My Template" --file <path-to-definition.json> --json
```

The definition file should be a JSON file containing:
- `slug`, `name`, `description`, `category`, `tags`
- `definition.featureRefs[]` — feature slugs + config overrides
- `definition.scaffolding` — files/directories to create
- `definition.projectDefaults` — default project configuration
- `definition.configTemplate` — instruction profile template

### Update Templates

```bash
orch templates update <id> --file <path-to-definition.json> --json
```

### Delete Templates

```bash
orch templates delete <id> --json
```

### Generate Plan (preview before apply)

```bash
orch templates plan <slug> --project <id> --json
```

Shows what will happen without making changes:
- Features to install vs already installed
- Scaffolding actions (files/directories to create)
- Config changes to apply
- Project defaults diff (from → to)
- Estimated task count

### Apply Template

```bash
orch templates apply <slug> --project <id> --json
orch templates apply <slug> --project <id> --skip-optional --json
```

Generates a plan, shows it for confirmation, then executes:
1. Installs feature packages (creates tasks + ingests knowledge)
2. Runs scaffolding actions
3. Applies config changes
4. Sets project defaults

### Template Metadata

```bash
# These are useful for discovering available categories and tags
orch --get data templates list --json   # Raw template data
```

## Extracting Data with `--get`

```bash
orch --get data.*.name templates list                    # All template names
orch --get data.*.slug templates list                    # All template slugs
orch --get data.length templates list                    # Count templates
orch --get data.definition templates show <slug>         # Just the definition
orch --get data.id templates create "New Template"       # ID of newly created
```

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine which template operation to perform. Always use `--json` flag (or `--get` which implies it).

## Output Guidelines

- Summarize results concisely — don't dump raw JSON
- For list: show a table of slug, name, category, feature count
- For show: display name, description, features included, and scaffolding summary
- For search: show matching templates with relevance
- For plan: pretty-print the plan steps with clear before/after
- For apply: show real-time progress of each step
- For create/update/delete: confirm the action with ID
