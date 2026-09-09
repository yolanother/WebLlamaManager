<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Documents GPU pools and GPU reservations: how a GPU is named by CLASS rather than
by DRM index or PCI slot so the name survives a reorder or a re-plug, how an
external agent leases a card at a priority that preempts llama-manager's own use
of it, the difference between reserve (non-blocking, NOT yours yet) and lock
(returns only when the card is genuinely yours), TTL and the renew heartbeat, what
happens to work already running on a card being taken away, the loopback
authorization rule and its consequences, the settings shape, and the exact HTTP
status codes and error codes every route returns. Read this before integrating any
external agent against the GPU API or before changing the reservation contract.
-->

# GPU Pools and Reservations

## Why this exists: two programs, one card

The appliance can have a discrete NVIDIA card beside the Strix Halo APU. That
card's normal job does not belong to llama-manager — it belongs to the **pods
agent**, which does asset generation and TTS. The pods agent is resident between
jobs (about 1.45 GB of a 24 GB card, measured) and bursts hard during them.

Two programs sharing one card with no protocol between them ends one of two ways:
llama-manager loads a model onto the card and the agent's next job fails for want
of VRAM, or llama-manager never touches the card at all and the hardware sits idle
most of the day.

Before this feature there was only a VRAM heuristic (`api/duo-accelerator.js`),
which guesses from VRAM whether the agent is mid-job, and no way for the agent to
say **"I need it NOW."** Reservations are that protocol.

> **A reservation protects a card. It does not make a card usable.** Whether
> llama-manager can execute anything on a given card is an engine question, not a
> reservation question — see [What can actually run on the NVIDIA card](#what-can-actually-run-on-the-nvidia-card).

---

## A named GPU is a POOL, matched by class

You name a GPU in settings. That name is the handle every caller uses — the HTTP
API, the `llm` CLI, MCP, and `pinnedModels`. **The DRM index (`card0`, `card1`) is
never a key**, because it reorders between the APU and an OCuLink card across
boots. The PCI address is not a reliable key either: an OCuLink card can come back
in a different slot.

What is stable is the card's **class** — its PCI `vendor:device` id and its product
name. So a settings entry names a class and matches every present card of that
class:

```json
{
  "gpus": [
    {
      "id": "rtx3090",
      "label": "RTX 3090 (OCuLink)",
      "match": { "pciId": "10de:2204" },
      "pinnedModels": ["llama-3.1-8b"],
      "defaultPriority": 0
    },
    {
      "id": "apu",
      "label": "Strix Halo iGPU",
      "match": { "pciId": "1002:1586" }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | **Required.** The handle used by API, CLI, MCP and pins. Must be unique. |
| `label` | Friendly name for readouts. Defaults to `id`. |
| `match` | Class selectors, ANDed. See below. |
| `pinnedModels` | Models bound to this pool. A pin **is** a reservation — see [Model pins](#model-pins-are-reservations). |
| `defaultPriority` | Integer priority llama-manager's own pin on this pool is held at. Defaults to `0`. |

### Selectors

Three selectors, all optional, all ANDed when present:

- **`pciId`** — `vendor:device`, e.g. `"10de:2204"`. Exact, case-insensitive, the
  `0x` prefix optional. **This is the normal case** and it survives a re-plug into
  another slot.
- **`name`** — a case-insensitive **substring** of the resolved product name, e.g.
  `"RTX 3090"`. Substring, not exact, because the name comes from the local PCI
  database and you should not have to reproduce it in full.
- **`pci`** — an exact PCI address, e.g. `"0000:c5:00.0"`. Available when an
  operator genuinely wants to pin one physical slot. Not required, not the default.

**A `match` with no selectors matches nothing**, and says so in a warning. That is
deliberate: reading an empty match as "all constraints satisfied" would silently
hand one name every card in the machine.

Selectors are validated strictly — an unknown key such as `"vendor"` is rejected
rather than ignored, because a selector that is never applied leaves the pool
constrained by less than you wrote.

### Several cards of one class is capacity, not ambiguity

Two RTX 3090s under one `id` gives that pool **capacity 2**. A caller cares whether
the resource is available, not which physical card it gets.

- `capacity` counts matching cards **with a kernel driver bound**. A card with no
  driver is still listed (hardware that is physically present must never vanish
  from a readout) but nothing can execute on it, so it is not capacity.
- A grant **binds to one specific card** and the response names it (`card`, `pci`),
  so a client that needs to set `CUDA_VISIBLE_DEVICES` itself can.
- Concurrent claims up to `capacity` are all granted immediately, at any priority,
  with no contention. **Priority only engages when the pool is full.**
- A card matched by two pools goes to the **first in settings order**, and both
  pools carry a warning naming the collision.

### A pool matching nothing is reported, never silent

```console
$ llm gpu list --url http://localhost:5250
```
```json
{
  "id": "rtx3090",
  "label": "RTX 3090 (OCuLink)",
  "capacity": 0,
  "free": 0,
  "held": [], "pending": [], "softClaimed": [], "cards": [],
  "warnings": ["GPU pool \"rtx3090\" matches no card present in this machine"]
}
```

`GET /api/gpus/rtx3090` still returns **200** for such a pool — it exists, it just
has no hardware. Only an id that is not in settings at all is a 404. Claiming
against it returns **503 `NO_CARD_PRESENT`**, because a claim that can never be
granted must not be queued forever.

---

## Priority

Priority is a **signed integer**. `0` is llama-manager's own baseline.

| Priority | Meaning | Typical user |
|---|---|---|
| `80` | Preempts llama-manager's own use of the card. | The pods agent during a job. |
| `0` | llama-manager's baseline. Its own model pins sit here. | llama-manager itself. |
| `-10` | Yields to ordinary llama-manager work. A soft hold that keeps the card associated with you and blocks nobody. | A background batch that is happy to be bumped. |

Three rules make the scale predictable:

1. **A free card goes to anyone.** While the pool has spare capacity, priority is
   not consulted at all — even `-10` is granted instantly.
2. **A full pool is taken only by a STRICTLY higher claim.** It preempts the
   *lowest-priority* held reservation in that pool. Equal priority **never**
   preempts, which is what stops two equal claimants trading a card forever.
3. **Ties break oldest-first**, so the choice among equals is deterministic.

A claim that cannot preempt anything either **queues** (default) or is **refused
immediately** with **409 `GPU_BUSY`** when you pass `noWait: true`:

```console
$ curl -s -X POST http://127.0.0.1:5250/api/gpus/apu/reserve \
    -H 'Content-Type: application/json' \
    -d '{"holder":"nightly-batch","priority":-10,"noWait":true}'
{"error":"GPU \"apu\" is fully reserved at or above priority -10","code":"GPU_BUSY"}
```

### Worked example

The `apu` pool has capacity 1 and llama-manager's own model pin on it at priority
`0`.

```console
# pods needs the card for a TTS batch. 80 > 0, so it takes it.
$ curl -s -X POST http://127.0.0.1:5250/api/gpus/apu/lock \
    -H 'Content-Type: application/json' \
    -d '{"holder":"pods","priority":80,"ttlSeconds":600,"reason":"TTS batch"}'
{"reservationId":"res-7","state":"held","gpu":"apu","card":"card1","pci":"0000:c6:00.0", ...}

# The model pin is now preempted, not lost:
$ curl -s 'http://127.0.0.1:5250/api/gpus/apu?state=preempted'
  res-6  llama-manager  "model pin: llama-3.1-8b"

# pods finishes and releases. Within one sweep (5s) llama-manager retakes the card
# and reloads the pinned model:
$ curl -s -X DELETE http://127.0.0.1:5250/api/gpus/reservations/res-7
$ curl -s 'http://127.0.0.1:5250/api/gpus/apu?state=held'
  res-8  llama-manager  "model pin: llama-3.1-8b"  ttlSeconds=null
```

Note that the pin comes back as a **new reservation id** (`res-8`). A preempted
reservation is terminal; it is never revived.

---

## reserve vs lock vs wait

> ### A 202 from `reserve` does NOT mean the card is free.
>
> This is the single most consequential mistake an integrator can make against
> this API. `reserve` returns **202 Accepted** with a lease in state
> **`pending`**. Pending means *a card has been bound to your lease and
> llama-manager is getting off it* — it does **not** mean the card is yours. Models
> may still be resident on it and requests may still be in flight.
>
> The lease is yours only in state **`held`**.

| Call | Blocks? | Returns |
|---|---|---|
| `POST /api/gpus/:gpu/reserve` | No | **202** with a `pending` lease. You must then wait. |
| `POST /api/gpus/reservations/:id/wait` | Yes | **200** when `held`; **408** if still pending at the deadline; **409** if the lease died meanwhile. |
| `POST /api/gpus/:gpu/lock` | Yes | **200** only when the card is genuinely yours. Reserve + wait in one call. |

**`lock` is what most callers want.** Use `reserve` + `wait` only when you have
useful work to do between filing the claim and getting the card.

A **408 does not cancel the lease.** The claim stays queued and you may wait again.
Cancelling on timeout would lose a claim's place in the queue every time a client
blinked.

### The full agent cycle, copy-pasteable

```bash
#!/usr/bin/env bash
# Take the RTX 3090 at a priority that outranks llama-manager, do work,
# heartbeat so a crash cannot strand the card, and hand it back.
set -euo pipefail
API=http://127.0.0.1:5250

# 1. LOCK — returns only when the card is genuinely ours.
resp=$(curl -sf -X POST "$API/api/gpus/rtx3090/lock" \
  -H 'Content-Type: application/json' \
  -d '{"holder":"pods","priority":80,"ttlSeconds":300,"timeoutSeconds":60,
       "reason":"asset generation batch"}')

RES=$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reservationId"])')
PCI=$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pci"])')

# Always release, however we exit.
trap 'curl -sf -X DELETE "$API/api/gpus/reservations/$RES" >/dev/null || true' EXIT

# 2. HEARTBEAT — well inside the 300s TTL.
( while true; do
    sleep 60
    curl -sf -X POST "$API/api/gpus/reservations/$RES/renew" >/dev/null || exit
  done ) &

# 3. WORK — bind by the PCI address the grant named, never a positional index.
CUDA_VISIBLE_DEVICES="$PCI" ./generate-assets.py

# 4. RELEASE happens in the trap.
```

Two details that matter in that script:

- **Bind by `pci` (or the card's UUID), never by a device index.** Index reordering
  is the exact fault this whole mechanism exists to survive. `CUDA_VISIBLE_DEVICES`
  accepts a PCI address directly.
- **The heartbeat interval must be well inside the TTL**, not equal to it. A missed
  renew loses the card.

---

## TTL: a crashed holder must never strand a card

Every lease taken over HTTP **expires**. `ttlSeconds` defaults to **300**. On
expiry the card is returned automatically:

```console
$ curl -s -X POST http://127.0.0.1:5250/api/gpus/apu/lock \
    -H 'Content-Type: application/json' -d '{"holder":"crashy","ttlSeconds":3}'
  res-5  held

# ...9 seconds later, with no renew:
$ curl -s 'http://127.0.0.1:5250/api/gpus?gpu=apu&state=expired'
  res-5  crashy  state=expired
```

TTLs are swept every **5 seconds**, and also lazily whenever a lease is created or
read, so a live claim never waits on the timer.

**A no-expiry lease is NOT available over HTTP.** `ttlSeconds: null` is reserved
for llama-manager's own internal model pins, where there is no crashed remote
holder to protect against. If HTTP could take a perpetual lease, one crashed agent
would take a card out of service until an operator noticed.

---

## What happens to work already on the card

Requests are **never dropped** during a handover. When a claim is granted, the
manager drains the card (`api/gpu-drain.js`, executed by `runGpuDrain` in
`api/server.js`):

1. **In-flight work finishes.** The drain waits up to **120 s** for the local queue
   to empty. A generation in progress holds the card; killing it would fail a
   caller for someone else's scheduling decision. A wedged request does not strand
   the holder forever, hence the ceiling.
2. **Models a peer can serve are offloaded.** For each resident model,
   `findFastestAvailableBackend` decides whether another node can serve it. If so,
   new requests for that model route to the peer.
3. **Models with nowhere to go PARK.** A request for such a model waits in
   `acquireLocalSlot` for up to **300 s** until the card comes back, before it takes
   a queue slot. It is never answered with a 404 or a 503. This is the same
   contract as an engine mode swap.
4. **The engine child bound to the card stops.**
5. Only then does the lease become **`held`**.

When the lease ends — released, expired, or preempted, all the same event from
llama-manager's side — parked requests are let go and an engine stopped for that
holder is restarted, which reloads the pinned models and drains the queue behind
it.

Answering a request with an error because an unrelated agent wanted a GPU would
make the reservation mechanism a denial of service against llama-manager's own
callers. That is why parking is the floor and offloading is only an optimisation.

---

## Model pins ARE reservations

`pinnedModels` on a pool creates an internal reservation held by
**`llama-manager`** at that pool's `defaultPriority`, **with no TTL**:

```json
{
  "id": "res-6", "gpu": "apu", "card": "card1", "pci": "0000:c6:00.0",
  "holder": "llama-manager", "priority": 0, "state": "held",
  "reason": "model pin: llama-3.1-8b",
  "ttlSeconds": null, "expiresAt": null
}
```

One mechanism, not two. An external claim at a higher priority preempts a pin
through exactly the same path it preempts anything else, and the pin retakes the
card when that claim ends (within one 5-second sweep).

The pinned card is carried into the engine as `LLAMA_GPU_PCI` (the PCI address,
which `CUDA_VISIBLE_DEVICES` accepts) and `LLAMA_GPU_UUID` (amdgpu's sysfs
`unique_id`, which `ROCR_VISIBLE_DEVICES` accepts as `GPU-<uuid>`).
`container-start.sh` does the mapping. A DRM or backend index is never used.

**Pinning is honoured in router mode only.** Single-preset mode does not currently
consult the pin — the local llama.cpp router is one process serving every model, so
it can be bound to one card only, and the first pool that pins models and currently
holds a card supplies that binding. Per-model placement across several cards would
need a router per card, which this appliance does not run.

---

## The unfriendly neighbour: a busy card with no reservation

Not every program on the box will learn to call this API. A card that is **visibly
busy but holds no reservation** is treated as *softly claimed*: llama-manager will
not schedule onto it, and will **not evict anything from it either**. It is left
alone.

This is a **guess** inferred from VRAM alone (`agentHoldsCard` in
`api/duo-accelerator.js`: is there enough headroom left for the agent to burst?).
An explicit reservation is not a guess, so a reservation is always checked first
and settles the question outright.

A soft claim is **advisory and blocks nothing**:

- `reserve()` ignores soft claims entirely.
- The pool's `free` count deliberately does **not** inherit one — reporting
  `free: 0` for a soft claim would predict a failure that will not happen.
- It appears only in the pool's `softClaimed` array, which is where a caller
  weighing whether a card is *worth* taking should read it.

> **Known defect on a Strix Halo box (task `T31258b5e1fa2b`, open).** The soft-claim
> heuristic reserves an absolute 8 GiB of headroom, a figure chosen for a 24 GB
> RTX 3090. The Strix Halo APU reports only 1 GiB of *dedicated* VRAM (it addresses
> the rest of host memory through a 128 GiB GTT window), so `total - 8 GiB` is
> negative and **any** usage trips the test. On such a box `softClaimed` is
> populated permanently, even when the card is idle. It blocks nothing — scheduling
> is correct — but do not read the field as meaningful on an integrated card until
> that task lands. It does clear while a reservation holds the card, since a card
> under a reservation is accounted for and never a soft claim.

---

## Authorization: the loopback rule

The server has **no inbound authentication middleware** today. The operator's
chosen model is *"open on localhost, authenticate from off-box"*:

- **Mutating routes** (`reserve`, `lock`, `wait`, `renew`, `release`) accept only
  loopback callers — `127.0.0.0/8`, `::1`, and the IPv4-mapped form. Everyone else
  gets **403 `NOT_LOOPBACK`**.
- **Read-only routes** (`GET /api/gpus`, `GET /api/gpus/:gpu`) stay open to any
  caller, exactly like `GET /api/stats`.

The check reads the **socket's** peer address, never `req.ip` and never
`X-Forwarded-For`, so it cannot be spoofed by a client header.

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.209:5250/api/gpus
200
$ curl -s -X POST http://192.168.1.209:5250/api/gpus/apu/reserve \
    -H 'Content-Type: application/json' -d '{"holder":"remote"}'
{"error":"GPU reservations may only be changed from this machine. Off-box callers
are read-only until API-key authentication lands.","code":"NOT_LOOPBACK"}
```

### `holder` is a LABEL, not an authorization scope

State this plainly, because a reader must not discover it by accident:

**`holder` is descriptive text. It is not checked on renew or release. Combined
with the loopback rule, ANY local process can renew or release ANY lease** —
including the pods agent's, and including llama-manager's own model pin.

```console
# Nothing identifies the caller. This succeeds regardless of who took res-4.
$ curl -s -o /dev/null -w '%{http_code}\n' \
    -X DELETE http://127.0.0.1:5250/api/gpus/reservations/res-4
200
```

That follows directly from "open on localhost". It is fine for a co-installed,
cooperating agent, which is the deployment this was designed for. It is **not** a
security boundary between mutually distrusting local programs, and it must not be
relied on as one. Real key authentication replaces `isLoopbackRequest` in one
place when it lands.

---

## The HTTP contract

Seconds throughout. There is no `ttlMs` anywhere on the wire. Timestamps
(`expiresAt`, `createdAt`, `updatedAt`, `grantedAt`) are Unix epoch
**milliseconds**.

| Route | Codes |
|---|---|
| `GET /api/gpus` | `200` — `?gpu=` and `?state=` filter the reservation list |
| `GET /api/gpus/:gpu` | `200`, `404` — `?state=` filters |
| `POST /api/gpus/:gpu/reserve` | `202`, `400`, `403`, `404`, `409`, `503` |
| `POST /api/gpus/:gpu/lock` | `200`, `400`, `403`, `404`, `408`, `409`, `503` |
| `POST /api/gpus/reservations/:id/wait` | `200`, `403`, `404`, `408`, `409` |
| `POST /api/gpus/reservations/:id/renew` | `200`, `403`, `404`, `409` |
| `DELETE /api/gpus/reservations/:id` | `200`, `403`, `404`, `409` |

| Status | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed body — a non-integer `priority`, a non-positive `ttlSeconds`/`timeoutSeconds`. |
| 403 | `NOT_LOOPBACK` | A mutating route called from off-box. |
| 404 | `UNKNOWN_GPU` | No pool in settings carries that id. *(A pool that exists but matches no card is not this — it is 503 on a claim, 200 on a read.)* |
| 404 | `UNKNOWN_RESERVATION` | No lease with that id. |
| 408 | `WAIT_TIMEOUT` | Still pending at the deadline. **The lease is NOT cancelled** — it stays queued and may be waited on again. |
| 409 | `GPU_BUSY` | `noWait` was set and the pool is full of claims this one cannot preempt. |
| 409 | `RESERVATION_INACTIVE` | The lease is terminal (`released`, `expired`, `preempted`). |
| 503 | `NO_CARD_PRESENT` | The pool matches no card present in this machine, so the claim could never be granted. |

### Reservation states

```
pending ──▶ held ──▶ released
   │          │  ╲──▶ expired
   ╰──────────┴───▶ preempted
```

`released`, `expired` and `preempted` are **terminal**. A terminal reservation
**keeps the `card` and `pci` it was bound to**, as a record of what it lost — so
**always branch on `state`, never on the presence of `card`.**

### Defaults

| Field | Default | Where |
|---|---|---|
| `ttlSeconds` | `300` | `reserve`, `lock` |
| `timeoutSeconds` | `30` | `lock`, `wait` |
| `priority` | `0` | `reserve`, `lock` |
| `holder` | `"api"` | `reserve`, `lock` |
| `noWait` | `false` | `reserve`, `lock` |

> **Known defect: a queued claim is not promoted (task `T312594d909a54`, open).**
> A claim that must wait for capacity is bound to a card when one frees, but is
> **not currently drained or moved to `held`** — only `reserve` and `lock` start a
> drain, and the sweep promotes llama-manager's own pins only. `wait` on such a
> claim returns 408 until its TTL expires, while the claim occupies the card.
> Until that lands, **treat a 408 from `lock` as "release this lease and lock
> again"** rather than waiting on it. A claim that is granted immediately — which
> is every claim that either finds spare capacity or outranks the current holder —
> is unaffected.

> **Known gap: non-200 codes are prose in OpenAPI (task `T31256f487e4ee`, open).**
> `scripts/gen-openapi.mjs` emits only a `200` response object per operation, for
> all 131 routes. The codes above are documented in each operation's *description*
> in `api/openapi.json`, but not as response objects — so a **generated client will
> assume 200** and treat a `202` pending lease as a granted one. Read the table
> above, not the generated types.
>
> The declared **200** schemas for the GPU routes are also wrong in six places —
> pool `free` is an integer and not a boolean, `softClaimed` is an array of card
> names and not a boolean, and the reservation schema requires a `reservationId`
> field the records do not carry (they use `id`). Tracked as `T3125955cb14f3`. The
> shapes shown in this document are what the server actually returns; they were
> read off a live instance.

---

## Other surfaces

Everything above is reachable three ways. The HTTP API is the contract; the others
are thin wrappers over it.

- **`llm` CLI** — `llm gpu list | show | lock | reserve | wait | renew | release |
  reservations`. See [`../Utilities/llm-cli.md`](../Utilities/llm-cli.md).
- **MCP** — `llama_list_gpus`, `llama_lock_gpu`, `llama_reserve_gpu`,
  `llama_wait_gpu_reservation`, `llama_renew_gpu_reservation`, `llama_release_gpu`.
  See [`../mcp.md`](../mcp.md).
- **OpenAPI** — `api/openapi.json`, generated from `api/api-spec.js`, served by the
  server itself and consumed by `llm api call`.

---

## What can actually run on the NVIDIA card

**As of 2026-09-08: nothing, through llama-manager.** Reservations protect the
card; they do not make it usable.

The shipped engine (`b10752`) and its bundled `rpc-server` are both HIP/ROCm
builds — `ldd` resolves `libggml-hip.so.0` on each. There is no CUDA backend in
either.

A CUDA `rpc-server` **has** been built and proven on the 3090 on drakemore
(Qwen3-8B-Q4_K_M loaded fully onto the card, 132 tok/s generation, the pods agent
left untouched), but it was run from `/tmp` and **nothing is installed or wired**.
The remaining blocker is on the *router* side, not the CUDA side: the deployed HIP
engine was compiled without `-DGGML_RPC=ON`, and ggml registers the RPC backend at
**compile time**, so `--rpc` parses but binds to nothing. Dropping a
`libggml-rpc.so` into the engine directory is inert. The ROCm engine must be
rebuilt and redeployed first.

The failure mode is **quiet** — the router starts and simply never offloads — so
the diagnostic to check is `--list-devices` showing an `RPC0` entry, not "the
process survived."

Tracked as task `T312557bb1b9bc`. The build procedure is written up in
`docs/llama-cpp-cuda-rpc-build-and-deployment.md`, which lands with that task and is
not in this tree yet.

---

## Verifying a change

A box with no `gpus` array configured is completely inert here: `resolvePools([])`
returns no pools, so no reservation can be created, no drain can run, and no pin is
emitted. Everything is additive — a one-GPU appliance behaves exactly as it did.

**Unit tests** (no GPU required — every module is pure and clock-injected):

```bash
node --test api/gpu-pools.test.js api/gpu-reservations.test.js \
            api/gpu-drain.test.js api/duo-accelerator.test.js
```

**Against a live server**, without touching the dev instance on 5250 — start a
throwaway with its own config and data directories:

```bash
mkdir -p /tmp/gpucheck/cfg /tmp/gpucheck/data
cat > /tmp/gpucheck/cfg/config.json <<'EOF'
{"autoStart": false,
 "gpus": [{"id":"apu","label":"Strix Halo iGPU","match":{"pciId":"1002:1586"}}]}
EOF

LLAMA_MANAGER_CONFIG_DIR=/tmp/gpucheck/cfg \
LLAMA_MANAGER_DATA_DIR=/tmp/gpucheck/data \
API_PORT=5299 LLAMA_PORT=5298 node api/server.js
```

Note the port variable is **`API_PORT`**, not `PORT`. Then:

```bash
node cli/llm.js --url http://127.0.0.1:5299 gpu list
```

A healthy readout names the card, resolves its PCI address, and reports live VRAM:

```json
{
  "id": "apu", "label": "Strix Halo iGPU",
  "capacity": 1, "free": 1, "held": [], "pending": [], "warnings": [],
  "cards": [{ "card": "card1", "pci": "0000:c6:00.0",
              "name": "AMD Device 1586", "driver": "amdgpu", "available": true,
              "vramBytes": 1073741824, "vramUsedBytes": 364994560,
              "busyPercent": 100, "free": true }]
}
```

`busyPercent: 100` on an idle Strix Halo is expected, not a bug: `rocm-smi` reports
0% on this iGPU under kernel 6.18+, so utilisation is proxied from package power.

---

## Where things live

| Concern | File |
|---|---|
| Class matching, capacity, warnings (pure) | `api/gpu-pools.js` |
| Reservation state machine: priority, TTL, preemption (pure) | `api/gpu-reservations.js` |
| What must happen before a card is honestly held (pure) | `api/gpu-drain.js` |
| Soft-claim heuristic + duo's rpc-server plan (pure) | `api/duo-accelerator.js` |
| Routes, drain execution, pins, loopback rule, sweep timer | `api/server.js` |
| API/OpenAPI documentation of the routes | `api/api-spec.js` |
| CLI commands | `cli/catalog.js` |
| MCP tools | `mcp/server.js` |

## Related docs

- [`../Designs/GpuReservations.md`](../Designs/GpuReservations.md) — the design decisions and why they were made that way
- [`../Utilities/llm-cli.md`](../Utilities/llm-cli.md) — the `llm gpu` commands
- [`../mcp.md`](../mcp.md) — the `llama_*_gpu` MCP tools
- [`../Designs/ModelManagement.md`](../Designs/ModelManagement.md) — model lifecycle, router vs preset mode
- [`memory-pressure-governor.md`](memory-pressure-governor.md) — the other resource guard that sheds work under pressure
