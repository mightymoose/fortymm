"""Upgrade retained beta history, independently of the current ORM seed helpers.

Both origins are 0001 at freeze time: these initially verify the populated
baseline survives an honest no-op upgrade. Future forward migrations run through
this same test without rewriting the frozen fixture or creating fake revisions.
"""

import json
import os
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from tests._migration_database import empty_database, run_alembic
from tests._released_schema import git, verify_release_record

API = Path(__file__).parents[1]
FIXTURE = Path(__file__).parent / "fixtures" / "beta-0001.json"
# Durable facts, aggregate settings, relationships, pending work and ledgers.
# Every populated fixture table must have an explicit preservation policy below.
RETAINED_TABLES = (
    "accounts",
    "device_tokens",
    "account_session_tokens",
    "account_email_tokens",
    "account_email_intents",
    "account_first_sign_in_intents",
    "league_memberships",
    "notifications",
    "notification_channel_settings",
    "notification_preferences",
    "match_void_actions",
    "role_permissions",
    "user_roles",
    "tournament_account_grants",
    "tournament_ownership_transfers",
    "tournament_entry_registrations",
    "tournament_table_call_history",
    "required_repair_attempts",
    "tournament_archive_history",
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
    "leagues",
    "required_repairs",
    "schedule_solves",
    "tournaments",
    "tournament_events",
    "tournament_draw_revisions",
    "tournament_event_stages",
    "tournament_event_stage_groups",
    "tournament_event_reservations",
    "tournament_event_group_reservations",
    "tournament_event_reservation_tables",
    "tournament_event_recorded_games",
    "tournament_event_reconciliations",
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


# Preserve the original catalogue rows' meaning without freezing display labels,
# activation/availability policy, ordering, or the addition of new catalogue rows.
CATALOGUE_COLUMNS = {
    "permissions": ("id", "name"),
    "draw_types": ("id", "key"),
    "notification_channels": ("id", "key"),
    "notification_types": ("id", "key"),
    "roles": ("id", "name"),  # Name is the authorization key, not a display label.
    "rating_strategies": (
        "id",
        "key",
        "version",
        "state_schema",
        "initial_state",
        "initial_rating_value",
        "is_automatic",
    ),
}
# Replay may regenerate surrogate IDs and current-projection bookkeeping dates.
# Historical created_at is the rating timeline and must survive unchanged.
RATING_PROJECTION_BOOKKEEPING = {
    "rating_history": {"id"},
    "user_league_ratings": {"id", "created_at", "updated_at"},
}


def migration_revision(filename):
    record = json.loads((API / "migrations" / filename).read_text())
    revision = record["revision"]
    assert isinstance(revision, str) and revision
    if filename == "released-schema.json":
        base = os.environ.get("MIGRATION_BASE_SHA")
        if base is None:
            base = git(API.parent, "merge-base", "HEAD", "origin/main").strip()
        return verify_release_record(
            API.parent, base, record, migration_revision("beta-baseline.json")
        )
    return revision


async def load_frozen_fixture(engine, fixture):
    # This engine comes exclusively from empty_database: never a supplied/shared
    # database. Like normal fixture cleanup, LOCAL restores FK/retention triggers
    # before returning the connection. The source rows were committed with all
    # real baseline constraints enabled; no current app/model imports seed them.
    async with engine.begin() as connection:
        baseline_tables = await connection.run_sync(
            lambda conn: set(inspect(conn).get_table_names()) - {"alembic_version"}
        )
        assert set(fixture) == baseline_tables, (
            "Every baseline table needs fixture rows"
        )
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
    classified = (
        set(RETAINED_TABLES)
        | set(CATALOGUE_COLUMNS)
        | set(RATING_PROJECTION_BOOKKEEPING)
    )
    assert set(fixture) == classified, "Every populated fixture table needs a policy"
    history = {}
    async with engine.connect() as connection:
        for table in (*RETAINED_TABLES, *RATING_PROJECTION_BOOKKEEPING):
            # Explicitly retain the original columns, so additive columns do not
            # look like lost data. Schema transformations need semantic assertions
            # here rather than regenerating the input fixture from current models.
            bookkeeping = RATING_PROJECTION_BOOKKEEPING.get(table, {"updated_at"})
            columns = sorted(set(fixture[table][0]) - bookkeeping)
            projection = ", ".join(f'"{column}"' for column in columns)
            rows = await connection.scalars(
                text(
                    f"SELECT to_jsonb(retained) FROM (SELECT {projection} "
                    f'FROM "{table}") retained'
                )
            )
            history[table] = sorted(json.dumps(row, sort_keys=True) for row in rows)
        for table, columns in CATALOGUE_COLUMNS.items():
            projection = ", ".join(f'"{column}"' for column in columns)
            rows = await connection.scalars(
                text(
                    f"SELECT to_jsonb(retained) FROM (SELECT {projection} "
                    f'FROM "{table}" WHERE id::text IN '
                    "(SELECT jsonb_array_elements_text(CAST(:ids AS jsonb)))) retained"
                ),
                {"ids": json.dumps([row["id"] for row in fixture[table]])},
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


async def test_payments_migration_backfills_pre_payments_registration_stamp(
    postgres_server_url,
):
    """#1816's forward migration adds ``pre_payments_registration`` NOT NULL
    with a ``true`` server default — every registration that exists at
    migration time (the frozen fixture's populated rows) must come back
    stamped ``true`` from that single column-add, with no separate backfill
    step."""
    fixture = json.loads(FIXTURE.read_text())
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", "0001")
        await load_frozen_fixture(engine, fixture)
        async with engine.connect() as connection:
            registration_count = await connection.scalar(
                text("SELECT count(*) FROM tournament_entry_registrations")
            )
        assert registration_count and registration_count > 0
        run_alembic(engine.url, "upgrade", "head")
        async with engine.connect() as connection:
            unstamped = await connection.scalar(
                text(
                    "SELECT count(*) FROM tournament_entry_registrations "
                    "WHERE pre_payments_registration IS NOT TRUE"
                )
            )
        assert unstamped == 0


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


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE tournaments SET name = name || '-corrupt'",
        "UPDATE tournaments SET status = 'draft' WHERE status <> 'archived'",
        "UPDATE tournament_events SET name = name || '-corrupt'",
        "UPDATE tournament_events SET timezone = 'UTC'",
    ],
)
async def test_retained_history_detects_changed_tournament_roots(
    postgres_server_url, statement
):
    fixture = json.loads(FIXTURE.read_text())
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", "0001")
        await load_frozen_fixture(engine, fixture)
        expected = await retained_history(engine, fixture)
        async with engine.begin() as connection:
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(text(statement))
        await assert_foreign_keys(engine)
        actual = await retained_history(engine, fixture)
        assert actual["tournament_fixtures"] == expected["tournament_fixtures"]
        assert actual["match_official_results"] == expected["match_official_results"]
        assert actual != expected, "Tournament root corruption was not detected"


async def test_catalogue_additions_and_display_edits_preserve_historical_meaning(
    postgres_server_url,
):
    fixture = json.loads(FIXTURE.read_text())
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", "0001")
        await load_frozen_fixture(engine, fixture)
        expected = await retained_history(engine, fixture)
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE draw_types SET name = name || ' label'")
            )
            await connection.execute(
                text(
                    "INSERT INTO notification_types"
                    "(key,name,short_label,description,display_order) "
                    "VALUES ('future_type','Future type','Future',"
                    "'Future notifications',99)"
                )
            )
        assert await retained_history(engine, fixture) == expected
        # Retargeting a stable identity to a different semantic key must fail,
        # even though all foreign keys and display labels remain valid.
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE draw_types SET key = key || '_corrupt'")
            )
        assert await retained_history(engine, fixture) != expected


@pytest.mark.parametrize(
    "statement",
    [
        "DELETE FROM tournament_account_grants WHERE revoked_at IS NOT NULL",
        "DELETE FROM league_memberships",
        "DELETE FROM notifications",
        "DELETE FROM notification_channel_settings",
        "DELETE FROM notification_preferences",
        "DELETE FROM required_repair_attempts",
        "DELETE FROM account_email_intents",
        "DELETE FROM user_roles",
        "DELETE FROM tournament_entry_registrations",
    ],
)
async def test_retained_history_detects_lost_owned_state_and_operational_history(
    postgres_server_url, statement
):
    fixture = json.loads(FIXTURE.read_text())
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", "0001")
        await load_frozen_fixture(engine, fixture)
        expected = await retained_history(engine, fixture)
        async with engine.begin() as connection:
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(text(statement))
        # Losing these child rows leaves valid FKs and unchanged owning roots;
        # only explicit preservation checks detect the lost settings/history.
        await assert_foreign_keys(engine)
        actual = await retained_history(engine, fixture)
        assert actual["accounts"] == expected["accounts"]
        assert actual["tournaments"] == expected["tournaments"]
        assert actual["required_repairs"] == expected["required_repairs"]
        assert actual != expected, "Owned state or operational history loss was missed"


@pytest.mark.parametrize(
    "statement",
    [
        "DELETE FROM rating_history",
        "DELETE FROM user_league_ratings",
        "UPDATE rating_history SET rating_state = "
        "jsonb_set(rating_state, '{rd}', '999'::jsonb)",
        "UPDATE user_league_ratings SET rating_value = rating_value + 100, "
        "rating_state = jsonb_set(rating_state, '{rating}', "
        "to_jsonb(rating_value + 100))",
        "UPDATE rating_history SET created_at = created_at + INTERVAL '1 day'",
        "UPDATE rating_history SET created_by_user_id = NULL",
    ],
)
async def test_retained_history_requires_rating_projection_semantics(
    postgres_server_url, statement
):
    fixture = json.loads(FIXTURE.read_text())
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", "0001")
        await load_frozen_fixture(engine, fixture)
        expected = await retained_history(engine, fixture)
        async with engine.begin() as connection:
            # Simulate a migration bypassing projection consistency triggers;
            # re-enable them before checking FKs and preserved semantics.
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(text(statement))
        await assert_foreign_keys(engine)
        actual = await retained_history(engine, fixture)
        assert actual["rating_inputs"] == expected["rating_inputs"]
        assert actual["match_official_results"] == expected["match_official_results"]
        assert actual != expected, "Ratings/history changed without equivalent replay"


async def test_rating_replay_may_regenerate_projection_bookkeeping(postgres_server_url):
    fixture = json.loads(FIXTURE.read_text())
    async with empty_database(postgres_server_url) as engine:
        run_alembic(engine.url, "upgrade", "0001")
        await load_frozen_fixture(engine, fixture)
        expected = await retained_history(engine, fixture)
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE rating_history SET id = gen_random_uuid()")
            )
            await connection.execute(
                text(
                    "UPDATE user_league_ratings SET id = gen_random_uuid(), "
                    "created_at = clock_timestamp(), updated_at = clock_timestamp()"
                )
            )
        await assert_foreign_keys(engine)
        assert await retained_history(engine, fixture) == expected
