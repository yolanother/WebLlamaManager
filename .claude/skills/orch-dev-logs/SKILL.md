---
name: orch-dev-logs
description: "Fetch, search, and analyze logs from all orchestrator components (server, node, web, build). Use when debugging issues, checking errors, monitoring system health, or any 'check the logs' / 'what went wrong' request."
visibility: public
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[node|server|web|build|all|search PATTERN] [lines]"
---

# Log Analysis Skill

You are analyzing logs from the orchestrator dev environment. Use the `dev-logs.sh` utility to fetch logs safely.

## Available Log Sources

| Source | Description | Script Command |
|--------|-------------|----------------|
| `node` | Tauri client node (Rust app) — heartbeats, sessions, Docker | `./scripts/dev-logs.sh node` |
| `server` | Orchestrator API server — routes, DB, dispatch | `./scripts/dev-logs.sh server` |
| `web` | Vite web frontend — build errors, HMR | `./scripts/dev-logs.sh web` |
| `build` | Build/compilation logs | `./scripts/dev-logs.sh build` |
| `all` | Combined view of all logs | `./scripts/dev-logs.sh all` |

## How to Use

### Fetch recent logs
```bash
./scripts/dev-logs.sh $ARGUMENTS
```

### Search logs for a pattern
```bash
./scripts/dev-logs.sh search "ERROR" all
./scripts/dev-logs.sh search "heartbeat" node
./scripts/dev-logs.sh search "session" server
```

### List available log files
```bash
./scripts/dev-logs.sh list
```

## Analysis Guidelines

When analyzing logs:
1. **Start broad**: Use `./scripts/dev-logs.sh all 30` for a quick overview
2. **Search for errors**: `./scripts/dev-logs.sh search "ERROR"` or `./scripts/dev-logs.sh search "WARN"`
3. **Narrow down**: Once you identify the component, fetch more lines from that specific source
4. **Check timing**: Look at timestamps to correlate events across components
5. **Report findings**: Summarize what you found — errors, warnings, and the likely root cause

## Common Patterns to Look For
- `heartbeat failed` — Node can't reach the server
- `session_id` — Track a specific session across node and server logs
- `Permission denied` — Docker container filesystem issues
- `ECONNREFUSED` — Service not running or wrong port
- `exit_code` — Agent process exit codes (0 = success)
