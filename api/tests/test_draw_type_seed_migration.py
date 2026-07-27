"""The one test in the suite that actually runs Alembic.

Everything else builds its schema with ``Base.metadata.create_all`` (see the
``engine`` fixture in ``conftest.py``), so the migrations are entirely
unexercised: deleting migration 0010's whole ``op.bulk_insert`` of
``draw_types`` leaves the rest of the suite green. That is the hole this file
closes, and it is the guard the ADR "a draw type is a seeded row, and the enum
holds only what runs" promises.

The claim under test is the ADR's central one: **a row in ``draw_types`` means
"this draw type has an implementation"**, so the ``key`` set a migrated database
ends up with must equal ``{t.value for t in DrawType}`` — the closed set the code
dispatches on. The seed lives in two hardcoded places (the migration, which by
design cannot import app code, and ``conftest.DRAW_TYPE_SEED``) and nothing
compared either to the enum until now.

**Where the database comes from.** Migrating the suite's own database would
prove nothing — it is already fully built by ``create_all``, so ``upgrade head``
would either collide or no-op. So this creates a *separate, brand-new* database
on the same Postgres server the suite already has (testcontainer, or whatever
``TEST_DATABASE_URL`` points at), asserts it is genuinely empty, and migrates
that. The main ``db_session`` database is never touched and no extra container
is started.

**Alembic runs as a subprocess**, not via ``alembic.command``: ``migrations/env.py``
ends in ``asyncio.run(...)``, which cannot be called from inside pytest-asyncio's
already-running session loop. The subprocess uses ``sys.executable`` — the same
interpreter running pytest, i.e. this checkout's virtualenv — and this
directory's ``alembic.ini``, so what gets migrated is provably the working tree's
migrations and not some other checkout's.

**Cost:** a full ``upgrade head`` runs *once per session* (session-scoped
fixtures), not once per test. There is no slow/integration marker convention in
this repo — no ``markers`` in ``[tool.pytest.ini_options]`` and no
``pytest.mark.slow`` anywhere in ``tests/`` — so this file deliberately adds
none rather than inventing one.
"""

import os
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.models import DrawType

# ``tests/`` lives directly under the api package root, next to alembic.ini and
# migrations/. Deriving both from __file__ is what pins the migrations under
# test to *this* worktree.
API_ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_INI = API_ROOT / "alembic.ini"

# A database of our own, so the suite's create_all-built one is untouched.
MIGRATION_DATABASE = "fortymm_migration_check"


async def _drop_database(admin_url: str) -> None:
    """DROP the scratch database, forcing off any lingering backend.

    ``WITH (FORCE)`` (Postgres 13+) rather than a polite drop: alembic ran in a
    subprocess we do not own the connection teardown of, and a leaked backend
    would otherwise fail the drop and leak the database into the next run.
    """
    admin = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            await conn.execute(
                sa.text(f'DROP DATABASE IF EXISTS "{MIGRATION_DATABASE}" WITH (FORCE)')
            )
    finally:
        await admin.dispose()


@pytest_asyncio.fixture(scope="session")
async def migrated_database_url(postgres_url: str) -> AsyncIterator[str]:
    """A URL for a database built by ``alembic upgrade head`` and nothing else."""
    await _drop_database(postgres_url)

    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            await conn.execute(sa.text(f'CREATE DATABASE "{MIGRATION_DATABASE}"'))
    finally:
        await admin.dispose()

    url = (
        make_url(postgres_url)
        .set(database=MIGRATION_DATABASE)
        .render_as_string(hide_password=False)
    )

    try:
        # Prove it is empty BEFORE migrating. Without this the test could pass
        # against a database somebody else had already built, which is exactly
        # the "the green run was about a different artifact" failure mode.
        engine = create_async_engine(url)
        try:
            async with engine.connect() as conn:
                pre_existing = (
                    (
                        await conn.execute(
                            sa.text(
                                "SELECT table_name FROM information_schema.tables"
                                " WHERE table_schema = 'public'"
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
        finally:
            await engine.dispose()
        assert not pre_existing, (
            f"scratch database {MIGRATION_DATABASE} was not empty before "
            f"migrating — found {sorted(pre_existing)}. The migration result "
            "would not be attributable to alembic."
        )

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "alembic",
                "-c",
                str(ALEMBIC_INI),
                "upgrade",
                "head",
            ],
            cwd=API_ROOT,
            env={**os.environ, "DATABASE_URL": url},
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, (
            "`alembic upgrade head` failed against a fresh empty database "
            f"(exit {result.returncode}).\n"
            f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
        )

        yield url
    finally:
        await _drop_database(postgres_url)


@pytest_asyncio.fixture(scope="session")
async def seeded_draw_types(
    migrated_database_url: str,
) -> list[sa.Row[tuple[str, str, str, int]]]:
    """The ``draw_types`` rows a migrated database ends up with.

    Read with raw SQL rather than through ``DrawTypeOption``: the subject is what
    the *migration* produced, and naming the columns explicitly also asserts the
    migration created them.
    """
    engine = create_async_engine(migrated_database_url)
    try:
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    sa.text(
                        "SELECT key, name, description, display_order FROM draw_types"
                    )
                )
            ).all()
    finally:
        await engine.dispose()
    return list(rows)


async def test_migration_seeds_exactly_the_draw_types_the_code_dispatches(
    seeded_draw_types: list[sa.Row[tuple[str, str, str, int]]],
) -> None:
    """The central claim: seeded rows == ``DrawType`` members, both ways.

    A missing row means a draw type the code can run has no lookup row, so the
    FK on the event's draw settings rejects it. An extra row means the table
    offers a director a draw type ``strategy_for`` cannot dispatch — precisely
    the "discovers at cut time it was never possible" defect the ADR exists to
    remove.
    """
    seeded = {row.key for row in seeded_draw_types}
    expected = {draw_type.value for draw_type in DrawType}

    missing = sorted(expected - seeded)
    unbacked = sorted(seeded - expected)
    assert seeded == expected, (
        "migration 0010's draw_types seed has drifted from the DrawType enum. "
        f"DrawType members with no seeded row: {missing or 'none'}. "
        f"Seeded rows with no DrawType member: {unbacked or 'none'}. "
        f"(seeded={sorted(seeded)}, enum={sorted(expected)})"
    )


async def test_every_seeded_draw_type_carries_picker_copy(
    seeded_draw_types: list[sa.Row[tuple[str, str, str, int]]],
) -> None:
    """``name`` and ``description`` are rendered to directors as the picker's
    label and help text, so a blank one is a blank option on screen."""
    assert seeded_draw_types, "migration 0010 seeded no draw_types rows at all"

    blank = sorted(
        row.key
        for row in seeded_draw_types
        if not (row.name or "").strip() or not (row.description or "").strip()
    )
    assert not blank, (
        f"seeded draw_types rows with a blank name or description: {blank}. "
        "Both are rendered in the director's draw-type picker."
    )


async def test_seeded_draw_types_have_distinct_display_orders(
    seeded_draw_types: list[sa.Row[tuple[str, str, str, int]]],
) -> None:
    """Duplicate ``display_order`` values leave the picker's order up to the
    database, which is a real defect and an intermittent one."""
    assert seeded_draw_types, "migration 0010 seeded no draw_types rows at all"

    orders = [row.display_order for row in seeded_draw_types]
    duplicated = sorted({order for order in orders if orders.count(order) > 1})
    assert len(set(orders)) == len(orders), (
        f"seeded draw_types share display_order values {duplicated}, so the "
        "picker's order is undefined. "
        f"(key -> display_order: "
        f"{ {row.key: row.display_order for row in seeded_draw_types} })"
    )
