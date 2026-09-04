# Branded boot chain

Copyright (c) 2026 DoubTech. Use of this document is governed by the LICENSE
file in the repository root.

This document describes how the Llama Manager appliance turns a stock Ubuntu
Desktop boot sequence into a crafted, per-platform experience: a themed GRUB
menu, a Plymouth boot splash, and greeter / first-paint desktop backgrounds. All
art is committed to the repository and nothing is fetched or generated with image
tooling at build or install time, preserving the offline invariant.

It stops at the surfaces this repository composes art for. The **guided
installer's own screens** are branded through a different mechanism — a
white-label config read by Ubuntu's installer snap — and are documented in
[INSTALLER.md](INSTALLER.md). The appliance shell itself is in
[KIOSK.md](KIOSK.md).

## Platforms and palettes

Branding ships per host platform. Today the AMD Ryzen AI Max variant is wired
into the appliance; the NVIDIA and hardware-neutral variants are built and
available but intentionally not pulled in by the AMD appliance meta-package.

| Token        | Generic (cyan)         | AMD (ember)            | NVIDIA (green)          |
| ------------ | ---------------------- | ---------------------- | ----------------------- |
| Base         | `#0a0a0a`              | `#0a0a0a`              | `#0d0d0d`               |
| Accent       | `#00d3db` / `#5fe9f0`  | `#ff6a00` → `#ffa02f`  | `#76b900` / `#8fd400`   |
| Text         | `#ffffff`              | `#fff7f0`              | `#ffffff`               |

`generic` is for images that target neither accelerator, so it carries no vendor
accent.

Source art lives in `branding/assets/`, three files per platform:

- `llama-<platform>.png` — transparent platform logo mark, 1024×1024 RGBA.
- `splash-<platform>.png` — 1920×1080 GRUB menu background, **no emblem**.
- `desktop-<platform>.png` — 1920×1080 GDM greeter and desktop background, the
  same field **with** the emblem.

All three are contractual and enforced by `tests/test-branding-payload.sh`, which
reads the PNG headers with `od` rather than image tooling so the check survives
inside `dh_auto_test`.

### Composing the art

The committed art is derived from the eight-slot master brand set by
`scripts/compose-brand-art.py`. That script is an **authoring-time** tool run by
hand when the brand changes — nothing in `debian/rules`, the payload assembler,
or the ISO build invokes it, so the build stays free of image tooling:

```bash
scripts/compose-brand-art.py --brand-dir /path/to/brand --output-dir branding/assets
```

The logo mark is the `logo-mark` crest trimmed to its alpha bounding box and
centred. Both backgrounds are the `wallpaper` slot cover-scaled to 1920×1080,
dimmed, and darkened further across the band GRUB paints into. They differ only
in the emblem: `desktop-<platform>.png` carries the crest **bottom-left**,
`splash-<platform>.png` does not. No caption is drawn under it — the crest
already contains the wordmark.

**Why there are two backgrounds.** The GRUB menu, the GDM greeter, and the
desktop were originally served one shared asset, and their needs pull in opposite
directions. GRUB draws menu text across the middle of its background and reads
best over a clean field. The greeter and the desktop are wallpaper: showing the
product mark there is the whole point. A single asset forces one of those roles
to lose, so the composition is split and the assembler routes each to its own
surface:

| Installed path                                          | Source                  |
| ------------------------------------------------------- | ----------------------- |
| `boot/grub/themes/llama-manager-<p>/background.png`      | `splash-<p>.png` (bare) |
| `usr/share/backgrounds/llama-manager-<p>-splash.png`     | `desktop-<p>.png`       |

The installed filename under `usr/share/backgrounds/` is deliberately unchanged,
so the dconf greeter and desktop drop-ins keep resolving without edits.
`tests/test-branding-payload.sh` asserts each surface gets the right source and
that the two are never the same bytes.

The emblem sits at **x 4.5–20.1%, y 68.5–94.5%**, which also keeps it clear of
the centred GDM login form. It was originally placed to dodge the GRUB furniture
as well — boot menu at x 25–75% / y 30–70%, timeout bar at y 78% — and it still
does, so the desktop art remains usable as a GRUB background in a pinch.

## The assembler

`scripts/build-branding-payload.sh <platform> <dest-root>` materializes one
platform's complete branding package root from the committed art. It copies the
PNGs and generates every theme/config text file (with its repository header),
using only `awk` for colour math — no Python, ImageMagick, or network. It is the
single source of truth for the theme content and is invoked both by
`scripts/build-package-payload.sh` (for the Debian packages) and can be pointed
at the live ISO overlay.

Each assembled root contains:

```
usr/share/plymouth/themes/llama-manager-<platform>/
    llama-manager-<platform>.plymouth   # theme descriptor (script plugin)
    llama-manager.script                # splash logic
    logo.png                            # platform logo mark
boot/grub/themes/llama-manager-<platform>/
    theme.txt                           # GRUB menu theme
    background.png                      # platform splash
etc/default/grub.d/95-llama-manager-branding-<platform>.cfg   # GRUB_THEME activation
usr/share/backgrounds/llama-manager-<platform>-splash.png     # greeter/desktop art
etc/dconf/db/local.d/95-llama-manager-branding-<platform>     # GNOME session bg, dock, terminal
etc/dconf/db/gdm.d/95-llama-manager-branding-<platform>       # GDM greeter bg
usr/share/applications/
    llama-manager-dashboard-<platform>.desktop                # dock: landing page
    llama-manager-settings-<platform>.desktop                 # dock: settings page
usr/share/pixmaps/llama-manager-<platform>.png                # dock launcher icon
etc/firefox/policies/policies.json                            # browser homepage
```

## GRUB menu geometry

`GRUB_GFXMODE` asks for 1920x1080 and falls back to `auto`, so the menu is drawn
at whatever mode the firmware offers. That makes the split between pixel and
percentage units load-bearing:

- The **logo and the title label under it are anchored to the top edge in
  pixels** (`top = 24`, `height = 160`, label at `top = 200`). The emblem is
  sized in pixels, so anything placed beneath it *by percentage* climbs into it
  as the panel gets shorter — at 1600x900 a label at `y 20%` already drew
  underneath the emblem, and by 1024x768 the logo band reached a quarter of the
  way down the screen.
- The **boot menu and the timeout bar below them are positioned by percentage**,
  because they should scale with the panel. They start far enough down that the
  fixed logo band cannot reach them.

The timeout bar is **derived from the menu, not tuned beside it**. `boot_menu`
insets every entry by `item_padding` on both sides, so a bar given the menu's own
`left`/`width` overhangs the text it sits under by that much on each edge. The
assembler emits `left = 25%+6` and `width = 50%-12` from the same
`menu_left_pct` / `menu_width_pct` / `menu_item_padding` variables the menu uses,
so the two cannot drift apart.

`tests/test-branding-payload.sh` reads the emitted geometry back out of
`theme.txt` and replays it at 1920x1080, 1600x900, 1366x768, and 1024x768,
asserting nothing draws under the logo and the bar stays below the menu.
`tests/test-grub-theme.sh` additionally proves the theme path the live menu
activates is one the assembler actually produces.

## Appliance desktop

The branding package also carries the desktop seams, because they are per
platform for the same reason the boot chain is — they show the platform emblem.

**The dock.** The kiosk shell is already up and owns the screen, so the dock is
only an escape hatch out of it: minimal, but never absent. `favorite-apps` is a
whole-list key, so naming the three appliance entries is also what removes the
stock Ubuntu set (store, file browser, music, mail, office, help) — there is no
per-entry way to drop them. Mounted volumes are untouched; dash-to-dock surfaces
those outside `favorite-apps`.

| Key | Value |
| --- | --- |
| `org/gnome/shell` `favorite-apps` | dashboard, settings, `org.gnome.Terminal.desktop` |
| `dash-to-dock` `dock-fixed` | `false` |
| `dash-to-dock` `autohide` | `true` |
| `dash-to-dock` `intellihide` | `false` |

**The terminal.** gnome-terminal does not follow the session GTK theme. It keeps
its colours per profile, ships `use-theme-colors=false` and a hardcoded Ubuntu
aubergine background, and so stays stock purple on an otherwise near-black
appliance unless its profile is branded directly — which is what the same
`local.d` drop-in does. The profile list and default must both be declared or
the per-profile keys bind to nothing; the UUID is GNOME's own well-known
default-profile UUID so an existing profile picks the defaults up instead of a
second unbranded one appearing beside it.

| Key | Value |
| --- | --- |
| `profiles:` `list` / `default` | `b1dcc9dd-5262-4d8d-a863-c897e6d979b9` |
| `use-theme-colors` | `false` — the switch that makes the rest apply |
| `background-color` / `foreground-color` | platform `base` / `text` |
| `bold-color` | platform `accent_bright` |
| `cursor-background-color` | platform `accent` |
| `highlight-background-color` | platform `track` |
| `palette` | fixed 16-colour legible set (below) |

The colours come from the same shell variables that drive Plymouth, GRUB, and
the desktop, so the terminal cannot drift away from them. The 16 ANSI colours
are deliberately **not** derived from the accent: this is the surface an
operator reads error text on, ANSI slots carry meaning (red is failure, green is
pass), and rotating them per platform would destroy that while helping nobody.
They are chosen for contrast against the near-black base — Ubuntu's stock
`#3465A4` blue is near-illegible there, and its slot-0 `#2E3436` "black" is
nearly the background itself, so slots 0 and 8 are lifted greys.

`dock-fixed` is the master switch: while it is true dash-to-dock pins the dock
open and ignores `autohide` entirely, which is why both are set. `intellihide`
is off on purpose — it hides the dock only when a window overlaps it, and the
appliance's own shell is fullscreen, so "hidden until hovered" is what actually
stays out of the way.

The two launchers open `http://localhost/` and `http://localhost/settings`
through `xdg-open` rather than naming a browser, which has changed before. Their
filenames carry the platform suffix like every other path in this root: the three
branding packages declare no `Conflicts`, so a shared path would be a dpkg file
conflict the moment two were installed. The icon is referenced by absolute path
from `/usr/share/pixmaps` — the committed art is 1024x1024 and hicolor's
`index.theme` lists no such size, so a name-based lookup would resolve to nothing
and the dock would fall back to a generic cog.

**The browser homepage.** `etc/firefox/policies/policies.json` starts every
window and every new tab on the local appliance UI instead of a stock page
pointing at an internet a sealed box may not have. Firefox reads that path
whether it is the deb or the Ubuntu snap, and for the snap it is the only seam
that reaches it. There is no policy key for the new-tab URL — disabling the
built-in new-tab page is the supported way to get one, after which Firefox opens
the home page in new tabs too. Both are seeded as **defaults, not locked**: the
appliance decides where a browser starts, it does not take the setting away. The
file is static config and is written correctly whether or not the listener is up.

## Packages

Three `Architecture: all` binary packages are defined in `debian/control`:

- `llama-manager-branding-generic`
- `llama-manager-branding-amd`
- `llama-manager-branding-nvidia`

Each depends on `plymouth`, `grub2-common`, `initramfs-tools`, and `dconf-cli`.
Exactly one is ever installed: `llama-manager-appliance` depends on
`llama-manager-branding-amd`, `llama-manager-appliance-nvidia-spark` depends on
`llama-manager-branding-nvidia`, and neither pulls in the generic branding.
Installing two would leave which Plymouth theme wins down to package ordering,
so `tests/test-debian-metadata.sh` enforces the exclusivity.

The postinst (on `configure`) selects the platform Plymouth theme with
`plymouth-set-default-theme`, refreshes the initramfs (`update-initramfs -u`) so
the splash is embedded, regenerates the themed menu (`update-grub`), and compiles
the greeter/desktop dconf databases (`dconf update`). Every command is guarded by
`command -v`, and none perform network or build work. The postrm restores the
default Plymouth theme and refreshes the boot artifacts on removal.

## Plymouth splash

The theme uses the Plymouth **script** plugin. The script paints the platform
base colour, centres the platform logo with a gentle opacity "breathing" pulse,
and renders an accent-coloured segmented progress bar driven by the
boot/shutdown progress hook. The bar is drawn with `Image.Text`, so no additional
image assets are required. A minimal message and password-prompt handler are
included; the first appliance release is LUKS-less, so the password prompt
styling is intentionally simple.

The logo is capped on **both** axes — `min(30% of width, 42% of height)` — and is
only ever scaled down. The emblem is nearly square, so a width-only cap blows it
up on wide panels: at 3440×1440 that gave a 1032 px logo filling 72% of the
screen height and running into the progress bar at y = 72%. The two-axis cap
holds it to 605 px there, clear of the bar.

Because `Image.Text` renders at the label plugin's fixed point size, the progress
bar does **not** scale with resolution — it is roughly 192 px wide on any screen,
so it reads as a small indicator on a 4K or ultrawide panel. That is existing
upstream behaviour and is left alone deliberately; changing the bar's mechanism
risks the boot splash for no gain.

## GRUB menu

`theme.txt` sets the platform splash as the desktop image and colours the boot
menu, title label, and timeout progress bar from the platform palette. The
`95-llama-manager-branding-<platform>.cfg` snippet sets `GRUB_THEME`,
`GRUB_BACKGROUND`, and `GRUB_GFXMODE`. It is numbered `95` so it loads *after* the
gfx1151 kernel-parameter snippet (`90-llama-manager-gfx1151.cfg`) and never alters
the validated `GRUB_CMDLINE_LINUX`.

## Greeter and desktop first-paint

Backgrounds are applied through the dconf database drop-ins compiled by
`dconf update`:

- `etc/dconf/db/gdm.d/…` sets the GDM greeter (login screen) background.
- `etc/dconf/db/local.d/…` sets the GNOME session desktop and screensaver
  background.

These rely on the dconf `gdm` and `user` profiles that Ubuntu's `gdm3` already
ships; the packages deliberately do not overwrite `/etc/dconf/profile/*` to avoid
conflicting with the base system. The appliance's primary session is the `cage`
kiosk, so the GNOME desktop background is a best-effort first-paint default.

**SDDM:** the appliance uses GDM, so only the GDM greeter path is wired. A future
NVIDIA desktop variant that uses SDDM would add an SDDM theme referencing
`usr/share/backgrounds/llama-manager-nvidia-splash.png`; that is out of scope for
the current appliance.

## ISO / live-USB integration

The installed system gets the full branding from the branding package's postinst.
The **live USB** boot needs two pieces the installed system gets for free:

1. **Live GRUB menu.** `scripts/build-iso.sh --branding-dir <branding-root>`
   overlays the platform `boot/grub/themes/…` tree onto the ISO (additive; the
   base boot image replay and installer entries are untouched). Point
   `--branding-dir` at an assembled branding root, e.g.
   `build/package-root/llama-manager-branding-amd`. Activation is handled by
   `scripts/generate-grub-config.sh`, which emits

   ```
   if [ -f /boot/grub/themes/llama-manager-<branding>/theme.txt ]; then
     insmod gfxmenu
     set theme=/boot/grub/themes/llama-manager-<branding>/theme.txt
     export theme
   fi
   ```

   inside the graphical-console guard. `<branding>` comes from
   `release-config.sh platform branding`, so `amd` → `llama-manager-amd` and
   `nvidia-spark` → `llama-manager-**nvidia**` (matching the tree
   `build-branding-payload.sh` actually builds, not the platform id).

   The activation is conditional on the theme file being present, so an ISO
   built *without* `--branding-dir` still boots a plain text menu. Nothing
   boot-critical lives inside either guard — `set default`, `set timeout`, and
   every `menuentry` are emitted at top level, so a missing theme, a missing
   font, or a video failure costs you the styling and never the boot.

   Note the graphical guard loads `unicode`, not `/boot/grub/font.pf2`: the
   Ubuntu base media ships `/boot/grub/fonts/unicode.pf2` and has no
   `font.pf2`. Loading a nonexistent font leaves `gfxterm` inactive, and an
   inactive `gfxterm` renders no theme at all.

2. **Live Plymouth splash.** The Plymouth theme lives inside the casper
   squashfs/initrd, which `build-iso.sh`'s file-map replay cannot reach.
   `scripts/customize-live-filesystem.sh` closes that gap: it rebuilds the casper
   live layer with the branding payload installed and appends the theme to the
   live initrd. See [BUILDING.md](BUILDING.md#live-media-branding) for the stage
   and its root/fakeroot requirement.

   **It runs on every build.** `build-iso.sh` invokes it directly after it
   assembles the branding payload, and maps the rebuilt layer, sidecars, initrd,
   and `md5sum.txt` onto the image. It is not optional and does not degrade: an
   unbranded live boot looks exactly like a successful build until someone
   flashes a stick, so a failure in this stage fails the release.

3. **Live desktop wallpaper.** Same layer, different mechanism. The background
   default is a dconf keyfile, and dconf ignores `/etc/dconf/db/local.d/` unless
   `/etc/dconf/profile/user` names `system-db:local` — which stock Ubuntu does
   not ship. The branding package's postinst provisions that profile on an
   installed system; the live-media stage writes it and compiles the database
   into the layer, because the lean live package set never installs the branding
   package. See [BUILDING.md](BUILDING.md#the-wallpaper-needs-a-dconf-profile-not-just-a-drop-in).

4. **GRUB menu logo.** The GRUB background is deliberately the emblem-free
   field, so the menu carries the product mark only because `theme.txt` draws
   `logo.png` as its own `image` component. Image paths in a GRUB theme resolve
   against the theme directory, so the logo is copied in beside `theme.txt`.

## ISO product identity (`/.disk/info`)

`/.disk/info` is the one-line string the live session and the Ubuntu installer
read to announce what is being installed. Leaving the base image's copy in place
is why a flashed appliance reported "Ubuntu 24.04.4 LTS" throughout, even after
the boot menu was branded.

`scripts/generate-disk-info.sh` writes it and `build-iso.sh` maps it over the
base image's copy:

```
Ubuntu 24.04.4 LTS "Noble Numbat" - Release amd64 (20260210)   # base image
Llama Manager 24.04.4 - Release amd64 (20260802)               # amd
Llama Manager for NVIDIA DGX Spark EXPERIMENTAL 24.04.4 - Release arm64 (…)
```

The shape mirrors upstream — `<product> <version> - Release <arch> (<date>)` —
minus Canonical's name, the `LTS` marker, and the codename. The product name
comes from `release-config.sh platform product`, and experimental media carries
its `label` so the installer cannot be mistaken for a stable image. The file has
**no trailing newline**, matching upstream, because tools reading it with a bare
`read(2)` would otherwise pick up a stray byte. Set `SOURCE_DATE_EPOCH` to make
the build date reproducible.

### The sibling `/.disk` files are deliberately untouched

The base image ships four other files in `/.disk`. They are **not** branding,
and rewriting one to remove the word "Ubuntu" can break the install path:

| File | Content | Decision |
|---|---|---|
| `base_installable` | empty — its *presence* is the flag | **Leave.** Presence tells the installer the medium can install a base system. Carries no brand string. |
| `cd_type` | `full_cd/single` | **Leave.** Casper and the installer read this to decide media semantics. Functional, no brand string. |
| `casper-uuid-generic` | a UUID | **Leave.** Casper matches this against the UUID baked into the initrd to find the right boot medium. Changing it breaks medium detection. |
| `release_notes_url` | `http://www.ubuntu.com/getubuntu/releasenotes?…` | **Left for now — open decision.** This *is* a visible Canonical brand leak: the installer offers it as a "Release Notes" link. It was not retargeted because doing so requires a URL that actually serves release notes; a dead link in the installer is worse than an accurate upstream one. Point it at a real product URL when one exists. |

`tests/test-disk-info.sh` and `tests/test-iso-builder.sh` both assert the
builder maps **only** `/.disk/info`, so a later change cannot quietly clobber a
functional file.

## Adding a platform

1. Commit all three assets: `branding/assets/llama-<platform>.png`,
   `branding/assets/splash-<platform>.png`, and
   `branding/assets/desktop-<platform>.png`. Add the platform to `PLATFORMS` in
   `scripts/compose-brand-art.py` and generate them from the master brand set
   rather than hand-editing.
2. Add the palette case to `scripts/build-branding-payload.sh`. If the platform
   is also a *build* target (not just a branding variant — `generic` is branding
   only), add a `product` name to its platform profile in
   `scripts/release-config.sh`.
3. Add a `llama-manager-branding-<platform>` stanza to `debian/control`, the two
   maintainer scripts, and the copy step in `debian/rules`, and assemble the root
   in `scripts/build-package-payload.sh`.
4. Extend the four tests that enumerate branding per platform:
   `tests/test-branding-payload.sh`, `tests/test-debian-metadata.sh`,
   `tests/test-maintainer-scripts.sh`, and `tests/test-package-payload.sh`.
