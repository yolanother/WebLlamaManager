<!--
Llama Manager — appliance federation design.

Design for turning independent Llama Manager appliances into a self-organising
cluster: how a node acquires an identity, how nodes find each other, how one is
designated main, how the main node offloads inference to the others, and how
model downloads are managed fleet-wide from a single screen. States what is
already built, what is decided, and what is still open. Written 2026-08-25
against appliance build 2e0d5c6f; measurements in it were taken on real hardware
and are labelled as such.
-->

# Appliance federation

## The goal

Three boxes on a desk, each booted from a thumb drive, should become one system
without anybody editing a config file. Plug them in; they name themselves, find
each other, agree who is in charge, and the one in charge can drive the rest —
including pulling models onto them.

Everything below is subordinate to that. A design that is elegant but needs a
setup step on each node has failed the brief.

## Principles

1. **Zero configuration is the requirement, not the aspiration.** Any step that
   asks the operator to type an address, a token, or a role is a defect unless
   it is the one deliberate choice we ask for (the naming theme).
2. **A node alone must be fully useful.** Federation is additive. A single box
   with no peers behaves exactly as it does today, with no degraded paths and no
   waiting on elections.
3. **Degrade to working, never to broken.** Every federation feature has an
   answer to "what if the network is hostile / the peer vanished / the model is
   not up yet", and that answer is always a working single node.
4. **The live USB is a first-class deployment.** Anything that only works after
   an install-to-disk is not done. Identity, discovery, and role must survive a
   live boot.

## Phase 0 — node identity *(done)*

Each node is reachable at `http://{name}-llama-manager.local`.

**Decided:** a single mDNS label, `{name}-llama-manager`. Not
`{name}.llama-manager.local` — three-label names under `.local` require CNAME
publication and do not resolve reliably from macOS, Windows or iOS, which is
precisely where zero-config has to hold.

**Measured on hardware (2026-08-25):** `avahi-daemon` is already active on the
appliance and publishes `<hostname>.local`; `llama.local` resolved with no work.
Setting the system hostname is therefore sufficient — no custom publication, and
no dependency on `avahi-publish`, which is not installed. The USB carries a
writable `ext4` partition labelled `writable` (41 GB, already mounted), so a
generated name persists across live boots.

Before a theme is known a node is `setup-llama-manager`. That name is
deliberately memorable and identical on every fresh node: the operator's first
action is to open one of them, and a fleet of three unconfigured boxes competing
for the same name is a problem we would rather surface immediately than paper
over. **Open question O1** below.

## Phase 1 — discovery *(built)*

Nodes advertise a DNS-SD service (`_llama-manager._tcp`) carrying, in TXT
records: schema version, node id, name, role, engine state, loaded model, and
the capability triple (`gpu`, `vram`, `engines`) that settles O5.

Browsing that service gives every node a live picture of the fleet without a
registry, a broker, or a bootstrap address. A node that sees no peers is simply
a fleet of one — and reports an empty list, having filtered itself out of its
own browse by node id.

**Why DNS-SD rather than a gossip protocol or a broadcast of our own:** it is
already running on the box and every OS ships a browser for it.

**Measured on hardware (2026-08-25), and each of these changed the design:**

- **There is no `avahi-browse` on the appliance.** Only `avahi-daemon` and the
  libraries are installed; `avahi-utils` is absent entirely. Discovery therefore
  speaks the mDNS wire format directly over an ephemeral UDP port rather than
  shelling out, which also lets it coexist with the avahi already holding 5353.
  Queries set the unicast-response bit, which avahi honours.
- **Publishing is free.** Writing `/etc/avahi/services/llama-manager.service` is
  picked up with no restart — the journal shows "Files changed, reloading" then
  "successfully established". No polkit seam, no unit bounce, no dependency.
- **One query returns a whole peer.** Verified from a second machine, a single
  PTR query comes back with PTR, TXT, SRV, A and AAAA stuffed into one response.
  Discovery is one round trip, not three.
- **`ProtectSystem=full` makes all of `/etc` read-only.** Owning the service file
  is not sufficient; without a `ReadWritePaths` carve-out the manager gets EROFS
  and the node never appears, with a correctly owned file sitting there.
- **avahi refuses a service group whose instance name and type are already
  claimed locally.** The advertisement is therefore one fixed path, always
  overwritten in place; a second file under another name takes the node OFF the
  fleet rather than updating it.
- **`deny-interfaces=lo` is what stops avahi renaming the node.** Without it
  avahi publishes on loopback before the real interface exists, finds its own
  record on re-probe, and renames itself to `<name>-2`. Already handled by
  `scripts/llama-manager-identity`, which edits avahi's config at boot — that
  placement is the right one, since it covers an installed disk and not only the
  live ISO layer. Discovery depends on it and does not re-implement it.

Live state beyond triage is fetched over HTTP once discovery yields a host and
port; the TXT records carry only what is needed to find a peer and place work.

## Phase 2 — main-node designation *(built)*

One node coordinates. The rest serve inference on request.

**Decided (O2):** deterministic election over the discovered set, lowest node id
wins, with an explicit operator override that is sticky and persisted.

The election is *convergent rather than negotiated*. Every node ranks the same
set of ids the same way, so all of them reach the same answer without exchanging
a message, and transiently different views settle by themselves as discovery
converges. No terms, no votes, no quorum.

The operator's pin is both persisted **and advertised**. Advertising it is
load-bearing, not informational: the TXT record is the only channel by which a
choice made on one node's screen reaches the rest of the fleet, and a pin that
were merely stored would leave every other node quietly electing around the
operator's decision. A node does not prefer its own pin over a peer's, or two
pinned nodes would each believe they were main and the fleet would never
converge.

A node that cannot state its own id defers rather than claiming main — a main
node the fleet cannot address is worse than none. A node alone is main of a
fleet of one, with nothing to wait for.

The main node's authority must be soft: a secondary that loses contact keeps
serving its own users. There is no fencing and no quorum here — this is a desk,
not a datacentre, and the failure we actually expect is a thumb drive being
pulled out.

## Phase 3 — inference offload *(gated — harness built, not yet run)*

The main node routes work to peers when that is faster than serving it locally.

This is the phase with the most unknowns and the least justification for
guessing, so it stays gated. `scripts/measure-offload.mjs` is the gate and is
ready to run against two live appliances.

The framing that harness encodes, because it decides the size of this phase: a
single request on an idle box is **always** faster served locally — the hop buys
nothing and costs a round trip. Offload can only pay when the local node is
saturated or cannot serve the request at all. So the harness measures the *hop
tax* (one request local vs shipped, both idle) and the *crossover* (N concurrent
requests local-only vs spread across the fleet), and treats a cold peer that
must load the model first as a separate and much more expensive proposition.

Load is spread round-robin rather than by a clever policy, deliberately: that is
the floor any real routing must beat, and a policy that cannot beat round-robin
is not worth building. The verdict reads p50, never mean — one cold model load
drags a mean somewhere no request actually went — refuses to answer at all on a
partial run, and reports a gain below 1.25x as marginal rather than as a green
light.

## Phase 4 — managed model downloads *(built)*

From the main node's screen, pull a model onto any node, or all of them.

The distinction the fleet screen lives on is between "that node does not have
the model" and "that node did not answer". They look identical in a naive merge
and are not remotely the same to an operator: showing an unreachable node as
missing invites a redundant multi-gigabyte download onto a box that already
holds the file. An in-flight download is reported as in flight, not as present —
a half-downloaded model is not a model.

Targeting never defaults. An unspecified target resolves to nothing rather than
to "all", because defaulting a mis-typed request to the whole fleet turns a typo
into simultaneous downloads on every box.

The download UI becomes fleet-aware: a model has a per-node presence, and the
operator acts on the fleet rather than on a box. The main node does not proxy
the bytes — it tells each node to fetch, and each reports progress — because
proxying makes the main node's uplink the bottleneck for every node at once.

## Security posture

Stated plainly because it is easy to skip and expensive to retrofit.

Today the appliance answers on `0.0.0.0` with no authentication.

**Decided (O4): LAN-trust, no shared secret.** Work is accepted from any node
advertising `_llama-manager._tcp` on the local link. Stated plainly once,
because the alternative was offered and declined deliberately: anything on the
LAN can queue inference on this hardware. That is an accepted posture for a
desk-scale fleet behind a router, and it is the first decision to revisit if the
fleet ever leaves that setting.

## Open questions

- **O1 — name collision on first boot. DECIDED (2026-08-25): the node steps
  aside itself.** At boot, a node falling through to the bootstrap name probes
  the link and adopts the first free variant (`setup`, `setup-2`, `setup-3`),
  then persists what it picked. The visible result matches what avahi would have
  done anyway; the difference is that the NODE knows. Left to avahi, the record
  is renamed silently while the manager goes on reporting the name it thinks it
  has — handing the operator a URL that opens a different machine.

  Rejected: seeding from the machine ID, which is unique but unguessable and
  breaks the "open one of them" first action the setup flow is built around.

  Only the bootstrap fall-through probes. A name an operator chose is published
  as given, and a node that finds itself is not a collision — otherwise a box
  would rename on every boot. The probe is bounded, which is load-bearing: an
  mDNS query for a name nobody holds does not fail, it waits, and the identity
  unit is ordered before avahi.

  The residual race — three boxes booting simultaneously, all probing empty air
  — is accepted. avahi still resolves it, and discovery keys peers on the stable
  node id rather than the name.
- **O2 — election vs operator designation. DECIDED (2026-08-26):** lowest node
  id wins, with a sticky, advertised operator override. See Phase 2. Rejected:
  capability-weighted ranking, which moves main whenever a bigger box joins and
  needs damping because capability changes at runtime; and operator-only
  designation, which leaves a fresh fleet with no main until somebody chooses.
- **O3 — is offload worth it?** OPEN, and deliberately still open. The harness
  exists (`scripts/measure-offload.mjs`) and the verdict logic is tested; the
  run needs two live appliances and the second one is down. Phase 3 does not
  start until this produces a number.
- **O4 — fleet trust. DECIDED (2026-08-26):** LAN-trust, no secret. See the
  security posture above.
- **O5 — mixed hardware. DECIDED (2026-08-25): a capability triple, not an
  inventory.** Each node advertises `gpu` (vendor), `vram` (usable model memory
  in MiB), and `engines` (the backends it can actually run). "Can this peer run
  model X" is answered by engine format support plus memory fit; which models
  are on disk is a separate per-node question that belongs to Phase 4.

  Usable memory is the larger of VRAM and GTT, and that is the point of it: the
  Strix Halo appliance reports a nominal 1 GB of dedicated VRAM against ~120 GB
  of real model memory in GTT, while a discrete NVIDIA card is the reverse. A
  peer that believed the APU's VRAM figure would never be offered a model it runs
  comfortably. Verified on hardware — the appliance advertises `vram=122800`.

  A machine reporting several GPUs resolves to the most capable, since a
  workstation with a discrete card also reports the integrated adapter beside it.

## Sequencing

Phases 0 and 1 are independently useful and carry no risk to a single node.
Phase 2 is small once 1 exists. Phase 3 should not start until O3 is measured.
Phase 4 depends on 1 and 2 but not on 3, and is the phase the operator will feel
most, so it should not be sequenced behind the hardest one.
