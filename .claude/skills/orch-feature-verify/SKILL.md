---
name: orch-feature-verify
description: "Run feature verification checks to ensure installed features are healthy and correctly configured. Use when: user says 'verify feature', 'check feature health', 'run verification', 'feature health check', 'verify installation', 'check features', 'feature status', 'are features working'."
visibility: public
allowed-tools: Bash, Read, Write, Edit, Glob
context: fork
argument-hint: "<installationId> | --project <id> | --all"
---

# Feature Verification Skill

Run verification checks on installed feature packages to ensure they are healthy and correctly configured. Verification uses a three-level system: pattern checks, health checks, and agent verification.

## Commands

### Verify Single Installation

```bash
orch features verify <installationId> --json
```

Runs all verification checks for a single feature installation.

### Verify All Features in Project

```bash
orch features verify --project <projectId> --json
```

Runs verification across all installed features in the project.

### Check Installed Features

```bash
orch features installed --json
```

Lists all installed features with their installation IDs (needed for single verification).

## Interpreting Results

The verification result contains three levels of checks:

### Level 1: Pattern Checks (automated)
- Checks if expected files/patterns exist in the codebase
- Verifies configuration files are present and correctly structured
- Reports: `pass`, `fail`, or `skip` (if no patterns defined)

### Level 2: Health Checks (automated)
- Runs defined health check commands (e.g., test suites, linting)
- Validates runtime behavior and integration points
- Reports: `pass`, `fail`, `error`, or `skip`

### Level 3: Agent Verification (dispatched)
- Dispatches an agent to perform deeper verification
- Agent reviews code quality, integration correctness, edge cases
- Reports: `pass`, `fail`, `needs_review`, or `skip`

### Result Structure

Each check in the result includes:
- **name**: What was checked
- **level**: `pattern`, `health`, or `agent`
- **status**: `pass`, `fail`, `error`, `skip`, or `needs_review`
- **message**: Human-readable explanation
- **details**: Additional context (file paths, error output, etc.)

### Overall Status

The overall verification status is determined by the worst individual check:
- All pass → `healthy`
- Any needs_review → `needs_review`
- Any fail → `unhealthy`
- Any error → `error`

## Common Workflows

### After Template Application

```bash
# Apply template, then verify everything installed correctly
orch templates apply <slug> --project <projectId> --json
orch features verify --project <projectId> --json
```

### Periodic Health Check

```bash
# Run project-wide verification to catch drift
orch features verify --project <projectId> --json
```

### Debugging a Failed Feature

```bash
# Check what's installed
orch features installed --json

# Verify the specific feature
orch features verify <installationId> --json

# Look at the detailed check results for failures
# Fix issues based on the failure messages
# Re-verify
orch features verify <installationId> --json
```

## Feature Updates

When verification fails due to outdated features, check for pending updates:

```bash
# List pending feature updates
orch features updates --project <projectId> --json

# Approve a pending update
orch features updates approve <updateId> --json

# Reject an update
orch features updates reject <updateId> --json
```

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine verification scope (single feature vs project-wide). Always use `--json` flag.

## Output Guidelines

- Summarize verification results as a table: feature name, check count, pass/fail/skip counts, overall status
- Highlight failures prominently with the failure message
- For project-wide checks, show a summary line (e.g., "8/10 features healthy, 2 need attention")
- Suggest next steps for any failures (re-verify, check updates, manual fix)
