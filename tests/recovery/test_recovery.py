#!/usr/bin/env python3
# Llama Manager recovery CLI integration tests.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# Exercises the public recovery command in temporary replacement-host roots so
# backup, masking, planning, and restore safety are verified without reading or
# changing the developer workstation.

"""Integration tests for the llama-manager-recovery public CLI."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = REPO_ROOT / "scripts" / "llama-manager-recovery"


class RecoveryCliTests(unittest.TestCase):
    """Verify recovery bundles solely through the command-line interface."""

    def setUp(self) -> None:
        """Create an isolated source host and output tree for each test."""
        self.temp_dir = tempfile.TemporaryDirectory(prefix="llama-recovery-test-")
        self.addCleanup(self.temp_dir.cleanup)
        self.base = Path(self.temp_dir.name)
        self.source_root = self.base / "source"
        self.output = self.base / "backups"
        config = self.source_root / "etc" / "llama-manager" / "config.json"
        config.parent.mkdir(parents=True)
        config.write_text(
            json.dumps(
                {
                    "modelsDir": "/srv/models",
                    "apiPort": 3001,
                    "HF_TOKEN": "hf_super_secret_value",
                }
            ),
            encoding="utf-8",
        )
        arbitrary = self.source_root / "home" / "operator" / "notes.txt"
        arbitrary.parent.mkdir(parents=True)
        arbitrary.write_text("must not be copied\n", encoding="utf-8")
        model = self.source_root / "srv" / "models" / "qwen.gguf"
        model.parent.mkdir(parents=True)
        model.write_bytes(b"model blob must not be copied")

    def run_cli(
        self,
        *args: str,
        check: bool = True,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Run the recovery CLI and return its captured process result.

        Args:
            *args: Arguments supplied after the CLI executable.
            check: Raise when the command exits unsuccessfully.
            env: Optional environment overrides used by deterministic race tests.

        Returns:
            The completed subprocess with text output captured.
        """
        return subprocess.run(
            [str(CLI), *args],
            check=check,
            text=True,
            capture_output=True,
            env={**os.environ, **(env or {})},
        )

    def resign_bundle(self, bundle: Path) -> None:
        """Recompute checksums after constructing a hostile but internally signed bundle.

        Args:
            bundle: Test bundle whose payload checksum file should be replaced.
        """
        lines = []
        for path in sorted(item for item in bundle.rglob("*") if item.is_file()):
            if path.name == "SHA256SUMS":
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            lines.append(f"{digest}  {path.relative_to(bundle)}")
        (bundle / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_backup_copies_only_allowlisted_files_and_masks_secrets(self) -> None:
        """Backup includes sanitized manager config but no home data or models."""
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120000Z",
        )

        bundle = Path(result.stdout.strip())
        self.assertEqual(0o700, stat.S_IMODE(bundle.stat().st_mode))
        copied_config = bundle / "files" / "etc" / "llama-manager" / "config.json"
        self.assertTrue(copied_config.is_file())
        self.assertNotIn("hf_super_secret_value", copied_config.read_text(encoding="utf-8"))
        self.assertEqual("[REDACTED]", json.loads(copied_config.read_text())["HF_TOKEN"])
        self.assertFalse((bundle / "files" / "home").exists())
        self.assertFalse((bundle / "files" / "srv" / "models").exists())

    def test_backup_migrates_legacy_install_settings_without_service_secrets(self) -> None:
        """Legacy config is normalized while its user unit remains a redacted reference."""
        (self.source_root / "etc" / "llama-manager" / "config.json").unlink()
        project = self.source_root / "home" / "operator" / "llama-server"
        (project / "api").mkdir(parents=True)
        (project / "install.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        (project / "api" / "server.js").write_text("// server\n", encoding="utf-8")
        (project / "config.json").write_text(
            json.dumps({"modelsDir": "/srv/models", "HF_TOKEN": "legacy-secret"}),
            encoding="utf-8",
        )
        service = (
            self.source_root
            / "home"
            / "operator"
            / ".config"
            / "systemd"
            / "user"
            / "llama-manager.service"
        )
        service.parent.mkdir(parents=True)
        service.write_text(
            "[Service]\n"
            "WorkingDirectory=/home/operator/llama-server/api\n"
            "Environment=HF_TOKEN=legacy-service-secret\n",
            encoding="utf-8",
        )

        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--legacy-project-root",
            "/home/operator/llama-server",
            "--legacy-user-home",
            "/home/operator",
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120025Z",
        )

        bundle = Path(result.stdout.strip())
        migrated = bundle / "files" / "etc" / "llama-manager" / "config.json"
        self.assertEqual("[REDACTED]", json.loads(migrated.read_text())["HF_TOKEN"])
        manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        reference = manifest["runtime"]["legacyInstall"]["userServiceReference"]
        self.assertIn("Environment=HF_TOKEN=[REDACTED]", reference)
        self.assertNotIn("legacy-secret", (bundle / "manifest.json").read_text())
        inspected = json.loads(self.run_cli("inspect", str(bundle)).stdout)
        self.assertEqual(["manager", "service-reference"], inspected["categories"])
        self.assertTrue(inspected["legacyInstallCaptured"])

    def test_backup_masks_service_environment_secrets(self) -> None:
        """Systemd Environment assignments cannot leak captured credentials."""
        service = (
            self.source_root
            / "etc"
            / "systemd"
            / "system"
            / "llama-manager.service"
        )
        service.parent.mkdir(parents=True)
        service.write_text(
            "[Service]\nEnvironment=HF_TOKEN=hf_service_secret\nEnvironment=API_PORT=3001\n",
            encoding="utf-8",
        )

        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120050Z",
        )

        bundle = Path(result.stdout.strip())
        captured = (
            bundle
            / "files"
            / "etc"
            / "systemd"
            / "system"
            / "llama-manager.service"
        ).read_text(encoding="utf-8")
        self.assertNotIn("hf_service_secret", captured)
        self.assertIn("Environment=HF_TOKEN=[REDACTED]", captured)
        self.assertIn("Environment=API_PORT=3001", captured)

    def test_backup_masks_credentials_embedded_in_boot_arguments(self) -> None:
        """Credential-like boot assignments are redacted inside quoted values."""
        grub = self.source_root / "etc" / "default" / "grub"
        grub.parent.mkdir(parents=True)
        grub.write_text(
            'GRUB_CMDLINE_LINUX="quiet recovery_password=dont-copy-me amdgpu.gttsize=126976"\n',
            encoding="utf-8",
        )

        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120055Z",
        )

        captured = (
            Path(result.stdout.strip()) / "files" / "etc" / "default" / "grub"
        ).read_text(encoding="utf-8")
        self.assertNotIn("dont-copy-me", captured)
        self.assertEqual("GRUB_CMDLINE_LINUX=[REDACTED]\n", captured)

    def test_backup_redacts_complete_url_values_containing_credentials(self) -> None:
        """URL userinfo and sensitive query values cause whole-value redaction."""
        config = self.source_root / "etc" / "llama-manager" / "config.json"
        config.write_text(
            json.dumps(
                {
                    "credentialedMirror": "https://operator:password@example.test/models",
                    "queryMirror": "https://example.test/models?token=query-secret&part=1",
                    "publicMirror": "https://example.test/models?part=1",
                    "prefixed": "fetch from https://operator:password@example.test/models now",
                    "assignment": "curl=https://operator:password@example.test/models",
                    "quotedSecret": 'flags token="secret value" safe=true',
                }
            ),
            encoding="utf-8",
        )
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120056Z",
        )

        captured = json.loads(
            (
                Path(result.stdout.strip())
                / "files"
                / "etc"
                / "llama-manager"
                / "config.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual("[REDACTED]", captured["credentialedMirror"])
        self.assertEqual("[REDACTED]", captured["queryMirror"])
        self.assertEqual("[REDACTED]", captured["prefixed"])
        self.assertEqual("[REDACTED]", captured["assignment"])
        self.assertEqual("[REDACTED]", captured["quotedSecret"])
        self.assertEqual("https://example.test/models?part=1", captured["publicMirror"])
        self.assertNotIn("password", json.dumps(captured))
        self.assertNotIn("query-secret", json.dumps(captured))

    def test_backup_records_portable_nfs_and_platform_manifests(self) -> None:
        """Backup describes mounts and platform pins without copying model blobs."""
        fstab = self.source_root / "etc" / "fstab"
        fstab.parent.mkdir(parents=True, exist_ok=True)
        fstab.write_text(
            "UUID=host-specific / ext4 defaults 0 1\n"
            "nas.lan:/models /srv/models nfs4 rw,noatime,noauto,x-systemd.automount 0 0\n",
            encoding="utf-8",
        )
        kernel = self.source_root / "proc" / "sys" / "kernel" / "osrelease"
        kernel.parent.mkdir(parents=True)
        kernel.write_text("6.18.36-mainline\n", encoding="utf-8")
        product = self.source_root / "sys" / "class" / "dmi" / "id" / "product_name"
        product.parent.mkdir(parents=True)
        product.write_text("GMKtec EVO-X2\n", encoding="utf-8")
        runtime = self.source_root / "var" / "lib" / "llama-manager" / "runtime.json"
        runtime.parent.mkdir(parents=True)
        runtime.write_text(
            json.dumps({"container": "llama-rocm-7.2.4", "rocm": "7.2.4"}),
            encoding="utf-8",
        )

        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120100Z",
        )

        bundle = Path(result.stdout.strip())
        manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(
            [
                {
                    "filesystem": "nfs4",
                    "mountpoint": "/srv/models",
                    "options": ["rw", "noatime", "noauto", "x-systemd.automount"],
                    "source": "nas.lan:/models",
                }
            ],
            manifest["storage"]["nfsMounts"],
        )
        self.assertEqual("/srv/models", manifest["storage"]["modelsDir"])
        self.assertEqual("6.18.36-mainline", manifest["platform"]["kernel"])
        self.assertEqual("GMKtec EVO-X2", manifest["platform"]["product"])
        self.assertEqual("llama-rocm-7.2.4", manifest["runtime"]["container"])
        self.assertTrue((bundle / "SHA256SUMS").is_file())
        guide = (bundle / "RECONFIGURE.md").read_text(encoding="utf-8")
        self.assertIn("Codex or Claude", guide)
        self.assertIn("map NFS source and mount paths", guide)

    def test_inspect_summarizes_and_validates_bundle_without_secrets(self) -> None:
        """Inspect reports source, categories, and checksum status safely."""
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120200Z",
        )
        bundle = backup.stdout.strip()

        result = self.run_cli("inspect", bundle)

        summary = json.loads(result.stdout)
        self.assertEqual("source-host", summary["sourceHost"])
        self.assertEqual(["manager"], summary["categories"])
        self.assertTrue(summary["checksumsValid"])
        self.assertNotIn("hf_super_secret_value", result.stdout)

    def test_plan_rejects_signed_manifest_entries_outside_exact_allowlist(self) -> None:
        """Checksums cannot authorize duplicate, mistyped, or unknown restore targets."""
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120250Z",
        )
        bundle = Path(backup.stdout.strip())
        manifest_path = bundle / "manifest.json"
        original = json.loads(manifest_path.read_text(encoding="utf-8"))
        hostile_entries = (
            original["files"] + [original["files"][0]],
            [{"category": "manager", "path": "/etc/shadow"}],
            [{"category": "platform", "path": "/etc/llama-manager/config.json"}],
            [{"category": 5, "path": "/etc/llama-manager/config.json"}],
        )
        for index, entries in enumerate(hostile_entries):
            with self.subTest(index=index):
                manifest = dict(original)
                manifest["files"] = entries
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                self.resign_bundle(bundle)
                result = self.run_cli(
                    "--root",
                    str(self.base / "target"),
                    "plan",
                    str(bundle),
                    "--hostname",
                    "source-host",
                    check=False,
                )
                self.assertNotEqual(0, result.returncode)
                self.assertIn("manifest", result.stderr.lower())
        hostile_source = dict(original)
        hostile_source["sourceHost"] = "../escaped-host"
        manifest_path.write_text(json.dumps(hostile_source), encoding="utf-8")
        self.resign_bundle(bundle)
        result = self.run_cli("inspect", str(bundle), check=False)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("hostname", result.stderr.lower())

    def test_plan_rejects_hostile_nfs_manifest_fields_and_options(self) -> None:
        """A checksummed bundle still cannot inject fstab syntax or arbitrary options."""
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120251Z",
        )
        bundle = Path(backup.stdout.strip())
        manifest_path = bundle / "manifest.json"
        original = json.loads(manifest_path.read_text(encoding="utf-8"))
        hostile_mounts = (
            {
                "source": "nas:/models\nmalicious",
                "mountpoint": "/srv/models",
                "filesystem": "nfs4",
                "options": ["rw"],
            },
            {
                "source": "nas:/models",
                "mountpoint": "../../etc",
                "filesystem": "nfs4",
                "options": ["rw"],
            },
            {
                "source": "nas:/models",
                "mountpoint": "/srv/models",
                "filesystem": "nfs4",
                "options": ["rw", "credentials=/etc/shadow"],
            },
        )
        for index, mount in enumerate(hostile_mounts):
            with self.subTest(index=index):
                manifest = dict(original)
                manifest["storage"] = {
                    "modelsDir": "/srv/models",
                    "nfsMounts": [mount],
                }
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                self.resign_bundle(bundle)
                result = self.run_cli(
                    "plan", str(bundle), "--hostname", "source-host", check=False
                )
                self.assertNotEqual(0, result.returncode)
                self.assertIn("nfs", result.stderr.lower())

    def test_backup_rejects_symlinked_sources_and_unsafe_path_components(self) -> None:
        """Backup never follows allowlisted metadata symlinks or path traversal names."""
        outside = self.base / "outside-config.json"
        outside.write_text('{"modelsDir":"/escaped"}', encoding="utf-8")
        config = self.source_root / "etc" / "llama-manager" / "config.json"
        config.unlink()
        config.symlink_to(outside)
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120252Z",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("symbolic", result.stderr.lower())

        config.unlink()
        config.write_text('{"modelsDir":"/srv/models"}', encoding="utf-8")
        outside_runtime = self.base / "outside-runtime.json"
        outside_runtime.write_text('{"container":"untrusted"}', encoding="utf-8")
        runtime = self.source_root / "var" / "lib" / "llama-manager" / "runtime.json"
        runtime.parent.mkdir(parents=True)
        runtime.symlink_to(outside_runtime)
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120254Z",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("symbolic", result.stderr.lower())

        for hostname, timestamp in (("../escape", "20260714T120253Z"), ("host", "../../x")):
            with self.subTest(hostname=hostname, timestamp=timestamp):
                result = self.run_cli(
                    "--root",
                    str(self.base / "empty-root"),
                    "backup",
                    "--output-dir",
                    str(self.output),
                    "--hostname",
                    hostname,
                    "--timestamp",
                    timestamp,
                    check=False,
                )
                self.assertNotEqual(0, result.returncode)
                expected_error = "hostname" if ".." in hostname else "timestamp"
                self.assertIn(expected_error, result.stderr.lower())

    def test_backup_rejects_symlinked_output_and_platform_escape(self) -> None:
        """Output parents and platform reads cannot follow attacker-controlled links."""
        real_output = self.base / "real-output"
        real_output.mkdir()
        linked_output = self.base / "linked-output"
        linked_output.symlink_to(real_output, target_is_directory=True)
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(linked_output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120255Z",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("symbolic", result.stderr.lower())

        safe_output = self.base / "safe-output"
        safe_output.mkdir()
        redirected_host = self.base / "redirected-host"
        redirected_host.mkdir()
        (safe_output / "source-host").symlink_to(
            redirected_host, target_is_directory=True
        )
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(safe_output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120257Z",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("symbolic", result.stderr.lower())

        os_release = self.source_root / "etc" / "os-release"
        os_release.parent.mkdir(parents=True, exist_ok=True)
        outside = self.base / "outside-os-release"
        outside.write_text("PRETTY_NAME=escaped\n", encoding="utf-8")
        os_release.symlink_to(outside)
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120256Z",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("platform", result.stderr.lower())

    def test_backup_resolves_configured_volume_alias(self) -> None:
        """The configured backup root may use a stable system volume alias."""
        canonical_volume = self.base / "mnt" / "nas" / "volumes"
        canonical_volume.mkdir(parents=True)
        volume_alias = self.base / "volumes"
        volume_alias.symlink_to(canonical_volume, target_is_directory=True)
        configured_output = volume_alias / "llama-manager" / "private" / "backups"

        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120258Z",
            env={"LLAMA_MANAGER_RECOVERY_DIR": str(configured_output)},
        )

        bundle = Path(result.stdout.strip())
        self.assertEqual(
            canonical_volume
            / "llama-manager"
            / "private"
            / "backups"
            / "source-host"
            / "20260714T120258Z",
            bundle,
        )
        self.assertTrue((bundle / "manifest.json").is_file())

    def test_backup_source_parent_swap_uses_open_descriptor(self) -> None:
        """A validated source parent swap cannot redirect the captured bytes."""
        source_file = (
            self.source_root
            / "usr"
            / "share"
            / "wayland-sessions"
            / "llama-kiosk.desktop"
        )
        source_file.parent.mkdir(parents=True)
        source_file.write_text("Exec=/usr/bin/llama-kiosk\n", encoding="utf-8")
        outside = self.base / "outside-session"
        outside.mkdir()
        (outside / "llama-kiosk.desktop").write_text(
            "Exec=/usr/bin/redirected\n", encoding="utf-8"
        )

        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120258Z",
            env={
                "LLAMA_RECOVERY_TEST_SOURCE_SWAP": (
                    "/usr/share/wayland-sessions/llama-kiosk.desktop"
                ),
                "LLAMA_RECOVERY_TEST_SOURCE_SWAP_TARGET": str(outside),
            },
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)

        captured = (
            Path(result.stdout.strip())
            / "files"
            / "usr"
            / "share"
            / "wayland-sessions"
            / "llama-kiosk.desktop"
        ).read_text(encoding="utf-8")
        self.assertTrue(source_file.parent.is_symlink())
        self.assertTrue(
            source_file.parent.with_name("wayland-sessions.stable").is_dir()
        )
        self.assertEqual("Exec=/usr/bin/llama-kiosk\n", captured)

    def test_backup_output_parent_swap_cannot_redirect_payloads(self) -> None:
        """A created bundle swap cannot redirect fd-relative payload writes."""
        outside = self.base / "outside-output"
        outside.mkdir()
        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120259Z",
            env={
                "LLAMA_RECOVERY_TEST_OUTPUT_SWAP": "1",
                "LLAMA_RECOVERY_TEST_OUTPUT_SWAP_TARGET": str(outside),
            },
        )

        bundle = Path(result.stdout.strip())
        original = self.output / "source-host" / "20260714T120259Z"
        self.assertTrue(original.is_symlink())
        self.assertEqual("20260714T120259Z.stable", bundle.name)
        self.assertTrue((bundle / "manifest.json").is_file())
        self.assertTrue((bundle / "SHA256SUMS").is_file())
        self.assertEqual([], list(outside.iterdir()))

    def test_backup_allows_root_internal_os_release_symlink(self) -> None:
        """Ubuntu's root-internal os-release symlink is read through stable fds."""
        canonical = self.source_root / "usr" / "lib" / "os-release"
        canonical.parent.mkdir(parents=True)
        canonical.write_text("ID=ubuntu\nPRETTY_NAME=Ubuntu Recovery\n", encoding="utf-8")
        os_release = self.source_root / "etc" / "os-release"
        os_release.parent.mkdir(parents=True, exist_ok=True)
        os_release.symlink_to("../usr/lib/os-release")

        result = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120300Z",
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)

        manifest = json.loads(
            (Path(result.stdout.strip()) / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual("ubuntu", manifest["platform"]["osRelease"]["ID"])
        self.assertEqual(
            "Ubuntu Recovery", manifest["platform"]["osRelease"]["PRETTY_NAME"]
        )

    def test_plan_requires_explicit_replacement_host_storage_mappings(self) -> None:
        """Plan flags host-specific values instead of proposing blind restoration."""
        fstab = self.source_root / "etc" / "fstab"
        fstab.parent.mkdir(parents=True, exist_ok=True)
        fstab.write_text(
            "old-nas:/models /srv/models nfs4 rw,x-systemd.automount 0 0\n",
            encoding="utf-8",
        )
        gdm = self.source_root / "etc" / "gdm3" / "custom.conf"
        gdm.parent.mkdir(parents=True)
        gdm.write_text(
            "[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin=llama-kiosk\n",
            encoding="utf-8",
        )
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120300Z",
        )
        target_root = self.base / "replacement"

        result = self.run_cli(
            "--root",
            str(target_root),
            "plan",
            backup.stdout.strip(),
            "--hostname",
            "replacement-host",
        )

        plan = json.loads(result.stdout)
        self.assertEqual("replacement-host", plan["targetHost"])
        self.assertEqual(
            [
                "host.hostname",
                "kiosk.user",
                "nfs.0.mountpoint",
                "nfs.0.source",
                "storage.models_dir",
            ],
            plan["requiredMappings"],
        )
        self.assertEqual("create", plan["changes"][0]["status"])
        self.assertFalse(plan["readyToRestore"])

    def test_restore_dry_run_honors_category_selection_without_mutation(self) -> None:
        """Dry-run previews only selected files and never creates rollback state."""
        source_service = (
            self.source_root
            / "etc"
            / "systemd"
            / "system"
            / "llama-manager.service"
        )
        source_service.parent.mkdir(parents=True)
        source_service.write_text("[Service]\nExecStart=/usr/bin/llama-manager\n", encoding="utf-8")
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120400Z",
        )
        target_root = self.base / "target"
        target_service = (
            target_root / "etc" / "systemd" / "system" / "llama-manager.service"
        )
        target_service.parent.mkdir(parents=True)
        target_service.write_text("[Service]\nExecStart=/old/path\n", encoding="utf-8")

        result = self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--dry-run",
            "--categories",
            "service",
            "--hostname",
            "same-host",
        )

        preview = json.loads(result.stdout)
        self.assertTrue(preview["dryRun"])
        self.assertEqual(["service"], preview["categories"])
        self.assertEqual("replace", preview["changes"][0]["status"])
        self.assertEqual("[Service]\nExecStart=/old/path\n", target_service.read_text())
        self.assertFalse((target_root / "var" / "backups").exists())

    def test_restore_rejects_symlinked_destination_ancestor_even_inside_root(self) -> None:
        """A destination ancestor link is rejected even when it resolves inside root."""
        source_service = (
            self.source_root
            / "etc"
            / "systemd"
            / "system"
            / "llama-manager.service"
        )
        source_service.parent.mkdir(parents=True)
        source_service.write_text("[Service]\nExecStart=/new\n")
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120401Z",
        )
        target_root = self.base / "target"
        real_etc = target_root / "real-etc"
        real_etc.mkdir(parents=True)
        (target_root / "etc").symlink_to(real_etc, target_is_directory=True)
        result = self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--dry-run",
            "--categories",
            "service",
            "--hostname",
            "same-host",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("symbolic", result.stderr.lower())
        self.assertFalse((real_etc / "systemd" / "system" / "llama-manager.service").exists())

    def test_storage_only_restore_creates_mapped_model_directory(self) -> None:
        """The required storage.models_dir mapping has an observable storage action."""
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120450Z",
        )
        target_root = self.base / "target"

        preview = self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--dry-run",
            "--categories",
            "storage",
            "--hostname",
            "same-host",
            "--map",
            "storage.models_dir=/mnt/ai-models",
            "--manager-uid",
            str(os.geteuid()),
            "--manager-gid",
            str(os.getegid()),
        )
        self.assertIn("/mnt/ai-models", preview.stdout)
        self.assertFalse((target_root / "mnt" / "ai-models").exists())

        self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--categories",
            "storage",
            "--hostname",
            "same-host",
            "--map",
            "storage.models_dir=/mnt/ai-models",
            "--manager-uid",
            str(os.geteuid()),
            "--manager-gid",
            str(os.getegid()),
            "--timestamp",
            "20260714T120451Z",
        )
        model_dir = target_root / "mnt" / "ai-models"
        self.assertTrue(model_dir.is_dir())
        self.assertEqual(0o2775, stat.S_IMODE(model_dir.stat().st_mode))
        self.assertEqual(
            (os.geteuid(), os.getegid()),
            (model_dir.stat().st_uid, model_dir.stat().st_gid),
        )

    def test_storage_restore_rejects_regular_file_collision(self) -> None:
        """A mapped model path that is already a regular file is never accepted."""
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120453Z",
        )
        target_root = self.base / "target"
        collision = target_root / "mnt" / "ai-models"
        collision.parent.mkdir(parents=True)
        collision.write_text("not a directory\n")
        result = self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--dry-run",
            "--categories",
            "storage",
            "--hostname",
            "same-host",
            "--map",
            "storage.models_dir=/mnt/ai-models",
            "--manager-uid",
            str(os.geteuid()),
            "--manager-gid",
            str(os.getegid()),
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("regular file", result.stderr.lower())

    def test_storage_creation_failure_removes_new_directory_before_rolled_back_state(self) -> None:
        """Rollback durably removes a newly created model directory before recording state."""
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120454Z",
        )
        target_root = self.base / "target"
        result = self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--categories",
            "storage",
            "--hostname",
            "same-host",
            "--map",
            "storage.models_dir=/mnt/ai-models",
            "--manager-uid",
            str(os.geteuid()),
            "--manager-gid",
            str(os.getegid()),
            "--timestamp",
            "20260714T120455Z",
            "--fail-after",
            "1",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertFalse((target_root / "mnt" / "ai-models").exists())
        rollback = (
            target_root
            / "var"
            / "backups"
            / "llama-manager-recovery"
            / "20260714T120455Z"
        )
        state = json.loads((rollback / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual("rolled_back", state["state"])

    def test_restore_rejects_model_storage_under_protected_system_paths(self) -> None:
        """Storage mappings cannot turn model-directory creation into system mutation."""
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120452Z",
        )
        result = self.run_cli(
            "--root",
            str(self.base / "target"),
            "restore",
            backup.stdout.strip(),
            "--dry-run",
            "--categories",
            "storage",
            "--hostname",
            "same-host",
            "--map",
            "storage.models_dir=/etc/llama-manager/models",
            check=False,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("protected", result.stderr.lower())

    def test_restore_backs_up_every_target_and_writes_rollback_instructions(self) -> None:
        """Applying one category preserves prior state and leaves others untouched."""
        source_service = (
            self.source_root
            / "etc"
            / "systemd"
            / "system"
            / "llama-manager.service"
        )
        source_service.parent.mkdir(parents=True)
        source_service.write_text("[Service]\nExecStart=/usr/bin/llama-manager\n", encoding="utf-8")
        source_grub = self.source_root / "etc" / "default" / "grub"
        source_grub.parent.mkdir(parents=True)
        source_grub.write_text('GRUB_CMDLINE_LINUX_DEFAULT="amdgpu.gttsize=126976"\n')
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120500Z",
        )
        target_root = self.base / "target"
        target_service = (
            target_root / "etc" / "systemd" / "system" / "llama-manager.service"
        )
        target_service.parent.mkdir(parents=True)
        target_service.write_text("[Service]\nExecStart=/old/path\n", encoding="utf-8")
        target_grub = target_root / "etc" / "default" / "grub"
        target_grub.parent.mkdir(parents=True)
        target_grub.write_text('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"\n')

        result = self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--categories",
            "service",
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120600Z",
        )

        summary = json.loads(result.stdout)
        rollback = Path(summary["rollbackDir"])
        self.assertEqual(
            "[Service]\nExecStart=/usr/bin/llama-manager\n",
            target_service.read_text(),
        )
        self.assertEqual(
            'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"\n', target_grub.read_text()
        )
        saved = rollback / "original" / "etc" / "systemd" / "system" / "llama-manager.service"
        self.assertEqual("[Service]\nExecStart=/old/path\n", saved.read_text())
        rollback_guide = (rollback / "ROLLBACK.md").read_text(encoding="utf-8")
        self.assertIn("llama-manager.service", rollback_guide)
        self.assertIn("Restore this directory before retrying", rollback_guide)

    def test_restore_preserves_existing_metadata_and_secures_new_manager_config(self) -> None:
        """Existing ownership/mode survive while a new manager config is not world-readable."""
        source_service = (
            self.source_root
            / "etc"
            / "systemd"
            / "system"
            / "llama-manager.service"
        )
        source_service.parent.mkdir(parents=True)
        source_service.write_text("[Service]\nExecStart=/usr/bin/llama-manager\n")
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120650Z",
        )
        target_root = self.base / "target"
        target_service = (
            target_root / "etc" / "systemd" / "system" / "llama-manager.service"
        )
        target_service.parent.mkdir(parents=True)
        target_service.write_text("[Service]\nExecStart=/old/path\n")
        target_service.chmod(0o600)
        original_stat = target_service.stat()

        self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--categories",
            "manager,service",
            "--hostname",
            "same-host",
            "--map",
            "storage.models_dir=/mnt/models",
            "--timestamp",
            "20260714T120651Z",
        )

        restored_stat = target_service.stat()
        self.assertEqual(0o600, stat.S_IMODE(restored_stat.st_mode))
        self.assertEqual(
            (original_stat.st_uid, original_stat.st_gid),
            (restored_stat.st_uid, restored_stat.st_gid),
        )
        target_config = target_root / "etc" / "llama-manager" / "config.json"
        self.assertEqual(0o640, stat.S_IMODE(target_config.stat().st_mode))

    def test_restore_failure_automatically_rolls_back_from_prepared_manifest(self) -> None:
        """A mid-transaction failure restores every target and records rolled_back state."""
        source_service = (
            self.source_root
            / "etc"
            / "systemd"
            / "system"
            / "llama-manager.service"
        )
        source_service.parent.mkdir(parents=True)
        source_service.write_text("[Service]\nExecStart=/new\n")
        source_grub = self.source_root / "etc" / "default" / "grub"
        source_grub.parent.mkdir(parents=True)
        source_grub.write_text('GRUB_CMDLINE_LINUX_DEFAULT="amdgpu.gttsize=126976"\n')
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120659Z",
        )
        target_root = self.base / "target"
        target_service = (
            target_root / "etc" / "systemd" / "system" / "llama-manager.service"
        )
        target_service.parent.mkdir(parents=True)
        target_service.write_text("[Service]\nExecStart=/old\n")
        target_grub = target_root / "etc" / "default" / "grub"
        target_grub.parent.mkdir(parents=True)
        target_grub.write_text('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"\n')

        result = self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--categories",
            "service,platform",
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120700Z",
            "--fail-after",
            "1",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("[Service]\nExecStart=/old\n", target_service.read_text())
        self.assertEqual(
            'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"\n', target_grub.read_text()
        )
        rollback = (
            target_root
            / "var"
            / "backups"
            / "llama-manager-recovery"
            / "20260714T120700Z"
        )
        manifest = json.loads((rollback / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual("rolled_back", manifest["state"])
        self.assertEqual(0o700, stat.S_IMODE(rollback.stat().st_mode))
        self.assertTrue((rollback / "ROLLBACK.md").is_file())
        self.assertIn("automatic rollback", (rollback / "ROLLBACK.md").read_text().lower())

    def test_restore_adapts_storage_nfs_and_kiosk_without_replacing_secrets(self) -> None:
        """Replacement-host mappings reconstruct portable settings and keep credentials."""
        fstab = self.source_root / "etc" / "fstab"
        fstab.parent.mkdir(parents=True, exist_ok=True)
        fstab.write_text(
            "old-nas:/models /srv/models nfs4 rw,noauto,x-systemd.automount 0 0\n",
            encoding="utf-8",
        )
        gdm = self.source_root / "etc" / "gdm3" / "custom.conf"
        gdm.parent.mkdir(parents=True)
        gdm.write_text("[daemon]\nAutomaticLogin=llama-kiosk\n", encoding="utf-8")
        account = (
            self.source_root
            / "var"
            / "lib"
            / "AccountsService"
            / "users"
            / "llama-kiosk"
        )
        account.parent.mkdir(parents=True)
        account.write_text("[User]\nUserName=llama-kiosk\nSession=llama-kiosk\n", encoding="utf-8")
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "source-host",
            "--timestamp",
            "20260714T120700Z",
        )
        target_root = self.base / "replacement"
        target_config = target_root / "etc" / "llama-manager" / "config.json"
        target_config.parent.mkdir(parents=True)
        target_config.write_text(
            json.dumps({"modelsDir": "/old", "HF_TOKEN": "replacement-secret"}),
            encoding="utf-8",
        )
        target_fstab = target_root / "etc" / "fstab"
        target_fstab.parent.mkdir(parents=True, exist_ok=True)
        target_fstab.write_text("UUID=new-root / ext4 defaults 0 1\n", encoding="utf-8")

        self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--categories",
            "manager,kiosk,storage",
            "--hostname",
            "replacement-host",
            "--map",
            "host.hostname=replacement-host",
            "--map",
            "storage.models_dir=/mnt/ai-models",
            "--map",
            "nfs.0.source=new-nas:/ai-models",
            "--map",
            "nfs.0.mountpoint=/mnt/ai-models",
            "--map",
            "kiosk.user=llama-kiosk-new",
            "--timestamp",
            "20260714T120800Z",
        )

        restored = json.loads(target_config.read_text(encoding="utf-8"))
        self.assertEqual("/mnt/ai-models", restored["modelsDir"])
        self.assertEqual("replacement-secret", restored["HF_TOKEN"])
        target_gdm = target_root / "etc" / "gdm3" / "custom.conf"
        self.assertIn("AutomaticLogin=llama-kiosk-new", target_gdm.read_text())
        mapped_account = (
            target_root
            / "var"
            / "lib"
            / "AccountsService"
            / "users"
            / "llama-kiosk-new"
        )
        self.assertTrue(mapped_account.is_file())
        self.assertIn("UserName=llama-kiosk-new", mapped_account.read_text())
        self.assertFalse(
            (
                target_root
                / "var"
                / "lib"
                / "AccountsService"
                / "users"
                / "llama-kiosk"
            ).exists()
        )
        restored_fstab = target_fstab.read_text(encoding="utf-8")
        self.assertIn("UUID=new-root / ext4 defaults 0 1", restored_fstab)
        self.assertIn(
            "new-nas:/ai-models /mnt/ai-models nfs4 rw,noauto,x-systemd.automount 0 0",
            restored_fstab,
        )
        self.assertNotIn("old-nas", restored_fstab)

    def test_restore_preserves_complete_target_value_for_redacted_boot_arguments(self) -> None:
        """Platform restore keeps the whole target value when the source was redacted."""
        source_grub = self.source_root / "etc" / "default" / "grub"
        source_grub.parent.mkdir(parents=True)
        source_grub.write_text(
            'GRUB_CMDLINE_LINUX="recovery_password=source-secret amdgpu.gttsize=126976"\n'
        )
        backup = self.run_cli(
            "--root",
            str(self.source_root),
            "backup",
            "--output-dir",
            str(self.output),
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T120900Z",
        )
        target_root = self.base / "target"
        target_grub = target_root / "etc" / "default" / "grub"
        target_grub.parent.mkdir(parents=True)
        target_grub.write_text(
            'GRUB_CMDLINE_LINUX="recovery_password=target-secret quiet"\n'
        )

        self.run_cli(
            "--root",
            str(target_root),
            "restore",
            backup.stdout.strip(),
            "--categories",
            "platform",
            "--hostname",
            "same-host",
            "--timestamp",
            "20260714T121000Z",
        )

        restored = target_grub.read_text(encoding="utf-8")
        self.assertIn("recovery_password=target-secret", restored)
        self.assertNotIn("[REDACTED]", restored)
        self.assertIn("quiet", restored)
        self.assertNotIn("amdgpu.gttsize=126976", restored)


if __name__ == "__main__":
    unittest.main()
