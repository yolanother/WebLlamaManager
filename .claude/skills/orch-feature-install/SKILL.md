# Install Feature Package

Focused skill for installing a feature package into the current project and working through the generated tasks.

## Quick Install

```bash
# Install and create tasks
orch features install <slug> --json

# Install and auto-dispatch to agent
orch features install <slug> --dispatch --json
```

## Working Through Tasks After Install

After installing, the feature creates orch tasks with detailed implementation prompts:

1. Check the parent task: `orch tasks show <parentTaskId> --json`
2. List subtasks: `orch tasks list --parent <parentTaskId> --json`
3. Work through subtasks in dependency order
4. Each subtask has a detailed prompt with:
   - Specific implementation instructions
   - Reference to the full integration prompt
   - Knowledge source references for context
5. Report progress: `orch tasks progress <taskId> "Completed: ..." --json`

## Knowledge Sources

Installed features may have ingested knowledge sources. Search them:
```bash
orch knowledge search "<feature-related query>" --json
```

## Check What's Installed

```bash
orch features installed --json
```
