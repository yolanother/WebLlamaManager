Slot-aware watchdog + don't break catch path with SSE keepalive

Two compounding bugs:

1. Stuck-slot cascade in llama-cpp. When the JS-side stall watchdog
   aborted a fetch mid-prompt-processing, llama-cpp didn't notice
   the TCP close (it only polls during token emission) and kept
   processing in the background. The next request got its own
   llama-cpp slot. Repeated kills produced N stuck slots competing
   for the GPU, each running at 1/N speed. That's the "4 minutes to
   first token" pathology.

   Watchdog now two-tier:
   - Soft (stallMs): if no token in stallMs, check llama-cpp /slots
     for the model. If any slot is_processing, the upstream IS still
     working — extend lastActivityAt and re-check next pass. Logs
     once on extension so the operator can see it happen.
   - Hard (stallMs × 6): unconditional kill if we hit the cap.
     Catches truly wedged llama-cpp (no slot activity at all).

2. SSE keepalive broke the chat/completions catch path. Flushing
   SSE headers early for keepalive made res.headersSent === true,
   which the catch block used as "real body already committed" and
   returned early — skipping endActiveRequest. The leaked
   activeRequests entry then got re-triggered by the event-driven
   backfill scanner on every subsequent completion, spamming
   "[backfill] Request X stalled" forever.

   Replaced res.headersSent checks with a bodyCommitted flag that
   only flips when the real upstream body starts streaming, and a
   sseKeepaliveActive flag for the "headers flushed for keepalive
   only" state. The catch block now always finalizes the
   activeRequest. New sendErrorIfPossible() helper handles the
   keepalive-active error path by emitting an SSE error event.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
