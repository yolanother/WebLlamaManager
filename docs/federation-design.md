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

## Phase 0 — node identity *(in progress, task pmc737LOFfNkGFXQMKZ7D)*

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

## Phase 1 — discovery

Nodes advertise a DNS-SD service (`_llama-manager._tcp`) carrying, in TXT
records: node name, role, engine state, model inventory hash, and API port.
Avahi is already running and already publishes; this is one service file plus
the code to keep the TXT records current.

Browsing that service gives every node a live picture of the fleet without a
registry, a broker, or a bootstrap address. A node that sees no peers is simply
a fleet of one.

**Why DNS-SD rather than a gossip protocol or a broadcast of our own:** it is
already running on the box, every OS ships a browser for it, and it makes the
fleet inspectable with `avahi-browse` when something is wrong — which matters
more than protocol elegance the first time a node does not appear.

## Phase 2 — main-node designation

One node coordinates. The rest serve inference on request.

**Leaning, not yet decided (O2):** deterministic election over the discovered
set, lowest node-id wins, with an explicit operator override that is sticky and
persisted. Automatic election keeps the zero-config promise; the override exists
because the operator will have opinions about which box is the good one, and a
system that re-elects around them is infuriating.

The main node's authority must be soft: a secondary that loses contact keeps
serving its own users. There is no fencing and no quorum here — this is a desk,
not a datacentre, and the failure we actually expect is a thumb drive being
pulled out.

## Phase 3 — inference offload

The main node routes work to peers when that is faster than serving it locally.

This is the phase with the most unknowns and the least justification for
guessing. What we know: the manager already has a router mode and a queue, so
the shape of "hold a request, pick a target, stream back" exists. What we do not
know: whether offload beats local execution often enough to be worth it on this
hardware, given a 5 GB model load and a gigabit link. **That is measurable and
should be measured before it is built** — see O3.

## Phase 4 — managed model downloads

From the main node's screen, pull a model onto any node, or all of them.

The download UI becomes fleet-aware: a model has a per-node presence, and the
operator acts on the fleet rather than on a box. The main node does not proxy
the bytes — it tells each node to fetch, and each reports progress — because
proxying makes the main node's uplink the bottleneck for every node at once.

## Security posture

Stated plainly because it is easy to skip and expensive to retrofit.

Today the appliance answers on `0.0.0.0` with no authentication, which is a
reasonable default for one box on a home LAN and an unreasonable one for a fleet
that accepts work from peers. Before Phase 3 ships, node-to-node calls need at
minimum a shared secret established at designation time, and the fleet needs to
refuse work from nodes outside it. **Open question O4.**

## Open questions

- **O1 — name collision on first boot.** Three unconfigured nodes all claim
  `setup-llama-manager.local`. mDNS will resolve this by renaming (`-2`, `-3`),
  which is survivable but confusing. Alternative: seed the bootstrap name from
  the machine ID so it is unique but unmemorable. Decide before Phase 1.
- **O2 — election vs operator designation.** See Phase 2.
- **O3 — is offload worth it?** Measure before building: time a request served
  locally against the same request shipped to a peer, on the real hardware, with
  a warm and a cold model. If the crossover is rare, Phase 3 is a much smaller
  feature than it looks.
- **O4 — fleet trust.** What establishes it, and what happens when an untrusted
  node advertises itself.
- **O5 — mixed hardware.** An AMD box and an NVIDIA box in one fleet: does the
  main node need to know which models each peer can actually run? Almost
  certainly yes, which means the inventory in the TXT records is a capability
  record, not just a model list.

## Sequencing

Phases 0 and 1 are independently useful and carry no risk to a single node.
Phase 2 is small once 1 exists. Phase 3 should not start until O3 is measured.
Phase 4 depends on 1 and 2 but not on 3, and is the phase the operator will feel
most, so it should not be sequenced behind the hardest one.
