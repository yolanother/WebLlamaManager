# Feature Packages

Browse, search, and manage feature packages -- reusable integration recipes that can be installed into orchestrator projects.

## Commands

### Browse Features
```bash
orch features list --json                    # All available
orch features list --category auth --json    # By category
orch features list --tag nextjs --json       # By tag
orch features search "clerk auth" --json     # Text search
orch features show <slug> --json             # Full details
```

### Install Features
```bash
orch features install <slug> --json                # Install into current project
orch features install <slug> --dispatch --json     # Install + dispatch tasks
orch features installed --json                     # List installed in current project
orch features uninstall <slug> --json              # Remove installation tracking
```

### Author Features (admin)
```bash
orch features create --file <path> --json    # Create from JSON definition file
orch features update <id> --file <path> --json
orch features delete <id> --json
```

## What Installation Does

When a feature is installed into a project:
1. Creates a parent orch task with the integration prompt
2. Creates subtasks from the feature's task templates (with dependencies)
3. Ingests knowledge sources (docs, repos) into the project's knowledge base
4. Applies config section additions to the project's instruction profile
5. Installs referenced skills and workflows
6. Optionally dispatches tasks to agent nodes (with `--dispatch`)

## Feature Definition Format

A feature package JSON file contains:
- `slug`, `name`, `description`, `category`, `tags`
- `definition.integrationPrompt` -- Main markdown instructions for agents
- `definition.taskTemplates[]` -- Tasks to create on install
- `definition.knowledgeSources[]` -- Docs/repos to ingest
- `definition.configAdditions[]` -- Config sections to add/modify
- `definition.skillSlugs[]`, `definition.workflowSlugs[]`
- `definition.compatibility` -- Framework/language requirements
