#!/usr/bin/env python3
"""Enforce the beta migration freeze against a trusted, full-history base commit.

CI runs the base commit's copy of this file, so a checker improvement cannot
permit a migration rewrite in the same PR. The first freeze uses --bootstrap.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

MANIFEST = "api/migrations/beta-baseline.json"
VERSIONS = "api/migrations/versions/"
BASELINE_FIXTURE = "api/tests/fixtures/beta-0001.json"


def git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, check=False
    )
    if result.returncode:
        raise ValueError(
            f"git {' '.join(args)} failed: {result.stderr.decode().strip()}"
        )
    return result.stdout


def files_at(repo: Path, commit: str) -> list[str]:
    return [
        path.decode()
        for path in git(
            repo, "ls-tree", "-r", "--name-only", "-z", commit, VERSIONS
        ).split(b"\0")
        if path
    ]


def read_candidate(repo: Path, path: str) -> bytes:
    # is_symlink() on the leaf alone follows symlinked parents. A moved
    # versions directory must not hide revisions from later Git tree scans.
    target = repo
    for component in Path(path).parts:
        target = target / component
        if target.is_symlink():
            raise ValueError(f"Frozen file missing or not a regular file: {path}")
    if not target.is_file():
        raise ValueError(f"Frozen file missing or not a regular file: {path}")
    return target.read_bytes()


def check(repo: Path, base: str, bootstrap: bool) -> None:
    # Require a real full SHA, not an option, expression, or moving branch name.
    if not re.fullmatch(r"[0-9a-f]{40}", base) or base == "0" * 40:
        raise ValueError("A nonzero full trusted base SHA is required")
    git(repo, "cat-file", "-e", f"{base}^{{commit}}")
    # Checkout must contain the current target base (CI uses the PR merge commit).
    # A stale feature checkout cannot silently omit migrations newly on main.
    git(repo, "merge-base", "--is-ancestor", base, "HEAD")
    base_paths = (
        git(repo, "ls-tree", "-r", "--name-only", base, MANIFEST).decode().splitlines()
    )
    frozen = MANIFEST in base_paths
    if not frozen and not bootstrap:
        raise ValueError(
            "Base has no freeze manifest; initial freeze requires --bootstrap"
        )
    if frozen and bootstrap:
        raise ValueError("--bootstrap is forbidden after the freeze has merged")

    candidate_manifest = read_candidate(repo, MANIFEST)
    if frozen and candidate_manifest != git(repo, "show", f"{base}:{MANIFEST}"):
        raise ValueError("Frozen baseline manifest changed; it must remain immutable")
    manifest = json.loads(candidate_manifest)
    hashes = manifest.get("files")
    source = manifest.get("source_commit")
    if not isinstance(hashes, dict) or not hashes:
        raise ValueError("Baseline manifest must contain a nonempty files map")
    if not isinstance(manifest.get("revision"), str) or not manifest["revision"]:
        raise ValueError("Baseline manifest must identify its revision")
    if not isinstance(source, str) or not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("Baseline manifest requires a full source_commit SHA")
    git(repo, "cat-file", "-e", f"{source}^{{commit}}")
    git(repo, "merge-base", "--is-ancestor", source, base)
    if set(hashes) != set(files_at(repo, source)):
        raise ValueError(
            "Baseline files must exactly match the source commit's migrations"
        )
    for path, expected in hashes.items():
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError(f"Invalid SHA-256 for {path}")
        original = git(repo, "show", f"{source}:{path}")
        if hashlib.sha256(original).hexdigest() != expected:
            raise ValueError(f"Baseline source checksum mismatch: {path}")
        if hashlib.sha256(read_candidate(repo, path)).hexdigest() != expected:
            raise ValueError(f"Baseline checksum mismatch: {path}")

    # Gitlinks look like ordinary directories on disk, but ls-tree includes
    # them as commit objects. Reject them in the candidate index before they
    # become impossible-to-read frozen entries on main. In CI the checkout index
    # is the candidate merge tree; locally this also checks staged additions.
    protected = (MANIFEST, BASELINE_FIXTURE, VERSIONS.rstrip("/"))
    # Include ancestor entries too: an initialized submodule replacing api/ or
    # migrations/ can expose identical files while hiding them from the index.
    for entry in git(repo, "ls-files", "--stage", "-z", "--", "api").split(b"\0"):
        if not entry:
            continue
        attributes, indexed_path = entry.decode().split("\t", 1)
        concerns_frozen_paths = indexed_path.startswith(VERSIONS) or any(
            path == indexed_path or path.startswith(indexed_path + "/")
            for path in protected
        )
        if not concerns_frozen_paths:
            continue
        mode, _, stage = attributes.split()
        if mode not in {"100644", "100755"} or stage != "0":
            raise ValueError(
                f"Migration path has non-regular Git mode or unresolved stage: {indexed_path}"
            )

    # New revisions must also be real files before they become frozen. Otherwise
    # a symlink could merge once and make every subsequent freeze check fail.
    for candidate in (repo / VERSIONS).rglob("*"):
        if candidate.is_symlink():
            raise ValueError(
                f"Migration path is not a regular file: {candidate.relative_to(repo)}"
            )

    fixture_paths = (
        git(repo, "ls-tree", "-r", "--name-only", base, BASELINE_FIXTURE)
        .decode()
        .splitlines()
    )
    for path in [*files_at(repo, base), *fixture_paths]:
        if read_candidate(repo, path) != git(repo, "show", f"{base}:{path}"):
            raise ValueError(
                f"Frozen migration or fixture already on main was changed: {path}"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base", required=True, help="Trusted target branch commit SHA"
    )
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args()
    try:
        check(args.repo.resolve(), args.base, args.bootstrap)
    except (ValueError, OSError, TypeError, AttributeError) as error:
        print(f"Migration freeze check failed: {error}", file=sys.stderr)
        return 1
    print("Migration freeze check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
