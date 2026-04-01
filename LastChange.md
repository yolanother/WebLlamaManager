Add model selection dropdowns, test gating, and fix backend test

- Model mapping now uses dropdowns populated from local and remote
  model lists instead of free-text inputs. Local models come from
  /api/models, remote models fetched via new GET /api/backends/:id/models
  endpoint. Supports glob patterns (e.g. "qwen*") in addition to
  exact match and * wildcard.

- Backend test now fetches the remote /models list first to find a
  valid model name, then sends a test chat completion. Previously
  used the catch-all mapping value which could be empty, causing
  "model is required" errors on backends like Ollama.

- Backends must pass a connectivity test before they can be used for
  offloading. The "tested" flag is persisted in config.json and
  checked by the routing engine. Untested backends show a warning
  badge in the UI.

- Adding a new backend now auto-triggers a connectivity test. The
  button reads "Add Backend & Test" to make this clear.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
