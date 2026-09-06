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
from sqlalchemy.ext.asyncio import create_async_engine

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


async def test_permissive_team_still_rejects_merged_duplicates_within_one_entry(
    db_session,
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
    with pytest.raises(IntegrityError, match="duplicate.*member"):
        async with db_session.begin_nested():
            await merge_user(
                db_session, from_user_id=players[0].id, to_user_id=players[1].id
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


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
