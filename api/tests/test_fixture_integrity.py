"""Fixture invariants through SQL, against metadata and fresh Alembic installs."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.models import TournamentEntry, TournamentEntryStatus
from tests.test_entry_members import entry_schema as entry_schema
from tests.test_entry_members import postgres_url as postgres_url
from tests.test_entry_members import seed_doubles_match


async def test_fixture_cannot_seat_the_same_entry_twice(db_session):
    _, _, _, _, fixture = await seed_doubles_match(db_session)
    with pytest.raises(IntegrityError, match="ck_tournament_fixtures_distinct_entries"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET entry_b_id = entry_a_id WHERE "
                    "id = :id"
                ),
                {"id": fixture.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("missing", ["a", "b", "both", "unrelated"])
async def test_winner_requires_two_known_contestants_and_must_be_one(
    db_session, missing
):
    event, _, _, _, fixture = await seed_doubles_match(db_session)
    unrelated = TournamentEntry(
        event_id=event.id, status=TournamentEntryStatus.withdrawn
    )
    db_session.add(unrelated)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="valid_winner"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET winner_entry_id = "
                    + (":winner" if missing == "unrelated" else "entry_a_id")
                    + (", entry_a_id = NULL" if missing in ("a", "both") else "")
                    + (", entry_b_id = NULL" if missing in ("b", "both") else "")
                    + " WHERE id = :id"
                ),
                {"id": fixture.id, "winner": unrelated.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("side", ["a", "b"])
async def test_fixture_rejects_a_contestant_from_another_event(db_session, side):
    _, _, _, _, fixture = await seed_doubles_match(db_session)
    from tests.test_tournament_fixtures import _make_event

    other = await _make_event(db_session)
    entrant = TournamentEntry(event_id=other.id, status=TournamentEntryStatus.withdrawn)
    db_session.add(entrant)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="fixture.*entry_" + side):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    f"UPDATE tournament_fixtures SET entry_{side}_id = :entry "
                    "WHERE id = :id"
                ),
                {"id": fixture.id, "entry": entrant.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_fixture_table_must_belong_to_its_tournament(db_session):
    from app.models import VenueTable
    from tests.test_tournament_fixtures import _make_event

    _, _, _, _, fixture = await seed_doubles_match(db_session)
    other = await _make_event(db_session)
    table = VenueTable(
        tournament_id=other.tournament_id,
        label="Foreign table",
        court="Hall",
        position=0,
    )
    db_session.add(table)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="fixture.*table"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE tournament_fixtures SET table_id = :table WHERE id = :id"),
                {"id": fixture.id, "table": table.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_a_match_cannot_be_attached_to_two_fixtures(db_session):
    _, _, _, _, fixture = await seed_doubles_match(db_session)
    with pytest.raises(IntegrityError, match="fixture.*match"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO tournament_fixtures "
                    "(stage_id, group_id, round, position, entry_a_id, entry_b_id, "
                    "match_id) "
                    "SELECT stage_id, group_id, round, position + 1, entry_a_id, "
                    "entry_b_id, match_id "
                    "FROM tournament_fixtures WHERE id = :id"
                ),
                {"id": fixture.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize(
    "change",
    [
        "match_id = NULL",
        "entry_a_id = entry_b_id, entry_b_id = entry_a_id",
        "group_id = :group",
    ],
)
async def test_recorded_play_freezes_fixture_ownership(db_session, change):
    event, _, _, match, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    # A later terminal status must not erase the recorded lineup.
    await db_session.execute(
        text("UPDATE matches SET status = 'voided' WHERE id = :id"), {"id": match.id}
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="recorded match fixture must be retained"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE tournament_fixtures SET " + change + " WHERE id = :id"),
                {"id": fixture.id, "group": event.groups[1].id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_detachment_cannot_commit_during_a_concurrent_match_start(
    db_session, engine
):
    import asyncio

    _, _, _, match, fixture = await seed_doubles_match(db_session)
    ready = asyncio.Event()

    async def detach():
        try:
            async with engine.begin() as connection:
                ready.set()
                await connection.execute(
                    text(
                        "UPDATE tournament_fixtures SET match_id = NULL WHERE id = :id"
                    ),
                    {"id": fixture.id},
                )
            return True
        except IntegrityError as exc:
            assert "recorded match fixture must be retained" in str(exc)
            return False
        except DBAPIError as exc:
            assert exc.orig.sqlstate == "40001"
            return False

    async with engine.connect() as starter:
        transaction = await starter.begin()
        await starter.execute(
            text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
            {"id": match.id},
        )
        await starter.execute(text("SET CONSTRAINTS capture_match_lineup IMMEDIATE"))
        await starter.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        contender = asyncio.create_task(detach())
        try:
            await asyncio.wait_for(ready.wait(), 5)
            completed, _ = await asyncio.wait([contender], timeout=0.15)
            if completed:
                assert await contender is False, "a racing detach must not commit"
        finally:
            await transaction.commit()
            detached = await asyncio.wait_for(contender, 5)
    assert not detached
    assert (
        await db_session.scalar(
            text("SELECT match_id FROM tournament_fixtures WHERE id = :id"),
            {"id": fixture.id},
        )
        == match.id
    )


async def test_recorded_play_cannot_move_to_another_draw_position(db_session):
    _, _, _, match, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="recorded match fixture must be retained"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET round = round + 1, position = "
                    "position + 1 WHERE id = :id"
                ),
                {"id": fixture.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("known_sides", [0, 1, 2])
async def test_undecided_fixtures_allow_tbd_sides(db_session, known_sides):
    _, _, _, _, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text(
            "UPDATE tournament_fixtures SET match_id = NULL, "
            "entry_a_id = CASE WHEN :known >= 1 THEN entry_a_id END, "
            "entry_b_id = CASE WHEN :known >= 2 THEN entry_b_id END WHERE id = :id"
        ),
        {"id": fixture.id, "known": known_sides},
    )
    await db_session.commit()


@pytest.mark.parametrize("winner", ["entry_a_id", "entry_b_id"])
async def test_walkover_can_name_a_withdrawn_winner_without_a_match(db_session, winner):
    _, _, entries, _, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text("UPDATE tournament_entries SET status = 'withdrawn' WHERE id = :id"),
        {"id": entries[0].id},
    )
    await db_session.execute(
        text(
            "UPDATE tournament_fixtures SET match_id = NULL, "
            f"winner_entry_id = {winner} "
            "WHERE id = :id"
        ),
        {"id": fixture.id},
    )
    await db_session.commit()
    assert await db_session.scalar(
        text("SELECT winner_entry_id FROM tournament_fixtures WHERE id = :id"),
        {"id": fixture.id},
    ) == (entries[0].id if winner == "entry_a_id" else entries[1].id)


async def test_historical_placement_does_not_require_a_current_reservation(db_session):
    from app.models import VenueTable

    event, _, _, match, fixture = await seed_doubles_match(db_session)
    table = VenueTable(
        tournament_id=event.tournament_id, label="Historical", court="Hall", position=0
    )
    db_session.add(table)
    await db_session.commit()
    await db_session.execute(
        text(
            "INSERT INTO tournament_event_reservation_tables "
            "(tournament_id, event_id, reservation_id, table_id, position) "
            "SELECT :tournament, event_id, id, :table, 0 "
            "FROM tournament_event_reservations WHERE event_id = :event LIMIT 1"
        ),
        {"tournament": event.tournament_id, "event": event.id, "table": table.id},
    )
    assert (
        await db_session.scalar(
            text(
                "SELECT count(*) FROM tournament_event_reservation_tables "
                "WHERE table_id = :table"
            ),
            {"table": table.id},
        )
        == 1
    )
    await db_session.execute(
        text("UPDATE tournament_fixtures SET table_id = :table WHERE id = :id"),
        {"id": fixture.id, "table": table.id},
    )
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    await db_session.execute(
        text("DELETE FROM tournament_event_reservation_tables WHERE table_id = :table"),
        {"table": table.id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT table_id FROM tournament_fixtures WHERE id = :id"),
            {"id": fixture.id},
        )
        == table.id
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE tournament_event_stages SET event_id = :other_event WHERE id = :stage",
        "UPDATE tournament_events SET tournament_id = :other_tournament"
        " WHERE id = :event",
        "UPDATE tournament_event_stage_groups SET stage_id = "
        ":other_stage WHERE id = :group",
        "UPDATE tournament_fixtures SET stage_id = :other_stage, "
        "group_id = :other_group WHERE id = :fixture",
        "UPDATE tournament_fixtures SET scope_event_id = :other_event "
        "WHERE id = :fixture",
        "UPDATE tournament_fixtures SET scope_tournament_id = "
        ":other_tournament WHERE id = :fixture",
        "DELETE FROM tournament_fixtures WHERE id = :fixture",
    ],
)
async def test_played_fixture_ownership_cannot_change_through_parents_or_scope_keys(
    db_session, mutation
):
    from tests.test_tournament_fixtures import _make_event

    event, _, _, match, fixture = await seed_doubles_match(db_session)
    other = await _make_event(db_session)
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(mutation),
                {
                    "other_event": other.id,
                    "other_tournament": other.tournament_id,
                    "other_stage": other.stages[0].id,
                    "other_group": other.groups[0].id,
                    "fixture": fixture.id,
                    "stage": event.stages[0].id,
                    "event": event.id,
                    "group": event.groups[0].id,
                },
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_unplayed_fixture_can_move_to_another_group_and_replace_its_match(
    db_session,
):
    event, _, _, match, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text(
            "UPDATE tournament_fixtures SET match_id = NULL, group_id = "
            ":group WHERE id = :id"
        ),
        {"id": fixture.id, "group": event.groups[1].id},
    )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE tournament_fixtures SET match_id = :match WHERE id = :id"),
        {"id": fixture.id, "match": match.id},
    )
    await db_session.commit()


async def test_late_attachment_cannot_bypass_lineup_membership(db_session):
    _, _, _, match, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text("UPDATE tournament_fixtures SET match_id = NULL WHERE id = :id"),
        {"id": fixture.id},
    )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="participant"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET match_id = :match, "
                    "entry_a_id = entry_b_id, entry_b_id = entry_a_id WHERE id = :id"
                ),
                {"id": fixture.id, "match": match.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_attachment_waits_for_start_and_captures_the_lineup(db_session, engine):
    import asyncio

    _, _, _, match, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text("UPDATE tournament_fixtures SET match_id = NULL WHERE id = :id"),
        {"id": fixture.id},
    )
    await db_session.commit()
    ready = asyncio.Event()

    async def attach():
        async with engine.begin() as connection:
            ready.set()
            await connection.execute(
                text("UPDATE tournament_fixtures SET match_id = :match WHERE id = :id"),
                {"id": fixture.id, "match": match.id},
            )

    async with engine.connect() as starter:
        transaction = await starter.begin()
        await starter.execute(
            text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
            {"id": match.id},
        )
        await starter.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        contender = asyncio.create_task(attach())
        try:
            await asyncio.wait_for(ready.wait(), 5)
            completed, _ = await asyncio.wait([contender], timeout=0.15)
            assert not completed, "attachment must serialize with match start"
        finally:
            await transaction.commit()
            await asyncio.wait_for(contender, 5)
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_lineups WHERE match_id = :id"),
            {"id": match.id},
        )
        == 1
    )


async def test_unplayed_fixture_can_move_then_start_in_one_transaction(db_session):
    event, _, _, match, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text("UPDATE tournament_fixtures SET group_id = :group WHERE id = :id"),
        {"id": fixture.id, "group": event.groups[1].id},
    )
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_lineups WHERE match_id = :id"),
            {"id": match.id},
        )
        == 1
    )


async def test_pristine_uncall_keeps_the_fixture_editable(db_session):
    event, _, _, match, fixture = await seed_doubles_match(db_session)
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE matches SET status = 'pending' WHERE id = :id"),
        {"id": match.id},
    )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE tournament_fixtures SET group_id = :group WHERE id = :id"),
        {"id": fixture.id, "group": event.groups[1].id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT group_id FROM tournament_fixtures WHERE id = :id"),
            {"id": fixture.id},
        )
        == event.groups[1].id
    )
