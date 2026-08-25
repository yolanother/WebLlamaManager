# Zero-configuration node identity

## Decision

Every appliance names itself and is reachable at
`http://<name>-llama-manager.local` with no configuration on the box or on the
machine connecting to it, on a live USB boot and on an installed disk alike.

The name is published by setting the system hostname. `avahi-daemon` ships and
runs on the appliance image and already publishes `<hostname>.local`, so nothing
publishes mDNS records of its own — setting the hostname is the whole mechanism.

## Why one flat label

The hostname is a **single** mDNS label, `<name>-llama-manager`, not
`<name>.llama-manager.local`. A three-label name under `.local` requires CNAME
publication and does not resolve reliably from macOS, Windows, or iOS — which is
exactly where zero-configuration access has to work. The `-llama-manager` suffix
keeps appliances recognisable in a `.local` browse list without costing a label.

## Why this lives in the app package

The `llama-manager` package is installed both into the live squashfs (the ISO
build unpacks it with `dpkg-deb --extract`) and onto an installed disk (`apt`).
The hostname has to be right in both cases, so identity resolution ships with the
package rather than with the ISO's live-only scripts. The kiosk UI that drives it
is the respin's, because the kiosk exists only on the appliance image.

## Resolution order

`scripts/llama-manager-identity apply` resolves the name in this order:

1. `/var/lib/llama-manager/node-name` — persistent state, and what the manager
   writes when an operator picks a name.
2. `llama-manager/node-name` at the **root** of the partition labelled
   `writable` — the live USB's persistence.
3. `setup` — the bootstrap name, so a box that has never been named is already
   addressable at `setup-llama-manager.local` on its very first boot.

One rule covers both directions. At a live boot the persistent path is an empty
RAM overlay, so the partition's copy wins and the node re-adopts the identity it
was given. Immediately after the manager saves a new name the persistent path
exists, so the new name wins over the now-stale mirror. The resolved name is
written back to every store on each run, which is what carries a live boot's
choice out onto the partition.

An installed disk has no `writable` partition; step 1 is simply persistent there
and step 2 finds nothing.

## Applying the name

| Concern | Where |
|---|---|
| Resolve and publish | `scripts/llama-manager-identity` (root) |
| Unit | `llama-manager-identity.service` |
| Pulled in by | `Wants=` / `After=` in `llama-manager.service` |
| Live re-apply | manager restarts the unit through `packaging/90-llama-manager.rules` |
| Naming rules | `api/node-identity.js` |
| API | `GET`/`POST /api/node/identity`, `POST /api/node/name-suggestions` |
| State path | `nodeNamePath` in `api/runtime-paths.js` |

The identity unit is deliberately **not** enabled with a `WantedBy=` symlink.
`llama-manager.service` pulls it in with `Wants=`, so the one enablement that
already exists — the image build's `enable_service`, and the package's own —
brings identity along on both media. There is no second enablement path to keep
in sync between the packager and the ISO build.

The manager runs unprivileged and never changes the hostname itself. It persists
a name and restarts the identity unit, which the package's polkit rule permits
for that unit only. Granting the unit rather than the `hostname1` polkit action
keeps the privilege scoped to one script whose behaviour the package fixes, and
means exactly one component writes the hostname at boot and at rename both.

Applying a name also rewrites the `127.0.1.1` alias in `/etc/hosts`.
`hostnamectl` does not, and a stale alias is what produces `sudo: unable to
resolve host` and a multi-second stall on every privileged command afterwards.

## Naming from the local model

The kiosk asks for a naming theme. The manager loops that back through its own
`/api/v1/chat/completions` with `model: "auto"`, so generation inherits the same
queueing, model routing, and engine activation as any other request and works on
either engine.

The model's answer is not trusted. It is read out of a JSON array where one is
present (including inside a code fence), otherwise line by line; candidates are
rejected by word and hyphen count so a chatty answer cannot become the machine's
address, folded to a legal label, length-capped, de-duplicated, and probed for
mDNS collisions before they are offered.

Every failure — no theme, no engine, a refusal, a timeout, a wall of prose —
returns an empty candidate list and a reason. Nothing is renamed, so the node
keeps the name and address it already answers to. Generation is bounded at 90
seconds: the chat route will patiently wait out a three-minute cold model load,
which is right for a real request and wrong for a kiosk asking for name ideas.

## Verified on hardware

On a live appliance: a wiped RAM overlay with the hostname reset to casper's
default re-adopts its name from the partition root when
`llama-manager.service` starts, publishes it, and answers at
`<name>-llama-manager.local` from another machine on the LAN. Renaming through
the API takes effect immediately and withdraws the old name.

See [GOTCHAS](../GOTCHAS.md) for the three things that only showed up there:
avahi not noticing a hostname change, the systemd deadlock that a blocking
restart of it causes, and where casper actually mounts the `writable` partition.
