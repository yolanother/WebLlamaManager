#!/usr/bin/env python3
# Llama Manager — loopback kiosk control helper tests.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Exercises the helper through its HTTP interface to prove it binds only to
# loopback, rejects cross-origin requests, and invokes the GDM switch callback
# only for a POST from the local dashboard origin.

"""Integration tests for the local kiosk control HTTP interface."""

from http.client import HTTPConnection
import importlib.util
from pathlib import Path
import threading
import unittest


HELPER_PATH = Path(__file__).parents[2] / "scripts" / "llama-kiosk-control.py"


def load_helper_module():
    """Load the executable helper as a module for interface-level testing."""

    spec = importlib.util.spec_from_file_location("llama_kiosk_control", HELPER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class KioskControlTests(unittest.TestCase):
    """Verify loopback binding, origin checks, and the login switch action."""

    def setUp(self):
        """Start an ephemeral loopback server with a recording callback."""

        self.helper = load_helper_module()
        self.calls = []
        self.server = self.helper.create_server(
            port=0,
            allowed_origins={"http://localhost:3001"},
            switch_to_gdm=lambda: self.calls.append("switch"),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        """Stop the ephemeral helper server."""

        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, origin):
        """POST the login action with the given browser Origin header."""

        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request("POST", "/system-login", headers={"Origin": origin})
        response = connection.getresponse()
        response.read()
        connection.close()
        return response.status

    def test_server_binds_only_to_loopback(self):
        """The helper must never listen on a LAN-accessible wildcard address."""

        self.assertEqual("127.0.0.1", self.server.server_address[0])

    def test_remote_origin_cannot_switch_to_login(self):
        """A dashboard loaded from a remote origin receives no system control."""

        self.assertEqual(403, self.request("http://appliance.example:3001"))
        self.assertEqual([], self.calls)

    def test_local_dashboard_can_switch_to_login(self):
        """The appliance-local dashboard may ask GDM to show its greeter."""

        self.assertEqual(204, self.request("http://localhost:3001"))
        self.assertEqual(["switch"], self.calls)


if __name__ == "__main__":
    unittest.main()
