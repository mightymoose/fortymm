"""Entry membership is a database interface; HTTP remains singles-only."""

import asyncio
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.account_merge import merge_user
from app.db import Base
from app.models import (
    EventFormat,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryMember,
    TournamentFixture,
    TournamentStatus,
)
from tests._helpers import make_user, start_session
from tests.test_tournament_entries import _entries_url, _make_event
from tests.test_tournament_fixtures import _make_event as make_drawn_event


@pytest.fixture(scope="session", params=["metadata", "alembic"])
def entry_schema(request):
    # Parametrize schema selection, not the postgres_url override itself: the
    # latter also keys its inherited fixture and restarts the shared container,
    # stranding the application's cached engine on a stopped port in later tests.
    return request.param


@pytest_asyncio.fixture(scope="session")
async def postgres_url(postgres_url, entry_schema):
    """Every integrity scenario runs against ORM DDL and a real fresh migration."""
    database = "entry_members_" + uuid.uuid4().hex
    url = make_url(postgres_url).set(database=database)
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{database}"'))
    try:
        if entry_schema == "metadata":
            metadata_engine = create_async_engine(url)
            try:
                async with metadata_engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
            finally:
                await metadata_engine.dispose()
        if entry_schema == "alembic":
            installed = subprocess.run(
                [sys.executable, "-m", "alembic", "upgrade", "head"],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                timeout=60,
                env={
                    **os.environ,
                    "DATABASE_URL": url.render_as_string(hide_password=False),
                },
            )
            assert installed.returncode == 0, installed.stderr
            migrated = create_async_engine(url)
            # The shared fixtures supply their own catalogue seeds in both modes.
            async with migrated.begin() as connection:
                for table in reversed(Base.metadata.sorted_tables):
                    await connection.execute(table.delete())
            await migrated.dispose()
        yield url.render_as_string(hide_password=False)
    finally:
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE "{database}" WITH (FORCE)'))
        await admin.dispose()


async def test_singles_registration_stores_a_player_member(api_client, db_session):
    player = await start_session(api_client, db_session)
    event = await _make_event(db_session)
    response = await api_client.post(_entries_url(event))
    assert response.status_code == 201, response.text
    entry = response.json()
    assert entry["user_id"] == str(player.player_id)
    members = (
        (
            await db_session.execute(
                text(
                    "SELECT player_id FROM tournament_entry_members WHERE entry_id "
                    "= :id"
                ),
                {"id": entry["id"]},
            )
        )
        .scalars()
        .all()
    )
    assert members == [player.player_id]


async def test_a_player_can_enter_multiple_events_but_not_twice_in_one(
    api_client, db_session
):
    await start_session(api_client, db_session)
    first = await _make_event(db_session)
    second = await _make_event(db_session)
    second.tournament_id = first.tournament_id
    await db_session.commit()
    first_url, second_url = _entries_url(first), _entries_url(second)
    assert (await api_client.post(first_url)).status_code == 201
    assert (await api_client.post(second_url)).status_code == 201
    duplicate = await api_client.post(first_url)
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "already_entered"


async def test_format_edit_refuses_incompatible_existing_members(
    api_client, db_session
):
    from app.models import DrawType
    from app.tournament_event_stages import mint_stages

    actor = await start_session(api_client, db_session)
    event = await _make_event(db_session)
    event.stages = mint_stages(DrawType.single_elim)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.owner_account_id = actor.id
    await db_session.commit()
    assert (await api_client.post(_entries_url(event))).status_code == 201
    response = await api_client.patch(
        f"/v1/tournaments/{tournament.id}/events/{event.id}",
        json={"format": "doubles", "lock_version": event.lock_version},
    )
    assert response.status_code == 409, response.text
    assert "existing entry membership" in response.json()["detail"]
    await db_session.refresh(event)
    assert event.format is EventFormat.singles


async def test_team_event_can_explicitly_allow_multiple_entries(db_session):
    event = await _make_event(db_session, format=EventFormat.teams)
    player = await make_user(db_session, "team-player")
    event.allow_multiple_entries_per_player = True
    db_session.add_all(
        [
            TournamentEntry(event_id=event.id, user_id=player.player_id),
            TournamentEntry(event_id=event.id, user_id=player.player_id),
        ]
    )
    await db_session.commit()
    # Even the permissive team rule never permits two current member rows
    # for the same Player within one entry.
    entry_id = await db_session.scalar(
        text("SELECT id FROM tournament_entries LIMIT 1")
    )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                TournamentEntryMember(entry_id=entry_id, player_id=player.player_id)
            )
            await db_session.flush()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("through_alias", [False, True])
async def test_permissive_team_still_rejects_merged_duplicates_within_one_entry(
    db_session, through_alias
):
    event = await _make_event(db_session, format=EventFormat.teams)
    event.allow_multiple_entries_per_player = True
    players = [await make_user(db_session, f"same-team-{n}") for n in range(2)]
    db_session.add(
        TournamentEntry(
            event_id=event.id,
            members=[TournamentEntryMember(player_id=p.player_id) for p in players],
        )
    )
    await db_session.commit()
    source_account_id = players[0].id
    if through_alias:
        successor = await make_user(db_session, "same-team-successor")
        await merge_user(
            db_session, from_user_id=source_account_id, to_user_id=successor.id
        )
        await db_session.commit()
        source_account_id = successor.id
    with pytest.raises(IntegrityError, match="duplicate.*member"):
        async with db_session.begin_nested():
            await merge_user(
                db_session, from_user_id=source_account_id, to_user_id=players[1].id
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_reentry_and_identity_merge_share_event_before_player_lock_order(
    db_session, engine
):
    from app.models import TournamentEntryStatus

    event = await _make_event(db_session)
    source = await make_user(db_session, "reentry-source")
    target = await make_user(db_session, "reentry-target")
    db_session.add(
        TournamentEntry(
            event_id=event.id,
            user_id=source.player_id,
            status=TournamentEntryStatus.withdrawn,
        )
    )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as registration, sessions() as merger:
        registration_pid = await registration.scalar(text("SELECT pg_backend_pid()"))
        merger_pid = await merger.scalar(text("SELECT pg_backend_pid()"))
        entry_id = await registration.scalar(
            text(
                "INSERT INTO tournament_entries (event_id) VALUES (:event) RETURNING id"
            ),
            {"event": event.id},
        )
        merge_task = asyncio.create_task(
            merge_user(merger, from_user_id=source.id, to_user_id=target.id)
        )
        try:

            async def wait_for_block():
                while registration_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": merger_pid}
                ):
                    assert not merge_task.done()
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_block(), timeout=5)
            # The member FK must still be acquirable while merge waits for the
            # event. NOWAIT exposes an inverted lock without a deadlock timeout.
            await registration.execute(
                text("SELECT id FROM players WHERE id = :id FOR KEY SHARE NOWAIT"),
                {"id": source.player_id},
            )
            await registration.execute(
                text(
                    "INSERT INTO tournament_entry_members (entry_id, player_id) "
                    "VALUES (:entry, :player)"
                ),
                {"entry": entry_id, "player": source.player_id},
            )
            await registration.commit()
            await asyncio.wait_for(merge_task, timeout=5)
            await merger.commit()
            assert (
                await db_session.scalar(
                    text("SELECT entry_single_player(:entry)"), {"entry": entry_id}
                )
                == target.player_id
            )
        finally:
            if not merge_task.done():
                merge_task.cancel()
            await asyncio.gather(merge_task, return_exceptions=True)


@pytest.mark.parametrize("through_alias", [False, True])
async def test_identity_merge_does_not_validate_unrelated_deferred_entry_changes(
    db_session, through_alias
):
    affected = await _make_event(db_session)
    unrelated = await _make_event(db_session)
    source = await make_user(db_session, "scoped-source")
    target = await make_user(db_session, "scoped-target")
    other = await make_user(db_session, "scoped-other")
    registered_player = source.player_id
    if through_alias:
        alias = await make_user(db_session, "scoped-alias")
        registered_player = alias.player_id
        await merge_user(db_session, from_user_id=alias.id, to_user_id=source.id)
    db_session.add(TournamentEntry(event_id=affected.id, user_id=registered_player))
    await db_session.commit()
    # An unrelated event can have a temporary duplicate during an atomic edit.
    # Checking this merge must not force that event's deferred checks early.
    db_session.add_all(
        [
            TournamentEntry(event_id=unrelated.id, user_id=other.player_id)
            for _ in range(2)
        ]
    )
    await db_session.flush()
    await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)
    await db_session.execute(
        text("SET CONSTRAINTS check_player_entry_events IMMEDIATE")
    )
    # The unrelated event still has its own integrity checks; they were scoped,
    # not disabled. Never commit its deliberately unfinished edit.
    with pytest.raises(IntegrityError, match="player already entered"):
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.rollback()


@pytest.mark.parametrize("has_collision", [False, True])
async def test_merge_collision_lookup_ignores_unrelated_identity_edits(
    db_session, has_collision
):
    event = await _make_event(db_session)
    source = await make_user(db_session, "lookup-source")
    target = await make_user(db_session, "lookup-target")
    others = [await make_user(db_session, f"lookup-other-{n}") for n in range(2)]
    db_session.add(TournamentEntry(event_id=event.id, user_id=others[0].player_id))
    await db_session.commit()
    if has_collision:
        affected = await _make_event(db_session)
        db_session.add_all(
            [
                TournamentEntry(event_id=affected.id, user_id=p.player_id)
                for p in (source, target)
            ]
        )
        await db_session.commit()
    # An unrelated identity edit is temporarily cyclic with deferred validation.
    # Collision discovery for these two players must not evaluate that entry.
    for original, destination in [(others[0], others[1]), (others[1], others[0])]:
        await db_session.execute(
            text(
                "UPDATE players SET merged_into_player_id = :destination, "
                "merged_at = clock_timestamp() WHERE id = :original"
            ),
            {"original": original.player_id, "destination": destination.player_id},
        )
    await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)
    # Its own deferred validation still rejects the unrelated unfinished edit.
    with pytest.raises(IntegrityError, match="cyclic player identity"):
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.rollback()


async def test_dashboard_membership_lookup_ignores_unrelated_identity_edits(db_session):
    from app.dashboard_tournaments import build_tournament_panels

    event = await _make_event(db_session)
    caller = await make_user(db_session, "dashboard-caller")
    others = [await make_user(db_session, f"dashboard-other-{n}") for n in range(2)]
    db_session.add(TournamentEntry(event_id=event.id, user_id=others[0].player_id))
    await db_session.commit()
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.live
    await db_session.commit()
    for original, destination in [(others[0], others[1]), (others[1], others[0])]:
        await db_session.execute(
            text(
                "UPDATE players SET merged_into_player_id = :destination, "
                "merged_at = clock_timestamp() WHERE id = :original"
            ),
            {"original": original.player_id, "destination": destination.player_id},
        )
    assert await build_tournament_panels(db_session, caller.player_id) == []
    with pytest.raises(IntegrityError, match="cyclic player identity"):
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.rollback()


@pytest.mark.parametrize("doubles", [False, True])
async def test_dashboard_preserves_single_player_projection_after_identity_merge(
    db_session, doubles
):
    from app.dashboard_tournaments import build_tournament_panels

    event = await _make_event(db_session)
    original = await make_user(db_session, "dashboard-original")
    caller = await make_user(db_session, "dashboard-survivor")
    members = [TournamentEntryMember(player_id=original.player_id)]
    if doubles:
        event.format = EventFormat.doubles
        partner = await make_user(db_session, "dashboard-partner")
        members.append(TournamentEntryMember(player_id=partner.player_id))
    db_session.add(TournamentEntry(event_id=event.id, members=members))
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE players SET merged_into_player_id = :destination, "
            "merged_at = clock_timestamp() WHERE id = :original"
        ),
        {"original": original.player_id, "destination": caller.player_id},
    )
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.live
    await db_session.commit()
    panels = await build_tournament_panels(db_session, caller.player_id)
    assert [panel.id for panel in panels] == ([] if doubles else [tournament.id])


@pytest.mark.parametrize("exclusive_collision", [False, True])
async def test_merge_preserves_distinct_entries_in_a_permissive_team_event(
    db_session, exclusive_collision
):
    event = await _make_event(db_session, format=EventFormat.teams)
    event.allow_multiple_entries_per_player = True
    players = [await make_user(db_session, f"cross-team-{n}") for n in range(2)]
    entries = [TournamentEntry(event_id=event.id, user_id=p.player_id) for p in players]
    db_session.add_all(entries)
    await db_session.commit()
    if exclusive_collision:
        singles = await _make_event(db_session)
        db_session.add_all(
            [TournamentEntry(event_id=singles.id, user_id=p.player_id) for p in players]
        )
        await db_session.commit()
    await merge_user(db_session, from_user_id=players[0].id, to_user_id=players[1].id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text(
                "SELECT count(*) FROM tournament_entries WHERE status = 'entered' "
                "AND event_id = :event"
            ),
            {"event": event.id},
        )
        == 2
    )


async def test_director_correction_adds_a_revision_without_rewriting_original(
    db_session,
):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    event.format = EventFormat.teams
    alternate = TournamentEntryMember(player_id=players[4].player_id)
    entries[0].members.append(alternate)
    await db_session.commit()
    match.status = MatchStatus.in_progress
    await db_session.commit()
    original_id = await db_session.scalar(
        text("SELECT id FROM match_lineups WHERE match_id = :id"), {"id": match.id}
    )
    correction_savepoint = await db_session.begin_nested()
    corrected_id = await db_session.scalar(
        text(
            "INSERT INTO match_lineups (match_id, revision, started_at, "
            "recorded_by_account_id, correction_reason) "
            "SELECT match_id, 2, started_at, :actor, 'Wrong team member recorded' "
            "FROM match_lineups WHERE id = :id RETURNING id"
        ),
        {"id": original_id, "actor": match.created_by_user_id},
    )
    await db_session.execute(
        text(
            "INSERT INTO match_lineup_players (lineup_id, side_number, player_id, "
            "entry_member_id) "
            "SELECT :new, side_number, CASE WHEN player_id = :old_player THEN "
            ":new_player ELSE player_id END, "
            "CASE WHEN player_id = :old_player THEN :member ELSE entry_member_id END "
            "FROM match_lineup_players WHERE lineup_id = :old"
        ),
        {
            "new": corrected_id,
            "old": original_id,
            "old_player": players[0].player_id,
            "new_player": players[4].player_id,
            "member": alternate.id,
        },
    )
    await correction_savepoint.commit()
    await db_session.commit()
    recorded = (
        await db_session.execute(
            text(
                "SELECT l.revision, p.player_id FROM match_lineups l "
                "JOIN match_lineup_players p ON p.lineup_id = l.id WHERE l.match_id "
                "= :id"
            ),
            {"id": match.id},
        )
    ).all()
    assert {p for rev, p in recorded if rev == 1} == {p.player_id for p in players[:4]}
    assert {p for rev, p in recorded if rev == 2} == {p.player_id for p in players[1:]}
    with pytest.raises(IntegrityError, match="lineup history"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE match_lineup_players SET side_number = 2 "
                    "WHERE lineup_id = :id AND player_id = :player"
                ),
                {"id": original_id, "player": players[0].player_id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_membership_join_time_is_when_the_member_is_inserted(db_session):
    event = await _make_event(db_session)
    player = await make_user(db_session, "late-join")
    # Start the transaction, then record a later wall-clock boundary before insert.
    await db_session.execute(text("SELECT transaction_timestamp()"))
    boundary = await db_session.scalar(text("SELECT clock_timestamp()"))
    entry = TournamentEntry(event_id=event.id, user_id=player.player_id)
    db_session.add(entry)
    await db_session.commit()
    assert entry.members[0].joined_at >= boundary


async def test_partner_replacement_keeps_membership_history_and_entry(db_session):
    event = await _make_event(db_session, format=EventFormat.doubles)
    players = [await make_user(db_session, f"partner-{n}") for n in range(3)]
    original = TournamentEntryMember(player_id=players[0].player_id)
    entry = TournamentEntry(
        event_id=event.id,
        seed=3,
        members=[
            original,
            TournamentEntryMember(player_id=players[1].player_id),
        ],
    )
    db_session.add(entry)
    await db_session.commit()
    original.left_at = datetime.now(UTC)
    entry.members.append(TournamentEntryMember(player_id=players[2].player_id))
    await db_session.commit()
    assert entry.seed == 3
    rows = (
        await db_session.execute(
            text(
                "SELECT player_id, left_at FROM tournament_entry_members WHERE "
                "entry_id = :id"
            ),
            {"id": entry.id},
        )
    ).all()
    assert len(rows) == 3
    assert {p for p, left in rows if left is None} == {
        players[1].player_id,
        players[2].player_id,
    }
    with pytest.raises(IntegrityError, match="membership history"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_entry_members SET player_id = :player WHERE "
                    "id = :id"
                ),
                {"id": original.id, "player": players[2].player_id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize(
    "format,count",
    [
        (EventFormat.singles, 0),
        (EventFormat.singles, 2),
        (EventFormat.doubles, 0),
        (EventFormat.doubles, 1),
        (EventFormat.doubles, 3),
    ],
)
async def test_active_entry_requires_format_member_count(db_session, format, count):
    event = await _make_event(db_session, format=format)
    players = [await make_user(db_session, f"member-{n}") for n in range(count)]
    with pytest.raises(IntegrityError, match="member count"):
        async with db_session.begin_nested():
            db_session.add(
                TournamentEntry(
                    event_id=event.id,
                    members=[
                        TournamentEntryMember(player_id=p.player_id) for p in players
                    ],
                )
            )
            await db_session.flush()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def seed_doubles_match(db_session):
    event = await make_drawn_event(db_session)
    event.format = EventFormat.doubles
    players = [await make_user(db_session, f"lineup-{n}") for n in range(5)]
    entries = [
        TournamentEntry(
            event_id=event.id,
            seed=n + 1,
            members=[
                TournamentEntryMember(player_id=p.player_id)
                for p in players[n * 2 : n * 2 + 2]
            ],
        )
        for n in range(2)
    ]
    db_session.add_all(entries)
    await db_session.commit()
    tournament = await db_session.get(Tournament, event.tournament_id)
    match = Match(
        league_id=tournament.league_id,
        created_by_user_id=tournament.owner_account_id,
        status=MatchStatus.pending,
        match_settings=MatchSettings(team_size=2, best_of=5, affects_rating=False),
    )
    for n in range(2):
        side = MatchSide(match=match, side_number=n + 1)
        side.players = [
            MatchSidePlayer(match=match, user_id=p.player_id)
            for p in players[n * 2 : n * 2 + 2]
        ]
    db_session.add(match)
    await db_session.flush()
    fixture = TournamentFixture(
        stage_id=event.stages[0].id,
        group_id=event.groups[0].id,
        round=1,
        position=1,
        entry_a_id=entries[0].id,
        entry_b_id=entries[1].id,
        match_id=match.id,
    )
    db_session.add(fixture)
    await db_session.commit()
    return event, players, entries, match, fixture


@pytest.mark.parametrize("manual_lineup", [False, True])
async def test_first_lineup_waits_for_roster_replacement(
    db_session, engine, manual_lineup
):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as roster, sessions() as capture:
        roster_pid = await roster.scalar(text("SELECT pg_backend_pid()"))
        capture_pid = await capture.scalar(text("SELECT pg_backend_pid()"))
        await roster.execute(
            text(
                "UPDATE tournament_entry_members SET left_at = clock_timestamp() "
                "WHERE id = :id"
            ),
            {"id": entries[0].members[0].id},
        )
        await roster.execute(
            text(
                "INSERT INTO tournament_entry_members (entry_id, player_id) "
                "VALUES (:entry, :player)"
            ),
            {"entry": entries[0].id, "player": players[4].player_id},
        )
        # Validate the replacement before capture is visible, but retain its
        # locks. Neither transaction may commit based on the other's old state.
        await roster.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        await capture.execute(
            text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
            {"id": match.id},
        )

        async def record_lineup():
            if manual_lineup:
                lineup_id = await capture.scalar(
                    text(
                        "INSERT INTO match_lineups (match_id) VALUES (:id) RETURNING id"
                    ),
                    {"id": match.id},
                )
                await capture.execute(
                    text(
                        "INSERT INTO match_lineup_players "
                        "(lineup_id, side_number, entry_member_id, player_id) "
                        "SELECT :lineup, CASE WHEN entry_id = :a THEN 1 ELSE 2 END, "
                        "id, player_id FROM tournament_entry_members "
                        "WHERE id = ANY(:ids)"
                    ),
                    {
                        "lineup": lineup_id,
                        "a": entries[0].id,
                        "ids": [m.id for entry in entries for m in entry.members],
                    },
                )
            await capture.commit()

        capture_task = asyncio.create_task(record_lineup())
        try:

            async def wait_for_block():
                while roster_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": capture_pid}
                ):
                    assert not capture_task.done(), "capture bypassed the roster edit"
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_block(), timeout=5)
            await roster.commit()
            # The scheduled side still names the departed member. Refuse the
            # stale start rather than recording an ineligible played lineup.
            with pytest.raises(
                IntegrityError, match="current entry member|at match start"
            ):
                await capture_task
        finally:
            if not capture_task.done():
                capture_task.cancel()
            await asyncio.gather(capture_task, return_exceptions=True)


@pytest.mark.parametrize("status", ["in_progress", "completed"])
async def test_fixture_attaching_an_already_played_match_captures_history(
    db_session, status
):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    fixture.match_id = None
    await db_session.commit()
    await db_session.execute(
        text("UPDATE matches SET status = :status WHERE id = :id"),
        {"id": match.id, "status": status},
    )
    await db_session.commit()
    assert await db_session.scalar(text("SELECT count(*) FROM match_lineups")) == 0
    await db_session.execute(
        text("UPDATE tournament_fixtures SET match_id = :match WHERE id = :id"),
        {"match": match.id, "id": fixture.id},
    )
    await db_session.commit()
    assert set(
        await db_session.scalars(text("SELECT player_id FROM match_lineup_players"))
    ) == {player.player_id for player in players[:4]}


async def test_a_match_can_belong_to_only_one_fixture(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    second = TournamentFixture(
        stage_id=fixture.stage_id,
        group_id=fixture.group_id,
        round=1,
        position=2,
    )
    third = TournamentFixture(
        stage_id=fixture.stage_id,
        group_id=fixture.group_id,
        round=1,
        position=3,
    )
    db_session.add_all([second, third])
    await db_session.commit()
    with pytest.raises(IntegrityError, match="ix_tournament_fixtures_match_id"):
        async with db_session.begin_nested():
            second.match_id = match.id
            await db_session.flush()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_pending_match_cannot_record_a_complete_played_lineup(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    with pytest.raises(IntegrityError, match="lineup requires a started match"):
        async with db_session.begin_nested():
            lineup_id = await db_session.scalar(
                text("INSERT INTO match_lineups (match_id) VALUES (:id) RETURNING id"),
                {"id": match.id},
            )
            await db_session.execute(
                text(
                    "INSERT INTO match_lineup_players "
                    "(lineup_id, side_number, entry_member_id, player_id) "
                    "SELECT :lineup, CASE WHEN entry_id = :a THEN 1 ELSE 2 END, "
                    "id, player_id FROM tournament_entry_members "
                    "WHERE entry_id IN (:a, :b) AND left_at IS NULL"
                ),
                {"lineup": lineup_id, "a": entries[0].id, "b": entries[1].id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("commit_call", [False, True])
async def test_cancelling_an_untouched_call_resets_its_provisional_lineup(
    db_session, commit_call
):
    from app.match_calls import apply_manual_placement
    from app.models import User
    from app.tournament_events import delete_event
    from app.tournament_retention import require_no_recorded_play

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    tournament = await db_session.get(Tournament, event.tournament_id)
    match.status = MatchStatus.in_progress
    if commit_call:
        await db_session.commit()
        assert await db_session.scalar(text("SELECT count(*) FROM match_lineups")) == 1
    else:
        await db_session.flush()
    await apply_manual_placement(
        db_session,
        tournament,
        fixture,
        table_id=None,
        scheduled_start=None,
        event_timezone="America/Chicago",
    )
    await db_session.commit()
    assert match.status is MatchStatus.pending
    assert await db_session.scalar(text("SELECT count(*) FROM match_lineups")) == 0
    await require_no_recorded_play(db_session, tournament_id=tournament.id)
    owner = await db_session.get(User, tournament.owner_account_id)
    await delete_event(
        db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
    )


@pytest.mark.parametrize("commit_cancellation", [False, True])
async def test_recalling_an_untouched_match_captures_the_replacement(
    db_session, commit_cancellation
):
    from app.match_calls import apply_manual_placement

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    tournament = await db_session.get(Tournament, event.tournament_id)
    match.status = MatchStatus.in_progress
    await db_session.commit()
    await apply_manual_placement(
        db_session,
        tournament,
        fixture,
        table_id=None,
        scheduled_start=None,
        event_timezone="America/Chicago",
    )
    if commit_cancellation:
        await db_session.commit()
    entries[0].members[0].left_at = datetime.now(UTC)
    entries[0].members.append(TournamentEntryMember(player_id=players[4].player_id))
    await db_session.execute(
        text(
            "UPDATE match_side_players SET user_id = :replacement "
            "WHERE match_id = :match AND user_id = :original"
        ),
        {
            "replacement": players[4].player_id,
            "match": match.id,
            "original": players[0].player_id,
        },
    )
    match.status = MatchStatus.in_progress
    await db_session.commit()
    recorded = set(
        (
            await db_session.scalars(text("SELECT player_id FROM match_lineup_players"))
        ).all()
    )
    assert recorded == {player.player_id for player in players[1:]}


@pytest.mark.parametrize("evidence", ["game", "result"])
async def test_uncall_cannot_discard_lineup_before_later_play_evidence(
    db_session, evidence
):
    from app.models import MatchGame, MatchResult

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    match.status = MatchStatus.in_progress
    await db_session.commit()
    original = await db_session.scalar(text("SELECT id FROM match_lineups"))
    with pytest.raises(IntegrityError, match="uncall must preserve recorded play"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE matches SET status = 'pending' WHERE id = :id"),
                {"id": match.id},
            )
            if evidence == "game":
                db_session.add(MatchGame(match_id=match.id, game_number=1))
            else:
                db_session.add(
                    MatchResult(
                        match_id=match.id, submitted_by_user_id=players[0].id, games=[]
                    )
                )
            await db_session.flush()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    assert await db_session.scalar(text("SELECT id FROM match_lineups")) == original


@pytest.mark.parametrize("evidence", ["game", "result"])
async def test_cancelling_a_call_with_play_keeps_its_lineup(db_session, evidence):
    from app.match_calls import apply_manual_placement
    from app.models import MatchGame, MatchResult
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_retention import require_no_recorded_play

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    tournament = await db_session.get(Tournament, event.tournament_id)
    match.status = MatchStatus.in_progress
    if evidence == "game":
        db_session.add(MatchGame(match_id=match.id, game_number=1))
    else:
        db_session.add(
            MatchResult(match_id=match.id, submitted_by_user_id=players[0].id, games=[])
        )
    await db_session.commit()
    original = await db_session.scalar(text("SELECT id FROM match_lineups"))
    await apply_manual_placement(
        db_session,
        tournament,
        fixture,
        table_id=None,
        scheduled_start=None,
        event_timezone="America/Chicago",
    )
    await db_session.commit()
    assert match.status is MatchStatus.in_progress
    assert await db_session.scalar(text("SELECT id FROM match_lineups")) == original
    with pytest.raises(RecordedPlayDeletionError):
        await require_no_recorded_play(db_session, tournament_id=tournament.id)
    with pytest.raises(IntegrityError, match="lineup history"):
        async with db_session.begin_nested():
            await db_session.execute(text("DELETE FROM match_lineups"))


@pytest.mark.parametrize("target", ["event", "tournament"])
@pytest.mark.parametrize("capture_kind", ["status", "lineup", "game", "result"])
async def test_deletion_racing_first_lineup_reports_recorded_play(
    db_session, engine, target, capture_kind
):
    from app.models import MatchGame, MatchResult, User
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_events import delete_event
    from app.tournament_lifecycle import delete_tournament

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as capture, sessions() as deletion:
        capture_pid = await capture.scalar(text("SELECT pg_backend_pid()"))
        delete_pid = await deletion.scalar(text("SELECT pg_backend_pid()"))
        actor = await deletion.get(User, match.created_by_user_id)
        # First capture holds the membership FK locks but is not yet visible to
        # deletion. This is the commit-time DB path of a pending rated proposal.
        if capture_kind in ("status", "lineup"):
            await capture.execute(
                text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
                {"id": match.id},
            )
        if capture_kind == "lineup":
            lineup_id = await capture.scalar(
                text("INSERT INTO match_lineups (match_id) VALUES (:id) RETURNING id"),
                {"id": match.id},
            )
            await capture.execute(
                text(
                    "INSERT INTO match_lineup_players "
                    "(lineup_id, side_number, entry_member_id, player_id) "
                    "SELECT :lineup, CASE WHEN entry_id = :a THEN 1 ELSE 2 END, "
                    "id, player_id FROM tournament_entry_members "
                    "WHERE entry_id IN (:a, :b) AND left_at IS NULL"
                ),
                {"lineup": lineup_id, "a": entries[0].id, "b": entries[1].id},
            )
        elif capture_kind == "status":
            await capture.execute(
                text("SET CONSTRAINTS capture_match_lineup IMMEDIATE")
            )
        elif capture_kind == "game":
            capture.add(MatchGame(match_id=match.id, game_number=1))
            await capture.flush()
        else:
            capture.add(
                MatchResult(
                    match_id=match.id, submitted_by_user_id=players[0].id, games=[]
                )
            )
            await capture.flush()
        if target == "event":
            delete_task = asyncio.create_task(
                delete_event(
                    deletion,
                    tournament_id=event.tournament_id,
                    event_id=event.id,
                    actor=actor,
                )
            )
        else:
            delete_task = asyncio.create_task(
                delete_tournament(
                    deletion,
                    tournament_id=event.tournament_id,
                    actor=actor,
                )
            )
        try:

            async def wait_for_block():
                while capture_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": delete_pid}
                ):
                    assert not delete_task.done()
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_block(), timeout=5)
            await capture.commit()
            with pytest.raises(RecordedPlayDeletionError):
                await delete_task
        finally:
            if not delete_task.done():
                delete_task.cancel()
            await asyncio.gather(delete_task, return_exceptions=True)


@pytest.mark.parametrize("target", ["event", "tournament"])
@pytest.mark.parametrize("evidence", ["game", "result"])
async def test_deletion_preserves_pending_match_with_recorded_evidence(
    db_session, target, evidence
):
    from app.models import MatchGame, MatchResult, User
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_events import delete_event
    from app.tournament_lifecycle import delete_tournament

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    if evidence == "game":
        db_session.add(MatchGame(match_id=match.id, game_number=1))
    else:
        db_session.add(
            MatchResult(match_id=match.id, submitted_by_user_id=players[0].id, games=[])
        )
    await db_session.commit()
    actor = await db_session.get(User, match.created_by_user_id)
    with pytest.raises(RecordedPlayDeletionError):
        if target == "event":
            await delete_event(
                db_session,
                tournament_id=event.tournament_id,
                event_id=event.id,
                actor=actor,
            )
        else:
            await delete_tournament(
                db_session,
                tournament_id=event.tournament_id,
                actor=actor,
            )


async def test_direct_result_completion_preserves_actual_lineup(db_session):
    from app.result_proposal import propose_result
    from app.schemas.match import MatchResultsGameWrite

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    assert match.status is MatchStatus.pending
    await propose_result(
        db_session,
        match.id,
        players[0].id,
        games=[
            MatchResultsGameWrite(game_number=n, side_1_points=11, side_2_points=4)
            for n in range(1, 4)
        ],
        supersedes_result_id=None,
    )
    assert match.status is MatchStatus.completed
    assert (
        await db_session.scalar(text("SELECT count(*) FROM match_lineup_players")) == 4
    )


async def test_start_captures_actual_doubles_lineup_independent_of_roster(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    assert await db_session.scalar(text("SELECT count(*) FROM match_lineups")) == 0
    match.status = MatchStatus.in_progress
    await db_session.commit()
    before = (
        await db_session.execute(
            text(
                "SELECT p.side_number, p.player_id FROM match_lineup_players p "
                "JOIN match_lineups l ON l.id = p.lineup_id WHERE l.match_id = :id"
            ),
            {"id": match.id},
        )
    ).all()
    assert set(before) == {(n // 2 + 1, p.player_id) for n, p in enumerate(players[:4])}
    entries[0].members[0].left_at = datetime.now(UTC)
    entries[0].members.append(TournamentEntryMember(player_id=players[4].player_id))
    await db_session.commit()
    after = (
        await db_session.execute(
            text(
                "SELECT p.side_number, p.player_id FROM match_lineup_players p "
                "JOIN match_lineups l ON l.id = p.lineup_id WHERE l.match_id = :id"
            ),
            {"id": match.id},
        )
    ).all()
    assert set(after) == set(before)
    assert fixture.entry_a_id == entries[0].id
    assert entries[0].seed == 1


async def test_match_cannot_start_with_a_nonmember_participant(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    with pytest.raises(IntegrityError, match="current entry member"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE match_side_players SET user_id = :outsider "
                    "WHERE match_id = :match AND user_id = :original"
                ),
                {
                    "outsider": players[4].player_id,
                    "match": match.id,
                    "original": players[0].player_id,
                },
            )
            match.status = MatchStatus.in_progress
            await db_session.flush()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_identity_merge_before_start_keeps_original_membership(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    original_player = players[0].player_id
    await merge_user(db_session, from_user_id=players[0].id, to_user_id=players[4].id)
    await db_session.commit()
    match.status = MatchStatus.in_progress
    await db_session.commit()
    recorded = set(
        (
            await db_session.scalars(text("SELECT player_id FROM match_lineup_players"))
        ).all()
    )
    assert original_player in recorded
    assert players[4].player_id not in recorded


@pytest.mark.parametrize(
    "mutation",
    [
        "DELETE FROM match_lineups WHERE match_id = :id",
        "UPDATE match_lineups SET started_at = clock_timestamp() WHERE match_id = :id",
    ],
)
async def test_recorded_lineup_header_cannot_be_erased_or_changed(db_session, mutation):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    match.status = MatchStatus.in_progress
    await db_session.commit()
    with pytest.raises(IntegrityError, match="lineup history"):
        async with db_session.begin_nested():
            await db_session.execute(text(mutation), {"id": match.id})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_old_lineup_rejects_appends_when_transaction_status_is_unavailable(
    db_session,
):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    event.format = EventFormat.teams
    alternates = [entry.members[1] for entry in entries]
    match.match_settings.team_size = 1
    await db_session.execute(
        text("DELETE FROM match_side_players WHERE user_id IN (:first, :second)"),
        {"first": players[1].player_id, "second": players[3].player_id},
    )
    await db_session.commit()
    match.status = MatchStatus.in_progress
    await db_session.commit()
    lineup = await db_session.scalar(text("SELECT id FROM match_lineups"))
    # Increase side size so cardinality alone cannot mask a history-guard failure.
    match.match_settings.team_size = 2
    sandbox = await db_session.begin_nested()
    try:
        # Mock the external transaction-status retention boundary in this test DB,
        # without replacing PostgreSQL's builtin or touching another database.
        await db_session.execute(
            text(
                "CREATE FUNCTION public.pg_xact_status(xid8) RETURNS text "
                "LANGUAGE sql AS 'SELECT NULL::text'"
            )
        )
        await db_session.execute(text("SET LOCAL search_path = public, pg_catalog"))
        assert (
            await db_session.scalar(text("SELECT pg_xact_status(pg_current_xact_id())"))
            is None
        )
        with pytest.raises(IntegrityError, match="lineup history"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(
                        "INSERT INTO match_lineup_players "
                        "(lineup_id, side_number, entry_member_id, player_id) "
                        "SELECT :lineup, CASE WHEN id = :first THEN 1 ELSE 2 END, "
                        "id, player_id FROM tournament_entry_members "
                        "WHERE id IN (:first, :second)"
                    ),
                    {
                        "lineup": lineup,
                        "first": alternates[0].id,
                        "second": alternates[1].id,
                    },
                )
                await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    finally:
        await sandbox.rollback()


async def test_entry_cannot_be_reparented_to_another_event(db_session):
    first = await _make_event(db_session)
    second = await _make_event(db_session)
    player = await make_user(db_session, "entry-owner")
    entry = TournamentEntry(event_id=first.id, user_id=player.player_id)
    db_session.add(entry)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="entry event"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE tournament_entries SET event_id = :event WHERE id = :id"),
                {"id": entry.id, "event": second.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("parent", ["entry", "event", "tournament"])
async def test_deleting_a_parent_cannot_cascade_away_recorded_membership(
    db_session, parent
):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    match.status = MatchStatus.in_progress
    await db_session.commit()
    statement, parent_id = {
        "entry": ("DELETE FROM tournament_entries WHERE id = :id", entries[0].id),
        "event": ("DELETE FROM tournament_events WHERE id = :id", event.id),
        "tournament": ("DELETE FROM tournaments WHERE id = :id", event.tournament_id),
    }[parent]
    with pytest.raises(
        IntegrityError, match="match_lineup_players_entry_member_id_fkey"
    ):
        async with db_session.begin_nested():
            await db_session.execute(text(statement), {"id": parent_id})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    assert (
        await db_session.scalar(text("SELECT count(*) FROM match_lineup_players")) == 4
    )


@pytest.mark.parametrize("parent", ["event", "tournament"])
async def test_delete_api_refuses_recorded_play(api_client, db_session, parent):
    actor = await start_session(api_client, db_session)
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.owner_account_id = actor.id
    match.status = MatchStatus.in_progress
    await db_session.commit()
    url = f"/v1/tournaments/{tournament.id}"
    if parent == "event":
        url += f"/events/{event.id}"
    response = await api_client.delete(url)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        "Recorded play must be preserved. This event or tournament cannot be deleted."
    )
    assert (
        await db_session.scalar(text("SELECT count(*) FROM match_lineup_players")) == 4
    )


async def test_concurrent_sql_entries_serialize_and_only_one_claims_the_player(
    db_session, engine
):
    event = await _make_event(db_session)
    player = await make_user(db_session, "concurrent-member")
    event_id, player_id = event.id, player.player_id
    ready = [asyncio.Event(), asyncio.Event()]

    async def enter(index):
        try:
            async with engine.begin() as connection:
                ready[index].set()
                entry_id = await connection.scalar(
                    text(
                        "INSERT INTO tournament_entries (event_id) "
                        "VALUES (:event) RETURNING id"
                    ),
                    {"event": event_id},
                )
                await connection.execute(
                    text(
                        "INSERT INTO tournament_entry_members (entry_id, player_id) "
                        "VALUES (:entry, :player)"
                    ),
                    {"entry": entry_id, "player": player_id},
                )
            return True
        except IntegrityError:
            return False

    async with engine.connect() as gatekeeper:
        transaction = await gatekeeper.begin()
        await gatekeeper.execute(
            text("SELECT id FROM tournament_events WHERE id = :id FOR UPDATE"),
            {"id": event_id},
        )
        contenders = [asyncio.create_task(enter(i)) for i in range(2)]
        try:
            await asyncio.wait_for(asyncio.gather(*(r.wait() for r in ready)), 5)
            completed, _ = await asyncio.wait(contenders, timeout=0.1)
            assert not completed, "SQL entry writers must wait for the event lock"
        finally:
            await transaction.rollback()
            results = await asyncio.wait_for(asyncio.gather(*contenders), 5)
    assert sorted(results) == [False, True]
    assert await db_session.scalar(text("SELECT count(*) FROM tournament_entries")) == 1


async def test_membership_end_cannot_erase_eligibility_for_recorded_play(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    match.status = MatchStatus.in_progress
    await db_session.commit()
    original = entries[0].members[0]
    with pytest.raises(IntegrityError, match="membership history"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_entry_members SET left_at = joined_at "
                    "WHERE id = :id"
                ),
                {"id": original.id},
            )
            db_session.add(
                TournamentEntryMember(
                    entry_id=entries[0].id, player_id=players[4].player_id
                )
            )
            await db_session.flush()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_lineup_correction_requires_the_director(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    match.status = MatchStatus.in_progress
    await db_session.commit()
    with pytest.raises(IntegrityError, match="director"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO match_lineups (match_id, revision, started_at, "
                    "recorded_by_account_id, correction_reason) "
                    "SELECT match_id, 2, started_at, :actor, 'Correction' "
                    "FROM match_lineups WHERE match_id = :id"
                ),
                {"id": match.id, "actor": players[0].id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_format_change_racing_roster_addition_reports_format_conflict(
    db_session, engine
):
    from app.models import User
    from app.schemas.tournament import TournamentEventUpdate
    from app.tournament_errors import EventFormatMembershipError
    from app.tournament_events import update_event

    event = await make_drawn_event(db_session)
    event.format = EventFormat.teams
    players = [await make_user(db_session, f"format-race-{n}") for n in range(2)]
    entry = TournamentEntry(event_id=event.id, user_id=players[0].player_id)
    db_session.add(entry)
    await db_session.commit()
    tournament = await db_session.get(Tournament, event.tournament_id)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as roster, sessions() as editor:
        roster_pid = await roster.scalar(text("SELECT pg_backend_pid()"))
        editor_pid = await editor.scalar(text("SELECT pg_backend_pid()"))
        actor = await editor.get(User, tournament.owner_account_id)
        await roster.execute(
            text(
                "INSERT INTO tournament_entry_members (entry_id, player_id) "
                "VALUES (:entry, :player)"
            ),
            {"entry": entry.id, "player": players[1].player_id},
        )

        async def edit():
            await update_event(
                editor,
                tournament_id=event.tournament_id,
                event_id=event.id,
                actor=actor,
                updates=TournamentEventUpdate(
                    format=EventFormat.singles, lock_version=event.lock_version
                ),
            )
            await editor.commit()

        edit_task = asyncio.create_task(edit())
        try:

            async def wait_for_block():
                while roster_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": editor_pid}
                ):
                    assert not edit_task.done()
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_block(), timeout=5)
            await roster.commit()
            with pytest.raises(EventFormatMembershipError):
                await edit_task
        finally:
            if not edit_task.done():
                edit_task.cancel()
            await asyncio.gather(edit_task, return_exceptions=True)


async def test_older_transaction_cannot_bypass_live_roster_director(db_session, engine):
    event = await _make_event(db_session, format=EventFormat.teams)
    players = [await make_user(db_session, f"old-transaction-{n}") for n in range(2)]
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.live
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as older:
        await older.execute(text("SELECT transaction_timestamp()"))
        entry = TournamentEntry(event_id=event.id, user_id=players[0].player_id)
        db_session.add(entry)
        await db_session.commit()
        with pytest.raises(IntegrityError, match="director"):
            await older.execute(
                text(
                    "INSERT INTO tournament_entry_members (entry_id, player_id) "
                    "VALUES (:entry, :player)"
                ),
                {"entry": entry.id, "player": players[1].player_id},
            )


async def test_go_live_waits_for_roster_replacement(db_session, engine, default_league):
    from app.models import User
    from app.tournament_draws import cut_draw
    from app.tournament_lifecycle import transition_tournament
    from tests.test_tournament_lifecycle import _enter, _make_tournament_at, _one_event

    owner = await make_user(db_session, "roster-live-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    await _enter(db_session, event, 4)
    await cut_draw(db_session, event)
    replacement = await make_user(db_session, "roster-live-replacement")
    original = (
        await db_session.execute(
            text(
                "SELECT m.id, m.entry_id, m.player_id FROM tournament_entry_members m "
                "JOIN tournament_entries e ON e.id = m.entry_id "
                "WHERE e.event_id = :event LIMIT 1"
            ),
            {"event": event.id},
        )
    ).one()
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as roster, sessions() as lifecycle:
        roster_pid = await roster.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        actor = await lifecycle.get(User, owner.id)
        await roster.execute(
            text(
                "UPDATE tournament_entry_members SET left_at = clock_timestamp() "
                "WHERE id = :id"
            ),
            {"id": original.id},
        )
        await roster.execute(
            text(
                "INSERT INTO tournament_entry_members (entry_id, player_id) "
                "VALUES (:entry, :player)"
            ),
            {"entry": original.entry_id, "player": replacement.player_id},
        )
        live_task = asyncio.create_task(
            transition_tournament(
                lifecycle,
                tournament_id=tournament.id,
                actor=actor,
                to=TournamentStatus.live,
            )
        )
        try:

            async def wait_for_block():
                while roster_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": lifecycle_pid}
                ):
                    assert not live_task.done(), "go-live bypassed the roster edit"
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_block(), timeout=5)
            await roster.commit()
            await live_task
            participants = set(
                await db_session.scalars(text("SELECT user_id FROM match_side_players"))
            )
            assert replacement.player_id in participants
            assert original.player_id not in participants
        finally:
            if not live_task.done():
                live_task.cancel()
            await asyncio.gather(live_task, return_exceptions=True)


async def test_roster_rechecks_director_when_go_live_commits_first(db_session, engine):
    event = await _make_event(db_session)
    players = [await make_user(db_session, f"live-first-{n}") for n in range(2)]
    entry = TournamentEntry(event_id=event.id, user_id=players[0].player_id)
    db_session.add(entry)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.published
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as lifecycle, sessions() as roster:
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        roster_pid = await roster.scalar(text("SELECT pg_backend_pid()"))
        await lifecycle.execute(
            text("UPDATE tournaments SET status = 'live' WHERE id = :id"),
            {"id": tournament.id},
        )

        async def replace():
            await roster.execute(
                text(
                    "UPDATE tournament_entry_members SET left_at = clock_timestamp() "
                    "WHERE entry_id = :entry"
                ),
                {"entry": entry.id},
            )
            await roster.execute(
                text(
                    "INSERT INTO tournament_entry_members (entry_id, player_id) "
                    "VALUES (:entry, :player)"
                ),
                {"entry": entry.id, "player": players[1].player_id},
            )
            await roster.commit()

        roster_task = asyncio.create_task(replace())
        try:

            async def wait_for_block():
                while lifecycle_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": roster_pid}
                ):
                    assert not roster_task.done()
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_block(), timeout=5)
            await lifecycle.commit()
            with pytest.raises(IntegrityError, match="director"):
                await roster_task
        finally:
            if not roster_task.done():
                roster_task.cancel()
            await asyncio.gather(roster_task, return_exceptions=True)


async def test_closed_membership_insert_requires_departure_director(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.live
    await db_session.commit()
    with pytest.raises(IntegrityError, match="director"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO tournament_entry_members "
                    "(entry_id, player_id, joined_at, left_at, joined_by_account_id) "
                    "VALUES (:entry, :player, clock_timestamp() - interval '1 minute', "
                    "clock_timestamp(), :director)"
                ),
                {
                    "entry": entries[0].id,
                    "player": players[4].player_id,
                    "director": tournament.owner_account_id,
                },
            )


async def test_roster_changes_after_go_live_record_the_director(db_session):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.live
    await db_session.commit()
    original = entries[0].members[0]
    original_id, entry_id, owner_id = (
        original.id,
        entries[0].id,
        tournament.owner_account_id,
    )
    with pytest.raises(IntegrityError, match="director"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_entry_members SET left_at = "
                    "clock_timestamp() WHERE id = :id"
                ),
                {"id": original_id},
            )
    await db_session.execute(
        text(
            "UPDATE tournament_entry_members SET left_at = clock_timestamp(), "
            "left_by_account_id = :actor "
            "WHERE id = :id"
        ),
        {"id": original_id, "actor": owner_id},
    )
    db_session.add(
        TournamentEntryMember(
            entry_id=entry_id,
            player_id=players[4].player_id,
            joined_by_account_id=owner_id,
        )
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text(
                "SELECT left_by_account_id FROM tournament_entry_members WHERE id = :id"
            ),
            {"id": original_id},
        )
        == owner_id
    )


@pytest.mark.parametrize(
    "invalid", ["missing_player", "outsider", "skipped_revision", "changed_start"]
)
async def test_correction_is_a_complete_eligible_lineup_revision(db_session, invalid):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    match.status = MatchStatus.in_progress
    await db_session.commit()
    original_id = await db_session.scalar(text("SELECT id FROM match_lineups"))
    with pytest.raises(IntegrityError, match="lineup"):
        async with db_session.begin_nested():
            new_id = await db_session.scalar(
                text(
                    "INSERT INTO match_lineups (match_id, revision, started_at, "
                    "recorded_by_account_id, correction_reason) "
                    "SELECT match_id, :revision, started_at + (:offset * interval "
                    "'1 second'), :actor, 'Correction' "
                    "FROM match_lineups WHERE id = :id RETURNING id"
                ),
                {
                    "id": original_id,
                    "actor": match.created_by_user_id,
                    "revision": 3 if invalid == "skipped_revision" else 2,
                    "offset": 1 if invalid == "changed_start" else 0,
                },
            )
            await db_session.execute(
                text(
                    "INSERT INTO match_lineup_players (lineup_id, side_number, "
                    "player_id, entry_member_id) "
                    "SELECT :new, side_number, CASE WHEN :invalid = 'outsider' AND "
                    "player_id = :old_player "
                    "THEN :new_player ELSE player_id END, entry_member_id "
                    "FROM match_lineup_players WHERE lineup_id = :old "
                    "AND (:invalid <> 'missing_player' OR player_id <> :old_player)"
                ),
                {
                    "new": new_id,
                    "old": original_id,
                    "invalid": invalid,
                    "old_player": players[0].player_id,
                    "new_player": players[4].player_id,
                },
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize(
    "ending,played", [("walkover", False), ("stopped_during_play", True)]
)
async def test_special_ending_distinguishes_played_participants(
    db_session, ending, played
):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    if played:
        match.status = MatchStatus.in_progress
        await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE matches SET ending = :ending, status = 'completed', completed_at = "
            "clock_timestamp() "
            "WHERE id = :id"
        ),
        {"id": match.id, "ending": ending},
    )
    fixture.winner_entry_id = entries[1].id
    await db_session.commit()
    count = await db_session.scalar(
        text(
            "SELECT count(*) FROM match_lineup_players p "
            "JOIN match_lineups l ON l.id = p.lineup_id WHERE l.match_id = :id"
        ),
        {"id": match.id},
    )
    assert count == (4 if played else 0)
    assert fixture.winner_entry_id == entries[1].id


@pytest.mark.parametrize(
    "ending,played", [("walkover", True), ("stopped_during_play", False)]
)
async def test_ending_cannot_contradict_whether_play_started(
    db_session, ending, played
):
    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    if played:
        match.status = MatchStatus.in_progress
        await db_session.commit()
    with pytest.raises(IntegrityError, match="ending"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE matches SET ending = :ending, status = 'completed', "
                    "completed_at = clock_timestamp() "
                    "WHERE id = :id"
                ),
                {"id": match.id, "ending": ending},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
