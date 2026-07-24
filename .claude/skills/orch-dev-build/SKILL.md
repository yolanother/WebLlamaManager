---
name: orch-dev-build
description: "Build, type-check, and verify the orchestrator TypeScript packages. Use after making code changes to ensure everything compiles correctly. Triggers for 'build', 'type check', 'compile', 'tsc', 'check the build', 'does it compile', or any build-related request."
visibility: public
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[check|build|clean|status] [package]"
---

# Build & Type-Check Skill

You are building and type-checking the orchestrator project.

## Available Commands

| Command | Description |
|---------|-------------|
| `./scripts/dev-build.sh check [package]` | Type-check without emitting (fast) |
| `./scripts/dev-build.sh build [package]` | Full Turborepo build |
| `./scripts/dev-build.sh clean` | Remove all dist/ and .turbo/ dirs |
| `./scripts/dev-build.sh status` | Show which packages are built |

## How to Use

```bash
./scripts/dev-build.sh $ARGUMENTS
```

## Packages

| Package | Description |
|---------|-------------|
| `shared` | Shared types and utilities |
| `orchestrator` | API server (Fastify + Drizzle) |
| `web` | Vite + React frontend |
| `mcp-server` | MCP protocol server |
| `discord-bot` | Discord bot integration |
| `cli` | `orch` CLI tool (esbuild bundle → `orch-bundle.cjs`) |

## Common Workflows

### After editing TypeScript files
```bash
./scripts/dev-build.sh check orchestrator    # Quick type-check of changed package
```

### Before committing
```bash
./scripts/dev-build.sh check                 # Type-check all packages
./scripts/dev-build.sh build                 # Full build to verify everything
```

### After editing CLI code
```bash
./scripts/dev-build.sh build cli              # Rebuild CLI bundle
```
If `.orch-linked` exists in repo root, the build auto-copies the bundle to `~/.orchestrator/bin/` so the global `orch` command picks up changes immediately.

### After pulling changes
```bash
./scripts/dev-build.sh clean                 # Clear stale artifacts
./scripts/dev-build.sh build                 # Fresh build
```

## Subagent Usage

When running builds that may take time, consider delegating to a background subagent to avoid blocking the main conversation:

- Use `Agent` tool with `subagent_type: "general-purpose"` and `run_in_background: true`
- The subagent can run the build/check and report results when done
- This frees the main agent to continue other work in parallel
- Particularly useful for full `build` (which runs all packages via Turborepo)

## Platform Notes

The `dev-build.sh` script handles platform differences internally:

| Platform | Notes |
|----------|-------|
| **Windows** | Sets `RUST_MIN_STACK=8388608` to avoid `windows` crate stack overflows. Detects Cargo at `$USERPROFILE/.cargo/bin/cargo.exe`. |
| **macOS vs Linux** | `stat` command differences handled automatically by the script. |
| **PowerShell** | Equivalent scripts exist: `dev-build.ps1`, `dev-node.ps1` for native Windows shells. |
| **Remote Docker** | Dispatched agents always build in Linux containers regardless of host OS. |

All platforms use `NODE_OPTIONS="--max-old-space-size=8192"` to avoid OOM on large builds.

## Important Notes

- The Tauri client-node is NOT part of the TS build — it uses `cargo tauri build`
- `check` is faster than `build` — use it for quick verification during development
- `build` runs via Turborepo which handles dependency ordering automatically
