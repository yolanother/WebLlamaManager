Queue UX: surface invisible slot holders, show position, SSE keepalive

Three related queue-visibility fixes:

1. Surface "invisible" local slot holders. completions / responses /
   messages handlers hold the local llamaQueue slot but don't call
   startActiveRequest, so they didn't appear anywhere in the UI's
   Active Requests list. That made pending chat requests look
   mysteriously stuck — the slot was held but nothing visible was
   running. /api/queue now emits a synthetic active row for any
   llamaQueue.activeItems entry that lacks a matching activeRequest,
   labeled "local (<endpoint>)".

2. Queue position. Each pending item now includes queuePosition
   (1-based) and queueLength so the UI can render a "#3 of 17" chip.
   Pending items are sorted by position for FIFO display order.

3. SSE keepalive while queued. acquireLocalSlot() accepts an onWait
   callback fired every 5s while blocked on acquire. The
   chat/completions handler uses it (when stream=true) to flush SSE
   headers up front and emit `:` comment lines, keeping reverse
   proxies from 504ing during long queue waits. Comments are
   ignored by SSE clients (including OpenAI-compatible ones) so this
   is invisible to consumers except for the kept-open socket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
