Auto-save routing settings so enable toggle persists across restarts

The enable checkbox and all routing policy controls now save to the
server immediately on change via POST /api/backends/routing, instead
of only updating local React state. Previously the enabled state was
lost on server restart because it was never persisted to config.json.

Removed the separate "Save Routing Policy" button since changes now
auto-save.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
