---
name: orch-dev-tests
description: "Run integration tests, E2E tests, API health checks, and smoke tests for the orchestrator system. Use when verifying system health, testing changes, running smoke tests, or checking if services are working."
visibility: public
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[api-health|heartbeat|docker-image|dispatch-e2e] [args]"
---

# Test Runner Skill

You are running tests against the orchestrator system. Use the `run-test.sh` utility.

## Available Tests

| Test | What It Checks | Command |
|------|----------------|---------|
| `api-health` | API server responding (port auto-detected from .env) | `./scripts/run-test.sh api-health` |
| `heartbeat` | Client node heartbeating successfully | `./scripts/run-test.sh heartbeat` |
| `docker-image` | Docker agent images built and working | `./scripts/run-test.sh docker-image` |
| `dispatch-e2e` | Full E2E: create task → dispatch → Docker run → PR | `./scripts/run-test.sh dispatch-e2e [taskId]` |

## How to Use

```bash
./scripts/run-test.sh $ARGUMENTS
```

## Test Workflow

### Quick health check
```bash
./scripts/run-test.sh api-health
./scripts/run-test.sh heartbeat
```

### Before E2E testing
```bash
# Ensure prerequisites are met:
./scripts/run-test.sh api-health       # Server running?
./scripts/run-test.sh heartbeat        # Node connected?
./scripts/dev-docker.sh test claude    # Docker image working?
```

### Full E2E dispatch
```bash
# Auto-create a test task and dispatch it:
./scripts/run-test.sh dispatch-e2e

# Or dispatch an existing task:
./scripts/run-test.sh dispatch-e2e <taskId>
```

## When Tests Fail

1. **api-health fails**: Check if server is running with `./scripts/dev-server.sh status`
2. **heartbeat fails**: Check node status with `./scripts/dev-node.sh status`, then logs with `./scripts/dev-logs.sh node`
3. **docker-image fails**: Rebuild with `./scripts/dev-docker.sh build claude`
4. **dispatch-e2e fails**: Check logs from both server and node: `./scripts/dev-logs.sh all`

## Subagent Usage

When running tests (especially E2E or Docker tests) that may take time, consider delegating to a background subagent:

- Use `Agent` tool with `subagent_type: "general-purpose"` and `run_in_background: true`
- The subagent can run the test suite and report results when done
- This frees the main agent to continue other work in parallel
- Particularly useful for `dispatch-e2e` which involves Docker container lifecycle

## Build Verification

After making code changes, verify the build passes:
```bash
./scripts/dev-build.sh check            # Type-check all packages
./scripts/dev-build.sh build            # Full Turborepo build
```
