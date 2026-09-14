"""Upgrade retained beta history, independently of the current ORM seed helpers.

Both origins are 0001 at freeze time: these initially verify the populated
baseline survives an honest no-op upgrade. Future forward migrations run through
this same test without rewriting the frozen fixture or creating fake revisions.
"""

import json
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from tests._migration_database import empty_database, run_alembic
from tests._released_schema import verify_release_commit

API = Path(__file__).parents[1]
FIXTURE = Path(__file__).parent / "fixtures" / "beta-0001.json"
# Deliberately exclude rebuildable ratings/notifications and other projections.
# These are durable facts, identities, and relationships in the frozen fixture.
RETAINED_TABLES = (
    "accounts",
    "players",
    "account_players",
    "login_identities",
    "matches",
    "match_settings",
    "match_games",
    "match_game_scores",
    "match_sides",
    "match_lineups",
    "match_lineup_players",
    "match_recorded_participants",
    "match_recorded_play",
    "match_rating_bases",
    "match_side_players",
    "match_results",
    "match_official_results",
    "rating_inputs",
    "fixture_advancement_decisions",
    "advancement_decision_evidence",
    "tournament_entries",
    "tournament_entry_members",
    "tournament_entry_participations",
    "tournament_event_lifecycle_history",
    "tournament_entry_withdrawals",
    "tournament_fixtures",
    "tournament_tables",
    "tournament_table_outages",
)


def migration_revision(filename):
    record = json.loads((API / "migrations" / filename).read_text())
    revision = record["revision"]
    assert isinstance(revision, str) and revision
    if filename == "released-schema.json":
        assert record["status"] in {"initial-beta-candidate", "released"}
        if record["status"] == "initial-beta-candidate":
            assert revision == migration_revision("beta-baseline.json")
            assert record["release_commit"] is None
        else:
            commit = record["release_commit"]
            assert isinstance(commit, str)
            verify_release_commit(API.parent, commit, revision)
    return revision


async def load_frozen_fixture(engine, fixture):
    # This engine comes exclusively from empty_database: never a supplied/shared
    # database. Like normal fixture cleanup, LOCAL restores FK/retention triggers
    # before returning the connection. The source rows were committed with all
    # real baseline constraints enabled; no current app/model imports seed them.
    async with engine.begin() as connection:
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        for table in fixture:
            await connection.execute(text(f'DELETE FROM "{table}"'))
        for table, rows in fixture.items():
            await connection.execute(
                text(
                    f'INSERT INTO "{table}" OVERRIDING SYSTEM VALUE SELECT * FROM '
                    f'jsonb_populate_recordset(NULL::"{table}", CAST(:rows AS jsonb))'
                ),
                {"rows": json.dumps(rows)},
            )

        await connection.execute(
            text(
                "SELECT setval(pg_get_serial_sequence('rating_inputs', 'sequence'), "
                "(SELECT max(sequence) FROM rating_inputs))"
            )
        )


async def retained_history(engine, fixture):
    history = {}
    async with engine.connect() as connection:
        for table in RETAINED_TABLES:
            # Explicitly retain the original columns, so additive columns do not
            # look like lost data. Schema transformations need semantic assertions
            # here rather than regenerating the input fixture from current models.
            columns = sorted(set(fixture[table][0]) - {"updated_at"})
            projection = ", ".join(f'"{column}"' for column in columns)
            rows = await connection.scalars(
                text(
                    f"SELECT to_jsonb(retained) FROM (SELECT {projection} "
                    f'FROM "{table}") retained'
                )
            )
            history[table] = sorted(json.dumps(row, sort_keys=True) for row in rows)
    return history


async def assert_foreign_keys(engine):
    # Re-enabling triggers does not retroactively validate a fixture restored in
    # replica mode. Check every FK explicitly, including composite relationships.
    async with engine.connect() as connection:

        def foreign_keys(sync_connection):
            inspector = inspect(sync_connection)
            return [
                (table, key)
                for table in inspector.get_table_names()
                for key in inspector.get_foreign_keys(table)
            ]

        for table, key in await connection.run_sync(foreign_keys):
            referred_table = key["referred_table"]
            columns = key["constrained_columns"]
            nonnull = " AND ".join(
                f'source."{column}" IS NOT NULL' for column in columns
            )
            equality = " AND ".join(
                f'source."{source}" = target."{target}"'
                for source, target in zip(columns, key["referred_columns"], strict=True)
            )
            assert (
                await connection.scalar(
                    text(
                        f'SELECT count(*) FROM "{table}" source WHERE {nonnull} '
                        f'AND NOT EXISTS (SELECT 1 FROM "{referred_table}" target '
                        f"WHERE {equality})"
                    )
                )
                == 0
            ), key["name"]


@pytest.mark.parametrize("origin", ["beta-baseline.json", "released-schema.json"])
async def test_populated_beta_history_survives_upgrade_to_head(
    postgres_server_url, origin
):
    fixture = json.loads(FIXTURE.read_text())
    baseline = migration_revision("beta-baseline.json")
    released = migration_revision(origin)
    scripts = ScriptDirectory.from_config(Config(str(API / "alembic.ini")))
    head = scripts.get_current_head()
    ancestors = {revision.revision for revision in scripts.walk_revisions()}
    assert baseline in ancestors and released in ancestors
    assert baseline in {
        revision.revision for revision in scripts.walk_revisions(head=released)
    }, "The released schema must descend from the frozen beta baseline"
    assert baseline == "0001", "The frozen fixture belongs to beta revision 0001"
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", baseline)
        await load_frozen_fixture(engine, fixture)
        await assert_foreign_keys(engine)
        expected = await retained_history(engine, fixture)
        # Seed at the immutable baseline, then upgrade the populated DB to the
        # tracked release. This keeps the input valid as released schemas evolve.
        run_alembic(engine.url, "upgrade", released)
        assert await retained_history(engine, fixture) == expected
        run_alembic(engine.url, "upgrade", "head")
        assert await retained_history(engine, fixture) == expected
        await assert_foreign_keys(engine)
        async with engine.connect() as connection:
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == head
            )
            assert (
                await connection.scalar(text("SHOW session_replication_role"))
                == "origin"
            )
        # Retained rows alone are insufficient: the upgraded database must still
        # prevent ordinary writes from destroying historical actors/results.
        async with engine.begin() as connection:
            for statement in (
                "DELETE FROM accounts",
                "UPDATE match_official_results SET reason = 'rewritten'",
            ):
                with pytest.raises(IntegrityError):
                    async with connection.begin_nested():
                        await connection.execute(text(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "DELETE FROM match_game_scores",
        "UPDATE match_games SET game_number = game_number + 1",
    ],
)
async def test_retained_history_detects_lost_child_scores_and_changed_games(
    postgres_server_url, statement
):
    fixture = json.loads(FIXTURE.read_text())
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", "0001")
        await load_frozen_fixture(engine, fixture)
        expected = await retained_history(engine, fixture)
        # Model a faulty migration that bypasses retention triggers. Deleting a
        # child score leaves valid FKs and unchanged parent matches/results, so
        # checking only those parents would incorrectly report preservation.
        async with engine.begin() as connection:
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(text(statement))
        await assert_foreign_keys(engine)
        actual = await retained_history(engine, fixture)
        assert actual["matches"] == expected["matches"]
        assert actual["match_official_results"] == expected["match_official_results"]
        assert actual != expected, "Historical game/score corruption was not detected"
