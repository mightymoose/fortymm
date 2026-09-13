"""New sporting actions serialize with Account and Player lifecycle changes."""

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.identity_lifecycle import deactivate_account, retire_player
from app.match_creation import create_match
from app.models import Account
from app.player_accounts import PlayerAccessDenied
from tests._helpers import make_user
from tests.test_proposal_history import wait_for_blocked


@pytest.mark.parametrize("first", ["action", "deactivation"])
async def test_player_authorized_action_serializes_with_account_deactivation(
    db_session, engine, monkeypatch, first
):
    from app import match_creation

    actor = await make_user(db_session, "account-admission-race")
    await db_session.commit()
    actor_id = actor.id
    checked, proceed = asyncio.Event(), asyncio.Event()
    original = match_creation.require_player

    async def pause_after_authorization(*args, **kwargs):
        player = await original(*args, **kwargs)
        checked.set()
        await proceed.wait()
        return player

    monkeypatch.setattr(match_creation, "require_player", pause_after_authorization)
    async with (
        async_sessionmaker(engine, expire_on_commit=False)() as writer,
        async_sessionmaker(engine)() as lifecycle,
    ):
        writer_actor = await writer.get(Account, actor_id)
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))

        async def action():
            return await create_match(
                writer,
                creator=writer_actor,
                opponent_user_id=None,
                league_id=None,
                best_of=1,
                rated=False,
            )

        if first == "deactivation":
            await deactivate_account(lifecycle, actor_id)
            pending = asyncio.create_task(action())
            try:
                await wait_for_blocked(lifecycle, writer_pid, pending)
                assert not checked.is_set()
                await lifecycle.commit()
                with pytest.raises(PlayerAccessDenied):
                    await pending
            finally:
                proceed.set()
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
        else:
            writing = asyncio.create_task(action())
            await asyncio.wait_for(checked.wait(), 5)
            pending = asyncio.create_task(deactivate_account(lifecycle, actor_id))
            try:
                await wait_for_blocked(writer, lifecycle_pid, pending)
                proceed.set()
                await writing
                await pending
                await lifecycle.commit()
            finally:
                proceed.set()
                for task in (pending, writing):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(pending, writing, return_exceptions=True)
    assert await db_session.scalar(
        text("SELECT count(*) FROM matches WHERE created_by_user_id=:id"),
        {"id": actor_id},
    ) == (1 if first == "action" else 0)


@pytest.mark.parametrize("operation", ["insert", "reparent"])
async def test_sql_cannot_admit_retired_player_to_a_new_standalone_match(
    db_session, operation
):
    actor = await make_user(db_session, "sql-retired-match-owner")
    player = await make_user(db_session, "sql-retired-match-player")
    match = await create_match(
        db_session,
        creator=actor,
        opponent_user_id=player.player_id if operation == "reparent" else None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    destination = await create_match(
        db_session,
        creator=actor,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await retire_player(db_session, player.player_id)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="retired Player cannot be admitted"):
        async with db_session.begin_nested():
            if operation == "insert":
                await db_session.execute(
                    text(
                        "INSERT INTO "
                        "match_side_players(match_id,match_side_id,user_id) SELECT "
                        ":match,id,:player FROM match_sides WHERE match_id=:match AND"
                        " side_number=2"
                    ),
                    {"match": destination.id, "player": player.player_id},
                )
            else:
                await db_session.execute(
                    text(
                        "UPDATE match_side_players SET match_id=:destination, "
                        "match_side_id=(SELECT id FROM match_sides WHERE "
                        "match_id=:destination AND side_number=2) WHERE "
                        "match_id=:original AND user_id=:player"
                    ),
                    {
                        "destination": destination.id,
                        "original": match.id,
                        "player": player.player_id,
                    },
                )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_retired_admission_cannot_authorize_itself_by_recording_a_score(
    db_session,
):
    actor = await make_user(db_session, "self-authorized-owner")
    retired = await make_user(db_session, "self-authorized-retired")
    match = await create_match(
        db_session,
        creator=actor,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await retire_player(db_session, retired.player_id)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="retired Player cannot be admitted"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "match_side_players(match_id,match_side_id,user_id) SELECT "
                    ":match,id,:player FROM match_sides WHERE match_id=:match AND"
                    " side_number=2"
                ),
                {"match": match.id, "player": retired.player_id},
            )
            game = await db_session.scalar(
                text(
                    "INSERT INTO match_games(match_id,game_number) "
                    "VALUES(:match,1) RETURNING id"
                ),
                {"match": match.id},
            )
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "match_game_scores(match_game_id,side_1_points,side_2_points)"
                    " VALUES(:game,11,5)"
                ),
                {"game": game},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_retired_held_player_materializes_only_into_its_own_fixture_seat(
    db_session, default_league
):
    from app.models import TournamentStatus
    from app.tournament_draws import cut_draw
    from app.tournament_lifecycle import transition_tournament
    from tests.test_tournament_lifecycle import _enter, _make_tournament_at, _one_event

    owner = await make_user(db_session, "held-admission-director")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    await _enter(db_session, event, 4)
    player_id = await db_session.scalar(
        text(
            "SELECT member.player_id FROM tournament_entry_members member"
            " JOIN tournament_entries entry ON entry.id=member.entry_id "
            "WHERE entry.event_id=:event LIMIT 1"
        ),
        {"event": event.id},
    )
    await cut_draw(db_session, event)
    await db_session.commit()
    await retire_player(db_session, player_id)
    await db_session.commit()
    await transition_tournament(
        db_session, tournament_id=tournament.id, actor=owner, to=TournamentStatus.live
    )
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_side_players WHERE user_id=:player"),
            {"player": player_id},
        )
        > 0
    )
    # Updating retained membership without changing its subject is not admission.
    await db_session.execute(
        text("UPDATE match_side_players SET user_id=user_id WHERE user_id=:player"),
        {"player": player_id},
    )
    await db_session.commit()
    unrelated_match = await db_session.scalar(
        text(
            "SELECT f.match_id FROM tournament_fixtures f WHERE "
            "f.scope_event_id=:event AND NOT EXISTS (SELECT 1 FROM "
            "match_side_players p WHERE p.match_id=f.match_id AND "
            "p.user_id=:player) LIMIT 1"
        ),
        {"event": event.id, "player": player_id},
    )
    assert unrelated_match is not None
    with pytest.raises(IntegrityError, match="retired Player cannot be admitted"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "match_side_players(match_id,match_side_id,user_id) SELECT "
                    ":match,id,:player FROM match_sides WHERE match_id=:match AND"
                    " side_number=1"
                ),
                {"match": unrelated_match, "player": player_id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))

    from app.models import MatchSettings

    standalone_rules = MatchSettings(team_size=1, best_of=1, affects_rating=False)
    db_session.add(standalone_rules)
    await db_session.flush()
    for swap in ("reference", "source"):
        with pytest.raises(IntegrityError, match="immutable"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(
                        "INSERT INTO "
                        "match_side_players(match_id,match_side_id,user_id) "
                        "SELECT :match,id,:player FROM match_sides "
                        "WHERE match_id=:match AND side_number=1"
                    ),
                    {"match": unrelated_match, "player": player_id},
                )
                if swap == "reference":
                    await db_session.execute(
                        text(
                            "UPDATE matches SET match_settings_id=:rules WHERE "
                            "id=:match"
                        ),
                        {"rules": standalone_rules.id, "match": unrelated_match},
                    )
                else:
                    await db_session.execute(
                        text(
                            "UPDATE match_settings SET source_rule_revision_id=NULL "
                            "WHERE id=(SELECT match_settings_id FROM matches "
                            "WHERE id=:match)"
                        ),
                        {"match": unrelated_match},
                    )
                await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_retired_unplayed_membership_can_follow_same_person_merge(db_session):
    from app.account_merge import merge_user

    source = await make_user(db_session, "retired-merge-source")
    target = await make_user(db_session, "retired-merge-target")
    match = await create_match(
        db_session,
        creator=source,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await retire_player(db_session, source.player_id)
    await retire_player(db_session, target.player_id)
    await db_session.commit()
    await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT user_id FROM match_side_players WHERE match_id=:match"),
            {"match": match.id},
        )
        == target.player_id
    )


@pytest.mark.parametrize("first", ["admission", "retirement"])
async def test_sql_match_admission_serializes_with_player_retirement(
    db_session, engine, first
):
    actor = await make_user(db_session, "sql-lock-owner")
    opponent = await make_user(db_session, "sql-lock-opponent")
    match = await create_match(
        db_session,
        creator=actor,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    async with (
        async_sessionmaker(engine)() as writer,
        async_sessionmaker(engine)() as lifecycle,
    ):
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))

        async def admission():
            await writer.execute(
                text(
                    "INSERT INTO "
                    "match_side_players(match_id,match_side_id,user_id) SELECT "
                    ":match,id,:player FROM match_sides WHERE match_id=:match AND"
                    " side_number=2"
                ),
                {"match": match.id, "player": opponent.player_id},
            )

        if first == "retirement":
            await retire_player(lifecycle, opponent.player_id)
            await lifecycle.flush()
            pending = asyncio.create_task(admission())
            try:
                await wait_for_blocked(lifecycle, writer_pid, pending)
                await lifecycle.commit()
                with pytest.raises(
                    IntegrityError, match="retired Player cannot be admitted"
                ):
                    await pending
                    await writer.commit()
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
        else:
            await admission()
            pending = asyncio.create_task(retire_player(lifecycle, opponent.player_id))
            try:
                await wait_for_blocked(writer, lifecycle_pid, pending)
                await writer.commit()
                await pending
                await lifecycle.commit()
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
    assert await db_session.scalar(
        text(
            "SELECT count(*) FROM match_side_players WHERE "
            "match_id=:match AND user_id=:player"
        ),
        {"match": match.id, "player": opponent.player_id},
    ) == (1 if first == "admission" else 0)


async def test_sql_status_toggle_cannot_admit_a_retired_player_without_registration(
    db_session,
):
    from app.models import TournamentEntry, TournamentEntryStatus
    from tests.test_tournament_entries import _make_event

    player = await make_user(db_session, "withdrawn-retired-admission")
    event = await _make_event(db_session)
    await retire_player(db_session, player.player_id)
    entry = TournamentEntry(event_id=event.id, status=TournamentEntryStatus.withdrawn)
    db_session.add(entry)
    await db_session.flush()
    await db_session.execute(
        text("INSERT INTO tournament_entry_members(entry_id,player_id) VALUES(:e,:p)"),
        {"e": entry.id, "p": player.player_id},
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="retired Player cannot be admitted"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE tournament_entries SET status='entered' WHERE id=:e"),
                {"e": entry.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("first", ["admission", "retirement"])
async def test_sql_entry_activation_serializes_with_retirement(
    db_session, engine, first
):
    from app.models import TournamentEntry, TournamentEntryStatus
    from tests.test_tournament_entries import _make_event

    player = await make_user(db_session, "entry-activation-race")
    event = await _make_event(db_session)
    entry = TournamentEntry(event_id=event.id, status=TournamentEntryStatus.withdrawn)
    db_session.add(entry)
    await db_session.flush()
    await db_session.execute(
        text("INSERT INTO tournament_entry_members(entry_id,player_id) VALUES(:e,:p)"),
        {"e": entry.id, "p": player.player_id},
    )
    await db_session.commit()
    entry_id, player_id = entry.id, player.player_id
    async with (
        async_sessionmaker(engine)() as writer,
        async_sessionmaker(engine)() as lifecycle,
    ):
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))

        async def admit():
            await writer.execute(
                text("UPDATE tournament_entries SET status='entered' WHERE id=:e"),
                {"e": entry_id},
            )

        if first == "retirement":
            await retire_player(lifecycle, player_id)
            await lifecycle.flush()
            pending = asyncio.create_task(admit())
            try:
                await wait_for_blocked(lifecycle, writer_pid, pending)
                await lifecycle.commit()
                with pytest.raises(
                    IntegrityError, match="retired Player cannot be admitted"
                ):
                    await pending
                    await writer.commit()
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
        else:
            await admit()
            pending = asyncio.create_task(retire_player(lifecycle, player_id))
            try:
                await wait_for_blocked(writer, lifecycle_pid, pending)
                await writer.commit()
                await pending
                await lifecycle.commit()
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
    status = await db_session.scalar(
        text("SELECT status FROM tournament_entries WHERE id=:e"), {"e": entry_id}
    )
    assert status == ("entered" if first == "admission" else "withdrawn")


@pytest.mark.parametrize("first", ["membership", "activation"])
async def test_sql_compound_entry_activation_cannot_admit_retired_player(
    db_session, first
):
    from app.models import TournamentEntry, TournamentEntryStatus
    from tests.test_tournament_entries import _make_event

    player = await make_user(db_session, "compound-retired-entry")
    event = await _make_event(db_session)
    await retire_player(db_session, player.player_id)
    entry = TournamentEntry(event_id=event.id, status=TournamentEntryStatus.withdrawn)
    db_session.add(entry)
    await db_session.commit()
    statement = (
        "WITH membership AS (INSERT INTO tournament_entry_members(entry_id,player_id) "
        "VALUES(:e,:p) RETURNING entry_id) UPDATE tournament_entries "
        "SET status='entered' "
        "WHERE id IN (SELECT entry_id FROM membership)"
        if first == "membership"
        else "WITH activation AS (UPDATE tournament_entries SET status='entered' "
        "WHERE id=:e RETURNING id) INSERT INTO tournament_entry_members"
        "(entry_id,player_id) "
        "SELECT id,:p FROM activation"
    )
    with pytest.raises(IntegrityError, match="retired Player cannot be admitted"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(statement), {"e": entry.id, "p": player.player_id}
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("first", ["match", "deactivation"])
@pytest.mark.parametrize("invalidation", ["deactivation", "grant_revocation"])
async def test_rated_opponent_manager_serializes_with_deactivation(
    db_session, engine, monkeypatch, first, invalidation
):
    from app import match_creation
    from app.match_creation import OpponentNotFoundError

    creator = await make_user(db_session, "rated-manager-race-creator")
    opponent = await make_user(db_session, "rated-manager-race-opponent")
    await db_session.commit()
    creator_id, opponent_id, player_id = creator.id, opponent.id, opponent.player_id
    checked, proceed = asyncio.Event(), asyncio.Event()
    original = match_creation.resolve_league

    async def pause_after_opponent_check(*args, **kwargs):
        checked.set()
        await proceed.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(match_creation, "resolve_league", pause_after_opponent_check)
    async with (
        async_sessionmaker(engine, expire_on_commit=False)() as writer,
        async_sessionmaker(engine)() as lifecycle,
    ):
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        actor = await writer.get(Account, creator_id)

        async def create():
            return await create_match(
                writer,
                creator=actor,
                opponent_user_id=player_id,
                league_id=None,
                best_of=3,
                rated=True,
            )

        async def deactivate():
            statement = (
                "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
                if invalidation == "deactivation"
                else "DELETE FROM account_players WHERE account_id=:id"
            )
            await lifecycle.execute(text(statement), {"id": opponent_id})

        if first == "match":
            pending = asyncio.create_task(create())
            suspension = None
            try:
                await asyncio.wait_for(checked.wait(), 2)
                suspension = asyncio.create_task(deactivate())
                await wait_for_blocked(writer, lifecycle_pid, suspension)
                proceed.set()
                await pending
                await suspension
                await lifecycle.commit()
            finally:
                proceed.set()
                for task in (pending, suspension):
                    if task is not None and not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
        else:
            await deactivate()
            pending = asyncio.create_task(create())
            try:
                await wait_for_blocked(lifecycle, writer_pid, pending)
                await lifecycle.commit()
                proceed.set()
                with pytest.raises(OpponentNotFoundError):
                    await pending
            finally:
                proceed.set()
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)


async def test_retired_merged_source_entry_can_reenter_as_active_survivor(db_session):
    from app.account_merge import merge_user
    from app.tournament_entries import enter_event, withdraw_from_event
    from tests.test_tournament_entries import _make_event

    source = await make_user(db_session, "reentry-retired-source")
    target = await make_user(db_session, "reentry-active-survivor")
    original_player = source.player_id
    event = await _make_event(db_session)
    scope = {"tournament_id": event.tournament_id, "event_id": event.id}
    entry = await enter_event(db_session, **scope, actor=source, user_id=None)
    await retire_player(db_session, original_player)
    await db_session.commit()
    await withdraw_from_event(db_session, **scope, entry_id=entry.id, actor=source)
    await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)
    await db_session.commit()
    restored = await enter_event(db_session, **scope, actor=target, user_id=None)
    assert restored.id == entry.id
    assert restored.user_id == target.player_id
    assert (
        await db_session.scalar(
            text("SELECT player_id FROM tournament_entry_members WHERE entry_id=:e"),
            {"e": entry.id},
        )
        == original_player
    )


@pytest.mark.parametrize("operation", ["register", "withdraw"])
async def test_sql_new_registration_requires_active_actor(db_session, operation):
    from app.models import TournamentEntry
    from tests.test_tournament_entries import _make_event

    actor = await make_user(db_session, "inactive-registration-actor")
    player = await make_user(db_session, "active-registration-player")
    event = await _make_event(db_session)
    entry = TournamentEntry(event_id=event.id, user_id=player.player_id)
    db_session.add(entry)
    await db_session.commit()
    if operation == "withdraw":
        await db_session.execute(
            text(
                "INSERT INTO tournament_entry_registrations"
                "(entry_id,registered_by_account_id) VALUES(:e,:a)"
            ),
            {"e": entry.id, "a": actor.id},
        )
        await db_session.commit()
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:a"),
        {"a": actor.id},
    )
    await db_session.commit()
    statement = (
        "INSERT INTO tournament_entry_registrations"
        "(entry_id,registered_by_account_id) VALUES(:e,:a)"
        if operation == "register"
        else "UPDATE tournament_entry_registrations SET withdrawn_at=clock_timestamp(),"
        "withdrawn_by_account_id=:a,withdrawal_reason='self_withdrawal' "
        "WHERE entry_id=:e"
    )
    with pytest.raises(IntegrityError, match="registration actor must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(statement),
                {"e": entry.id, "a": actor.id},
            )
            if operation == "withdraw":
                await db_session.execute(
                    text(
                        "UPDATE tournament_entries SET status='withdrawn' WHERE id=:e"
                    ),
                    {"e": entry.id},
                )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("first", ["registration", "deactivation"])
@pytest.mark.parametrize("operation", ["register", "withdraw"])
async def test_registration_actor_serializes_with_sql_deactivation(
    db_session, engine, first, operation
):
    from app.models import TournamentEntry
    from tests.test_tournament_entries import _make_event

    actor = await make_user(db_session, "registration-actor-race")
    event = await _make_event(db_session)
    entry = TournamentEntry(event_id=event.id, user_id=actor.player_id)
    db_session.add(entry)
    await db_session.commit()
    if operation == "withdraw":
        await db_session.execute(
            text(
                "INSERT INTO tournament_entry_registrations"
                "(entry_id,registered_by_account_id) VALUES(:e,:a)"
            ),
            {"e": entry.id, "a": actor.id},
        )
        await db_session.commit()
    actor_id, entry_id = actor.id, entry.id
    async with (
        async_sessionmaker(engine)() as writer,
        async_sessionmaker(engine)() as lifecycle,
    ):
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))

        async def register():
            if operation == "withdraw":
                await writer.execute(
                    text(
                        "UPDATE tournament_entry_registrations "
                        "SET "
                        "withdrawn_at=clock_timestamp(),withdrawn_by_account_id=:a,"
                        "withdrawal_reason='self_withdrawal' WHERE entry_id=:e"
                    ),
                    {"e": entry_id, "a": actor_id},
                )
                await writer.execute(
                    text(
                        "UPDATE tournament_entries SET status='withdrawn' WHERE id=:e"
                    ),
                    {"e": entry_id},
                )
                return
            await writer.execute(
                text(
                    "INSERT INTO tournament_entry_registrations"
                    "(entry_id,registered_by_account_id) VALUES(:e,:a)"
                ),
                {"e": entry_id, "a": actor_id},
            )

        async def deactivate():
            await lifecycle.execute(
                text(
                    "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:a"
                ),
                {"a": actor_id},
            )

        if first == "deactivation":
            await deactivate()
            pending = asyncio.create_task(register())
            try:
                await wait_for_blocked(lifecycle, writer_pid, pending)
                await lifecycle.commit()
                with pytest.raises(
                    IntegrityError, match="registration actor must be active"
                ):
                    await pending
                    await writer.commit()
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
        else:
            await register()
            pending = asyncio.create_task(deactivate())
            try:
                await wait_for_blocked(writer, lifecycle_pid, pending)
                await writer.commit()
                await pending
                await lifecycle.commit()
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
    assert await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_registrations "
            "WHERE entry_id=:e AND withdrawn_at IS NULL"
        ),
        {"e": entry_id},
    ) == int((first == "registration") == (operation == "register"))
