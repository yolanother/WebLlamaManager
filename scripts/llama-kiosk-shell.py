#!/usr/bin/env python3
"""Llama Manager appliance kiosk shell.

Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE
file in the repository root.

A dedicated full-screen WebKit window that shows the appliance dashboard and
nothing else. It replaces driving a general-purpose browser, which is what left
the appliance showing a black screen with a cursor:

- Ubuntu's Firefox is a SNAP and, on a fresh profile, runs its first-run
  onboarding instead of the URL it is handed. Measured on the appliance: its
  only TCP connections went to Mozilla infrastructure and it never once
  connected to the local manager. Firefox 147 also moved to a "Profile Groups"
  layout, so pre-seeding prefs in the profiles.ini profile does not work.
- epiphany-browser does load the dashboard, but brings a browser's furniture
  with it -- a "Set as Default Browser?" dialog opened centred on the screen of
  a machine that has no keyboard or mouse to dismiss it. Suppressing each prompt
  as it appears is a game with no end.

This shell has no prompts to suppress because it has no features to prompt
about: no chrome, no tabs, no menus, no downloads, no navigation, and no
first-run anything. It is deliberately NOT Electron: WebKitGTK 6.0 and its
GObject-introspection typelibs are ALREADY on the appliance image (epiphany
depends on them), so this adds no runtime and no ~150 MB of bundled Chromium,
and it does not put us on the hook for shipping Chromium security updates.

The dashboard may not be serving yet when the session starts -- the manager
boots alongside it -- so a browser's raw connection-refused page is the wrong
thing to show an operator. This waits, retries, and says what it is waiting for.
"""
from __future__ import annotations

import argparse
import base64
import glob
import os
import sys
import urllib.error
import urllib.request

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import GLib, Gtk, WebKit  # noqa: E402  (GI needs the versions first)

#: How often to re-probe the dashboard while it is not yet serving, in seconds.
#: Short enough that the appliance appears promptly once the manager is up,
#: long enough not to spin.
POLL_SECONDS = 2

#: How long one readiness probe may take. The manager is on loopback, so a slow
#: reply means it is starting rather than far away.
PROBE_TIMEOUT_SECONDS = 2

#: Where the appliance mark lives, most specific first. The branding packages
#: install a platform-named pixmap (llama-manager-amd.png,
#: llama-manager-nvidia.png, ...) and the same mark again under the Plymouth
#: theme, so the waiting screen shows the SAME logo the operator has already
#: seen on the boot splash and the wallpaper rather than a second identity.
#: Overridable so a platform that names its mark differently needs no code
#: change.
LOGO_SEARCH = (
    os.environ.get("LLAMA_KIOSK_LOGO", ""),
    "/usr/share/pixmaps/llama-manager-*.png",
    "/usr/share/plymouth/themes/llama-manager-*/logo.png",
)


def find_logo() -> str:
    """Return the appliance mark as a data URI, or an empty string.

    Inlined rather than referenced: the waiting screen is loaded with
    ``load_html`` and has no base URI, so a file:// reference would not resolve.
    Reading one small PNG once at startup is cheaper than giving the shell a
    document root it does not otherwise need.

    :returns: ``data:image/png;base64,...`` or "" when no mark is installed.
    :rtype: str
    """
    for pattern in LOGO_SEARCH:
        if not pattern:
            continue
        for path in sorted(glob.glob(pattern)):
            try:
                with open(path, "rb") as handle:
                    encoded = base64.b64encode(handle.read()).decode("ascii")
                return "data:image/png;base64," + encoded
            except OSError:
                continue
    return ""


def dashboard_is_serving(url: str) -> bool:
    """Report whether the dashboard answers an HTTP request.

    :param str url: Dashboard URL to probe.
    :returns: True when the URL returns any HTTP response. Any status counts:
        the question is whether the manager is listening and replying, not
        whether this particular path is a 200.
    :rtype: bool
    """
    try:
        with urllib.request.urlopen(url, timeout=PROBE_TIMEOUT_SECONDS):
            return True
    except urllib.error.HTTPError:
        # It answered, which is what was asked.
        return True
    except Exception:
        return False


class KioskWindow(Gtk.ApplicationWindow):
    """Full-screen, undecorated window holding the dashboard.

    :param Gtk.Application app: Owning application.
    :param str url: Dashboard URL to display.
    """

    def __init__(self, app: Gtk.Application, url: str) -> None:
        super().__init__(application=app)
        self._url = url
        self._loaded = False

        self.set_decorated(False)
        self.fullscreen()

        self._view = WebKit.WebView()
        # No context menu: a right-click on an appliance should do nothing
        # rather than offer to view source or open a link in a new window.
        self._view.connect("context-menu", lambda *_: True)
        self._view.connect("load-failed", self._on_load_failed)

        settings = self._view.get_settings()
        # The dashboard needs none of these, and each is a way for a stray page
        # to become something other than the dashboard.
        settings.set_enable_developer_extras(False)
        settings.set_enable_html5_database(False)
        settings.set_enable_html5_local_storage(True)  # the UI remembers tabs
        settings.set_javascript_can_open_windows_automatically(False)

        self.set_child(self._view)
        self._show_waiting()
        GLib.timeout_add_seconds(POLL_SECONDS, self._poll)

    def _show_waiting(self) -> None:
        """Render the branded waiting state.

        A browser would show its own connection-refused page here, which tells
        an operator the machine is broken when it is merely still starting.
        """
        logo = find_logo()
        mark = (
            "<img src='%s' alt=''>" % logo
            if logo
            else ""
        )
        self._view.load_html(
            "<!doctype html><html><head><meta charset='utf-8'><style>"
            "html,body{height:100%;margin:0;background:#0b0b0d;color:#e8e8ea;"
            "font:400 16px/1.5 system-ui,sans-serif;display:flex;"
            "align-items:center;justify-content:center}"
            "div{text-align:center;opacity:.9}"
            "img{width:180px;height:auto;margin:0 0 1.6rem;"
            # The mark is the same one Plymouth just showed. A gentle pulse
            # says "working" without implying measurable progress, which this
            # screen cannot honestly report.
            "animation:b 2.4s ease-in-out infinite}"
            "@keyframes b{0%,100%{opacity:.95}50%{opacity:.55}}"
            "h1{font-size:1.4rem;font-weight:600;margin:0 0 .4rem}"
            "p{margin:0;opacity:.65;font-size:.95rem}"
            "</style></head><body><div>" + mark +
            "<h1>Starting the appliance</h1>"
            "<p>The local model service is coming up.</p>"
            "</div></body></html>",
            None,
        )

    def _poll(self) -> bool:
        """Load the dashboard once it is serving; keep waiting until then.

        :returns: True to stay scheduled, False to stop polling.
        :rtype: bool
        """
        if self._loaded:
            return False
        if dashboard_is_serving(self._url):
            self._loaded = True
            self._view.load_uri(self._url)
            return False
        return True

    def _on_load_failed(self, _view, _event, _uri, _error) -> bool:
        """Fall back to waiting when a load fails after the probe succeeded.

        The manager can restart underneath the shell -- a model load can take it
        down briefly -- and the operator should see the appliance's own waiting
        state rather than a WebKit error page.

        :returns: True, meaning this handler has shown something.
        :rtype: bool
        """
        self._loaded = False
        self._show_waiting()
        GLib.timeout_add_seconds(POLL_SECONDS, self._poll)
        return True


def main(argv: list[str] | None = None) -> int:
    """Run the kiosk shell.

    :param list argv: Argument vector, defaulting to the process arguments.
    :returns: Process exit status.
    :rtype: int
    """
    parser = argparse.ArgumentParser(description="Llama Manager kiosk shell")
    parser.add_argument(
        "url",
        nargs="?",
        default=os.environ.get("LLAMA_KIOSK_URL", "http://localhost:3001/kiosk"),
        help="dashboard URL to display",
    )
    args = parser.parse_args(argv)

    app = Gtk.Application(application_id="ai.doubtech.llama.kiosk")
    app.connect("activate", lambda a: KioskWindow(a, args.url).present())
    # Gtk.Application would otherwise try to parse our arguments again.
    return app.run([])


if __name__ == "__main__":
    sys.exit(main())
