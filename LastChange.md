Add remote backend load balancing for request offloading

When the local llama.cpp server queue fills up, requests can now be
offloaded to remote OpenAI-compatible API endpoints. Backends are
configurable with cost metrics (tok/s, $/1M tokens, shared resource
weight) and four offload policies: overflow, threshold, percentage,
and manual routing.

Key features:
- Backend directory with CRUD management via API and UI
- Per-backend request queues with configurable concurrency
- Cost tracking (time, money, shared resource contention)
- Routing engine with priority-based backend selection
- Test connectivity button for each backend
- Dashboard shows live backend status when enabled
- Request logs tagged with backend attribution
- API keys stored in .env, never exposed in config/API responses
- Fully backwards compatible (disabled by default)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
