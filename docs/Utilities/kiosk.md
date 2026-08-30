# Kiosk Dashboard Mode (optional)

Copyright (c) 2026 DoubTech. Use of this document is governed by the LICENSE
file in the repository root.

Turns this host into a dashboard appliance: on boot GDM logs the dedicated,
locked, non-administrative `llama-kiosk` graphical account in automatically and
launches full-screen Firefox (or Chrome/Chromium, when installed) through the
`cage` Wayland compositor. The account has a normal login UID, not a system UID,
so Ubuntu's Firefox snap can initialize a graphical user session and use its
home directory. Its password remains locked; a normal UID does not make it an
interactive administrator account. The administrator's GNOME account and
preferences are not changed. GNOME stays installed; uninstall restores the
original login behavior from backups and removes `llama-kiosk` only when the
installer created it.

This is standalone and **not** part of `install.sh` — install it only if you want
the machine dedicated to the dashboard.

## Installed kiosk versus the live appliance

This guide covers the **installed** dashboard kiosk. It autologs into the
dashboard on the machine's disk and is deliberately separate from the branded
live-media shell used to try or install the appliance. The live shell owns
live-only actions and a media marker; the installed kiosk must not depend on a
mounted USB, `live-install`, or files left in a source checkout.

The installed layout is:

| Purpose | Path |
|---|---|
| GDM Wayland session entry | `/usr/share/wayland-sessions/llama-kiosk.desktop` |
| Self-contained kiosk runtime | `/usr/local/lib/llama-manager/kiosk` |
| Kiosk account home | `/home/llama-kiosk` |
| Package environment | `/etc/llama-manager/llama-manager.env` |
| Installer backups and manifest | `/var/backups/llama-kiosk/` |

The `llama-kiosk` account must be created in the distribution's normal-user UID
range (normally at or above `UID_MIN` in `/etc/login.defs`). Do not create it
with `useradd --system`, assign a system UID, or move its home outside `/home`.
Those choices can leave Ubuntu's strictly confined Firefox snap unable to start
and present as a black kiosk screen even though GDM autologin succeeded.

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
- creates the dedicated `llama-kiosk` account with `/home/llama-kiosk` as its
  private home, which is directly accessible to Ubuntu's strictly confined
  Firefox snap,
- copies the kiosk runtime to `/usr/local/lib/llama-manager/kiosk` so the
  dedicated account never needs access to the administrator's source checkout,
- backs up `/etc/gdm3/custom.conf`, the kiosk AccountsService record, and any
  pre-existing `llama-kiosk.desktop` session entry to
  `/var/backups/llama-kiosk/`; symlinks are preserved as links, including exact
  target text for dangling links,
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

The installer intentionally does not run `snap set system homedirs=...`.
Keeping this dedicated home under `/home` avoids granting snaps access to a
broad nonstandard parent such as `/var/lib`, while preserving offline Firefox
startup with Ubuntu's default confinement.

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

## Recovering and diagnosing a black screen

Use SSH or press **Ctrl+Alt+F3** for a text console. First verify the installed
contract and inspect the session without changing it:

```bash
getent passwd llama-kiosk
id llama-kiosk
awk '$1 == "UID_MIN" { print "UID_MIN=" $2 }' /etc/login.defs
sudo passwd --status llama-kiosk
sudo grep -E '^(Name|Exec)=' /usr/share/wayland-sessions/llama-kiosk.desktop
sudo find /usr/local/lib/llama-manager/kiosk -maxdepth 2 -type f -print
sudo loginctl list-sessions
```

The account UID should be at or above `UID_MIN`, its home should be
`/home/llama-kiosk`, and `passwd --status` should report a locked password. A UID
below `UID_MIN` identifies a system account and is not a supported configuration
for the installed Firefox-snap kiosk. Do not repair that by editing
`/etc/passwd` manually; uninstall and reinstall the kiosk, or migrate the
account with normal account-management tooling before restarting GDM.

Collect the current boot's display-manager and kiosk-user logs before restarting
anything:

```bash
sudo systemctl status gdm3 snapd.socket --no-pager
sudo journalctl -b -u gdm3 --no-pager
sudo journalctl -b _UID="$(id -u llama-kiosk)" --no-pager
```

Look for a missing `Exec` target, an unreadable file under the installed runtime,
Firefox snap confinement or profile errors, Cage/Wayland startup failures, and a
dashboard readiness timeout. Once the paths and account are correct, recover the
graphical session with:

```bash
sudo bash scripts/install-kiosk.sh restart
```

That command ends any current graphical session. If the source checkout is not
available, `sudo systemctl restart gdm3` performs the same display-manager
restart but does not revalidate or repair the kiosk installation.

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
resources and reports when the installer originally added `cage`. After a
successful uninstall records `installed=false`, later uninstall commands are
complete no-ops: they never replay stale backups or remove resources created
after kiosk removal. A partial installation whose manifest has no `installed`
completion marker remains recoverable through the same uninstall command.

## Tests

```bash
bash tests/kiosk/run-tests.sh
python3 -m unittest tests/kiosk/test_control_helper.py
node --test ui/src/kiosk-control.test.js
```

The shell tests run entirely in a temp sandbox (`KIOSK_ROOT`) with no system
changes. The Python test opens only an ephemeral loopback port.
