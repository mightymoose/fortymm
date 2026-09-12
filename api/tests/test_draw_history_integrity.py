"""Trusted SQL writers cannot rewrite sporting history in the migrated schema."""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.models import League
from app.tournament_draw_service import cut_event_draw, uncut_event_draw
from tests._helpers import make_user
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


@pytest_asyncio.fixture
async def drawn_history(
    db_session: AsyncSession, default_league: League
) -> dict[str, uuid.UUID]:
    owner = await make_user(db_session, "integrity-history-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="integrity-history")
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    fixture_id = fixtures[0].id
    row = (
        await db_session.execute(
            text(
                "SELECT participation_a_id, draw_revision_id FROM "
                "tournament_fixtures WHERE id = :id"
            ),
            {"id": fixture_id},
        )
    ).one()
    return {
        "fixture_id": fixture_id,
        "participation_id": row.participation_a_id,
        "revision_id": row.draw_revision_id,
        "owner_id": owner.id,
        "tournament_id": tournament_id,
        "event_id": event_id,
    }


async def test_participation_start_is_immutable(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    with pytest.raises(IntegrityError, match="participation history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_entry_participations SET started_at = "
                    "started_at - interval '1 day' WHERE id = :id"
                ),
                {"id": drawn_history["participation_id"]},
            )


async def test_ended_participation_cannot_reopen(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await db_session.execute(
        text(
            "UPDATE tournament_entry_participations SET ended_at = "
            "clock_timestamp(), end_reason = 'stage_completed' WHERE id = :id"
        ),
        {"id": drawn_history["participation_id"]},
    )
    with pytest.raises(IntegrityError, match="participation history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_entry_participations SET ended_at = "
                    "NULL, end_reason = NULL WHERE id = :id"
                ),
                {"id": drawn_history["participation_id"]},
            )


async def test_draw_revision_configuration_is_immutable(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    with pytest.raises(IntegrityError, match="draw revision history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_draw_revisions SET configuration = '{}' "
                    "WHERE id = :id"
                ),
                {"id": drawn_history["revision_id"]},
            )


async def test_direct_fixture_insert_assigns_one_revision_to_its_participation(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "sql-fixture-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    entries = await _enter_field(db_session, event, 2, prefix="sql-fixture")
    entry_ids = [entry.id for entry in entries]
    await db_session.refresh(event)
    fixture_id = (
        await db_session.execute(
            text(
                "INSERT INTO "
                "tournament_fixtures(stage_id,group_id,round,position,entry_a_id,entry_b_id)"
                " VALUES (:stage,:group,1,1,:a,:b) RETURNING id"
            ),
            {
                "stage": event.stages[0].id,
                "group": event.groups[0].id,
                "a": entry_ids[0],
                "b": entry_ids[1],
            },
        )
    ).scalar_one()
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    row = (
        await db_session.execute(
            text(
                "SELECT f.draw_revision_id, p.draw_revision_id FROM "
                "tournament_fixtures f JOIN tournament_entry_participations p "
                "ON p.id = f.participation_a_id WHERE f.id = :id"
            ),
            {"id": fixture_id},
        )
    ).one()
    assert row[0] == row[1]


async def _uncut(db: AsyncSession, ids: dict[str, uuid.UUID]) -> None:
    from app.models import User

    owner = await db.get(User, ids["owner_id"])
    assert owner is not None
    await uncut_event_draw(
        db, tournament_id=ids["tournament_id"], event_id=ids["event_id"], actor=owner
    )


async def test_retired_revision_cannot_be_reopened(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await _uncut(db_session, drawn_history)
    with pytest.raises(IntegrityError, match="draw revision history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_draw_revisions SET retired_at = NULL "
                    "WHERE id = :id"
                ),
                {"id": drawn_history["revision_id"]},
            )


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE tournament_fixtures SET round = round + 1 WHERE id = :id",
        "DELETE FROM tournament_fixtures WHERE id = :id",
    ],
)
async def test_retired_fixture_cannot_be_rewritten_or_deleted(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID], statement: str
) -> None:
    await _uncut(db_session, drawn_history)
    with pytest.raises(IntegrityError, match="retired fixture history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(statement), {"id": drawn_history["fixture_id"]}
            )


@pytest.mark.parametrize(
    "table,id_key",
    [
        ("tournament_fixtures", "fixture_id"),
        ("tournament_draw_revisions", "revision_id"),
    ],
)
async def test_draw_retirement_must_include_revision_and_fixtures(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    table: str,
    id_key: str,
) -> None:
    with pytest.raises(IntegrityError, match="draw retirement must be consistent"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    f"UPDATE {table} SET retired_at = clock_timestamp() WHERE id = :id"
                ),
                {"id": drawn_history[id_key]},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_retired_stage_cannot_admit_new_participation(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await _uncut(db_session, drawn_history)
    with pytest.raises(
        IntegrityError, match="participation requires a current stage and revision"
    ):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "tournament_entry_participations(event_id,entry_id,stage_id,group_id)"
                    " SELECT event_id,entry_id,stage_id,group_id FROM "
                    "tournament_entry_participations WHERE id = :id"
                ),
                {"id": drawn_history["participation_id"]},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_ended_participation_cannot_take_a_new_fixture_seat(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await db_session.execute(
        text(
            "UPDATE tournament_entry_participations SET ended_at = "
            "clock_timestamp(), end_reason = 'stage_completed' WHERE id = :id"
        ),
        {"id": drawn_history["participation_id"]},
    )
    with pytest.raises(
        IntegrityError, match="new fixture seat requires active participation"
    ):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "tournament_fixtures(stage_id,group_id,round,position,entry_a_id,entry_b_id,participation_a_id,participation_b_id,draw_revision_id)"
                    " SELECT "
                    "stage_id,group_id,round,position+100,entry_a_id,entry_b_id,participation_a_id,participation_b_id,draw_revision_id"
                    " FROM tournament_fixtures WHERE id = :id"
                ),
                {"id": drawn_history["fixture_id"]},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_revision_retirement_closes_participation_without_fixtures(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await _uncut(db_session, drawn_history)
    revision_id = (
        await db_session.execute(
            text(
                "INSERT INTO "
                "tournament_entry_participations(event_id,entry_id,stage_id,group_id)"
                " SELECT s.event_id,p.entry_id,s.id,g.id FROM "
                "tournament_event_stages s JOIN "
                "tournament_event_stage_groups g ON g.stage_id=s.id JOIN "
                "tournament_entry_participations p ON p.event_id=s.event_id"
                " WHERE p.id=:id AND s.retired_at IS NULL RETURNING "
                "draw_revision_id"
            ),
            {"id": drawn_history["participation_id"]},
        )
    ).scalar_one()
    with pytest.raises(
        IntegrityError, match="active participation requires current draw configuration"
    ):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_draw_revisions SET "
                    "retired_at=clock_timestamp() WHERE id=:id"
                ),
                {"id": revision_id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize(
    "table,id_key",
    [
        ("tournament_entry_participations", "participation_id"),
        ("tournament_draw_revisions", "revision_id"),
    ],
)
async def test_history_cannot_be_deleted_while_its_event_exists(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    table: str,
    id_key: str,
) -> None:
    await _uncut(db_session, drawn_history)
    with pytest.raises(IntegrityError, match="history cannot be deleted"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"DELETE FROM {table} WHERE id=:id"), {"id": drawn_history[id_key]}
            )


async def test_direct_history_writer_retries_when_parent_is_locked(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    from sqlalchemy.exc import DBAPIError

    async with AsyncSession(bind=db_session.bind) as gatekeeper:
        await gatekeeper.execute(
            text("SELECT id FROM tournaments WHERE id=:id FOR UPDATE"),
            {"id": drawn_history["tournament_id"]},
        )
        with pytest.raises(DBAPIError, match="draw history requires parent locks"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(
                        "UPDATE tournament_fixtures SET "
                        "updated_at=clock_timestamp() WHERE id=:id"
                    ),
                    {"id": drawn_history["fixture_id"]},
                )


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE tournament_entry_withdrawals SET explanation='rewritten' WHERE id=:id",
        "DELETE FROM tournament_entry_withdrawals WHERE id=:id",
        (
            "UPDATE tournament_entry_withdrawals SET "
            "restored_at=NULL,restored_by_account_id=NULL WHERE id=:id"
        ),
    ],
)
async def test_competition_withdrawal_history_is_preserved(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID], statement: str
) -> None:
    from app.tournament_participation import WithdrawalReason, withdraw_competition

    entry_id = (
        await db_session.execute(
            text("SELECT entry_id FROM tournament_entry_participations WHERE id=:id"),
            {"id": drawn_history["participation_id"]},
        )
    ).scalar_one()
    await withdraw_competition(
        db_session,
        entry_id,
        drawn_history["owner_id"],
        WithdrawalReason.director_removal,
    )
    await db_session.flush()
    withdrawal_id = (
        await db_session.execute(
            text("SELECT id FROM tournament_entry_withdrawals WHERE entry_id=:id"),
            {"id": entry_id},
        )
    ).scalar_one()
    if "restored_at=NULL" in statement:
        await db_session.execute(
            text(
                "UPDATE tournament_entry_withdrawals SET "
                "restored_at=clock_timestamp(),restored_by_account_id=:actor "
                "WHERE id=:id"
            ),
            {"actor": drawn_history["owner_id"], "id": withdrawal_id},
        )
    with pytest.raises(IntegrityError, match="withdrawal history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(text(statement), {"id": withdrawal_id})


async def test_group_move_ends_old_period_without_repointing_other_fixtures(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    group_id = (
        await db_session.execute(
            text(
                "INSERT INTO tournament_event_stage_groups(stage_id,position) "
                "SELECT stage_id,1 FROM tournament_fixtures WHERE id=:id RETURNING id"
            ),
            {"id": drawn_history["fixture_id"]},
        )
    ).scalar_one()
    await db_session.execute(
        text("UPDATE tournament_fixtures SET group_id=:group_id WHERE id=:id"),
        {"group_id": group_id, "id": drawn_history["fixture_id"]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    old_period = (
        await db_session.execute(
            text(
                "SELECT ended_at,end_reason FROM tournament_entry_participations "
                "WHERE id=:id"
            ),
            {"id": drawn_history["participation_id"]},
        )
    ).one()
    assert old_period.ended_at is not None
    assert old_period.end_reason == "group_changed"
    new_period = (
        await db_session.execute(
            text(
                "SELECT p.id,p.group_id FROM tournament_entry_participations p "
                "JOIN tournament_fixtures f ON f.participation_a_id=p.id WHERE f.id=:id"
            ),
            {"id": drawn_history["fixture_id"]},
        )
    ).one()
    assert new_period.id != drawn_history["participation_id"]
    assert new_period.group_id == group_id
    retained = (
        await db_session.execute(
            text(
                "SELECT count(*) FROM tournament_fixtures "
                "WHERE participation_a_id=:id OR participation_b_id=:id"
            ),
            {"id": drawn_history["participation_id"]},
        )
    ).scalar_one()
    assert retained > 0


@pytest_asyncio.fixture
async def undrawn_registration(
    db_session: AsyncSession, default_league: League
) -> dict[str, uuid.UUID]:
    owner = await make_user(db_session, "undrawn-registration-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    tournament_id, event_id, owner_id = tournament.id, event.id, owner.id
    entries = await _enter_field(db_session, event, 1, prefix="undrawn-registration")
    entry_id = entries[0].id
    registration_id = (
        await db_session.execute(
            text(
                "INSERT INTO tournament_entry_registrations "
                "(entry_id, registered_by_account_id) VALUES (:entry, :actor) "
                "RETURNING id"
            ),
            {"entry": entry_id, "actor": owner_id},
        )
    ).scalar_one()
    await db_session.commit()
    return {
        "entry_id": entry_id,
        "registration_id": registration_id,
        "event_id": event_id,
        "tournament_id": tournament_id,
    }


async def test_entry_delete_cannot_erase_registration_before_a_draw_exists(
    db_session: AsyncSession, undrawn_registration: dict[str, uuid.UUID]
) -> None:
    with pytest.raises(IntegrityError, match="entry history must be retained"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("DELETE FROM tournament_entries WHERE id = :id"),
                {"id": undrawn_registration["entry_id"]},
            )


@pytest.mark.parametrize(
    "parent_table,id_key",
    [("tournament_events", "event_id"), ("tournaments", "tournament_id")],
)
async def test_unplayed_parent_delete_can_remove_undrawn_registration(
    db_session: AsyncSession,
    undrawn_registration: dict[str, uuid.UUID],
    parent_table: str,
    id_key: str,
) -> None:
    await db_session.execute(
        text(f"DELETE FROM {parent_table} WHERE id = :id"),
        {"id": undrawn_registration[id_key]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    retained = await db_session.scalar(
        text("SELECT count(*) FROM tournament_entry_registrations WHERE id = :id"),
        {"id": undrawn_registration["registration_id"]},
    )
    assert retained == 0


async def test_retiring_fixture_cannot_rewrite_its_existing_draw_position(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    with pytest.raises(IntegrityError, match="retired fixture history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET retired_at = clock_timestamp(), "
                    "round = round + 1 WHERE id = :id"
                ),
                {"id": drawn_history["fixture_id"]},
            )


async def test_uncut_changes_only_the_fixture_retirement_timestamp(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    snapshot = text(
        "SELECT to_jsonb(f) - 'retired_at' FROM tournament_fixtures f WHERE id = :id"
    )
    fixture_key = {"id": drawn_history["fixture_id"]}
    before = await db_session.scalar(snapshot, fixture_key)
    await _uncut(db_session, drawn_history)
    after = await db_session.scalar(snapshot, fixture_key)
    assert after == before
    retired_at = await db_session.scalar(
        text("SELECT retired_at FROM tournament_fixtures WHERE id = :id"),
        fixture_key,
    )
    assert retired_at is not None


@pytest.mark.parametrize("already_retired", [False, True])
@pytest.mark.parametrize(
    "metadata_change",
    [
        "position = position + 10",
        "draw_type_id = (SELECT id FROM draw_types WHERE key = 'single-elim')",
    ],
)
async def test_retired_stage_configuration_cannot_be_rewritten(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    already_retired: bool,
    metadata_change: str,
) -> None:
    stage_id = await db_session.scalar(
        text("SELECT stage_id FROM tournament_fixtures WHERE id = :id"),
        {"id": drawn_history["fixture_id"]},
    )
    if already_retired:
        await _uncut(db_session, drawn_history)
    with pytest.raises(IntegrityError, match="retired stage history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    f"UPDATE tournament_event_stages SET {metadata_change}, "
                    "retired_at = COALESCE(retired_at, clock_timestamp()) "
                    "WHERE id = :id"
                ),
                {"id": stage_id},
            )


@pytest.mark.parametrize(
    "parent_table,id_key",
    [("tournament_events", "event_id"), ("tournaments", "tournament_id")],
)
async def test_parent_delete_removes_superseded_entries_together(
    db_session: AsyncSession,
    undrawn_registration: dict[str, uuid.UUID],
    parent_table: str,
    id_key: str,
) -> None:
    from app.models import TournamentEvent

    event = await db_session.get(TournamentEvent, undrawn_registration["event_id"])
    assert event is not None
    duplicates = await _enter_field(db_session, event, 1, prefix="superseded-delete")
    duplicate_id = duplicates[0].id
    await db_session.execute(
        text(
            "UPDATE tournament_entries SET status = 'withdrawn', "
            "superseded_by_entry_id = :survivor WHERE id = :duplicate"
        ),
        {"survivor": undrawn_registration["entry_id"], "duplicate": duplicate_id},
    )
    await db_session.commit()
    await db_session.execute(
        text(f"DELETE FROM {parent_table} WHERE id = :id"),
        {"id": undrawn_registration[id_key]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    retained = await db_session.scalar(
        text("SELECT count(*) FROM tournament_entries WHERE event_id = :id"),
        {"id": undrawn_registration["event_id"]},
    )
    assert retained == 0


@pytest.mark.parametrize(
    "parent_table,id_key",
    [("tournament_events", "event_id"), ("tournaments", "tournament_id")],
)
async def test_uncut_preserves_stage_metadata_until_its_parent_is_deleted(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    parent_table: str,
    id_key: str,
) -> None:
    stage_id = await db_session.scalar(
        text("SELECT stage_id FROM tournament_fixtures WHERE id = :id"),
        {"id": drawn_history["fixture_id"]},
    )
    snapshot = text(
        "SELECT to_jsonb(s) - 'retired_at' FROM tournament_event_stages s "
        "WHERE id = :id"
    )
    stage_key = {"id": stage_id}
    before = await db_session.scalar(snapshot, stage_key)
    await _uncut(db_session, drawn_history)
    after = await db_session.scalar(snapshot, stage_key)
    assert after == before
    retired_at = await db_session.scalar(
        text("SELECT retired_at FROM tournament_event_stages WHERE id = :id"),
        stage_key,
    )
    assert retired_at is not None
    await db_session.execute(
        text(f"DELETE FROM {parent_table} WHERE id = :id"),
        {"id": drawn_history[id_key]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    retained = await db_session.scalar(
        text("SELECT count(*) FROM tournament_event_stages WHERE id = :id"),
        stage_key,
    )
    assert retained == 0


@pytest_asyncio.fixture
async def historical_table(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> dict[str, uuid.UUID]:
    table_id = await db_session.scalar(
        text(
            "SELECT id FROM tournament_tables WHERE tournament_id = :id "
            "ORDER BY position LIMIT 1"
        ),
        {"id": drawn_history["tournament_id"]},
    )
    await db_session.execute(
        text("UPDATE tournament_fixtures SET table_id = :table_id WHERE id = :id"),
        {"table_id": table_id, "id": drawn_history["fixture_id"]},
    )
    await _uncut(db_session, drawn_history)
    return {**drawn_history, "table_id": table_id}


@pytest.mark.parametrize("already_retired", [False, True])
async def test_retired_table_metadata_cannot_be_rewritten(
    db_session: AsyncSession,
    historical_table: dict[str, uuid.UUID],
    already_retired: bool,
) -> None:
    table_key = {"id": historical_table["table_id"]}
    if already_retired:
        await db_session.execute(
            text(
                "UPDATE tournament_tables SET retired_at = clock_timestamp() "
                "WHERE id = :id"
            ),
            table_key,
        )
    with pytest.raises(IntegrityError, match="retired table history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_tables SET label = 'Changed', "
                    "retired_at = COALESCE(retired_at, clock_timestamp()) "
                    "WHERE id = :id"
                ),
                table_key,
            )


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE tournament_event_stage_groups SET position = position + 10 "
        "WHERE id = (SELECT group_id FROM tournament_fixtures WHERE id=:id)",
        "DELETE FROM tournament_event_stage_groups "
        "WHERE id = (SELECT group_id FROM tournament_fixtures WHERE id=:id)",
        "INSERT INTO tournament_event_stage_groups(stage_id,position) "
        "SELECT stage_id, 100 FROM tournament_fixtures WHERE id=:id",
        "UPDATE tournament_event_stage_groups SET stage_id = "
        "(SELECT stage_id FROM tournament_fixtures WHERE id=:id) "
        "WHERE stage_id IN (SELECT id FROM tournament_event_stages "
        "WHERE event_id=:event_id AND retired_at IS NULL)",
    ],
)
async def test_archived_group_position_is_immutable(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID], mutation: str
) -> None:
    await _uncut(db_session, drawn_history)
    with pytest.raises(IntegrityError, match="archived group history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(mutation),
                {
                    "id": drawn_history["fixture_id"],
                    "event_id": drawn_history["event_id"],
                },
            )


async def test_deferred_fixture_retirement_checks_read_only_changed_fixtures(
    db_session: AsyncSession, default_league: League, engine: AsyncEngine
) -> None:
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    owner = await make_user(db_session, "retirement-work-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 24, prefix="retirement-work-player")
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    # Isolate algorithmic lookup work from SPI plans left on pooled connections.
    # Configure a fresh physical connection before it first executes any trigger;
    # do not couple this invariant to invalidating previously warmed plans.
    # Real table statistics also avoid small-table planner assumptions.
    probe_engine = create_async_engine(engine.url, poolclass=NullPool)
    try:
        async with probe_engine.connect() as probe:
            await probe.execute(text("SET LOCAL enable_seqscan = off"))
            await probe.execute(text("ANALYZE tournament_fixtures"))
            await probe.execute(
                text(
                    "UPDATE tournament_fixtures SET updated_at=updated_at "
                    "WHERE scope_event_id=:id"
                ),
                {"id": event_id},
            )
            read_count = text(
                "SELECT seq_tup_read + idx_tup_fetch FROM pg_stat_xact_user_tables "
                "WHERE relname='tournament_fixtures'"
            )
            before = await probe.scalar(read_count)
            await probe.execute(
                text("SET CONSTRAINTS check_fixture_draw_retirement IMMEDIATE")
            )
            after = await probe.scalar(read_count)
            assert 0 < after - before <= len(fixtures) * 4
    finally:
        await probe_engine.dispose()


async def test_retirement_checks_revalidate_after_an_immediate_constraint_cycle(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await db_session.execute(
        text("UPDATE tournament_fixtures SET updated_at=updated_at WHERE id=:id"),
        {"id": drawn_history["fixture_id"]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(text("SET CONSTRAINTS ALL DEFERRED"))
    with pytest.raises(IntegrityError, match="draw retirement must be consistent"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET retired_at=clock_timestamp() "
                    "WHERE id=:id"
                ),
                {"id": drawn_history["fixture_id"]},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    # Queue an event while current, then retire coherently before its check runs.
    # The validator must read the stored final row, not that event's NEW snapshot.
    await db_session.execute(
        text("UPDATE tournament_fixtures SET updated_at=updated_at WHERE id=:id"),
        {"id": drawn_history["fixture_id"]},
    )
    await _uncut(db_session, drawn_history)


@pytest.mark.parametrize(
    "function_name,max_calls",
    [
        ("seat_participation", 0),
        ("validate_new_fixture_seats", 0),
        ("lock_draw_history_parent", 26),
    ],
)
async def test_bulk_cut_uses_preallocated_participation_for_fixture_seats(
    db_session: AsyncSession,
    default_league: League,
    function_name: str,
    max_calls: int,
) -> None:
    from app.tournament_draws import cut_draw

    owner = await make_user(db_session, "batch-seat-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    await _enter_field(db_session, event, 24, prefix="batch-seat-player")
    await db_session.refresh(event)
    await db_session.execute(text("SET LOCAL track_functions = 'all'"))
    function_calls = text(
        "SELECT COALESCE(sum(calls), 0) FROM pg_stat_xact_user_functions "
        "WHERE funcname = :name"
    )
    before_calls = await db_session.scalar(function_calls, {"name": function_name})
    before_batches = await db_session.scalar(
        function_calls, {"name": "validate_fixture_insert_batch"}
    )
    await cut_draw(db_session, event)
    await db_session.flush()
    calls = await db_session.scalar(function_calls, {"name": function_name})
    assert calls - before_calls <= max_calls
    batch_calls = await db_session.scalar(
        function_calls, {"name": "validate_fixture_insert_batch"}
    )
    assert batch_calls - before_batches == 1


@pytest.mark.parametrize(
    "parent_table,id_key",
    [("tournaments", "tournament_id"), ("tournament_events", "event_id")],
)
@pytest.mark.parametrize("immediate", [False, True])
async def test_explicit_sql_fixture_insert_retries_when_parent_is_locked(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    parent_table: str,
    id_key: str,
    immediate: bool,
) -> None:
    from sqlalchemy.exc import DBAPIError

    async with AsyncSession(bind=db_session.bind) as gatekeeper:
        await gatekeeper.execute(
            text(f"SELECT id FROM {parent_table} WHERE id=:id FOR UPDATE"),
            {"id": drawn_history[id_key]},
        )
        # Explicitly immediate FKs run before AFTER STATEMENT triggers. Their
        # normal key-share wait can precede our NOWAIT event lock; a SQL caller's
        # lock_timeout bounds that wait without weakening the FK or seat checks.
        expected = (
            "lock timeout"
            if immediate and parent_table == "tournament_events"
            else "draw history requires parent locks"
        )
        with pytest.raises(DBAPIError, match=expected):
            async with db_session.begin_nested():
                await db_session.execute(text("SET LOCAL lock_timeout = '500ms'"))
                if immediate:
                    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
                await db_session.execute(
                    text(
                        "INSERT INTO tournament_fixtures("
                        "stage_id,group_id,round,position,"
                        "entry_a_id,entry_b_id,participation_a_id,participation_b_id,"
                        "draw_revision_id) SELECT stage_id,group_id,100,position,"
                        "entry_a_id,entry_b_id,participation_a_id,participation_b_id,"
                        "draw_revision_id FROM tournament_fixtures WHERE id=:id"
                    ),
                    {"id": drawn_history["fixture_id"]},
                )


async def _insert_active_withdrawal(
    db: AsyncSession, history: dict[str, uuid.UUID], *, stage_scoped: bool
) -> uuid.UUID:
    return (
        await db.execute(
            text(
                "INSERT INTO tournament_entry_withdrawals "
                "(event_id,entry_id,stage_id,actor_account_id,reason) "
                "SELECT event_id,entry_id,CASE WHEN :stage_scoped THEN stage_id END,"
                ":actor,'director_removal' FROM tournament_entry_participations "
                "WHERE id=:id RETURNING id"
            ),
            {
                "id": history["participation_id"],
                "actor": history["owner_id"],
                "stage_scoped": stage_scoped,
            },
        )
    ).scalar_one()


@pytest.mark.parametrize("stage_scoped", [False, True])
async def test_active_withdrawal_requires_matching_participation_to_end(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID], stage_scoped: bool
) -> None:
    with pytest.raises(
        IntegrityError, match="withdrawal requires participation to end"
    ):
        async with db_session.begin_nested():
            await _insert_active_withdrawal(
                db_session, drawn_history, stage_scoped=stage_scoped
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("stage_scoped", [False, True])
async def test_withdrawal_closure_matches_its_scope_across_stages(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID], stage_scoped: bool
) -> None:
    other_period_id = (
        await db_session.execute(
            text(
                "WITH stage AS (INSERT INTO tournament_event_stages "
                "(event_id,position,draw_type_id) SELECT event_id,100,draw_type_id "
                "FROM tournament_event_stages WHERE id=(SELECT stage_id FROM "
                "tournament_entry_participations WHERE id=:id) RETURNING id), "
                "stage_group AS (INSERT INTO tournament_event_stage_groups "
                "(stage_id,position) SELECT id,0 FROM stage RETURNING id,stage_id) "
                "INSERT INTO tournament_entry_participations "
                "(event_id,entry_id,stage_id,group_id,draw_revision_id) "
                "SELECT p.event_id,p.entry_id,g.stage_id,g.id,p.draw_revision_id "
                "FROM tournament_entry_participations p CROSS JOIN stage_group g "
                "WHERE p.id=:id RETURNING id"
            ),
            {"id": drawn_history["participation_id"]},
        )
    ).scalar_one()
    await _insert_active_withdrawal(
        db_session, drawn_history, stage_scoped=stage_scoped
    )
    close_period = text(
        "UPDATE tournament_entry_participations SET ended_at=clock_timestamp(),"
        "end_reason='director_removal',ended_by_account_id=:actor WHERE id=:id"
    )
    await db_session.execute(
        close_period,
        {"id": drawn_history["participation_id"], "actor": drawn_history["owner_id"]},
    )
    if not stage_scoped:
        with pytest.raises(
            IntegrityError, match="withdrawal requires participation to end"
        ):
            async with db_session.begin_nested():
                await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        await db_session.execute(
            close_period, {"id": other_period_id, "actor": drawn_history["owner_id"]}
        )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    assert (
        await db_session.scalar(
            text(
                "SELECT ended_at IS NULL FROM tournament_entry_participations "
                "WHERE id=:id"
            ),
            {"id": other_period_id},
        )
        is stage_scoped
    )


async def test_restoring_withdrawal_before_constraint_flush_uses_final_state(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    withdrawal_id = await _insert_active_withdrawal(
        db_session, drawn_history, stage_scoped=False
    )
    await db_session.execute(
        text(
            "UPDATE tournament_entry_withdrawals SET restored_at=clock_timestamp(),"
            "restored_by_account_id=:actor WHERE id=:id"
        ),
        {"actor": drawn_history["owner_id"], "id": withdrawal_id},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    assert (
        await db_session.scalar(
            text(
                "SELECT ended_at IS NULL FROM tournament_entry_participations "
                "WHERE id=:id"
            ),
            {"id": drawn_history["participation_id"]},
        )
        is True
    )


@pytest.mark.parametrize(
    "parent_table,id_key",
    [("tournaments", "tournament_id"), ("tournament_events", "event_id")],
)
async def test_parent_cascade_can_remove_pending_withdrawal_and_participation(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    parent_table: str,
    id_key: str,
) -> None:
    withdrawal_id = await _insert_active_withdrawal(
        db_session, drawn_history, stage_scoped=True
    )
    await db_session.execute(
        text(f"DELETE FROM {parent_table} WHERE id=:id"),
        {"id": drawn_history[id_key]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM tournament_entry_withdrawals WHERE id=:id"),
            {"id": withdrawal_id},
        )
        == 0
    )
