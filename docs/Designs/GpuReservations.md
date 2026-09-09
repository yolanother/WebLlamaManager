<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

The design record for GPU pools and reservations: why a named GPU is a class-matched
POOL rather than a DRM index or PCI address, why llama-manager's own model pins are
reservations through the same mechanism rather than a parallel concept, why preemption
requires strictly greater priority and breaks ties oldest-first, why a grant is a
two-step pending-then-held handshake instead of an instant grant, why negative priority
exists, why draining parks requests rather than refusing them, why authorization is a
loopback rule and what that costs, and the honest state of CUDA execution on the
discrete card. Records the reasoning behind each choice, not a walkthrough of the code.
-->

# Design — GPU Pools and Reservations

Operator-approved 2026-09-08. Implemented across `api/gpu-pools.js`,
`api/gpu-reservations.js`, `api/gpu-drain.js`, `api/duo-accelerator.js` and the routes
in `api/server.js`.

For *what the feature does and how to use it*, read
[`../features/gpu-reservations.md`](../features/gpu-reservations.md). This document is
the *why*.

---

## The problem being solved

A discrete card shared between llama-manager and an external program — on this
appliance, the pods agent doing asset generation and TTS. Neither can be told to go
away, and neither can see what the other intends. All that existed before was
`api/duo-accelerator.js`, a VRAM heuristic that guesses whether the agent is mid-job,
wired to nothing, and with no channel for the agent to state a claim.

Everything below follows from wanting **a stated claim to beat a guess**, while never
breaking a request that is already in the system.

---

## Why class matching beats PCI-address matching

`readCardSysfs` used to compute each card's PCI address and then discard it, leaving
the DRM index (`card0`, `card1`) as the only handle. That index **reorders between
boots** once there are two cards, so it cannot name a GPU.

The obvious replacement is the PCI address. It was rejected because **an OCuLink card
can come back in a different slot** — the enclosure is the entire point of OCuLink, and
a config that breaks when the operator moves the cable to the other port is a config
that will break.

What survives both faults is the card's **class**: its `vendor:device` id and its
product name. Neither changes when the kernel renumbers DRM nodes or when the card
moves to a different port.

The exact PCI address remains available as the `pci` selector, for the operator who
genuinely wants one physical slot and nothing else. It is available, not default: the
default should be the thing that keeps working.

### Several matching cards is capacity, not an error

Once a name selects a class rather than a device, two identical cards under one name is
the natural consequence — and the useful reading of it. A caller asking for "the 3090"
wants *a* 3090; which one it gets is llama-manager's problem, and the grant tells it
which so it can set `CUDA_VISIBLE_DEVICES` itself.

Resolving the ambiguity instead (erroring, or picking one and hiding the other) would
throw away half the machine's capacity to avoid a question nobody was asking.

This is why **priority only engages on a FULL pool**. Contention is a property of
exhausted capacity, not of a claim's rank, and consulting priority while a card sits
free would make a low-priority claim wait for no reason.

### Why an empty `match` matches nothing

A `match` with no selectors is the vacuous "all constraints satisfied" case. Read that
way, one pool name silently acquires every card in the machine — including cards a
later pool was written to claim. The blast radius of the wrong reading is the whole
machine; of the right reading, one warning. So an empty match matches nothing and says
so.

The same instinct runs through the module: an unknown selector key is **rejected**
rather than ignored (a selector never applied leaves the pool constrained by less than
the operator wrote), and every way a pool can come up empty produces a warning naming
the pool. Hardware that is present and missing from a readout is the hardest kind of
fault to chase.

---

## Why model pins ARE reservations

llama-manager pinning a model to a card and the pods agent leasing that card are the
same question — *who has this card right now* — asked by two parties. Modelling them
separately would mean two sets of rules that have to agree about capacity, priority,
preemption and release, and two sets of tests, and a bug class that only appears where
they disagree.

So a `pinnedModels` entry creates an ordinary reservation held by `llama-manager` at
the pool's `defaultPriority`. An external claim at 80 preempts it through exactly the
same code path that preempts any other lease, and the pin retakes the card when that
claim ends. There is **one mechanism to reason about and one to test.**

The pin differs from an HTTP lease in exactly one way — **it has no TTL** — and that
difference is itself a decision, below.

### Why a no-expiry lease is not offered over HTTP

The pin needs no TTL: llama-manager is the process that would have to crash, and if it
crashes the reservations die with it.

A *remote* holder is different. If HTTP could take a perpetual lease, one crashed agent
takes a card out of service until a human notices — the exact failure the TTL exists to
prevent. So `ttlSeconds: null` is reachable only from inside the process, and the HTTP
surface has no way to ask for it. This is a deliberate asymmetry, not an oversight, and
it is stated in the API description text so nobody adds it as a convenience.

---

## Why preemption requires STRICTLY greater priority

If equal priority could preempt, two claimants at the same rank would take the card
from each other in a loop, forever, each preempting the other's fresh grant. Neither
makes progress and the card is spent entirely on handovers.

Requiring **strictly** greater makes the relation a partial order that terminates: a
claim can only displace something below it, so a chain of preemptions is finite. Equal
claimants queue instead, which is the honest answer — they *are* equal, and the system
has no basis for preferring one.

The same rule is applied in `api/duo-accelerator.js`, where the accelerator yields only
to a reservation strictly above its own priority, so the two modules cannot disagree
about who outranks whom.

### Why ties break oldest-first

Among equal-priority claims, promotion goes to the longest-waiting. Any deterministic
rule prevents starvation; age is chosen because it is the one an operator can predict
without reading the code, and it makes the queue behave the way a queue is expected to.
The same tie-break is used when selecting a *victim* (lowest priority, oldest grant
first), so both ends of the decision are stable.

This mirrors `api/request-queue.js`, which already arbitrates by priority then age.
Reusing the house convention was preferred over inventing a second one.

### Why a separate priority vocabulary

The codebase already has two priority scales — `REQUEST_PRIORITIES`
(`realtime`/`interactive`/`background`) and `CONTEXT_PREPARE_PRIORITIES`. Both are
fixed string classes, and neither was reused.

A GPU claim needs an **open-ended ordering around llama-manager's own baseline**: the
whole point is that an external party can name a rank above or below llama-manager
without llama-manager having enumerated it first. A fixed class list cannot express
"just below llama-manager but above the nightly batch." So the GPU scale is a signed
integer with `0` as the baseline, and the three scales are deliberately not
interchangeable.

---

## Why negative priority exists

Zero is llama-manager's own work. Positive means *"take this away from
llama-manager."* Without a negative range there is no way to express the opposite —
**"I would like this card, but never at llama-manager's expense."**

That is a real and common shape: a nightly batch, a warm-up, a speculative job. It
wants the card when the card is idle and wants to be bumped the instant real work
arrives. Under a non-negative scale the only options are 0 (competes with
llama-manager's own scheduling) or don't reserve at all (and get evicted without
warning, with no record that anyone was there).

A negative reservation is a **soft hold that keeps the card associated with you and
blocks nobody**. It still appears in the readout, so an operator can see what is on the
card; it still gets a TTL and a release path; and it loses the card to any ordinary
llama-manager work without argument. Combined with `noWait`, it is also how a caller
asks "is this card idle *right now*?" and gets an immediate answer instead of a queue
slot.

---

## Why `pending -> held` is a two-step handshake

The tempting design is: a claim is granted, therefore the card is yours. It is wrong,
because between those two facts sits work llama-manager has to finish — a generation in
flight, a resident model to move, an engine child to stop. Handing over a card that
still has a model on it means the new holder OOMs or, worse, silently competes.

So the state machine grants a card and stops. It moves the lease to `pending`, binds it
to a specific card, and tells nobody it is ready. Only when the owner has actually
drained the card does it call `markHeld()`. **Nothing else performs that transition** —
the state machine never assumes a card is free just because it decided to give it away.

This is also why the state machine is pure and cooperative. It **never kills, drains, or
touches a card itself**; a preemption victim is moved to `preempted` and its owner is
told through `onPreempt`. That keeps the whole arbitration deterministic, clock-injected
and unit-testable on a one-GPU box, with every side effect confined to `server.js`.

The cost is that `reserve` alone is a trap — a 202 that reads like a grant. That is
precisely why `lock` (reserve + wait) exists and is documented as what most callers
want, and why the pending/held distinction is repeated in the API description text, the
MCP tool descriptions, and the feature doc. **The honest state machine is worth an extra
call**; the alternative is a mechanism that lies at exactly the moment it matters.

### The transaction hazard this created

`onPreempt` fires **mid-transaction** — after the victim is moved aside, but *before*
the displacing claim is bound to the card. A handler that calls back into the state
machine sees a free card that is about to be taken and hands it out twice. This was
observed live as two holders on a capacity-1 pool.

The rule that came out of it: **nothing in the server's GPU section may call back into
`gpuReservations` from `onPreempt`.** Re-establishing llama-manager's own pin is
deferred to the sweep timer, which is the one place that runs outside any transaction.
The cost is up to one sweep interval (5 s) of latency before a pin retakes a card;
correctness was preferred over immediacy.

---

## Why a drained request parks instead of failing

A request already in the system must survive a card being taken away, exactly as it
survives an engine mode swap today. Answering it with a 404 or a 503 because an
unrelated agent wanted a GPU would turn the reservation mechanism into **a denial of
service against llama-manager's own callers** — an external party could fail arbitrary
inference requests by taking a lease.

So the drain plan has a floor and an optimisation, in that order:

- **Parking is the floor.** A model with nowhere else to go queues until the card comes
  back. It waits; it does not fail.
- **Offloading is the optimisation**, available only when `findFastestAvailableBackend`
  says a peer can actually serve the model.

`hasViableRemote` is treated as **false when absent**, not as unknown-therefore-routable:
a model wrongly believed servable elsewhere has its requests sent to a peer that cannot
answer them, whereas a model wrongly parked merely waits. The asymmetry of those two
failures decides the default.

Two ceilings keep the policy from becoming its own hang: the drain waits at most 120 s
for in-flight work before stopping the engine anyway (a wedged request must not strand a
holder forever), and a parked request waits at most 300 s. Both are bounded because
"never fail a request" and "never block forever" are both requirements.

---

## Why the unfriendly-neighbour fallback stays a guess

Not every program on the box will learn to call this API — that is the premise, not an
edge case. `agentHoldsCard` in `api/duo-accelerator.js` infers from VRAM headroom
whether something is using the card, and llama-manager then declines to schedule onto it.

Its measured basis: between jobs the pods agent's two servers hold about **1.45 GB** of
the 24 GB card. Treating any non-zero usage as busy would mean llama-manager never got
the card at all, so the test is not "is the card untouched" but "is there still room for
the agent to burst."

Two properties were chosen deliberately:

- **A soft claim never evicts anything.** It is a reason to stay away, not a reason to
  act. Acting on a guess is how you kill someone else's job.
- **A reservation is checked before the guess, and settles the question outright** —
  including ahead of the `llama-first` override. `llama-first` exists to overrule a
  *guess* about who is using the card; a reservation is not a guess.
- **A soft claim does not clear the pool's `free` flag.** `reserve()` ignores soft claims
  entirely, so reporting `free: 0` would predict a failure that will not happen. The
  signal stays visible in `softClaimed`, where a caller weighing whether the card is
  *worth* taking reads it — separating "would this succeed" from "would this be rude."

`agentHoldsCard` also returns **true when telemetry is missing**: llama-manager must
never claim a card it cannot see the state of, because the failure mode is starving the
agent mid-job. That conservative default belongs in the *scheduling decision* only —
the `softClaimed` readout deliberately reports nothing for a card it has no telemetry
for, because an appliance with no telemetry wired must not read as permanently busy.

**Known consequence, unresolved (`T31258b5e1fa2b`).** The 8 GiB headroom figure is
absolute and was chosen for a 24 GB discrete card. The Strix Halo APU reports 1 GiB of
dedicated VRAM, so the comparison is meaningless there and the APU reads as
soft-claimed permanently. It blocks nothing, but it costs the signal on the box where it
would be real.

---

## Why authorization is a loopback rule

The server has **no inbound authentication middleware at all** — `apiKeyEnvVar` is
outbound-only and `docs/auth` is empty. Building a general API-key mechanism was not in
scope for this epic, and shipping the GPU routes unguarded was not acceptable either.

The operator chose *"open on localhost, authenticate from off-box"*: mutating routes
accept loopback callers and 403 everyone else; read-only routes stay open like
`GET /api/stats`. It is one function (`isLoopbackRequest`), so real key auth replaces it
in one place.

It reads the **socket's** peer address, never `req.ip` and never `X-Forwarded-For`. The
server sets no `trust proxy` today, so the two agree — but if one were ever enabled,
`req.ip` becomes client-settable through a forwarded header and would hand any remote
caller the loopback grant. The socket address cannot be spoofed by the client.

### The consequence the operator accepted

**`holder` is a descriptive label, not an authorization scope.** `renew` and `release`
do not fail closed on ownership, so **any local process can renew or release any lease**,
including the pods agent's and including llama-manager's own model pin.

That is not an oversight in the state machine — it is deliberate, and its header says
so. The module diverges here from `PreparedContextStore` in `api/context-cache.js`,
whose `scopeId` *is* an authorization scope. Enforcing who may touch a reservation is
the transport layer's job, and under "open on localhost" the transport layer has no
identity to enforce with. Adding a check against `holder` would be security theatre:
the caller supplies `holder` on the request.

This is fine for a co-installed, cooperating agent, which is the deployment this was
designed for. It is **not** a boundary between mutually distrusting local programs, and
it must not be relied on as one. It is written down here and in the feature doc so that
nobody discovers it by accident, and so that whoever adds key auth knows this is a
capability they are expected to add rather than a behaviour they are preserving.

---

## What is deliberately deferred

**Preset-mode pinning.** Router mode honours a pin; single-preset mode does not consult
it. The local llama.cpp router is one process serving every model, so it binds to one
card, and the first pool that pins models and holds a card supplies that binding.
Per-model placement across several cards would need a router per card, which this
appliance does not run. Deferred rather than faked.

**Inbound API-key auth as a general mechanism.** The loopback rule only.

**Changing default behaviour on a single-GPU box.** Everything here is additive: with no
`gpus` array configured, `resolvePools([])` returns no pools, no reservation can be
created, no drain can run, and no pin environment is emitted. A one-GPU appliance
behaves exactly as it did.

---

## The state of CUDA execution (as of 2026-09-08)

Recorded honestly because the epic's value depends on it and the answer has been moving.
Tracked as `T312557bb1b9bc`. The build procedure is written up in
`docs/llama-cpp-cuda-rpc-build-and-deployment.md`, which lands with that task and is
not in this tree yet.

**Reservations protect the card. They do not make it usable.** As of this writing
llama-manager cannot execute anything on the discrete RTX 3090.

What has been proven: an 8B model **has** run on the 3090 on drakemore, via a
CUDA-built llama.cpp `ggml-rpc-server` compiled from the same commit the ROCm engine is
pinned to (`b96806d9` / b10752, RPC protocol 6.0.0). Qwen3-8B-Q4_K_M loaded fully onto
the card (VRAM 1475 → 12128 MiB, the rpc-server process holding 10648 MiB) and served a
completion at **132 tok/s** generation with GPU utilisation peaking at 93%, while the
pods agent's two resident processes were left untouched throughout and the card returned
to its 1475 MiB baseline on teardown.

What that is **not**: an installed capability. The binary was run from `/tmp`, nothing
was installed into `/var/lib/llama-manager`, and llama-manager itself still cannot reach
the card.

Three facts worth carrying forward:

1. **The remaining blocker is the router, not the CUDA side.** The deployed HIP engine
   (b10752) was compiled without `-DGGML_RPC=ON`, and `ggml-backend-reg.cpp` registers
   the RPC backend under `#ifdef GGML_USE_RPC` with `GGML_BACKEND_DL` off — backends are
   statically linked, not scanned for. Dropping a `libggml-rpc.so` into the engine
   directory is inert even though that directory looks exactly like a plugin directory.
   `-DGGML_RPC=ON` has been added to `scripts/build-llama-cpp.sh`; the ROCm engine must
   be rebuilt and redeployed before any wiring works. The failure mode is **quiet** — the
   router starts and simply never offloads — so "the process survived" proves nothing.
   The bar is three signals together, since each has an innocent explanation alone:
   `--list-devices` lists an `RPC0` entry, **the rpc-server PID owns the climbing VRAM**
   in `nvidia-smi`'s process table, and throughput is in the right order of magnitude.
   `RPC0` alone is necessary but not sufficient — it proves the router has an RPC backend
   and reached the server, not that any tensor landed on the card; an engine can list
   `RPC0` and serve entirely from CPU. The VRAM-ownership signal is the one a CPU
   fallback cannot fake.

2. **A CUDA target needs more than `libcuda.so.1`.** Earlier notes in this epic said the
   target needed only the driver library; that is false. `libggml-cuda.so` also NEEDs
   `libcudart.so.13` and `libcublas.so.13` (which pulls `libcublasLt.so.13`) — CUDA
   *toolkit* libraries, not driver libraries. They total 595 MB, ~540 MB of it
   libcublasLt, and `nvprune` refuses CUDA 13's redistributable `.so` outright ("not
   relocatable"), so the usual trimming path is closed. That size is the central
   packaging problem; the current recommendation is that the package **depend on the
   distro's `cuda-cudart` / `libcublas` packages** rather than vendor them.

3. **The rpc-server architecture held up empirically, and the reservation semantics are
   unaffected.** Killing the rpc-server returned the card to baseline immediately with
   the pods agent still resident — the card is *borrowed*, not claimed, which is exactly
   what `api/duo-accelerator.js` assumes and why that indirection was chosen over a
   second CUDA-linked llama-server build. That measurement, not a preference, is what
   settles the question: a CUDA-linked engine would hold the card for the router's whole
   lifetime, and holding the card for a process lifetime is precisely the property that
   makes it unshareable. For the same reason the CUDA rpc-server is to be packaged with
   **no systemd unit**, so llama-manager owns start and stop. Nothing found in that work
   argues for changing any reservation semantics.

The earlier "amd-XOR-nvidia" platform concern recorded in epic `T310ec1fa136dd` is
**stale**: both driver stacks are loaded and bound simultaneously on drakemore
(`card1 → nvidia 10de:2204`, `card2 → amdgpu 1002:1586`), with the NVIDIA open kernel
module 610.43.02 and `nvidia_uvm` live.

---

## Known defects at time of writing

| Task | State | Effect |
|---|---|---|
| `T312594d909a54` | **fixed** (`3dec3f2`) | A claim that had to **queue** was bound to a card when one freed but was never promoted to `held`; `wait` on it 408'd until the TTL expired. The sweep timer now starts the drain the promotion could not start itself — promotion happens inside a transaction, and reserving from there double-books the card. Promotion latency is therefore bounded by the 5 s sweep interval. |
| `T31258b5e1fa2b` | open | `softClaimed` is permanently populated on a Strix Halo box, because the 8 GiB headroom figure is meaningless against 1 GiB of dedicated VRAM. Advisory only; blocks nothing. |
| `T31256f487e4ee` | open | `gen-openapi.mjs` emits only `200` response objects for all 131 operations, so the GPU routes' load-bearing `202`/`408`/`409`/`503` codes are prose, not schema. A generated client assumes 200. |
| `T3125955cb14f3` | open | The declared **200** schemas for the GPU routes diverge from what the server returns in six places (pool `free` is an integer not a boolean, `softClaimed` an array not a boolean, the reservation schema requires a field the records do not carry). |
| `T312557bb1b9bc` | in progress | Nothing can execute on the discrete NVIDIA card through llama-manager; see above. |

---

## Related

- [`../features/gpu-reservations.md`](../features/gpu-reservations.md) — what it does and how to use it
- [`EngineAbstraction.md`](EngineAbstraction.md) — the engine seam a drain stops and restarts
- [`ModelManagement.md`](ModelManagement.md) — model lifecycle, router vs preset mode, residency
- [`../features/memory-pressure-governor.md`](../features/memory-pressure-governor.md) — the other resource guard, and the house pattern of a pure decision module wired to real effects in `server.js`
