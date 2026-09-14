"""Run with unittest for Git-only validation without the database fixtures."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests._released_schema import verify_release_commit, verify_release_record


class ReleasedSchemaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.com")
        self.git("config", "user.name", "Release fixture")
        self.versions = self.repo / "api/migrations/versions"
        self.versions.mkdir(parents=True)
        self.write_revision("0001", None)
        self.baseline = self.commit()

    def git(self, *args):
        result = subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True,
            text=True,
            capture_output=True,
        )
        return result.stdout.strip()

    def write_revision(self, revision, parent, *, suffix=""):
        path = self.versions / f"{revision}{suffix}.py"
        path.write_text(
            f"revision: str = {revision!r}\ndown_revision = {parent!r}\n"
            "branch_labels = None\ndepends_on = None\n"
        )
        return path

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "Synthetic schema revision")
        return self.git("rev-parse", "HEAD")

    def test_exact_historical_head_can_precede_current_head(self):
        self.write_revision("0002", "0001")
        current = self.commit()
        verify_release_commit(self.repo, self.baseline, "0001")
        verify_release_commit(self.repo, current, "0002")

    def test_commit_with_wrong_recorded_revision_fails(self):
        with self.assertRaisesRegex(AssertionError, "do not match"):
            verify_release_commit(self.repo, self.baseline, "0002")

    def test_missing_commit_fails(self):
        with self.assertRaisesRegex(AssertionError, "Git check failed"):
            verify_release_commit(self.repo, "f" * 40, "0001")

    def test_existing_blob_is_not_a_commit(self):
        blob = self.git("rev-parse", "HEAD:api/migrations/versions/0001.py")
        with self.assertRaisesRegex(AssertionError, "commit object"):
            verify_release_commit(self.repo, blob, "0001")

    def test_unrelated_commit_with_same_schema_fails(self):
        orphan = self.git("commit-tree", "HEAD^{tree}", "-m", "Unrelated history")
        with self.assertRaisesRegex(AssertionError, "Git check failed"):
            verify_release_commit(self.repo, orphan, "0001")

    def test_multiple_historical_heads_fail(self):
        self.write_revision("0002", "0001")
        self.write_revision("0003", "0001")
        with self.assertRaisesRegex(AssertionError, "do not match"):
            verify_release_commit(self.repo, self.commit(), "0002")

    def test_merged_heads_resolve_like_alembic(self):
        self.write_revision("0002", "0001")
        self.write_revision("0003", "0001")
        self.write_revision("0004", ("0002", "0003"))
        verify_release_commit(self.repo, self.commit(), "0004")

    def test_duplicate_revision_fails(self):
        self.write_revision("0001", None, suffix="_duplicate")
        with self.assertRaisesRegex(AssertionError, "Duplicate"):
            verify_release_commit(self.repo, self.commit(), "0001")

    def test_historical_python_is_never_executed(self):
        path = self.write_revision("0002", "0001")
        with path.open("a") as output:
            output.write("raise RuntimeError('historical code executed')\n")
        verify_release_commit(self.repo, self.commit(), "0002")

    def test_computed_revision_fails_without_evaluating_it(self):
        path = self.write_revision("0002", "0001")
        path.write_text("revision = run_arbitrary_code()\ndown_revision = '0001'\n")
        with self.assertRaisesRegex(AssertionError, "Nonliteral"):
            verify_release_commit(self.repo, self.commit(), "0002")

    def test_symlinked_historical_migration_fails(self):
        (self.versions / "0002.py").symlink_to("0001.py")
        with self.assertRaisesRegex(AssertionError, "not a regular file"):
            verify_release_commit(self.repo, self.commit(), "0001")

    def test_old_rewritten_revision_id_is_not_release_provenance(self):
        path = self.versions / "0001.py"
        with path.open("a") as output:
            output.write("# Schema was rewritten before the freeze\n")
        self.commit()
        with self.assertRaisesRegex(AssertionError, "differs from immutable"):
            verify_release_commit(self.repo, self.baseline, "0001")

    def test_missing_parent_fails(self):
        self.write_revision("0002", "missing")
        with self.assertWarns(UserWarning):
            with self.assertRaisesRegex(AssertionError, "Invalid historical"):
                verify_release_commit(self.repo, self.commit(), "0002")

    def test_historical_cycle_fails(self):
        self.write_revision("0002", "0003")
        self.write_revision("0003", "0002")
        with self.assertRaisesRegex(AssertionError, "Invalid historical"):
            verify_release_commit(self.repo, self.commit(), "0001")

    def test_literal_list_parents_are_supported(self):
        self.write_revision("0002", "0001")
        self.write_revision("0003", "0001")
        self.write_revision("0004", ["0002", "0003"])
        verify_release_commit(self.repo, self.commit(), "0004")

    def record(self, commit, revision="0001", status="released"):
        return {"revision": revision, "status": status, "release_commit": commit}

    def record_base(self, record):
        (self.repo / "api/migrations/released-schema.json").write_text(
            json.dumps(record)
        )
        return self.commit()

    def test_initial_record_can_advance_to_first_release(self):
        base = self.record_base(self.record(None, status="initial-beta-candidate"))
        self.assertEqual(
            verify_release_record(self.repo, base, self.record(self.baseline), "0001"),
            "0001",
        )

    def test_released_record_cannot_return_to_candidate(self):
        base = self.record_base(self.record(self.baseline))
        with self.assertRaisesRegex(AssertionError, "cannot return"):
            verify_release_record(
                self.repo,
                base,
                self.record(None, status="initial-beta-candidate"),
                "0001",
            )

    def test_release_record_cannot_point_to_older_commit_with_same_schema(self):
        (self.repo / "app-version").write_text("new application")
        newer = self.commit()
        base = self.record_base(self.record(newer))
        with self.assertRaisesRegex(AssertionError, "Git check failed"):
            verify_release_record(self.repo, base, self.record(self.baseline), "0001")

    def test_release_record_can_advance_and_stay_unchanged(self):
        base = self.record_base(self.record(self.baseline))
        verify_release_record(self.repo, base, self.record(self.baseline), "0001")
        self.write_revision("0002", "0001")
        newer = self.commit()
        verify_release_record(self.repo, base, self.record(newer, "0002"), "0001")

    def test_later_commit_cannot_record_temporarily_downgraded_schema(self):
        path = self.write_revision("0002", "0001")
        old_release = self.commit()
        base = self.record_base(self.record(old_release, "0002"))
        path.unlink()
        downgrade = self.commit()
        self.write_revision("0002", "0001")
        self.commit()
        with self.assertRaisesRegex(AssertionError, "cannot move backward"):
            verify_release_record(self.repo, base, self.record(downgrade), "0001")

    def test_missing_release_record_on_frozen_base_fails(self):
        (self.repo / "api/migrations/beta-baseline.json").write_text("{}")
        base = self.commit()
        with self.assertRaisesRegex(AssertionError, "missing its release record"):
            verify_release_record(
                self.repo,
                base,
                self.record(None, status="initial-beta-candidate"),
                "0001",
            )
