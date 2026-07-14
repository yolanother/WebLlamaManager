# Kiosk Dashboard Service — Design

**Date:** 2026-05-31
**Status:** Implemented; revised 2026-07-14 for appliance packaging
**Author:** Llama Manager
**Spec location:** `docs/superpowers/specs/2026-05-31-kiosk-dashboard-service-design.md`

> Copyright (c) Llama Manager project. See the `LICENSE` file in the repository
> root for license terms. This document describes the intended design of the
> optional kiosk dashboard service and is the source of truth for its
> implementation plan.

## 1. Purpose

Provide an **optional, standalone** way to turn the host machine into a
dashboard appliance: on power-on it boots straight into a full-screen,
locked-down browser showing the Llama Manager dashboard, with no GNOME shell,
panels, or window chrome.

The feature ships as `scripts/install-kiosk.sh` plus a launcher and loopback
control helper, with `install`, `uninstall`, and `restart` subcommands. It stays
optional for source installations and is included by the appliance package.

### Success criteria

- Running `scripts/install-kiosk.sh install` (with sudo) configures the machine
  so the next boot lands directly on the dashboard in a full-screen browser, and
  **brings the kiosk up immediately** (by restarting the display manager) so no
  reboot is required for first use. A `--no-start` flag configures without
  bringing it up.
- Running `scripts/install-kiosk.sh restart` (with sudo) re-enters/refreshes the
  kiosk session without a reboot (e.g. after the dashboard service restarts).
- Running `scripts/install-kiosk.sh uninstall` restores the machine's original
  login behavior (gdm prompt + normal GNOME session) from backups taken at
  install time.
- GNOME and all existing sessions remain installed and selectable throughout.
- The on-screen **System Login** action switches to GDM without granting remote
  dashboard clients control of desktop sessions.
- Maintenance is always possible via SSH and via the text VTs
  (Ctrl+Alt+F2..F6).

## 2. Environment assumptions

Derived from the target host:

- Ubuntu-family system with **GNOME** via **gdm3**, default session is
  **Wayland**.
- Ubuntu Desktop's **Firefox snap** is available in the offline base image.
  Chrome and Chromium are optional alternatives, never requirements.
- **cage** is a mandatory appliance-package/image dependency. The standalone
  source installer uses `apt` as a fallback when it is missing.
- The dashboard is served by the package system service at
  `http://localhost:${API_PORT}` (default port `3001`). Runtime values come from
  `/etc/llama-manager/llama-manager.env`.

## 3. Boot flow

```
Power on
  → gdm3 autologin (dedicated llama-kiosk account)
    → "Llama Kiosk" Wayland session  (/usr/share/wayland-sessions/llama-kiosk.desktop)
      → llama-kiosk-launch.sh
        → start 127.0.0.1-only System Login helper
        → wait until KIOSK_URL is reachable (curl retry loop)
        → exec cage -- firefox --kiosk … KIOSK_URL
```

GNOME stays installed; the kiosk is simply a *different session* that gdm
auto-logs into. If the browser or cage exits, the session ends and gdm restarts
the autologin session — the kiosk self-heals.

## 4. Components / artifacts

| Artifact | Location | Purpose |
|---|---|---|
| `scripts/install-kiosk.sh` | repo | Installer / uninstaller / restarter. Subcommands `install`, `uninstall`, `restart`; flags `--dry-run`, `--no-start` (install only). Requires root for system changes. |
| `scripts/llama-kiosk-launch.sh` | `/usr/local/lib/llama-manager/kiosk/` | Reads the canonical manager environment, starts the helper, waits for readiness, then launches Firefox or a Chrome-family browser through `cage`. |
| `scripts/llama-kiosk-control.py` | `/usr/local/lib/llama-manager/kiosk/` | Binds only to `127.0.0.1`, validates exact localhost origins, and invokes `gdmflexiserver`. |
| `llama-kiosk.desktop` | `/usr/share/wayland-sessions/` (generated) | Registers the kiosk session with an `Exec=` under `/usr/local/lib/llama-manager/kiosk`. |
| Backups + manifest | `/var/backups/llama-kiosk/` | Original `gdm3/custom.conf`, AccountsService user file, optional pre-existing Wayland session entry, and a `manifest` recording exactly what install changed. |

### 4.1 System changes made by `install` (all backed up first)

1. **Require `cage`**. Appliance packages declare it as a dependency so offline
   installations already contain it; the standalone installer falls back to
   `apt-get install -y cage`. Record whether *we* installed it so uninstall can
   offer removal. Require any supported browser, preferring Chrome/Chromium when
   present and otherwise using the Firefox command bundled with Ubuntu Desktop.
2. Create the dedicated locked `llama-kiosk` system account with private home
   `/home/llama-kiosk`, and copy runtime files outside administrator homes.
   This standard home location works with Ubuntu's strictly confined Firefox
   snap without configuring a broad system-level `homedirs` override for
   `/var/lib`.
3. **`/etc/gdm3/custom.conf`** — back up, then enable:
   ```ini
   [daemon]
   AutomaticLoginEnable=true
   AutomaticLogin=llama-kiosk
   ```
4. **`/var/lib/AccountsService/users/llama-kiosk`** — back up, then set
   `Session=llama-kiosk` so the autologin uses the kiosk session rather than the
   user's previous session.
5. **`/usr/share/wayland-sessions/llama-kiosk.desktop`** — back up a
   pre-existing entry or record that the installer created it, then publish the
   managed session as a mode-`0644` regular temp file followed by an atomic
   same-directory rename. This replaces, rather than follows, a destination
   symlink. Repeated installs retain the original ownership record, including a
   pristine symlink backup whose external target is never written. Backup
   existence uses the directory entry itself, not target existence, so dangling
   symlinks retain their exact link target text through uninstall.
6. **Bring the kiosk up now** (unless `--no-start`): restart the display manager
   so gdm autologin immediately enters the kiosk session — no reboot required for
   first use.

### 4.3 Bring-up and `restart`

Both the tail of `install` and the standalone `restart` subcommand bring the
kiosk up without a reboot by restarting the display manager via the generic
`display-manager.service` systemd alias (works regardless of `gdm` vs `gdm3`
unit naming). gdm autologin then drops straight into the kiosk session. This
ends any current graphical session on the machine — acceptable for an appliance,
and logged as a warning. `restart` is the maintenance path to refresh the kiosk
(e.g. after the dashboard service was restarted) without rebooting. Both are
no-ops (logged only) under `--dry-run` and under the `--root` test sandbox.

Because these touch `/etc`, `apt`, and `/var/lib/AccountsService`, the script
must run as root. It checks for root and, if not root, re-executes itself under
`sudo` (or exits with guidance if sudo is unavailable). Backups live in
root-owned `/var/backups/llama-kiosk/`.

### 4.2 The kiosk user

The script uses the dedicated `llama-kiosk` account. It never converts the
invoking administrator's account into an autologin account or changes that
user's GNOME preferences.

## 5. Kiosk launcher (`llama-kiosk-launch.sh`)

1. Resolve `KIOSK_URL`:
   - If set in `/etc/llama-manager/llama-manager.env`, use it.
   - Else default to `http://localhost:${API_PORT:-3001}/kiosk` (reading `API_PORT`
     from the same canonical EnvironmentFile if present).
2. **Wait for readiness:** poll `KIOSK_URL` with `curl --silent --max-time` in a
   retry loop (≈60s total budget, fixed short interval), logging progress to the
   journal. This prevents a cold boot from flashing a connection error while the
   packaged `llama-manager` system service is still coming up. After the budget
   expires, launch anyway (the browser shows its own retry page rather than
   failing the session).
3. **Launch:**
   ```
   exec cage -- env MOZ_ENABLE_WAYLAND=1 firefox \
     --kiosk \
     --private-window "$KIOSK_URL"

   # Optional Chrome/Chromium path when installed:
   exec cage -- google-chrome \
     --kiosk \
     --ozone-platform=wayland \
     --noerrdialogs \
     --disable-infobars \
     --no-first-run \
     --disable-session-crashed-bubble \
     --disable-features=Translate \
     --user-data-dir="$HOME/.config/llama-kiosk/chrome" \
     --app="$KIOSK_URL"
   ```
   Firefox provides the offline-safe default. A dedicated `--user-data-dir`
   keeps optional kiosk Chrome state isolated from any normal Chrome profile.

## 6. Uninstall

`scripts/install-kiosk.sh uninstall` reads `/var/backups/llama-kiosk/manifest`
and reverses precisely:

- Restore `/etc/gdm3/custom.conf` from backup. If there was no prior file (we
  created it), remove the lines/file we added.
- Restore `/var/lib/AccountsService/users/<user>` from backup (or remove the
  `Session=` line we added if there was no prior value).
- Restore a pre-existing `/usr/share/wayland-sessions/llama-kiosk.desktop`, or
  remove it only when the manifest records that this installer created it.
- Terminate the `llama-kiosk` login session before removing runtime files or the
  account; refuse user deletion if processes remain.
- Remove the installed runtime and dedicated account/home only when the
  manifest says this installer created them.
- Leave `cage` installed by default (removing an apt package risks other
  dependents), but print a note and the exact `apt remove` command. If the
  manifest records that we installed cage, mention that explicitly.

After uninstall, the next boot returns to the normal gdm login prompt and GNOME
session.

Uninstall is **idempotent** and safe to run even if install never completed. A
missing manifest makes the entire operation a no-op, protecting unmanaged
accounts, session entries, and configuration. A missing individual backup in a
valid manifest is treated as "nothing to restore for that item" with a warning,
not a fatal error.

## 7. Idempotency & safety

- **Install is idempotent.** Re-running `install` must not clobber the *original*
  backups with already-modified files. The script only takes a backup of a file
  if no backup for it already exists in `/var/backups/llama-kiosk/`. The manifest
  is the authority for "have we already installed". Ownership markers for an
  installer-created account and installer-added `cage` remain true across
  repeated installs so uninstall can still clean up and provide correct guidance.
- **`--dry-run`** is honored by every mutating step (apt, file writes, backups):
  it prints the intended action and changes nothing. This is also what the
  automated tests exercise.
- All scripts use `set -euo pipefail` and quote variables.
- Sensitive config: literal `KIOSK_URL`/`API_PORT` values are read without
  sourcing the canonical manager EnvironmentFile, and values are not logged.

## 8. Testing strategy

Bash that mutates `/etc` is not classic-TDD friendly, so:

- **`--dry-run` mode** on every mutating step (prints intended actions, touches
  nothing) — the seam that makes the script testable.
- **`bats` (or plain shell) test suite** covering the *pure* logic:
  - `KIOSK_URL` resolution from the manager env (explicit value, default from `API_PORT`,
    default when neither set).
  - Firefox-only browser discovery and Wayland kiosk launch.
  - Manifest read/write round-trip.
  - Dry-run output asserts the right actions are *named* and that no target
    files are touched (run against a temp `--prefix`/`--root` redirection or by
    asserting dry-run never writes).
  - Idempotency: a second `install --dry-run` after a simulated first install
    does not propose re-backing-up an already-backed-up file, and a real repeated
    sandbox install preserves installer resource-ownership markers.
- **Manual verification checklist** for the real reboot path (documented in the
  implementation plan): install → reboot → dashboard appears → VT switch works →
  uninstall → reboot → normal login restored.

To support the file-system tests without root, the script will accept an
internal **`--root <dir>`** override (default `/`) used to relocate
`/etc`, `/var/backups`, `/var/lib/AccountsService`, and the wayland-sessions dir
under a sandbox directory during tests. This is an implementation seam, not a
user-facing feature, and will be documented as such.

## 9. Out of scope (YAGNI)

- No integration into `install.sh` / `uninstall.sh` (intentionally standalone).
- No general remote session-control API. The only on-screen escape hatch is the
  loopback-only System Login action.
- No support for X11 sessions (Wayland only, matching gdm default).
- No multi-display / rotation / touchscreen calibration handling.
- No automatic removal of `cage` on uninstall (only a printed hint).

## 10. File headers & docs

Each new script gets a header block: a one-line product/branding reference, a
copyright line pointing at the repo-root `LICENSE`, and a complete description of
the file's purpose. Functions inside the scripts get brief usage/parameter
comments consistent with the repo's documentation conventions.
