---
name: orch-template-apply
description: "Guided flow for applying a project template to create or configure a project. Use when: user says 'apply template', 'use template', 'scaffold project', 'new project from template', 'init with template', 'start project with template', 'create project from template', 'template wizard'."
visibility: public
allowed-tools: Bash, Read, Write, Edit, Glob
context: fork
argument-hint: "<template-slug> | --wizard"
---

# Apply Template Skill

Guided flow for applying a project template. There are three entry points depending on the user's situation.

## Entry Point 1: Apply to Existing Project

Use when the project already exists in orchestrator.

```bash
# Step 1: Generate and review the plan
orch templates plan <slug> --project <projectId> --json

# Step 2: Review the plan output — it shows:
#   - Features to install (new vs already installed)
#   - Scaffolding actions (files/dirs to create)
#   - Config changes
#   - Project defaults changes
#   - Estimated task count

# Step 3: Apply the template
orch templates apply <slug> --project <projectId> --json

# Step 4: Check created tasks
orch tasks list --status open --json
```

## Entry Point 2: Create New Project with Template

Use when starting a brand new project.

```bash
# Step 1: Create the project with a template in one command
orch projects new --name "My App" --template <slug> --json

# This will:
#   1. Create the project
#   2. Generate a template plan
#   3. Show the plan for review
#   4. On confirmation, execute the plan
#   5. Return project ID + created tasks

# Step 2: Link the local repo (if local project)
orch projects new --name "My App" --template <slug> --local --json

# Step 3: Start working through tasks
orch tasks list --status open --json
```

## Entry Point 3: Init Repository with Template

Use when initializing an existing repo as an orchestrator project.

```bash
# Option A: With a known template slug
orch init --template <slug>
# This will:
#   1. Detect repo, create project, link it
#   2. Generate template plan (skips scaffolding for existing files, detects installed features)
#   3. Show plan for review
#   4. On confirmation, execute plan

# Option B: With wizard (browse templates in web UI)
orch init --wizard
# This will:
#   1. Run normal init flow
#   2. Open browser to /templates page with project pre-selected
#   3. User selects template and completes wizard in web UI
```

## Plan Review Step

**Always review the plan before applying.** The plan shows exactly what will change:

```bash
# Generate plan without applying
orch templates plan <slug> --project <projectId> --json
```

The plan output includes:
- **Features to install**: List of feature packages with their slugs and names
- **Already installed**: Features that will be skipped (already present)
- **Scaffolding**: Files and directories to be created
- **Config changes**: Instruction profile sections to add/modify
- **Defaults changes**: Project settings that will change (shows before → after)
- **Task estimate**: How many orch tasks will be created

If the plan looks wrong, adjust by:
- Using `--skip-optional` to skip optional features
- Applying a different template
- Manually installing individual features instead: `orch features install <slug> --json`

## After Application

Once a template is applied:

1. **Work through tasks**: `orch tasks list --status open --json`
2. **Check feature status**: `orch features installed --json`
3. **Search knowledge**: `orch knowledge search "<feature topic>" --json`
4. **Verify features**: `orch features verify --project <projectId> --json`

## Skipping Optional Features

```bash
# Apply only required features, skip optional ones
orch templates apply <slug> --project <projectId> --skip-optional --json
```

## How to Use

Determine the user's situation:
1. **Has existing project?** → Entry Point 1 (apply)
2. **Starting fresh, no repo?** → Entry Point 2 (projects new)
3. **Has repo, not linked?** → Entry Point 3 (init)

Always show the plan and get confirmation before executing.
