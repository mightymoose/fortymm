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
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app.models import DrawType
from app.models.draw_type import DRAW_TYPE_IDS

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
) -> list[sa.Row[tuple[uuid.UUID, str, str, str, int]]]:
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
                        "SELECT id, key, name, description, display_order"
                        " FROM draw_types"
                    )
                )
            ).all()
    finally:
        await engine.dispose()
    return list(rows)


async def test_migration_seeds_exactly_the_draw_types_the_code_dispatches(
    seeded_draw_types: list[sa.Row[tuple[uuid.UUID, str, str, str, int]]],
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


async def test_migration_seeds_the_ids_the_app_writes_settings_rows_with(
    seeded_draw_types: list[sa.Row[tuple[uuid.UUID, str, str, str, int]]],
) -> None:
    """``draw_types.id`` on a migrated database matches
    ``app.models.draw_type.DRAW_TYPE_IDS`` (ADR 20260815, "draw_types gains a
    surrogate id primary key").

    The app never queries for a draw type's id — the settings row's ``draw_type``
    setter writes it straight from that fixed map, with no session in scope (see
    the map's own docstring for why). ``tests/conftest.py``'s autouse fixture now
    seeds its rows from this migration's own ids rather than from the app map, so
    a drift between the two also FK-violates every settings-row write across the
    ``create_all`` suite — but only on a migrated (Alembic-built) database does a
    real deployment feel it, which is what this test is actually checking.
    """
    seeded = {row.key: row.id for row in seeded_draw_types}
    expected = {draw_type.value: id_ for draw_type, id_ in DRAW_TYPE_IDS.items()}

    assert seeded == expected, (
        "migration 0010's draw_types seed ids have drifted from "
        f"app.models.draw_type.DRAW_TYPE_IDS: seeded={seeded}, expected={expected}"
    )


async def test_every_seeded_draw_type_carries_picker_copy(
    seeded_draw_types: list[sa.Row[tuple[uuid.UUID, str, str, str, int]]],
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


async def _draw_settings_column(
    url: str, column_name: str
) -> sa.Row[tuple[str, str, str | None]] | None:
    """One column of ``tournament_event_draw_settings`` as the **migrated** database
    describes it, or ``None`` when the migration did not create it."""
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    sa.text(
                        "SELECT data_type, is_nullable, column_default"
                        " FROM information_schema.columns"
                        " WHERE table_name = 'tournament_event_draw_settings'"
                        "   AND column_name = :column_name"
                    ),
                    {"column_name": column_name},
                )
            ).one_or_none()
    finally:
        await engine.dispose()


async def test_migration_creates_the_settings_column(
    migrated_database_url: str,
) -> None:
    """The settings object exists, as a NOT NULL ``jsonb`` defaulting to ``{}``, on a
    database built by Alembic — not by ``create_all``.

    Worth its own test precisely because ``create_all`` is what the rest of the
    suite runs on: a column added to the model and forgotten in the migration is
    invisible to every other test in this repo and fails on the first real
    deployment (api/CLAUDE.md, "pytest never runs the migrations").

    All three facts are asserted, not just presence, because each is load-bearing (ADR
    "a draw type's settings are one NOT NULL JSON object"): ``jsonb`` because the
    ``jsonb_typeof`` check and every read depend on it, NOT NULL because ``NULL`` and
    ``{}`` would be two spellings of "no configuration", and the default because it is
    what makes the NOT NULL survivable for a writer that omits the column.
    """
    column = await _draw_settings_column(migrated_database_url, "settings")

    assert column is not None, (
        "migrated database has no tournament_event_draw_settings.settings column —"
        " the model has it and create_all builds it, so the whole suite is green"
        " without the migration"
    )
    assert column.data_type == "jsonb", column
    assert column.is_nullable == "NO", column
    assert column.column_default is not None, column
    assert "'{}'" in column.column_default, column


async def test_migration_no_longer_creates_the_qualifiers_per_group_column(
    migrated_database_url: str,
) -> None:
    """The column the settings object replaced is **gone** from a migrated database.

    The half of an edit-in-place that is easy to leave half-done: adding ``settings``
    to migration 0010 and forgetting to delete ``qualifiers_per_group`` beside it leaves
    a database with two homes for one fact, and every other test in this repo — built
    by ``create_all`` from the model, which has only one — stays green over it.
    """
    assert (
        await _draw_settings_column(migrated_database_url, "qualifiers_per_group")
        is None
    ), (
        "migrated database still has tournament_event_draw_settings."
        "qualifiers_per_group — migration 0010 replaced it with the settings object,"
        " so the column is a second, stale home for the qualifier count"
    )


async def _draw_type_id_fk(url: str) -> sa.Row[tuple[str, str, str]] | None:
    """The foreign key on the migrated database's
    ``tournament_event_draw_settings.draw_type_id`` column — the table and column
    it targets, and its delete rule — or ``None`` if there is no such FK at all.

    A column can exist with the right name and type and still not be the FK
    the ADR describes: nothing about ``_draw_settings_column`` above proves a
    constraint is attached to it. Read from ``information_schema`` rather than
    through the model/``DrawTypeOption``, for the same reason every other
    assertion in this file is: the subject is what **Alembic** built, not what
    ``create_all`` would build from the same model regardless.
    """
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    sa.text(
                        "SELECT ccu.table_name, ccu.column_name, rc.delete_rule"
                        " FROM information_schema.table_constraints tc"
                        " JOIN information_schema.key_column_usage kcu"
                        "   ON tc.constraint_name = kcu.constraint_name"
                        "  AND tc.table_schema = kcu.table_schema"
                        " JOIN information_schema.constraint_column_usage ccu"
                        "   ON tc.constraint_name = ccu.constraint_name"
                        "  AND tc.table_schema = ccu.table_schema"
                        " JOIN information_schema.referential_constraints rc"
                        "   ON tc.constraint_name = rc.constraint_name"
                        "  AND tc.table_schema = rc.constraint_schema"
                        " WHERE tc.table_name = 'tournament_event_draw_settings'"
                        "   AND tc.constraint_type = 'FOREIGN KEY'"
                        "   AND kcu.column_name = 'draw_type_id'"
                    )
                )
            ).one_or_none()
    finally:
        await engine.dispose()


async def test_migration_moves_the_draw_type_fk_from_key_to_id(
    migrated_database_url: str,
) -> None:
    """``draw_type_id`` — a NOT NULL uuid, FK'd to ``draw_types.id`` ``ON DELETE
    RESTRICT`` — is what replaced ``draw_type_key`` (ADR 20260815, "draw_types
    gains a surrogate id primary key").

    The column alone is the same shape as the ``qualifiers_per_group`` test above,
    but api/CLAUDE.md asks more of a migration test that touches a foreign key:
    the constraint itself, not merely the column it sits on, has to be inspected
    on a database Alembic actually built — a ``create_all`` schema gets its FK
    from the model regardless of what this migration's DDL says, so only this
    test can catch a migration that renamed the column but wrote the wrong
    target or delete rule (or none at all).
    """
    new_column = await _draw_settings_column(migrated_database_url, "draw_type_id")
    assert new_column is not None, (
        "migrated database has no tournament_event_draw_settings.draw_type_id"
        " column — the model has it and create_all builds it, so the whole"
        " suite is green without the migration"
    )
    assert new_column.data_type == "uuid", new_column
    assert new_column.is_nullable == "NO", new_column

    fk = await _draw_type_id_fk(migrated_database_url)
    assert fk is not None, (
        "migrated database has no foreign key at all on"
        " tournament_event_draw_settings.draw_type_id"
    )
    assert fk.table_name == "draw_types", fk
    assert fk.column_name == "id", fk
    assert fk.delete_rule == "RESTRICT", fk


# Every ``settings`` value the CHECK has an opinion about, and the opinion. Written
# as data so the test below reports the WHOLE outcome table on a failure rather than
# dying at the first disagreement — a constraint that was never created and one that
# refuses everything look very different here, and that difference is the finding.
#
# The value is SQL text, not a bound parameter, because ``NULL`` and the JSON literal
# ``null`` are both under test and a bound ``None`` could not tell them apart in the
# failure message. The values are this module's own constants and never touch user
# input.
#
# There are deliberately **no cases pairing a draw type with the wrong settings**. The
# ``CASE`` constraint that refused ``('round-robin', 2)`` went away with the column it
# guarded, and a migrated database now accepts a round-robin row carrying a qualifier
# count (ADR "a draw type's settings are one NOT NULL JSON object"). That rule lives in
# the discriminated union at the request boundary now, where
# ``test_tournament_event_draw_settings.py`` pins it.
SETTINGS_VALUE_CASES: list[tuple[str, bool]] = [
    # The empty object is what a draw type with no configuration stores, and the
    # populated one is what ``rr-then-ko`` stores. Both must be accepted, or the
    # refusals below would also be satisfied by a constraint that rejects everything.
    ("'{}'::jsonb", True),
    ("'{\"qualifiers_per_group\": 2}'::jsonb", True),
    # Everything that is JSON but not an object. Each is asked, because a constraint
    # mistakenly written as ``settings IS NOT NULL`` accepts all four and would look
    # green on any one of them alone.
    ("'[]'::jsonb", False),
    ("'1'::jsonb", False),
    ("'\"nope\"'::jsonb", False),
    # JSON ``null`` is the sly one: it is a legal jsonb value, it is NOT SQL NULL, and
    # ``jsonb_typeof`` calls it ``'null'``.
    ("'null'::jsonb", False),
    # And SQL NULL, which the NOT NULL refuses rather than the CHECK — one column, two
    # guards, and the row must be refused either way.
    ("NULL", False),
]


async def test_migration_lets_the_settings_column_hold_objects_and_nothing_else(
    migrated_database_url: str,
) -> None:
    """What the CHECK **does** on a migrated database, not what its text says.

    An earlier version of this test asserted only that a constraint's text appeared in
    ``pg_get_constraintdef``. That caught a *missing* constraint but not a *wrong* one,
    and a wrong constraint is the likelier mistake the next time someone edits
    migration 0010, since the edit-in-place convention means the expression gets
    rewritten rather than replaced.

    So every case in :data:`SETTINGS_VALUE_CASES` is actually attempted, and it is the
    accept/reject outcome that is asserted. That also makes the test immune to Postgres
    re-rendering the expression.

    The model's copy of this rule is exercised by
    ``test_tournament_event_draw_settings.py`` against a ``create_all`` schema.
    This is the same questions asked of the schema **Alembic** built — which is
    the only way the two descriptions can be shown to agree.

    The slug the cases name is a row the migration itself inserted, so the settings
    rows below FK against the real seed rather than a test-local stand-in. Everything
    runs inside one transaction that is **rolled back**, so the session-scoped migrated
    database is left exactly as Alembic made it and the seed assertions in this file
    cannot be affected by test ordering.
    """
    engine = create_async_engine(migrated_database_url)
    outcomes: dict[str, bool] = {}
    try:
        conn = await engine.connect()
        try:
            transaction = await conn.begin()
            try:
                for value, _ in SETTINGS_VALUE_CASES:
                    # The slug resolves to its id via a sub-select rather than a bound
                    # uuid literal, so this case list keeps naming the draw type by its
                    # ``key`` — the spelling the rest of this file, and the code, both
                    # bind on (ADR 20260815 moved the FK's COLUMN to ``draw_type_id``,
                    # not what the test asks by).
                    statement = sa.text(
                        "INSERT INTO tournament_event_draw_settings"
                        " (draw_type_id, settings)"
                        " VALUES ((SELECT id FROM draw_types WHERE key = :slug),"
                        f" {value})"
                    )
                    try:
                        # A SAVEPOINT per case: a refused INSERT poisons the
                        # enclosing transaction, so without one the first
                        # rejection would abort every case after it and the
                        # outcome table would be a lie.
                        async with conn.begin_nested():
                            await conn.execute(statement, {"slug": "rr-then-ko"})
                    except IntegrityError:
                        outcomes[value] = False
                    else:
                        outcomes[value] = True
            finally:
                await transaction.rollback()
        finally:
            await conn.close()
    finally:
        await engine.dispose()

    expected = dict(SETTINGS_VALUE_CASES)
    disagreed = {
        value: f"expected {'accepted' if want else 'REFUSED'}, "
        f"got {'accepted' if outcomes[value] else 'REFUSED'}"
        for value, want in expected.items()
        if outcomes[value] != want
    }
    assert not disagreed, (
        "migration 0010's tournament_event_draw_settings.settings column does not "
        "behave like the model's copy on a migrated database: "
        f"{disagreed}"
    )


async def test_seeded_draw_types_have_distinct_display_orders(
    seeded_draw_types: list[sa.Row[tuple[uuid.UUID, str, str, str, int]]],
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


# ----- tournament_event_stages (ADR 20260815 decisions 1/3) -------------------------


async def _stage_column(
    url: str, column_name: str
) -> sa.Row[tuple[str, str, str | None]] | None:
    """One column of ``tournament_event_stages`` as the **migrated** database
    describes it, or ``None`` when the migration did not create it — mirroring
    ``_draw_settings_column`` above for the stages table."""
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    sa.text(
                        "SELECT data_type, is_nullable, column_default"
                        " FROM information_schema.columns"
                        " WHERE table_name = 'tournament_event_stages'"
                        "   AND column_name = :column_name"
                    ),
                    {"column_name": column_name},
                )
            ).one_or_none()
    finally:
        await engine.dispose()


async def _stage_fk(url: str, column_name: str) -> sa.Row[tuple[str, str, str]] | None:
    """The foreign key on the migrated database's ``tournament_event_stages
    .<column_name>`` column — the table and column it targets, and its delete rule —
    mirroring ``_draw_type_id_fk`` above for the stages table's own two FKs."""
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    sa.text(
                        "SELECT ccu.table_name, ccu.column_name, rc.delete_rule"
                        " FROM information_schema.table_constraints tc"
                        " JOIN information_schema.key_column_usage kcu"
                        "   ON tc.constraint_name = kcu.constraint_name"
                        "  AND tc.table_schema = kcu.table_schema"
                        " JOIN information_schema.constraint_column_usage ccu"
                        "   ON tc.constraint_name = ccu.constraint_name"
                        "  AND tc.table_schema = ccu.table_schema"
                        " JOIN information_schema.referential_constraints rc"
                        "   ON tc.constraint_name = rc.constraint_name"
                        "  AND tc.table_schema = rc.constraint_schema"
                        " WHERE tc.table_name = 'tournament_event_stages'"
                        "   AND tc.constraint_type = 'FOREIGN KEY'"
                        "   AND kcu.column_name = :column_name"
                    ),
                    {"column_name": column_name},
                )
            ).one_or_none()
    finally:
        await engine.dispose()


async def _stage_unique_constraint_columns(url: str, constraint_name: str) -> set[str]:
    """The column set of a named UNIQUE constraint on ``tournament_event_stages``, or
    the empty set when no constraint with that name exists — how the two
    composite-uniqueness claims (``uq_..._event_id_id`` / ``uq_..._event_id_position``,
    ADR 20260815 decision 1) are checked on a database Alembic actually built."""
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        sa.text(
                            "SELECT kcu.column_name"
                            " FROM information_schema.table_constraints tc"
                            " JOIN information_schema.key_column_usage kcu"
                            "   ON tc.constraint_name = kcu.constraint_name"
                            "  AND tc.table_schema = kcu.table_schema"
                            " WHERE tc.table_name = 'tournament_event_stages'"
                            "   AND tc.constraint_type = 'UNIQUE'"
                            "   AND tc.constraint_name = :constraint_name"
                        ),
                        {"constraint_name": constraint_name},
                    )
                )
                .scalars()
                .all()
            )
            return set(rows)
    finally:
        await engine.dispose()


async def test_migration_creates_the_tournament_event_stages_table(
    migrated_database_url: str,
) -> None:
    """``tournament_event_stages`` exists on a database Alembic actually built, with
    the columns, both foreign keys and both composite-uniqueness constraints the
    model declares (ADR 20260815 decisions 1/3) — mirroring
    ``test_migration_creates_the_settings_column``'s reasoning: ``create_all`` builds
    this table from the model regardless of what migration 0010's ``op.create_table``
    call says, since the edit-in-place convention means the two descriptions can
    silently drift apart the next time this migration is touched. Only a database
    Alembic actually migrated can catch a dropped or mis-shaped ``create_table``.
    """
    event_id = await _stage_column(migrated_database_url, "event_id")
    assert event_id is not None, (
        "migrated database has no tournament_event_stages.event_id column — the"
        " model has it and create_all builds it, so the whole suite is green"
        " without the migration"
    )
    assert event_id.data_type == "uuid", event_id
    assert event_id.is_nullable == "NO", event_id

    position = await _stage_column(migrated_database_url, "position")
    assert position is not None, position
    assert position.data_type == "integer", position
    assert position.is_nullable == "NO", position

    draw_type_id = await _stage_column(migrated_database_url, "draw_type_id")
    assert draw_type_id is not None, draw_type_id
    assert draw_type_id.data_type == "uuid", draw_type_id
    assert draw_type_id.is_nullable == "NO", draw_type_id

    event_fk = await _stage_fk(migrated_database_url, "event_id")
    assert event_fk is not None, (
        "migrated database has no foreign key on tournament_event_stages.event_id"
    )
    assert event_fk.table_name == "tournament_events", event_fk
    assert event_fk.column_name == "id", event_fk
    assert event_fk.delete_rule == "CASCADE", event_fk

    draw_type_fk = await _stage_fk(migrated_database_url, "draw_type_id")
    assert draw_type_fk is not None, (
        "migrated database has no foreign key on tournament_event_stages.draw_type_id"
    )
    assert draw_type_fk.table_name == "draw_types", draw_type_fk
    assert draw_type_fk.column_name == "id", draw_type_fk
    assert draw_type_fk.delete_rule == "RESTRICT", draw_type_fk

    assert await _stage_unique_constraint_columns(
        migrated_database_url, "uq_tournament_event_stages_event_id_id"
    ) == {"event_id", "id"}
    assert await _stage_unique_constraint_columns(
        migrated_database_url, "uq_tournament_event_stages_event_id_position"
    ) == {"event_id", "position"}
