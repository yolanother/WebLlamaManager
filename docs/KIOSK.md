# Llama Manager live kiosk shell

Copyright (c) 2026 DoubTech. Use of this document is governed by the LICENSE
file in the repository root.

The live session boots into an appliance, not a desktop. Choosing **Try Llama
Manager (live appliance)** starts a fullscreen, branded shell under the Cage
Wayland compositor that lets someone talk to a model on the box immediately,
tells them the address to open from their own laptop, and offers to install.

This document covers the shell. The live session that hosts it — the GRUB entry,
the cloud-init seed, and the autostart script that publishes the hooks below — is
documented in `docs/LIVE-USB.md`.

`scripts/build-kiosk-shell.sh` renders that shell for one hardware platform.

```bash
scripts/build-kiosk-shell.sh amd                   # -> build/kiosk/amd
scripts/build-kiosk-shell.sh nvidia /tmp/shell     # explicit output directory
```

The argument is a **branding** id, not a build target. `release-config.sh` names
the NVIDIA target `nvidia-spark`; resolve its branding id first:

```bash
scripts/build-kiosk-shell.sh "$(scripts/release-config.sh platform branding)"
```

The render is self-contained and deterministic. It refuses an unknown platform
and refuses a platform whose brand asset set is incomplete, so a half-themed
shell can never reach an image.

## What the shell shows

| Surface | Purpose |
|---|---|
| Readiness rail | Processor, graphics adapter and driver, memory, and inference engine state, read live from the machine |
| Local inference | A chat against the local engine, with a specific explanation whenever it is not usable |
| Connect from another machine | The `.local` address to open for the full Llama Manager dashboard, plus every interface's IP |
| Name this node | A naming theme, the names the local model suggests for it, and the one the operator picks |
| Install to this machine | Primary action; runs `pkexec live-install` |
| Open desktop mode | Secondary action; runs `pkexec live-desktop` |

### Rendered payload

```
index.html         markup, with the resolved product name substituted in
theme.css          generated: the platform palette and identity as CSS custom properties
app.css            static stylesheet, reads everything from theme.css
app.js             static behaviour
kiosk.json         machine-readable record of what this bundle was themed as
kiosk-agent.py     the local agent (below)
assets/            logo-mark.png, wallpaper.png
```

`assets/logo-mark.png` is `branding/assets/llama-<platform>.png` and
`assets/wallpaper.png` is `branding/assets/splash-<platform>.png`. The splash
doubles as the GDM and GNOME background and carries the brand mark burned into
its lower-left corner; the shell zooms it from the bottom-right so that corner
falls off-canvas, because the masthead already sets that mark.

Nothing in the bundle references a remote origin. The live session has no
internet, so `tests/test-kiosk-shell.sh` fails the build if any rendered file
contains an absolute `http://` or `https://` URL. Runtime endpoints are composed
from scheme, host, and port parts instead of being stored as literal URLs; the
browser only ever makes same-origin requests to the agent.

## Launching it (the contract for the live session)

**One command brings the shell up on screen:**

```
<bundle>/start-kiosk-shell.sh
```

That is the whole interface. It starts the kiosk agent, waits for it to accept
connections, and then `exec`s Cage running a fullscreen browser pointed at the
shell. Nothing else needs to know the port, the URL, or which browser is present.

Run it as the session's main process — a systemd user unit, a session script, or
whatever the live layer prefers. Cage replaces the launcher via `exec`, so the
process you start is the process that stays. The agent is left running as its
child and is reaped with the session's cgroup when Cage exits.

### Where the bundle lives

`scripts/build-kiosk-shell.sh` writes a self-contained directory. Staging it onto
the media or into the live rootfs is payload work owned outside this shell; the
launcher only requires that `start-kiosk-shell.sh`, `kiosk-agent.py`, and the
rendered files stay **in the same directory**, because the launcher resolves the
agent relative to itself and the agent serves its own directory.

### Browser requirement

**The image must ship a browser — none is declared today.** `cage` is a
dependency of `llama-manager-appliance`, but nothing to render in it is, and the
lean live package set installs neither. The launcher tries, in order:

| Browser | Invocation | Notes |
|---|---|---|
| `cog` | `cog <url>` | **Preferred.** WPE WebKit, no window chrome, smallest footprint |
| `epiphany-browser` | `--application-mode` | WebKitGTK fallback |
| `chromium` / `chromium-browser` | `--kiosk --ozone-platform=wayland` | |
| `firefox` | `--kiosk` | |

Override the list with `LLAMA_KIOSK_BROWSERS`.

### Failure behaviour

Every failure exits non-zero with a specific diagnostic on stderr, so a problem
lands in the journal rather than showing as a black screen:

| Condition | Message |
|---|---|
| No browser installed | `No kiosk browser is installed. Tried: ...` |
| Cage missing | `Cage compositor is missing: cage` |
| Agent file missing | `Kiosk agent is missing: <path>` |
| Agent dies during startup | `Kiosk agent exited before it began serving.` |
| Agent never listens | `Kiosk agent did not start serving within N seconds.` |

The browser is resolved **before** anything starts, so an image with no browser
fails immediately instead of after the agent is already running.

### Launcher configuration

| Variable | Default | Meaning |
|---|---|---|
| `LLAMA_KIOSK_AGENT` | `<bundle>/kiosk-agent.py` | Agent to start |
| `LLAMA_KIOSK_PYTHON` | `python3` | Interpreter |
| `LLAMA_KIOSK_CAGE` | `cage` | Compositor |
| `LLAMA_KIOSK_BROWSERS` | `cog epiphany-browser chromium chromium-browser firefox` | Preference order |
| `LLAMA_KIOSK_STARTUP_TIMEOUT` | `30` | Seconds to wait for the agent |

## The kiosk agent

A static page cannot read the machine's IP addresses, report its hardware, reach
the inference engine without a CORS preflight, or launch an installer.
`kiosk-agent.py` does those things. It uses only the Python 3 standard library,
binds loopback, and serves the rendered bundle as its document root.

```bash
cd build/kiosk/amd
python3 kiosk-agent.py           # then open http://127.0.0.1:8385/
```

| Endpoint | Method | Returns |
|---|---|---|
| `/api/system` | GET | `cpu`, `gpu`, `memory`, and which action hooks this image ships |
| `/api/network` | GET | `addresses[]` ordered most-reachable first, and `managerPort` |
| `/api/engine` | GET | `state` (`ready`, `unreachable`, `absent`), `model`, `models`, `port` |
| `/api/chat` | POST | Newline-delimited JSON stream of `{"delta"}`, then `{"done"}` or `{"error"}` |
| `/api/action/install` | POST | `{"status": "launched" \| "unavailable" \| "failed", "message"}` |
| `/api/action/desktop` | POST | Same shape as the install action |

`/api/network` lists only interfaces backed by real hardware. A machine running
containers has a dozen bridge addresses no visitor can reach, and advertising
one of those would send someone to a dead end.

### Configuration

Every setting is an environment variable with a working default.

| Variable | Default | Meaning |
|---|---|---|
| `LLAMA_KIOSK_BIND` | `127.0.0.1` | Address the shell is served on |
| `LLAMA_KIOSK_PORT` | `8385` | Port the shell is served on |
| `LLAMA_KIOSK_INFERENCE_SCHEME` | `http` | Scheme used to reach the engine |
| `LLAMA_KIOSK_INFERENCE_HOST` | `127.0.0.1` | Host running the engine |
| `LLAMA_KIOSK_INFERENCE_PORT` | `8080` | Port the engine listens on |
| `LLAMA_KIOSK_MANAGER_PORT` | `3001` | Dashboard port, and where the node-identity API is relayed to |
| `LLAMA_KIOSK_ENGINE_BIN` | `/usr/local/bin/llama-server` | Presence separates "not started yet" from "not installed" |
| `LLAMA_KIOSK_LIVE_MARKER` | `/run/llama-manager/live-media` | Live-session marker; see below |
| `LLAMA_KIOSK_INSTALL_COMMAND` | `pkexec live-install` | Install action |
| `LLAMA_KIOSK_DESKTOP_COMMAND` | `pkexec live-desktop` | Desktop-mode action |

## Naming this node

The appliance names itself so it can be reached at a `.local` address that does
not change with a DHCP lease. The manager owns that entirely — the naming rules,
the model call, the validation, and the hostname write all live in the
`llama-manager` package, documented in its `docs/Designs/NodeIdentity.md`. The
kiosk owns no naming policy at all; it relays.

| Agent endpoint | Relayed to | Purpose |
|---|---|---|
| `GET /api/identity` | `GET /api/node/identity` | Name and `.local` URL to display |
| `POST /api/identity/suggest` | `POST /api/node/name-suggestions` | Names the local model suggests for a theme |
| `POST /api/identity` | `POST /api/node/identity` | Commit the name the operator picked |

The connect tile leads with the `.local` address whenever the node has one and
falls back to a raw IP only when it does not. The naming panel is disabled until
the manager answers, because generation runs a completion on the local model
through it.

### Degraded behaviour

Both degraded paths matter on real media and are covered by
`tests/test-kiosk-identity.sh`:

- **The manager is not up yet.** On a live boot the appliance finishes installing
  itself minutes after this screen is already on it. `GET /api/identity` then
  answers from the system hostname with `managerUp: false`, so the screen still
  names an address rather than showing nothing, and the naming panel says naming
  becomes available once the machine is ready.
- **Generation fails.** No engine, a refusal, junk, or a timeout all come back as
  an empty candidate list, a reason, and the node's current identity. Nothing is
  renamed — the machine keeps the name and address it already answers to.

## Local inference endpoint expectation

The shell expects an **OpenAI-compatible** server on
`LLAMA_KIOSK_INFERENCE_HOST:LLAMA_KIOSK_INFERENCE_PORT`, which is what
`llama-server` and the Llama Manager router both speak. Two endpoints are used:

- `GET /v1/models` — the readiness probe. A 200 with a `data[]` array means
  ready, and the first `id` becomes the model name in the rail.
- `POST /v1/chat/completions` with `"stream": true` — the conversation. The
  agent relays each SSE `data:` frame's `choices[0].delta.content` to the
  browser as one newline-delimited JSON event, and terminates on `[DONE]`.

The agent prepends a system message naming the appliance so the model introduces
itself as running locally.

### Live mode now ships an engine, but it arrives a few minutes after the shell

This is worth stating plainly, because the shell must not promise otherwise.

The appliance stack — including `llama-manager-rocm-gfx1151`, where the engine
lives — is now **baked into the casper live layer at build time** (see
[BUILDING.md](BUILDING.md#the-appliance-stack-is-baked-into-the-live-layer)), and
the bundled Qwen3-8B is read straight off the medium. So a live session comes up
with a real dashboard and a real model, not a dashboard alone.

What is *not* instant is the first token. The engine runs inside the
`llama-rocm-7.2.4` Distrobox container, and that container's image cannot be
pre-populated at build time — a rootless Podman store is usable only by the
account that wrote it, and the release builder image carries no Podman. So
`start-live-appliance.sh` imports the OCI archive out of the live layer once at
boot, **after** the dashboard is serving. For those minutes the shell reports the
engine as absent, exactly as it did before, and points at the two things that
work meanwhile: the remote address, and installing to disk.

**The shell needs no change for either half of that**: the engine appearing flips
the state to `unreachable`, and the existing six-second probe turns the panel on
by itself once it starts serving.

Verified on hardware: ROCm 7.2.4 **does** drive gfx1151 on the casper kernel the
live session boots (`6.17.0-14-generic`, not the pinned mainline `6.18.36`), at
185.5 t/s prompt and 49.4 t/s generation on Qwen3-8B-Q4_K_M with full offload.
So the panel does turn on in live mode; it just turns on a couple of minutes
after the dashboard does.

### Every state is explained

The panel never shows a dead input box:

| State | What the person sees |
|---|---|
| `ready` | Chat enabled, model name in the rail, prompts to try |
| `unreachable` | "The engine is here but not answering yet", naming the port. The panel re-probes every 6 seconds and turns itself on when a model finishes loading |
| `absent`, live, dashboard not up | "Setting up from the boot media" — the live install is still running |
| `absent`, live, dashboard up | "Local models need the full install" — see below |
| `absent`, installed | "No inference engine on this machine yet", pointing at both the install action and the remote address |
| agent down | "The kiosk agent is not running", which is what you see if you open `index.html` directly |

The remote-access tile keeps working in every one of those states, because
someone else's laptop can reach the dashboard whether or not this box can run a
model yet.

## Live-session detection

`start-live-appliance.sh` writes the media payload root to
`/run/llama-manager/live-media` before the (slower) appliance install runs. The
shell reads it on every `/api/system` call and reports it as `live` / `liveMedia`.

It changes what the shell says, because the two situations are genuinely
different:

- **Live**: the session pill promises nothing is written to this machine, and an
  engine that is not answering yet is described as *setting up from the boot
  media*, with an explicit warning that replies run on the processor because GPU
  acceleration is configured when you install to disk.
- **Installed**: the pill says the appliance is running from this machine's disk,
  and a missing engine is a missing engine.

## Action contract

Both actions are **command lines**, not hardcoded binaries, so a deployment can
repoint either without the shell knowing what runs behind it.

| Action | Command | Provided by |
|---|---|---|
| install | `pkexec live-install` | `iso/live/start-live-appliance.sh` installs `iso/live/install-to-disk.sh` to `/usr/local/bin/live-install` |
| desktop | `pkexec live-desktop` | **Proposed — not yet provided.** See below |

`live-install` is the live session's established contract (`docs/LIVE-USB.md`);
the shell consumes it rather than inventing its own installer entry point. The
command owns the entire flow that follows, including confirmation before writing
to a disk — the shell's copy promises the person confirms first, so the installer
must honour that. The agent starts the command detached with closed standard
streams, and does not wait for it, read its output, or interpret its exit status.

**A missing action is a supported state.** The agent resolves every executable a
command needs — both the privilege wrapper and the program it elevates — through
`PATH`. `/api/system` reports what resolved; the shell disables the matching
button and says which program is missing, rather than offering a control that
does nothing. This is why the shell degrades cleanly today, before `live-desktop`
exists.

### Proposed: `live-desktop`

The desktop-mode action needs a counterpart to `live-install`, deliberately
shaped the same way so there is one pattern to maintain:

- An executable installed to `/usr/local/bin/live-desktop` by
  `start-live-appliance.sh`, alongside `live-install`.
- Taking no arguments, invoked as `pkexec live-desktop`.
- Responsible for leaving the Cage kiosk for a full desktop session — stopping
  the kiosk session and starting the standard graphical session — and for
  whatever it wants to do about the still-running `llama-manager.service`.

Until it exists the button is disabled and the shell explains why, so shipping
it is not a blocker for the shell.

## Running it during development

```bash
scripts/build-kiosk-shell.sh amd /tmp/kiosk-amd
cd /tmp/kiosk-amd
python3 kiosk-agent.py
```

Then open `http://127.0.0.1:8385/`. To exercise the states without real
hardware:

```bash
# Engine "absent" rather than "unreachable"
LLAMA_KIOSK_ENGINE_BIN=/nonexistent python3 kiosk-agent.py

# Point at an engine on another port
LLAMA_KIOSK_INFERENCE_PORT=8099 python3 kiosk-agent.py

# Enable the actions with throwaway commands
printf '#!/bin/sh\nexit 0\n' > /tmp/live-install && chmod +x /tmp/live-install
LLAMA_KIOSK_INSTALL_COMMAND=/tmp/live-install python3 kiosk-agent.py

# Pretend to be a live session
echo /cdrom/llama-manager > /tmp/live-media
LLAMA_KIOSK_LIVE_MARKER=/tmp/live-media python3 kiosk-agent.py
```

Opening `index.html` directly over `file://` also works and is the fastest way
to check the "no agent" presentation, but every readout will be unavailable.

## Runtime assumptions

- **Browser**: a WebKitGTK/WPE-based kiosk browser under Cage — `cog` is the
  intended pairing, with `epiphany-browser --application-mode` as a fallback.
  The shell uses CSS grid, custom properties, `backdrop-filter` (prefixed and
  unprefixed), `fetch` with a streaming response body, and no framework or build
  step. There is a non-streaming fallback for a browser that exposes no
  readable response body.
- **Python 3** with the standard library, for the agent. No third-party modules.
- **Fonts**: none are bundled and none are fetched. The stack asks for Noto Sans
  and falls back to DejaVu Sans, both of which are on the image. Personality
  comes from weight, tracking, and the display/monospace pairing rather than a
  bundled face, so the shell cannot render in a fallback nobody chose.
- **Resolution**: the layout is expressed in root-relative units against a
  viewport-scaled root font size, and is verified at 1366x768, 1920x1080, and
  3840x2160. Below 60rem it stacks to a single column.
- `prefers-reduced-motion` disables the ambient drift, the rail shimmer, and
  every entrance animation.

## Theming

The shell hardcodes no color and no product name. **`kiosk/theme-shim.sh` is the
single integration seam**: it is the only file that knows where platform colours,
product names, and brand artwork come from. `build-kiosk-shell.sh` reads
everything through it and emits the result into `theme.css` as custom properties,
so one stylesheet serves all three platforms:

`--accent-primary`, `--accent-bright`, `--accent-deep` (plus `-rgb` triplets for
`rgba()` composition), `--bg`, `--surface`, `--border`, `--text-primary`,
`--text-body`, `--text-muted`, `--text-faint`, `--on-accent`, `--status-ready`,
the glass recipe, the type stacks, and the easing curve.

`--on-accent` is derived, not declared: the renderer computes the accent's
relative luminance and picks near-black or white for text sitting on it. That is
why the AMD install button is white on red and the NVIDIA one is black on green.

The palette in the shim mirrors `scripts/build-branding-payload.sh` verbatim, so
the Plymouth splash, the GRUB theme, the GDM background, and the kiosk shell stay
one product. If that script gains a query interface, replace the shim's case
statement with a call to it and nothing else in the shell changes.

See `docs/BRANDING.md` for the platform palettes and the brand art set.
