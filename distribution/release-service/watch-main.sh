#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Commit watcher for the automatic Llama Manager release service. Invoked
# periodically by the systemd --user timer, it reads the current HEAD of the app
# repository's local `main`, and when that commit differs from the last one built
# it enforces a quiet window: the same new commit must remain HEAD for at least
# QUIET_WINDOW_SECONDS (default 10 minutes, no further commits) before it triggers
# exactly one release run via release-runner.sh. This debounces a burst of
# commits into a single build. It persists the pending commit and the timestamp
# it was first seen so the quiet window survives across timer ticks, and it does
# no signing or building itself — it only decides when to call the runner (which
# holds its own single-flight lock). Runs entirely as the invoking user (yolan),
# no root.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_REPO="${APP_REPO:-/home/yolan/workspace/ai/llama-server}"
QUIET_WINDOW_SECONDS="${QUIET_WINDOW_SECONDS:-600}"
STATE_DIR="${STATE_DIR:-$SELF_DIR/state}"
LOG_DIR="${LOG_DIR:-$SELF_DIR/logs}"
RUNNER="${RUNNER:-$SELF_DIR/release-runner.sh}"

[ -f "$SELF_DIR/config.env" ] && . "$SELF_DIR/config.env"

mkdir -p "$STATE_DIR" "$LOG_DIR"
WATCH_LOG="$LOG_DIR/watch.log"
PENDING_COMMIT_FILE="$STATE_DIR/pending-commit"
PENDING_SINCE_FILE="$STATE_DIR/pending-since"
LAST_BUILT_FILE="$STATE_DIR/last-built-commit"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-INFO}" "$1" >> "$WATCH_LOG"; }

# Single-flight so two overlapping timer ticks never both evaluate/trigger.
exec 8>"$STATE_DIR/watch.lock"
flock -n 8 || { log "Previous watch tick still running; skipping." WARN; exit 0; }

[ -d "$APP_REPO/.git" ] || { log "App repo not found: $APP_REPO" ERROR; exit 1; }

HEAD="$(git -C "$APP_REPO" rev-parse refs/heads/main 2>/dev/null || true)"
[ -n "$HEAD" ] || { log "Could not resolve $APP_REPO main HEAD" ERROR; exit 1; }
LAST_BUILT="$(cat "$LAST_BUILT_FILE" 2>/dev/null || true)"

# Nothing new to build.
if [ "$HEAD" = "$LAST_BUILT" ]; then
  rm -f "$PENDING_COMMIT_FILE" "$PENDING_SINCE_FILE"
  exit 0
fi

PENDING_COMMIT="$(cat "$PENDING_COMMIT_FILE" 2>/dev/null || true)"
NOW="$(date +%s)"

# New (or changed) commit: (re)start the quiet window and wait.
if [ "$HEAD" != "$PENDING_COMMIT" ]; then
  printf '%s\n' "$HEAD" > "$PENDING_COMMIT_FILE"
  printf '%s\n' "$NOW" > "$PENDING_SINCE_FILE"
  log "New commit ${HEAD:0:12} detected; starting ${QUIET_WINDOW_SECONDS}s quiet window."
  exit 0
fi

# Same pending commit as last tick: check whether the quiet window has elapsed.
SINCE="$(cat "$PENDING_SINCE_FILE" 2>/dev/null || echo "$NOW")"
ELAPSED=$(( NOW - SINCE ))
if [ "$ELAPSED" -lt "$QUIET_WINDOW_SECONDS" ]; then
  log "Commit ${HEAD:0:12} stable for ${ELAPSED}s / ${QUIET_WINDOW_SECONDS}s; waiting."
  exit 0
fi

log "Quiet window satisfied for ${HEAD:0:12} (${ELAPSED}s); invoking release runner."
if "$RUNNER"; then
  log "Release runner completed for ${HEAD:0:12}."
else
  rc=$?
  log "Release runner exited non-zero (rc=$rc) for ${HEAD:0:12}; see release logs." ERROR
fi
# Clear the pending window regardless: the runner records last-built on success,
# so a still-unbuilt HEAD restarts a fresh window on the next tick.
rm -f "$PENDING_COMMIT_FILE" "$PENDING_SINCE_FILE"
