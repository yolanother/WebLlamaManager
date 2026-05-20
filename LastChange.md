Wire preferLocal=false to always-prefer-remote for offloadable requests

When a pile of mixed offloadable + non-offloadable requests came in,
the `overflow` policy would let whoever arrived first claim the local
slot. If an offloadable request (one with a remote mapping) got there
first, non-offloadable requests (those with no remote alternative)
stacked behind it on the local queue — even though the offloadable
request could have gone to a remote backend.

`preferLocal` already existed in config + UI but was never consulted
in routing. Now:

- When `preferLocal: false`, offloadable requests go remote whenever
  any remote backend has capacity, regardless of local idle/busy
  state. The local slot is reserved for non-offloadable models.

- Pre-policy check: if a viable remote candidate exists (mapping
  present, circuit closed, queue has capacity), set `shouldOffload`
  before the overflow/threshold/percentage policy evaluation runs.

- Falls back to local automatically if no remote is viable (mapping
  missing, all remote queues full, circuits open) — non-offloadable
  models keep their guaranteed local path.

- UI label and hint updated to reflect actual behavior (was a dead
  checkbox before).

Verified: with three concurrent Qwen3-8B (offloadable to Dahaka +
Borethrax) and gemma-4-31B (no remote mapping), Qwen requests land
on Dahaka/Borethrax while gemma takes the local slot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
