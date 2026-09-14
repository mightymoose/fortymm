"""Validate a release record against Git without importing historical code."""

import ast
import re
import subprocess
from pathlib import Path

from alembic.script.revision import Revision, RevisionError, RevisionMap

METADATA = {"revision", "down_revision", "depends_on", "branch_labels"}


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"Release Git check failed: {result.stderr.strip()}"
    return result.stdout


def static_revision(source: str, path: str) -> Revision:
    metadata: dict[str, str | tuple[str, ...] | None] = {}
    for node in ast.parse(source, filename=path).body:
        value: ast.expr | None
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
            value = node.value
        else:
            continue
        for target in targets:
            if not isinstance(target, ast.Name) or target.id not in METADATA:
                continue
            name = target.id
            assert name not in metadata, f"Repeated migration metadata {name}: {path}"
            assert value is not None, f"Missing migration metadata {name}: {path}"
            try:
                literal = ast.literal_eval(value)
            except (ValueError, TypeError) as error:
                raise AssertionError(
                    f"Nonliteral migration metadata: {path}"
                ) from error
            if isinstance(literal, list):
                literal = tuple(literal)
            assert (
                literal is None
                or isinstance(literal, str)
                or (
                    isinstance(literal, tuple)
                    and all(isinstance(item, str) for item in literal)
                )
            ), f"Invalid migration metadata {name}: {path}"
            metadata[name] = literal
    assert "revision" in metadata and "down_revision" in metadata, path
    revision = metadata["revision"]
    assert isinstance(revision, str) and revision, path
    return Revision(
        revision,
        metadata["down_revision"],
        dependencies=metadata.get("depends_on"),
        branch_labels=metadata.get("branch_labels"),
    )


def verify_release_commit(repo: Path, commit: str, revision: str) -> None:
    """The exact historical commit must be an ancestor with this sole schema head.

    Read blobs from Git and parse only literal Alembic metadata. Never check out,
    import or execute the historical migrations, env.py, or application code.
    Full Git history is required; missing objects fail closed.
    """
    assert re.fullmatch(r"[0-9a-f]{40}", commit), "Expected a full release commit SHA"
    assert git(repo, "cat-file", "-t", commit).strip() == "commit", (
        "Release reference must name a commit object"
    )
    git(repo, "merge-base", "--is-ancestor", commit, "HEAD")
    entries = git(repo, "ls-tree", "-rz", commit, "--", "api/migrations/versions")
    current_entries = git(
        repo, "ls-tree", "-rz", "HEAD", "--", "api/migrations/versions"
    )
    current = {
        entry.split("\t", 1)[1]: entry.split("\t", 1)[0]
        for entry in current_entries.split("\0")
        if entry
    }
    revisions = []
    for entry in entries.split("\0"):
        if not entry:
            continue
        attributes, path = entry.split("\t", 1)
        if not path.endswith(".py") or Path(path).name == "__init__.py":
            continue
        mode, kind, object_id = attributes.split()
        assert mode in {"100644", "100755"} and kind == "blob", (
            f"Historical migration is not a regular file: {path}"
        )
        assert current.get(path) == attributes, (
            f"Release migration differs from immutable current history: {path}"
        )
        revisions.append(
            static_revision(git(repo, "cat-file", "blob", object_id), path)
        )
    assert revisions, "Release commit has no migration revisions"
    ids = {item.revision for item in revisions}
    assert len(ids) == len(revisions), "Duplicate historical migration revision"
    # Alembic validates references and cycles from these inert Revision objects;
    # this does not load or execute migration modules.
    graph = RevisionMap(lambda: iter(revisions))
    try:
        heads = graph.heads
    except (RevisionError, KeyError) as error:
        raise AssertionError("Invalid historical migration graph") from error
    assert heads == (revision,), (
        f"Release commit migration heads {heads} do not match {revision}"
    )
