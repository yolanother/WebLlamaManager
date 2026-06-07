#!/bin/bash
# Llama Manager — embeddings integration test.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Boots api/server.js with auto-start disabled and EMBED pointed at a local stub
# that returns a canned OpenAI embeddings response, then verifies the proxy
# forwards (batched) input to EMBED_PORT, returns the vectors, and records an
# LLM-log entry tagged endpoint=embeddings.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_PORT=5390; EMBED_PORT=5391
STUB_PID=""; SRV_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; }
trap cleanup EXIT

# 1) Stub embed backend returning two 4-dim vectors + usage.
cat > /tmp/embed-stub.mjs <<'EOF'
import { createServer } from 'http';
const PORT = process.env.STUB_PORT;
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"status":"ok"}'); }
  if (req.url === '/v1/embeddings' && req.method === 'POST') {
    let b=''; req.on('data', c=>b+=c); req.on('end', () => {
      const body = JSON.parse(b||'{}');
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((_, i) => ({ object:'embedding', index:i, embedding:[0.1,0.2,0.3,0.4] }));
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ object:'list', data, model: body.model, usage:{ prompt_tokens: 4, total_tokens: 4 } }));
    });
    return;
  }
  if (req.url === '/models') { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"data":[]}'); }
  res.writeHead(404); res.end();
}).listen(PORT);
EOF
STUB_PORT=$EMBED_PORT node /tmp/embed-stub.mjs & STUB_PID=$!
sleep 1

# 2) Boot the real server: no llama auto-start, embed supervisor off (we provide the stub).
AUTO_START=false EMBED_ENABLED=false API_PORT=$API_PORT EMBED_PORT=$EMBED_PORT \
  node "$REPO_ROOT/api/server.js" >/tmp/embed-srv.log 2>&1 & SRV_PID=$!

# Wait for the API to listen. Use /api/llm-logs — a static 200 that does NOT
# depend on the llama router being up (there is no /api/health endpoint).
for i in $(seq 1 30); do curl -sf "http://localhost:$API_PORT/api/llm-logs?limit=1" >/dev/null 2>&1 && break; sleep 1; done

FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }

# 3) Batched embeddings request → two vectors via the stub.
RESP="$(curl -s -m 10 "http://localhost:$API_PORT/api/v1/embeddings" \
  -H 'content-type: application/json' \
  -d '{"model":"test-embed","input":["hello","world"]}')"
echo "$RESP" | grep -q '"object":"list"' && ok "returns list" || bad "no list: $RESP"
# Count "index": (exactly one per embedding object) — robust vs "embedding"
# appearing twice per item (as both an object-type value and the vector key).
[ "$(echo "$RESP" | grep -o '"index":' | wc -l)" -eq 2 ] && ok "two vectors (batched)" || bad "not 2 vectors: $RESP"

# 4) Alias works too.
A="$(curl -s -m 10 "http://localhost:$API_PORT/api/embeddings" -H 'content-type: application/json' -d '{"model":"test-embed","input":"x"}')"
echo "$A" | grep -q '"embedding"' && ok "alias /api/embeddings works" || bad "alias failed: $A"

# 5) LLM log recorded with endpoint=embeddings.
sleep 1
L="$(curl -s -m 10 "http://localhost:$API_PORT/api/llm-logs?limit=20")"
echo "$L" | grep -q '"endpoint":"embeddings"' && ok "llm log records embeddings" || bad "no embeddings llm log: $L"

# 6) embed health endpoint responds.
H="$(curl -s -m 10 "http://localhost:$API_PORT/api/v1/embed/health")"
echo "$H" | grep -qE '"status":"(ok|disabled)"' && ok "embed health endpoint" || bad "embed health: $H"

# 7) /api/v1/models responds (embed row only added when a model is configured;
#    EMBED_ENABLED=false here, so we just assert the list endpoint works).
M="$(curl -s -m 10 "http://localhost:$API_PORT/api/v1/models")"
echo "$M" | grep -q '"object":"list"' && ok "models list responds" || bad "models failed: $M"

# 8) stats endpoint carries an embed block (served by GET /api/stats).
S="$(curl -s -m 10 "http://localhost:$API_PORT/api/stats")"
echo "$S" | grep -q '"embed"' && ok "stats has embed block" || bad "no embed in stats: ${S:0:200}"

echo; [ "$FAIL" -eq 0 ] && echo "integration: PASS" || echo "integration: FAIL"
exit $FAIL
