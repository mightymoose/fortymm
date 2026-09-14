"""Behavioral freeze checks against disposable git repositories; no database needed."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHECKER = Path(__file__).resolve().parents[1] / "check-migration-history.py"
MANIFEST = "api/migrations/beta-baseline.json"
BASELINE = "api/migrations/versions/0001_baseline.py"
FORWARD = "api/migrations/versions/0002_forward.py"


class MigrationHistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.email", "freeze-test@example.invalid")
        self.git("config", "user.name", "Freeze test")
        self.write(BASELINE, "revision = 'baseline'\ndown_revision = None\n")
        self.source = self.commit("pre-freeze")
        content = (self.repo / BASELINE).read_bytes()
        self.manifest = {
            "revision": "baseline",
            "source_commit": self.source,
            "files": {BASELINE: hashlib.sha256(content).hexdigest()},
        }
        self.write(MANIFEST, json.dumps(self.manifest))

    def git(self, *args):
        return (
            subprocess.check_output(["git", "-C", str(self.repo), *args])
            .decode()
            .strip()
        )

    def write(self, path, value):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def run_check(self, base, bootstrap=False, checker=CHECKER):
        args = [sys.executable, str(checker), "--repo", str(self.repo), "--base", base]
        if bootstrap:
            args.append("--bootstrap")
        return subprocess.run(args, capture_output=True, text=True)

    def assert_passes(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_fails(self, result, message):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)

    def test_bootstrap_requires_explicit_flag(self):
        self.assert_fails(self.run_check(self.source), "requires --bootstrap")
        self.assert_passes(self.run_check(self.source, bootstrap=True))

    def test_bootstrap_catches_changed_baseline_and_forged_checksum(self):
        self.write(BASELINE, "rewritten\n")
        self.assert_fails(
            self.run_check(self.source, True), "Baseline checksum mismatch"
        )
        self.manifest["files"][BASELINE] = hashlib.sha256(b"rewritten\n").hexdigest()
        self.write(MANIFEST, json.dumps(self.manifest))
        self.assert_fails(self.run_check(self.source, True), "source checksum mismatch")

    def test_bootstrap_cannot_omit_source_migrations(self):
        self.write(FORWARD, "revision = 'forward'\ndown_revision = 'baseline'\n")
        (self.repo / MANIFEST).unlink()
        source = self.commit("pre-freeze second migration")
        self.manifest["source_commit"] = source
        self.write(MANIFEST, json.dumps(self.manifest))
        self.assert_fails(self.run_check(source, True), "exactly match")

    def test_manifest_cannot_be_changed_deleted_or_bootstrapped_again(self):
        base = self.commit("freeze")
        self.assert_fails(self.run_check(base, True), "forbidden")
        self.write(MANIFEST, json.dumps(self.manifest, indent=2))
        self.assert_fails(self.run_check(base), "manifest changed")
        (self.repo / MANIFEST).unlink()
        self.assert_fails(self.run_check(base), "missing")

    def test_forward_migration_allowed_then_immutable_after_merge(self):
        base = self.commit("freeze")
        self.write(FORWARD, "revision = 'forward'\ndown_revision = 'baseline'\n")
        self.assert_passes(self.run_check(base))
        merged = self.commit("new forward migration")
        self.assert_passes(self.run_check(merged))
        self.write(FORWARD, "rewritten\n")
        self.assert_fails(self.run_check(merged), "already on main was changed")

    def test_baseline_fixture_cannot_be_rewritten_after_merge(self):
        fixture = "api/tests/fixtures/beta-0001.json"
        self.write(fixture, '{"identity": "historical"}\n')
        base = self.commit("freeze with historical data")
        self.write(fixture, '{"identity": "replacement"}\n')
        self.assert_fails(self.run_check(base), "fixture already on main was changed")
        (self.repo / fixture).unlink()
        self.assert_fails(self.run_check(base), "missing")

    def test_deletion_rename_and_symlink_rejected(self):
        base = self.commit("freeze")
        target = self.repo / BASELINE
        original = target.read_text()
        target.unlink()
        self.assert_fails(self.run_check(base), "missing")
        self.write(BASELINE + ".renamed", original)
        self.assert_fails(self.run_check(base), "missing")
        target.symlink_to(target.name + ".renamed")
        self.assert_fails(self.run_check(base), "not a regular file")

    def test_symlinked_parent_directories_cannot_hide_frozen_files(self):
        fixture = "api/tests/fixtures/beta-0001.json"
        self.write(fixture, "{}\n")
        base = self.commit("freeze with fixture")
        for parent in (
            "api/migrations/versions",
            "api/migrations",
            "api",
            "api/tests/fixtures",
            "api/tests",
        ):
            with self.subTest(parent=parent):
                directory = self.repo / parent
                moved = directory.with_name(directory.name + "-moved")
                directory.rename(moved)
                directory.symlink_to(moved.name, target_is_directory=True)
                try:
                    self.assert_fails(self.run_check(base), "not a regular file")
                finally:
                    directory.unlink()
                    moved.rename(directory)

    def test_new_migration_symlink_is_rejected_before_it_can_merge(self):
        base = self.commit("freeze")
        self.write("forward.py", "revision = 'forward'\ndown_revision = 'baseline'\n")
        (self.repo / FORWARD).symlink_to(self.repo / "forward.py")
        self.assert_fails(self.run_check(base), "not a regular file")

    def test_new_gitlink_is_rejected_before_it_can_freeze(self):
        base = self.commit("freeze")
        path = "api/migrations/versions/external"
        (self.repo / path).mkdir()
        self.git("update-index", "--add", "--cacheinfo", f"160000,{base},{path}")
        self.assert_fails(self.run_check(base), "non-regular Git mode")
        # Match CI's committed checkout as well as the staged local change.
        self.git("commit", "-qm", "Candidate gitlink")
        self.assert_fails(self.run_check(base), "non-regular Git mode")

    def test_gitlink_parent_cannot_hide_populated_frozen_directories(self):
        self.write("api/tests/fixtures/beta-0001.json", "{}\n")
        base = self.commit("freeze with fixture")
        for parent in (
            "api",
            "api/migrations",
            "api/migrations/versions",
            "api/tests",
            "api/tests/fixtures",
        ):
            with self.subTest(parent=parent):
                # Leave the files on disk to model an initialized submodule.
                self.git("rm", "-r", "--cached", parent)
                self.git(
                    "update-index", "--add", "--cacheinfo", f"160000,{base},{parent}"
                )
                try:
                    self.assert_fails(self.run_check(base), "non-regular Git mode")
                finally:
                    self.git("read-tree", base)

    def test_release_record_cannot_become_a_symlink_or_gitlink(self):
        path = "api/migrations/released-schema.json"
        self.write(
            path,
            '{"revision":"baseline","status":"initial-beta-candidate","release_commit":null}\n',
        )
        base = self.commit("freeze with release record")
        target = self.repo / path
        target.unlink()
        self.write(
            "record.json",
            '{"revision":"baseline","status":"initial-beta-candidate","release_commit":null}\n',
        )
        target.symlink_to("../../record.json")
        self.git("add", path)
        self.assert_fails(self.run_check(base), "non-regular Git mode")
        target.unlink()
        target.mkdir()
        self.git("update-index", "--add", "--cacheinfo", f"160000,{base},{path}")
        self.assert_fails(self.run_check(base), "non-regular Git mode")

    def test_missing_invalid_or_nonancestor_base_fails_closed(self):
        for base in ["", "0" * 40, "f" * 40, "HEAD"]:
            with self.subTest(base=base):
                self.assertNotEqual(self.run_check(base).returncode, 0)
        future = self.commit("freeze")
        self.git("checkout", "-q", self.source)
        self.assert_fails(self.run_check(future), "--is-ancestor")

    def test_trusted_checker_rejects_rewrite_even_if_candidate_checker_bypassed(self):
        checker_path = "scripts/check-migration-history.py"
        self.write(checker_path, CHECKER.read_text())
        base = self.commit("freeze")
        trusted = self.repo / "trusted-checker.py"
        trusted.write_text(self.git("show", f"{base}:{checker_path}") + "\n")
        self.write(checker_path, "raise SystemExit(0)\n")
        self.write(BASELINE, "rewritten\n")
        self.assert_fails(self.run_check(base, checker=trusted), "checksum mismatch")
        self.write(BASELINE, self.git("show", f"{base}:{BASELINE}") + "\n")
        self.assert_passes(self.run_check(base, checker=trusted))


if __name__ == "__main__":
    unittest.main()
