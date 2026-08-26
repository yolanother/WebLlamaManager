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
- **O2 — election vs operator designation.** See Phase 2.
- **O3 — is offload worth it?** Measure before building: time a request served
  locally against the same request shipped to a peer, on the real hardware, with
  a warm and a cold model. If the crossover is rare, Phase 3 is a much smaller
  feature than it looks.
- **O4 — fleet trust.** What establishes it, and what happens when an untrusted
  node advertises itself.
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
