# Kiosk Dashboard Mode (optional)

Turns this host into a dashboard appliance: on boot GDM logs the dedicated,
locked `llama-kiosk` system account in automatically and launches full-screen
Firefox (or Chrome/Chromium, when installed) through the `cage` Wayland
compositor. The administrator's GNOME account and preferences are not changed.
GNOME stays installed; uninstall restores the original login behavior from
backups and removes `llama-kiosk` only when the installer created it.

This is standalone and **not** part of `install.sh` — install it only if you want
the machine dedicated to the dashboard.

## Install

```bash
sudo bash scripts/install-kiosk.sh install
# preview without changing anything:
bash scripts/install-kiosk.sh install --dry-run
# configure but do not bring it up yet:
sudo bash scripts/install-kiosk.sh install --no-start
```

The installer:
- requires `cage` and installs it through apt if missing,
- uses Ubuntu Desktop's bundled Firefox offline, while retaining optional
  Chrome/Chromium support,
- creates the dedicated `llama-kiosk` account with `/var/lib/llama-kiosk` as
  its private home,
- copies the kiosk runtime to `/usr/local/lib/llama-manager/kiosk` so the
  dedicated account never needs access to the administrator's source checkout,
- backs up `/etc/gdm3/custom.conf`, the kiosk AccountsService record, and any
  pre-existing `llama-kiosk.desktop` session entry to
  `/var/backups/llama-kiosk/`,
- publishes the managed session entry as a mode-`0644` regular file using an
  atomic same-directory rename, so an existing symlink is replaced rather than
  followed and its target is never overwritten,
- enables gdm autologin into a new "Llama Kiosk" Wayland session,
- **brings the kiosk up immediately** by restarting the display manager (no
  reboot needed) — unless you pass `--no-start`.

The launcher waits for the dashboard to come up before showing it. Configure the
target with `KIOSK_URL=` (or `API_PORT=`) in the canonical package environment
`/etc/llama-manager/llama-manager.env`; the default is
`http://localhost:3001/kiosk`.

The appliance DEB and Ubuntu image **must include `cage` as a package
dependency** so the kiosk is available without network access. The standalone
script's apt installation is a fallback for source-based installations, not a
replacement for declaring the appliance package dependency. Proprietary Chrome
is never required.

The kiosk page includes **System Login**. It posts to a separate Python helper
bound only to `127.0.0.1:8798`; the helper accepts only exact localhost browser
origins and invokes `gdmflexiserver`. The button is not rendered when the
dashboard is loaded through a LAN hostname or IP, and no login-switch route is
added to the network-facing manager API. Selecting it opens the normal GDM
greeter so an administrator can log into GNOME. Logging out returns to the
configured appliance session.

> Note: bringing the kiosk up restarts the display manager, which ends any
> current graphical session on the machine.

## Restart (no reboot)

To re-enter or refresh the kiosk without rebooting — for example after the
dashboard service was restarted:

```bash
sudo bash scripts/install-kiosk.sh restart
```

This restarts the display manager so gdm autologin drops straight back into the
kiosk session.

## Escape hatches

- **SSH** into the box and run the uninstaller.
- **Ctrl+Alt+F3** switches to a text console; log in and run the uninstaller.
- From the appliance screen, select **System Login** in the dashboard's bottom
  status bar to open GDM.

## Uninstall

```bash
sudo bash scripts/install-kiosk.sh uninstall
```

Restores the backed-up gdm/session settings. A pre-existing
`llama-kiosk.desktop` is restored exactly; the entry is removed only when the
installer created it. Without an installation manifest, uninstall is a complete
no-op and never touches an unmanaged entry. If the installer created
`llama-kiosk`, it removes that account and its private home. It first terminates
the kiosk login session and refuses account removal if processes remain. A
pre-existing account with that name is preserved. `cage` is left installed
(remove with `sudo apt remove cage` if you want). Re-running the installer
preserves its ownership markers, so uninstall still removes installer-created
resources and reports when the installer originally added `cage`.

## Tests

```bash
bash tests/kiosk/run-tests.sh
python3 -m unittest tests/kiosk/test_control_helper.py
node --test ui/src/kiosk-control.test.js
```

The shell tests run entirely in a temp sandbox (`KIOSK_ROOT`) with no system
changes. The Python test opens only an ephemeral loopback port.
