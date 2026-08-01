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
dispatches on. The seed is hardcoded in the migration, which by design cannot
import app code (``conftest.DRAW_TYPE_SEED`` now reads it back out of that
migration by path rather than re-typing it), and nothing compared it to the enum
until now.

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
from sqlalchemy.exc import IntegrityError
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


async def test_migration_creates_the_qualifiers_per_pool_column(
    migrated_database_url: str,
) -> None:
    """The qualifier count exists, as a NULLABLE integer, on a database built by
    Alembic — not by ``create_all``.

    Worth its own test precisely because ``create_all`` is what the rest of the
    suite runs on: a column added to the model and forgotten in the migration is
    invisible to every other test in this repo and fails on the first real
    deployment (api/CLAUDE.md, "pytest never runs the migrations"). Nullability is
    asserted, not just presence, because ``NULL`` is the whole representation of
    "this draw type takes no qualifier count" — a NOT NULL column would make every
    round-robin row carry a number.
    """
    engine = create_async_engine(migrated_database_url)
    try:
        async with engine.connect() as conn:
            column = (
                await conn.execute(
                    sa.text(
                        "SELECT data_type, is_nullable, column_default"
                        " FROM information_schema.columns"
                        " WHERE table_name = 'tournament_event_draw_settings'"
                        "   AND column_name = 'qualifiers_per_pool'"
                    )
                )
            ).one_or_none()
    finally:
        await engine.dispose()

    assert column is not None, (
        "migrated database has no tournament_event_draw_settings.qualifiers_per_pool"
        " column — the model has it and create_all builds it, so the whole suite is"
        " green without the migration"
    )
    assert column.data_type == "integer", column
    assert column.is_nullable == "YES", column
    assert column.column_default is None, column


# Every ``(draw_type_key, qualifiers_per_pool)`` pair the CHECK has an opinion
# about, and the opinion. Written as data so the test below reports the WHOLE
# outcome table on a failure rather than dying at the first disagreement — a
# constraint that has lost one arm and a constraint that was never created look
# very different here, and that difference is the finding.
#
# ``count`` is SQL text, not a bound parameter, because ``NULL`` is one of the
# values under test and a bound ``None`` would be indistinguishable from the
# literal in the failure message. The values are this module's own constants and
# never touch user input.
QUALIFIER_COUNT_CASES: list[tuple[str, str, bool]] = [
    # No other draw type may carry a count at all: there is no cut to size for a
    # round-robin, and no pools to cut from for a single-elim. Both are asked,
    # because a constraint that had lost one of them looks identical on a
    # one-slug test.
    ("round-robin", "2", False),
    ("single-elim", "2", False),
    # ...and NULL is how they say so. This is the arm the verifier's `ELSE TRUE`
    # corruption destroys while leaving everything else intact.
    ("round-robin", "NULL", True),
    ("single-elim", "NULL", True),
    # ``K >= 1`` is the ADR's static bound: zero advances nobody, negative is not
    # a count, and absent leaves the cut with no answer to "how many advance".
    ("rr-then-ko", "0", False),
    ("rr-then-ko", "-1", False),
    ("rr-then-ko", "NULL", False),
    # One qualifier per pool IS legal — two pools at K=1 is a single final
    # between the pool winners, which the ADR names as a supported shape. Without
    # an accepted case the refusals above would also be satisfied by a constraint
    # that rejects everything.
    ("rr-then-ko", "1", True),
    ("rr-then-ko", "2", True),
]


async def test_migration_pairs_the_qualifier_count_with_its_draw_type(
    migrated_database_url: str,
) -> None:
    """What the CHECK **does** on a migrated database, not what its text says.

    An earlier version of this test asserted only that ``rr-then-ko`` and
    ``qualifiers_per_pool`` appeared in ``pg_get_constraintdef``. That caught a
    *missing* constraint but not a *wrong* one: corrupting the migration's ``ELSE
    qualifiers_per_pool IS NULL`` to ``ELSE TRUE`` — keeping the ``THEN`` arm,
    keeping the model correct — left this file green while shipping a database
    that happily stores ``round-robin`` with two qualifiers. A wrong constraint is
    the *likelier* mistake the next time someone edits migration 0010, since the
    edit-in-place convention means that expression gets rewritten rather than
    replaced.

    So every case in :data:`QUALIFIER_COUNT_CASES` is actually attempted, and it
    is the accept/reject outcome that is asserted. That also makes the test
    immune to Postgres re-rendering the expression (it already normalises
    ``'rr-then-ko'`` to ``'rr-then-ko'::text`` and adds its own parentheses).

    The model's copy of this rule is exercised by
    ``test_tournament_event_draw_settings.py`` against a ``create_all`` schema.
    This is the same questions asked of the schema **Alembic** built — which is
    the only way the two descriptions can be shown to agree.

    Every slug the cases name — ``rr-then-ko`` included, since #1227 seeded it —
    is a row the migration itself inserted, so the settings rows below FK against
    the real seed rather than a test-local stand-in. Everything runs inside one
    transaction that is **rolled back**, so the session-scoped migrated database
    is left exactly as Alembic made it and the seed assertions in this file
    cannot be affected by test ordering.
    """
    engine = create_async_engine(migrated_database_url)
    outcomes: dict[tuple[str, str], bool] = {}
    try:
        conn = await engine.connect()
        try:
            transaction = await conn.begin()
            try:
                for slug, count, _ in QUALIFIER_COUNT_CASES:
                    statement = sa.text(
                        "INSERT INTO tournament_event_draw_settings"
                        " (draw_type_key, qualifiers_per_pool)"
                        f" VALUES (:slug, {count})"
                    )
                    try:
                        # A SAVEPOINT per case: a refused INSERT poisons the
                        # enclosing transaction, so without one the first
                        # rejection would abort every case after it and the
                        # outcome table would be a lie.
                        async with conn.begin_nested():
                            await conn.execute(statement, {"slug": slug})
                    except IntegrityError:
                        outcomes[(slug, count)] = False
                    else:
                        outcomes[(slug, count)] = True
            finally:
                await transaction.rollback()
        finally:
            await conn.close()
    finally:
        await engine.dispose()

    expected = {
        (slug, count): accepted for slug, count, accepted in QUALIFIER_COUNT_CASES
    }
    disagreed = {
        case: f"expected {'accepted' if want else 'REFUSED'}, "
        f"got {'accepted' if outcomes[case] else 'REFUSED'}"
        for case, want in expected.items()
        if outcomes[case] != want
    }
    assert not disagreed, (
        "migration 0010's ck_tournament_event_draw_settings_qualifiers_per_pool "
        "does not behave like the model's copy on a migrated database: "
        f"{disagreed}"
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
