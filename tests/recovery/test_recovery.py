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

import json
from pathlib import Path
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

    def run_cli(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        """Run the recovery CLI and return its captured process result.

        Args:
            *args: Arguments supplied after the CLI executable.
            check: Raise when the command exits unsuccessfully.

        Returns:
            The completed subprocess with text output captured.
        """
        return subprocess.run(
            [str(CLI), *args],
            check=check,
            text=True,
            capture_output=True,
        )

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
        copied_config = bundle / "files" / "etc" / "llama-manager" / "config.json"
        self.assertTrue(copied_config.is_file())
        self.assertNotIn("hf_super_secret_value", copied_config.read_text(encoding="utf-8"))
        self.assertEqual("[REDACTED]", json.loads(copied_config.read_text())["HF_TOKEN"])
        self.assertFalse((bundle / "files" / "home").exists())
        self.assertFalse((bundle / "files" / "srv" / "models").exists())

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
        self.assertIn("recovery_password=[REDACTED]", captured)
        self.assertIn("amdgpu.gttsize=126976", captured)

    def test_backup_records_portable_nfs_and_platform_manifests(self) -> None:
        """Backup describes mounts and platform pins without copying model blobs."""
        fstab = self.source_root / "etc" / "fstab"
        fstab.parent.mkdir(parents=True, exist_ok=True)
        fstab.write_text(
            "UUID=host-specific / ext4 defaults 0 1\n"
            "nas.lan:/models /srv/models nfs4 rw,noauto,x-systemd.automount 0 0\n",
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
                    "options": ["rw", "noauto", "x-systemd.automount"],
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
        restored_fstab = target_fstab.read_text(encoding="utf-8")
        self.assertIn("UUID=new-root / ext4 defaults 0 1", restored_fstab)
        self.assertIn(
            "new-nas:/ai-models /mnt/ai-models nfs4 rw,noauto,x-systemd.automount 0 0",
            restored_fstab,
        )
        self.assertNotIn("old-nas", restored_fstab)

    def test_restore_preserves_target_secret_embedded_in_boot_arguments(self) -> None:
        """Platform restore reuses target secret values behind redaction markers."""
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
        self.assertIn("amdgpu.gttsize=126976", restored)


if __name__ == "__main__":
    unittest.main()
