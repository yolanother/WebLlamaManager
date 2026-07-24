---
name: orch-create-feature
description: "Analyze a project's implementation to auto-generate a feature package definition. Use when: user says 'create feature from project', 'extract feature', 'generate feature package', 'package this as a feature', 'feature from code', or wants to turn existing functionality into a reusable feature package."
visibility: public
allowed-tools: Bash, Read, Glob, Grep, Agent, Write, Edit
argument-hint: "[feature-name] [--scope <file-patterns>]"
---

# Create Feature Package from Project Analysis

Analyze existing project code and documentation to generate a reusable feature package definition that can be installed into other projects via the orchestrator.

## Feature Package Structure

A feature package consists of:
- **Integration prompt**: Detailed instructions for an agent to implement the feature
- **Knowledge sources**: Documentation, repos, and references for context
- **Task templates**: Pre-defined implementation tasks with prompts
- **Config additions**: Instruction profile sections to add
- **Skill/workflow refs**: Associated skills and workflows
- **Compatibility**: Required frameworks and languages
- **Verification**: Checks to confirm correct installation

## Process

### 1. Identify the Feature Scope

Ask the user (or infer from arguments) what functionality to extract:
- A specific subsystem (e.g., "auth", "payments", "notifications")
- A cross-cutting concern (e.g., "logging", "error handling", "testing")
- A full stack slice (e.g., "user management" = DB + API + UI)

### 2. Analyze Implementation

Examine the relevant code to understand:

```bash
# Find relevant files by pattern
find . -type f -name "*.ts" -o -name "*.tsx" | xargs grep -l "<feature-keyword>" | head -30

# Check for related tests
find . -path "*/test*" -name "*<feature>*" -o -path "*__tests__*" -name "*<feature>*"

# Check for related config sections
grep -r "<feature>" CLAUDE.md .claude/ 2>/dev/null

# Check for related design docs
ls docs/Designs/*<feature>* 2>/dev/null
```

Map out:
- **Files involved**: Schema, services, routes, components, tests
- **Dependencies**: npm packages, system dependencies
- **Configuration**: Environment variables, settings, config sections
- **API surface**: Routes, endpoints, events

### 3. Generate Integration Prompt

Write a comprehensive markdown prompt that tells an agent how to implement this feature in a new project. Include:

- **Overview**: What the feature does and why
- **Prerequisites**: What must exist before this feature is added
- **Architecture**: How the components fit together
- **Step-by-step guide**: Detailed implementation instructions
- **Configuration**: Required env vars, settings, config
- **Testing**: How to verify the feature works
- **Common issues**: Known gotchas and workarounds

The integration prompt should be self-contained — an agent reading it should be able to implement the feature without any other context.

### 4. Define Knowledge Sources

Identify documentation that would help an agent implement the feature:

```json
{
  "knowledgeSources": [
    {
      "type": "url",
      "uri": "https://docs.example.com/feature-docs",
      "description": "Official documentation for the feature's main dependency",
      "ingestOnInstall": true
    },
    {
      "type": "github_repo",
      "uri": "https://github.com/org/reference-impl",
      "description": "Reference implementation to follow",
      "ingestOnInstall": false
    }
  ]
}
```

### 5. Create Task Templates

Break the implementation into ordered tasks:

```json
{
  "taskTemplates": [
    {
      "title": "Add database schema for <feature>",
      "prompt": "Create the database schema...\n\nRefer to the integration prompt...",
      "priority": "high",
      "estimatedEffort": "small"
    },
    {
      "title": "Implement <feature> service layer",
      "prompt": "Create the service...",
      "dependsOn": ["Add database schema for <feature>"],
      "priority": "high",
      "estimatedEffort": "medium"
    }
  ]
}
```

Tasks should:
- Follow dependency order (schema -> service -> routes -> UI)
- Be independently completable
- Have detailed prompts with specific file paths and code patterns
- Reference the integration prompt for context

### 6. Define Config Additions

If the feature needs instruction profile sections:

```json
{
  "configAdditions": [
    {
      "sectionSlug": "feature-guidelines",
      "content": "## <Feature> Guidelines\n\n...",
      "action": "create"
    }
  ]
}
```

### 7. Define Compatibility

```json
{
  "compatibility": {
    "frameworks": ["react", "fastify"],
    "languages": ["typescript"],
    "requiredFeatures": ["auth"]
  }
}
```

### 8. Define Verification Checks

```json
{
  "verification": {
    "expectedPatterns": [
      {
        "description": "Schema file exists",
        "type": "file_exists",
        "target": "src/db/schema/<feature>.ts"
      },
      {
        "description": "Route registered",
        "type": "file_contains",
        "target": "src/server/routes/index.ts",
        "pattern": "<feature>Routes"
      },
      {
        "description": "Required dependency installed",
        "type": "dependency_installed",
        "target": "<package-name>"
      }
    ],
    "healthChecks": [
      {
        "command": "curl -s http://localhost:5174/api/v1/<feature> | jq .success",
        "expectedOutput": "true"
      }
    ]
  }
}
```

### 9. Assemble and Register

Write the complete feature definition:

```bash
# Write definition to temp file
cat > .orchestrator/tasks/feature-def.json << 'FEATURE_EOF'
{
  "slug": "<feature-slug>",
  "name": "<Feature Name>",
  "description": "<one-line description>",
  "category": "<category>",
  "tags": ["<tags>"],
  "definition": {
    "integrationPrompt": "<full markdown prompt>",
    "knowledgeSources": [...],
    "taskTemplates": [...],
    "configAdditions": [...],
    "skillSlugs": [],
    "workflowSlugs": [],
    "compatibility": {...},
    "verification": {...}
  }
}
FEATURE_EOF

# Create via CLI
orch features create "<name>" --file .orchestrator/tasks/feature-def.json --json
```

## Output

Present the generated feature package to the user for review:
1. Show feature name, description, category
2. List the task templates with dependency order
3. Show knowledge sources
4. Display compatibility requirements
5. Preview the integration prompt (first ~20 lines + summary)
6. Show verification checks
7. Ask for confirmation before creating

## Tips

- The integration prompt is the most important part — it must be thorough and self-contained
- Task templates should mirror how the feature was actually built (check git history)
- Include all environment variables and configuration needed
- Knowledge sources should point to stable, up-to-date references
- Verification checks should be fast and reliable
- If the feature has learnings (gotchas), include them in the integration prompt
- Check `orch features list --json` for existing features to avoid duplication
