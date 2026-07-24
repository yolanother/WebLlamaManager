---
name: orch-dev-docker
description: "Manage Docker agent images and containers for the orchestrator. Build, tag, test, monitor, and clean up Docker resources. Use when the user mentions Docker images, agent containers, building images, or container management."
visibility: public
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[build|tag|test|ps|stop|clean|list|status] [claude|opencode|all]"
---

# Docker Management Skill

You are managing Docker agent images and containers for the orchestrator.

## Quick Reference

| Command | Description |
|---------|-------------|
| `./scripts/dev-docker.sh build [claude\|opencode\|all]` | Build agent images (auto-tags) |
| `./scripts/dev-docker.sh tag [claude\|opencode\|all]` | Tag with registry prefix |
| `./scripts/dev-docker.sh test <claude\|opencode>` | Smoke-test a container |
| `./scripts/dev-docker.sh list` | List orchestrator images |
| `./scripts/dev-docker.sh ps` | Show running agent containers |
| `./scripts/dev-docker.sh logs <container>` | Follow container logs |
| `./scripts/dev-docker.sh stop [container\|all]` | Stop agent containers |
| `./scripts/dev-docker.sh clean` | Remove dangling images/stopped containers |
| `./scripts/dev-docker.sh status` | Docker system status + image info |

## How to Use

```bash
./scripts/dev-docker.sh $ARGUMENTS
```

## Image Names

| Backend | Image Tag |
|---------|-----------|
| Claude | `yolan/orchestrator-agent-claude:latest` |
| OpenCode | `yolan/orchestrator-agent-opencode:latest` |

Build automatically tags with the `yolan/` registry prefix.

## Common Workflows

### After changing a Dockerfile
```bash
./scripts/dev-docker.sh build claude    # Rebuild
./scripts/dev-docker.sh test claude     # Verify /workspace, git, gh, node all work
```

### Debug a running container
```bash
./scripts/dev-docker.sh ps              # Find container name
./scripts/dev-docker.sh logs <name>     # View output
./scripts/dev-docker.sh stop <name>     # Force-stop if needed
```

### Pre-E2E check
```bash
./scripts/dev-docker.sh status          # Docker running?
./scripts/dev-docker.sh test claude     # Image works?
```

## Subagent Usage

When running Docker builds or tests that may take time, consider delegating to a background subagent:

- Use `Agent` tool with `subagent_type: "general-purpose"` and `run_in_background: true`
- The subagent can run the build/test and report results when done
- This frees the main agent to continue other work in parallel
- Particularly useful for `build all` and `test` operations

## Platform Notes

The `dev-docker.sh` script handles platform differences internally:

| Platform | Notes |
|----------|-------|
| **Windows/MSYS** | Uses `cygpath` for path conversion. Sets `MSYS_NO_PATHCONV=1` to prevent path mangling. Uses `//bin/bash` double-slash workaround. |
| **PowerShell** | Equivalent script exists: `dev-docker.ps1` for native Windows shells. |
| **Remote Docker** | Dispatched agents always run in Linux containers regardless of host OS. Builds use the Linux Docker daemon directly. |

## Dockerfiles

- `docker/agent-claude/Dockerfile` — Claude Code agent
- `docker/agent-opencode/Dockerfile` — OpenCode agent
- Both create a non-root `agent` user and pre-create `/workspace` with correct ownership
