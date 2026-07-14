#!/usr/bin/env python3
# Llama Manager — appliance-local kiosk control helper.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Exposes the single privileged-looking desktop action needed by kiosk mode:
# switching the active graphical session to the GDM greeter. The HTTP server is
# hard-bound to IPv4 loopback and accepts requests only from explicitly allowed
# localhost dashboard origins, so clients viewing the dashboard over the LAN do
# not gain control of the appliance login session.

"""Serve the loopback-only kiosk action used by the local dashboard."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
from typing import Callable, Iterable
from urllib.parse import urlsplit


LOOPBACK_ADDRESS = "127.0.0.1"
DEFAULT_PORT = 8798


def switch_to_gdm() -> None:
    """Ask GDM to show its login greeter for a normal desktop login.

    Raises:
        subprocess.CalledProcessError: If GDM rejects or cannot perform the
            session switch.
    """

    subprocess.run(["gdmflexiserver"], check=True, timeout=15)


def local_origins(dashboard_url: str) -> set[str]:
    """Return allowed localhost origins matching the dashboard URL's port.

    Args:
        dashboard_url: Absolute HTTP(S) dashboard URL opened by kiosk Chrome.

    Returns:
        Equivalent localhost and IPv4-loopback origins for the URL's port.

    Raises:
        ValueError: If the URL is not an absolute localhost HTTP(S) URL.
    """

    parsed = urlsplit(dashboard_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "localhost",
        LOOPBACK_ADDRESS,
    }:
        raise ValueError("kiosk dashboard URL must use localhost or 127.0.0.1")
    port = f":{parsed.port}" if parsed.port else ""
    return {
        f"{parsed.scheme}://localhost{port}",
        f"{parsed.scheme}://{LOOPBACK_ADDRESS}{port}",
    }


def create_server(
    port: int,
    allowed_origins: Iterable[str],
    switch_to_gdm: Callable[[], None],
) -> ThreadingHTTPServer:
    """Create a loopback-bound kiosk control server.

    Args:
        port: TCP port, or zero to request an ephemeral test port.
        allowed_origins: Exact browser origins allowed to invoke actions.
        switch_to_gdm: Callback that switches the graphical login session.

    Returns:
        A configured, not-yet-running HTTP server bound to 127.0.0.1.
    """

    origins = frozenset(allowed_origins)

    class KioskControlHandler(BaseHTTPRequestHandler):
        """Handle the local system-login action without exposing other APIs."""

        def do_POST(self) -> None:
            """Validate origin and invoke the fixed GDM switch action."""

            origin = self.headers.get("Origin", "")
            if self.path != "/system-login":
                self.send_error(404)
                return
            if origin not in origins:
                self.send_error(403)
                return
            try:
                switch_to_gdm()
            except (OSError, subprocess.SubprocessError):
                self.send_error(503)
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.end_headers()

        def log_message(self, message_format: str, *args: object) -> None:
            """Suppress request logs so browser-provided data is never emitted."""

    return ThreadingHTTPServer((LOOPBACK_ADDRESS, port), KioskControlHandler)


def main() -> int:
    """Parse CLI settings and serve kiosk control requests until terminated."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--dashboard-url", default="http://localhost:3001/kiosk")
    args = parser.parse_args()
    server = create_server(args.port, local_origins(args.dashboard_url), switch_to_gdm)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
