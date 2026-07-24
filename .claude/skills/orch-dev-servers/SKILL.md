---
name: orch-dev-servers
description: "Manage orchestrator dev environment services: API server, Tauri client node, web frontend. Start, stop, check status, and view logs. Use when the user wants to start/stop services, check if things are running, restart after changes, or manage the dev environment."
visibility: public
allowed-tools: Bash, Read, Grep
argument-hint: "[start|stop|status|restart|docker|rebuild|logs] [server|node|web|all]"
---

# Dev Server Management Skill

You are managing the orchestrator development environment services.

## Architecture

The dev environment runs on Docker by default:
- **PostgreSQL + Redis** always run as Docker containers
- **API Server** can run as a bare process (`start`) or Docker container (`docker`)
- **Web Frontend** can run as a bare process (`start`) or Docker container (`docker`)
- **Tauri Client Node** always runs as a bare process (native app)

Ports are configured via `.env` (use `.orchestrator/scripts/dev-config.sh env get PORT` to check):

| Service | Default Port | Env Var |
|---------|-------------|---------|
| API Server | 5174 | `PORT` |
| Web Frontend | 5173 | `VITE_PORT` |
| PostgreSQL | 5177 | `POSTGRES_PORT` |
| Redis | 5176 | `REDIS_PORT` |

**IMPORTANT**: Do NOT assume port 3000. Always check `.env` via dev-config.sh.

## Services & Scripts

| Service | Script | Description |
|---------|--------|-------------|
| Server | `./scripts/dev-server.sh` | Orchestrator API (PostgreSQL + Redis + Fastify) |
| Node | `./scripts/dev-node.sh` | Tauri client node (system tray app) |
| Web | `./scripts/dev-web.sh` | Vite web frontend |
| DB | `./scripts/dev-db.sh` | Database migrations & management (reads DATABASE_URL from .env) |

## Command Reference

### Server (`dev-server.sh`)
```bash
./scripts/dev-server.sh start      # Start bare process (PG+Redis via Docker, API as tsx watch)
./scripts/dev-server.sh stop       # Stop server (both bare and Docker)
./scripts/dev-server.sh restart    # Smart restart (Docker→rebuild, bare→stop+start)
./scripts/dev-server.sh status     # Check if running, show API health + node count
./scripts/dev-server.sh logs       # Show last 50 lines of logs
./scripts/dev-server.sh logs -f    # Follow logs live
./scripts/dev-server.sh docker     # Start server in Docker container (full stack)
./scripts/dev-server.sh rebuild    # Rebuild Docker image and restart container
```

### Web (`dev-web.sh`)
```bash
./scripts/dev-web.sh start         # Start Vite dev server (bare process)
./scripts/dev-web.sh stop          # Stop web frontend
./scripts/dev-web.sh restart       # Stop + start
./scripts/dev-web.sh status        # Check if running
./scripts/dev-web.sh logs          # Show recent logs
./scripts/dev-web.sh logs -f       # Follow logs live
./scripts/dev-web.sh docker        # Start via Docker Compose
./scripts/dev-web.sh rebuild       # Rebuild Docker image and restart
```

### Node (`dev-node.sh`)
```bash
./scripts/dev-node.sh start        # Build & start Tauri dev mode (compiles Rust)
./scripts/dev-node.sh stop         # Stop client node
./scripts/dev-node.sh restart      # Stop, clean crate artifacts, start
./scripts/dev-node.sh status       # Check running + heartbeat from server
./scripts/dev-node.sh clean        # Clean orchestrator-node crate artifacts
./scripts/dev-node.sh clean all    # Remove entire target/ (full rebuild)
./scripts/dev-node.sh check        # Type-check only (cargo check)
./scripts/dev-node.sh logs         # Show recent logs
./scripts/dev-node.sh logs -f      # Follow logs
./scripts/dev-node.sh ui           # Start UI dev server only (port 1430)
./scripts/dev-node.sh ui stop      # Stop UI dev server
```

### Database (`dev-db.sh`)
```bash
./scripts/dev-db.sh migrate        # Run pending migrations
./scripts/dev-db.sh generate       # Generate migration from schema changes
./scripts/dev-db.sh push           # Push schema directly (dev only)
./scripts/dev-db.sh studio         # Open Drizzle Studio
./scripts/dev-db.sh status         # Show migration status
```

## How to Respond to User Request

Parse `$ARGUMENTS` to determine the action and target:

- `start all` → Start server, web (and optionally node)
- `stop all` → Stop all services
- `status` → Check status of all services
- `restart server` → Restart the API server
- `start server` → Start only the API server
- `docker server` → Start the API server in Docker
- `rebuild server` → Rebuild and restart the Docker server
- `logs node` → Show node logs
- `migrate` or `db migrate` → Run database migrations

### Docker vs Bare Process

- `start` = bare process mode (tsx watch for server, npm run dev for web)
- `docker` = Docker container mode (full stack via docker-compose)
- `restart` is smart: if currently running in Docker, it rebuilds; if bare, it restarts
- `rebuild` always rebuilds the Docker image and restarts

When the user says "start everything" or "start all":
1. `./scripts/dev-server.sh start` (or `docker` if they prefer Docker)
2. `./scripts/dev-web.sh start`
3. Optionally `./scripts/dev-node.sh start` (slow — Rust compilation)

## Subagent Usage

When starting services that take time (especially `dev-node.sh start` which compiles Rust), consider delegating to a background subagent:

- Use `Agent` tool with `subagent_type: "general-purpose"` and `run_in_background: true`
- The subagent can start the service and report when it's ready
- This frees the main agent to continue other work in parallel
- Particularly useful for Tauri node startup (Rust compilation takes 2-3 min on first run)

## Troubleshooting

- **Server won't start**: Check Docker is running (`docker ps`), check PORT isn't in use
- **Port conflict**: `stop` commands kill both Docker containers AND bare processes on the port
- **Need Docker mode**: Use `./scripts/dev-server.sh docker` instead of `start`
- **After code changes**: Use `restart` (smart — detects Docker vs bare) or `rebuild` (Docker only)
- **Node won't start**: Tauri needs Rust toolchain. First run takes ~2-3 min to compile
- **Web won't start**: Check port 5173, try `./scripts/dev-web.sh stop` first
- **DB migration needed**: Run `./scripts/dev-db.sh migrate` (auto-reads DATABASE_URL from .env)
- **Everything stale**: `./scripts/dev-server.sh stop && ./scripts/dev-web.sh stop` then start fresh
