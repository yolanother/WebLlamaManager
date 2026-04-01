Add offloaded request visibility to telemetry dashboard

Forwarded requests to remote backends are now visible across all
telemetry surfaces:

- Active request panel shows a purple backend badge when processing
  a request via a remote backend
- Request log table has a new Backend column showing "local" or the
  backend ID for each request
- LLM log entries show backend badge (already done in prior commit)
- Request Volume chart includes a purple "Offloaded" area stacked
  with Success/Errors/Retries/Restarts
- Request Health % chart shows Local vs Offloaded vs Retries vs
  Errors breakdown
- Analytics JSONL records now include rOf (offloaded count) and bc
  (per-backend counts) per minute for historical analysis

Server-side changes:
- requestStatsAccum tracks offloaded count and per-backend counts
- startActiveRequest accepts backend parameter
- Request log middleware includes req._backend field
- All 5 proxy endpoints set req._backend when routing remote

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
