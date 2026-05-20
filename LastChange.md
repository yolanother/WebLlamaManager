Hold local queue slot through full body stream + stall watchdog

Concurrency = 1 was only serializing connection setup — fetchWithRetry
released the llamaQueue slot as soon as response headers arrived, so
multiple requests could be in the streaming phase against llama-cpp
simultaneously. Active Requests piled up and a single wedged upstream
(no timeout on fetch or reader.read) could hold one slot forever while
new requests stacked behind it.

Now:

- acquireLocalSlot(req, res) holds the slot for the entire response
  lifecycle via res.on('close'|'finish'). One local request at a time
  actually means one. Applied to chat/completions, completions,
  responses, and messages handlers.

- Stall watchdog scans local slot-holders every 5s and aborts any
  entry whose lastActivityAt is stale beyond config.localStallMs
  (default 60s). The timer resets on every token (updateActiveRequest)
  and on slot acquisition, so long generations are safe and only a
  genuinely wedged upstream gets killed. Counter exposed in
  /api/stats.watchdog and the per-minute aggregate.

- /api/queue cross-references llamaQueue.activeItems via activeReqId.
  Chat requests waiting on acquire() now correctly show as pending
  with backendName "local (queued)" instead of falsely as active.

- Routing improvements: track activeLocalModel separately from
  lastUsedModel so model-switch offload triggers even while a heavy
  model is still loading; skip backends whose queues are at capacity
  (backpressure); sort candidates by exponential-moving-average tok/s
  within each priority tier.

- Settings UI exposes localStallMs as a seconds input (0 = disabled).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
