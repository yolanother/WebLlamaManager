Add HTTP polling fallback when WebSocket is unavailable

When accessing the UI through a reverse proxy that doesn't forward
WebSocket connections, the dashboard would show an infinite
"Reconnecting to server..." banner with no stats data.

Now after 3 consecutive WebSocket failures, the UI automatically
falls back to polling GET /api/stats every 2 seconds. The dashboard
and all stats-dependent components work normally in polling mode.
If WebSocket reconnects later, polling stops automatically.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
