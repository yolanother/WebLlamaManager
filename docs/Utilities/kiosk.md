# Kiosk Dashboard Mode (optional)

Turns this host into a dashboard appliance: on boot it logs in automatically and
launches full-screen Chrome (via the `cage` Wayland compositor) showing the
Llama Manager dashboard. GNOME stays installed; uninstall restores your original
login behavior from backups.

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
- installs `cage` (via apt) if missing; requires `google-chrome`,
- backs up `/etc/gdm3/custom.conf` and your AccountsService record to
  `/var/backups/llama-kiosk/`,
- enables gdm autologin into a new "Llama Kiosk" Wayland session,
- **brings the kiosk up immediately** by restarting the display manager (no
  reboot needed) — unless you pass `--no-start`.

The launcher waits for the dashboard to come up before showing it. Configure the
target with `KIOSK_URL=` (or `API_PORT=`) in `.env`; the default is
`http://localhost:3001`.

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

## Uninstall

```bash
sudo bash scripts/install-kiosk.sh uninstall
```

Restores the backed-up gdm/session settings and removes the kiosk session entry.
`cage` is left installed (remove with `sudo apt remove cage` if you want). The
kiosk Chrome profile remains at `~/.config/llama-kiosk/`.

## Tests

```bash
bash tests/kiosk/run-tests.sh
```

Runs entirely in a temp sandbox (`KIOSK_ROOT`) — no root, no system changes.
