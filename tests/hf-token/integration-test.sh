#!/bin/bash
# Llama Manager — HuggingFace-token integration test.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Boots api/server.js against a throwaway CONFIG_PATH (no llama/embed spawns) and
# verifies: a token POSTed to /api/settings is persisted to config but NEVER
# returned raw by /api/settings or /api/config (only masked / boolean), and that
# the masked status reflects "set".
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_PORT=5394
CFG="$(mktemp "${TMPDIR:-/tmp}/hf-cfg.XXXXXX.json")"
printf '{"autoStart":false}' > "$CFG"
SRV_PID=""
cleanup() { [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -f "$CFG"; }
trap cleanup EXIT

AUTO_START=false EMBED_ENABLED=false API_PORT=$API_PORT CONFIG_PATH="$CFG" \
  node "$REPO_ROOT/api/server.js" >/tmp/hf-srv.log 2>&1 & SRV_PID=$!
for i in $(seq 1 30); do curl -sf "http://localhost:$API_PORT/api/llm-logs?limit=1" >/dev/null 2>&1 && break; sleep 1; done

FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }

SECRET="hf_supersecrettoken12345"

# 1) POST a token via settings.
curl -s -m 10 "http://localhost:$API_PORT/api/settings" -H 'content-type: application/json' \
  -d "{\"hfToken\":\"$SECRET\"}" >/dev/null

# 2) GET /api/settings must NOT contain the raw token; must show hasHfToken + mask.
S="$(curl -s -m 10 "http://localhost:$API_PORT/api/settings")"
echo "$S" | grep -q "$SECRET" && bad "raw token leaked in /api/settings" || ok "settings: no raw token"
echo "$S" | grep -q '"hasHfToken":true' && ok "settings: hasHfToken true" || bad "hasHfToken not true: $S"

# 3) GET /api/config must NOT contain the raw token.
C="$(curl -s -m 10 "http://localhost:$API_PORT/api/config")"
echo "$C" | grep -q "$SECRET" && bad "raw token leaked in /api/config" || ok "config: no raw token"

# 4) The token IS persisted to the on-disk config (storage works).
grep -q "$SECRET" "$CFG" && ok "token persisted to config file" || bad "token not persisted"

echo; [ "$FAIL" -eq 0 ] && echo "hf-token integration: PASS" || echo "hf-token integration: FAIL"
exit $FAIL
