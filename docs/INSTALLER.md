# Branding the guided installer

Copyright (c) 2026 DoubTech. Use of this document is governed by the LICENSE
file in the repository root.

The appliance does not ship an installer. Choosing **Install to this machine**
hands the disk off to Ubuntu's own guided installer with the appliance's
autoinstall seed (see [LIVE-USB.md](LIVE-USB.md#install-to-disk)), which means
the last screens someone sees before the box becomes theirs are Canonical's.
This document covers the seam that brands those screens: where the white-label
config lives, what it can change, what it silently refuses to change, and what
it cannot reach at all.

For the boot chain — GRUB, Plymouth, greeter, desktop, dock, terminal, and the
ISO's product identity — see [BRANDING.md](BRANDING.md). For the shell the
installer now opens *on top of*, see [KIOSK.md](KIOSK.md).

## The installer is a signed snap, and that is not the obstacle it looks like

Ubuntu 24.04's installer is the **`ubuntu-desktop-bootstrap` snap** (verified
against shipping revision 433), not a package. The obvious conclusion — that a
Canonical-signed snap cannot be rebranded without repacking and re-signing it —
is **wrong**, and acting on it costs days.

`ubuntu-desktop-bootstrap` uses **classic confinement**. A classic snap has no
private mount namespace and no filesystem interposition: it reads the host's
real `/usr` directly, exactly as an ordinary binary would. Its
`ubuntu_provision` layer looks for a white-label configuration on the host, and
finds whatever the appliance put there.

So the entire branding mechanism is *placing files on the host filesystem*.
There is no snap to repack, no signature to re-establish, no bind mount or
`snap try` sideload, and no revision pin to maintain against a rebased base
image. That single property is why this works at all, and it is worth stating
plainly, because every heavier approach is a dead end that looks necessary.

## The white-label configuration

`ubuntu_provision` reads:

```
/usr/share/desktop-provision/whitelabel.yaml
```

`whitelabel.yml` is accepted as well; pick one and stay with it. The schema:

```yaml
mode: standard            # standard | oem | core-desktop
flavor: <name>
app-name: <string>
theme:
  light:
    accent-color: '#……'
    elevated-button-color: '#……'
    elevated-button-text-color: '#……'
  dark:
    accent-color: '#……'
    elevated-button-color: '#……'
    elevated-button-text-color: '#……'
pages:
  <page-name>:
    image: <image-name>
    image-dark: <image-name>
    visible: true|false
```

| Key | Meaning |
|---|---|
| `mode` | Installer flow: `standard`, `oem`, or `core-desktop`. The appliance is a `standard` interactive install. |
| `flavor` | Flavour id the installer reports itself as. |
| `app-name` | Product name the installer uses for itself. |
| `theme.light` / `theme.dark` | Two complete accent sets. Both are declared; the session decides which applies (below). |
| `pages.<page>.image` / `.image-dark` | The illustration for one page, light and dark variant. |
| `pages.<page>.visible` | Whether the page is shown — **honoured for six pages only**, see below. |

### Images

Page images resolve by name against:

```
/usr/share/desktop-provision/images/<image-name>
```

The name in the config is resolved inside that directory, so images are dropped
in beside the config rather than referenced by absolute path.

**The Ubuntu logo on the "Choose your language" screen is `pages.locale.image`.**
It is not a separate branding key, a theme asset, or something baked into the
snap — it is that page's illustration, and replacing it is how the first screen
of the install stops carrying Canonical's mark.

### Pages

The page names `ubuntu_provision` recognises:

```
locale                accessibility          try-or-install
rst                   keyboard               network
refresh               source-selection       codecs-and-drivers
not-enough-disk-space secure-boot            storage
storage-icon          identity               confirm
done                  error
```

### Only six pages can be hidden — the rest fail silently

`visible: false` is honoured for exactly these:

```
ubuntu-pro-onboarding   eula        accessibility
try-or-install          refresh     source-selection
```

**Setting `visible: false` on any other page is ignored, with no error and no
log line.** The config still parses, the build still succeeds, the ISO still
builds, and the page appears anyway on the flashed stick. Nothing anywhere tells
you it was dropped.

This is the single most expensive trap on this seam, because every symptom of it
looks like something else: a stale image, a config that was not installed, a
path typo, a snap that ignored the file entirely. If a page you hid is still on
screen, check this list *first* — and if the page is not on it, the config was
read correctly and the answer is that hiding it is not supported.

Note that `ubuntu-pro-onboarding` and `eula` are hideable but are not in the page
list above: they take `visible`, not an image.

## Slides

The slideshow shown during the copy phase lives at:

```
/usr/share/desktop-provision/slides/<n>/slide_<locale>.html
```

- One numbered directory per slide. **Order is the numeric order of the
  directory names**, not an index file.
- Each directory holds one `slide_<locale>.html` per translated locale, and its
  images beside it, referenced relatively.
- **`slide_en_US.html` is the fallback.** A locale with no slide of its own gets
  it, so that file must always exist.

The rendered HTML is a **small supported subset, not a browser engine.** It is a
constrained renderer; CSS and markup that work in a browser preview will not
necessarily survive it, and the failure mode is a slide that renders wrong on
hardware rather than an error at build time. Start from the upstream slide
templates and change content within the structure they already use — that is the
cheapest way to stay inside the subset, and the only one that is checkable
without a flashed stick.

## The GTK seam is separate, and still required

White-labelling is not the only thing that reaches the installer. The branding
package's dconf drop-in already sets two session-wide GTK keys specifically for
it (see `scripts/build-branding-payload.sh` and
[BRANDING.md](BRANDING.md#appliance-desktop)):

| Key | Value | Why |
|---|---|---|
| `org/gnome/desktop/interface` `color-scheme` | `prefer-dark` | The installer is a Yaru application; this is what selects its dark variant — and therefore which of `theme.light` / `theme.dark` applies. |
| `org/gnome/desktop/interface` `gtk-theme` | platform theme | Yaru variant resolution. |

Without them the installer paints stock white with an Ubuntu-orange spinner in
front of the appliance's near-black branding. The two seams are complementary:
`color-scheme` decides *which* theme block is in play, `whitelabel.yaml` decides
what the colours in it are. Changing one without the other gives a half-branded
installer.

## What white-labelling does not reach

| Surface | Status |
|---|---|
| "Welcome to Ubuntu" wording, and the strings around it | **Inside the snap.** Not exposed by `whitelabel.yaml`. Unchanged. |
| Pages outside the six hideable ones | **Cannot be hidden.** See the trap above. |
| `/.disk/release_notes_url` | A visible Canonical link the installer offers as "Release Notes". Deliberately left pointing upstream until a real product URL exists — a dead link in the installer is worse. See [BRANDING.md](BRANDING.md#the-sibling-disk-files-are-deliberately-untouched). |
| `/.disk/info` product string | Already rebranded — that is what makes the installer announce Llama Manager instead of Ubuntu. See [BRANDING.md](BRANDING.md#iso-product-identity-diskinfo). |

## Where the installer draws: over the kiosk, not instead of it

The appliance runs its shell as **its own Wayland session under Cage**, not as a
browser painted over a GNOME desktop. `iso/live/llama-manager-appliance.desktop`
registers the session; `scripts/customize-live-filesystem.sh`'s
`register_appliance_session` installs it into the live layer.

That is what makes the installer's window behave. gdm holds DRM master only
until it starts a *user session*, so a compositor started as that session takes
the seat cleanly — and Cage stacks new toplevels on top of what is already
there. The guided installer therefore opens **over** the running appliance shell
with no window management, no compositor swap, and nothing torn down to make
room for it. `live-install` no longer stops the appliance services at all; if
the installer fails to open a window, the operator is still looking at a working
shell instead of an empty desktop.

The mechanics of the session — the per-account selector, why it cannot be baked
into the image, and the fallback when it does not run — are in
[LIVE-USB.md](LIVE-USB.md#the-appliance-is-its-own-session-under-cage).

## Where these files come from

The installed system and the live medium reach the same host paths by the two
routes every other branding surface already uses (see
[BRANDING.md](BRANDING.md#iso--live-usb-integration)):

- **Installed system** — shipped by the platform branding package, whose
  postinst already owns the other `usr/share` branding trees.
- **Live medium** — written into the casper layer by
  `scripts/customize-live-filesystem.sh`, because the lean live package set
  never installs the branding package. This is the path that matters most: the
  installer the operator actually runs is the *live* one.

Both must land the config and the images, or the branding is present on the
installed system nobody sees the installer on and absent from the medium where
they do.

> The specific assembler entry points land with the implementation; this section
> states the contract they have to satisfy, not the current call graph. Update it
> to name them once they exist.

## Open decisions

- **The accent colour is unresolved.** The request was "red for AMD", but the
  AMD platform accent already defined in [BRANDING.md](BRANDING.md#platforms-and-palettes)
  is `#FF6A00` — an ember orange, and close enough to Ubuntu's own orange that
  using it for `theme.*.accent-color` would leave the installer looking stock in
  exactly the place branding is meant to show. Red is not that colour. Reusing
  the platform accent keeps the installer consistent with the boot chain;
  choosing red makes it distinct from Ubuntu but inconsistent with everything
  before it. **This is an operator decision and has not been made.** Do not
  resolve it by picking whichever is convenient in code.

## Changing the installer branding

1. Edit `whitelabel.yaml` and add or replace images under
   `desktop-provision/images/`. Keep the light and dark variants in step —
   `color-scheme` is `prefer-dark`, so the dark set is the one that ships.
2. If you are hiding a page, confirm it is one of the six hideable ones. It will
   not tell you otherwise.
3. Slides: change content inside the upstream template structure, keep
   `slide_en_US.html` present, and check the numeric directory order is the
   order you intend.
4. Verify on a flashed stick, not in a browser. The slide renderer, the theme
   resolution, and the page visibility rules are all things that only fail
   visibly on hardware.
