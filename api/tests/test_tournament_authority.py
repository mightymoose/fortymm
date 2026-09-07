"""Tournament authority through transport-neutral operations and real PostgreSQL."""

import pytest

from app.geocoding import FakeGeocoder
from app.models import Tournament
from app.schemas.tournament import TournamentUpdate
from app.tournament_edit import edit_tournament
from tests._helpers import make_user


async def test_owner_can_delegate_operations_to_an_active_guest(
    db_session, default_league
):
    from app.tournament_authority import grant_director

    owner = await make_user(db_session, "authority-owner")
    guest = await make_user(db_session, "authority-guest")
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=guest.id
    )
    await db_session.commit()
    await edit_tournament(
        db_session,
        tournament_id=tournament.id,
        updates=TournamentUpdate(name="Guest Open", details_version=1),
        actor=guest,
        geocoder=FakeGeocoder(),
    )
    await db_session.refresh(tournament)
    assert tournament.name == "Guest Open"
    assert tournament.owner_account_id == owner.id


async def test_revocation_preserves_history_and_regrant_is_a_new_grant(
    db_session, default_league
):
    import pytest

    from app.tournament_authority import (
        authority_history,
        grant_director,
        revoke_director,
    )
    from app.tournament_errors import NotTournamentOwnerError

    owner = await make_user(db_session, "revoke-owner")
    guest = await make_user(db_session, "revoke-guest")
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    first = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=guest.id
    )
    await revoke_director(
        db_session, tournament.id, actor_id=owner.id, grant_id=first.id
    )
    await db_session.commit()
    with pytest.raises(NotTournamentOwnerError):
        await edit_tournament(
            db_session,
            tournament_id=tournament.id,
            updates=TournamentUpdate(name="Denied", details_version=1),
            actor=guest,
            geocoder=FakeGeocoder(),
        )
    second = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=guest.id
    )
    history = await authority_history(db_session, tournament.id)
    assert second.id != first.id
    assert len(history.grants) == 2
    assert first.revoked_by_account_id == owner.id
    assert first.revoked_at >= first.granted_at
    assert second.revoked_at is None


async def test_transfer_is_immediate_preserves_directors_and_removes_creator_authority(
    db_session, default_league
):
    import pytest

    from app.tournament_authority import (
        authority_history,
        can_direct,
        grant_director,
        transfer_ownership,
    )
    from app.tournament_errors import NotTournamentOwnerError
    from app.tournament_lifecycle import delete_tournament

    owner = await make_user(db_session, "transfer-owner")
    director = await make_user(db_session, "transfer-director")
    recipient = await make_user(db_session, "transfer-guest")
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=director.id
    )
    with pytest.raises(NotTournamentOwnerError):
        await transfer_ownership(
            db_session, tournament.id, actor_id=director.id, account_id=recipient.id
        )
    with pytest.raises(NotTournamentOwnerError):
        await delete_tournament(db_session, tournament_id=tournament.id, actor=director)
    await transfer_ownership(
        db_session, tournament.id, actor_id=owner.id, account_id=recipient.id
    )
    assert tournament.owner_account_id == recipient.id
    assert tournament.created_by_user_id == owner.id
    assert not await can_direct(db_session, tournament, owner.id)
    assert await can_direct(db_session, tournament, director.id)
    history = await authority_history(db_session, tournament.id)
    (transfer,) = history.transfers
    assert transfer.previous_owner_account_id == owner.id
    assert transfer.new_owner_account_id == recipient.id
    assert transfer.actor_account_id == owner.id
    assert transfer.reason == "explicit"


async def test_tombstoned_accounts_cannot_receive_or_exercise_authority(
    db_session, default_league
):
    from datetime import UTC, datetime

    import pytest

    from app.tournament_authority import grant_director, transfer_ownership

    owner = await make_user(db_session, "eligibility-owner")
    retired = await make_user(db_session, "eligibility-retired")
    retired.merged_at = datetime.now(UTC)
    retired.merged_into_user_id = owner.id
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    for operation in (grant_director, transfer_ownership):
        with pytest.raises(ValueError, match="active"):
            await operation(
                db_session, tournament.id, actor_id=owner.id, account_id=retired.id
            )


async def test_merge_carries_authority_preserving_original_grants_and_deduplicating(
    db_session, default_league
):
    from app.account_merge import merge_user
    from app.tournament_authority import authority_history, can_direct, grant_director

    source = await make_user(db_session, "merge-source")
    survivor = await make_user(db_session, "merge-survivor")
    owner = await make_user(db_session, "merge-owner")
    owned = Tournament(
        name="Owned", league_id=default_league.id, created_by_user_id=source.id
    )
    delegated = Tournament(
        name="Delegated", league_id=default_league.id, created_by_user_id=owner.id
    )
    duplicate = Tournament(
        name="Duplicate", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add_all([owned, delegated, duplicate])
    await db_session.commit()
    original = await grant_director(
        db_session, delegated.id, actor_id=owner.id, account_id=source.id
    )
    await grant_director(
        db_session, duplicate.id, actor_id=owner.id, account_id=source.id
    )
    existing = await grant_director(
        db_session, duplicate.id, actor_id=owner.id, account_id=survivor.id
    )
    await merge_user(db_session, from_user_id=source.id, to_user_id=survivor.id)
    await db_session.commit()
    assert await can_direct(db_session, delegated, survivor.id)
    assert not await can_direct(db_session, delegated, source.id)
    assert owned.owner_account_id == survivor.id
    history = await authority_history(db_session, delegated.id)
    original = next(g for g in history.grants if g.account_id == source.id)
    inherited = next(g for g in history.grants if g.account_id == survivor.id)
    assert original.account_id == source.id
    assert original.granted_by_account_id == owner.id
    assert original.revocation_reason == "account_merge"
    assert inherited.inherited_from_grant_id == original.id
    assert inherited.reason == "account_merge"
    assert inherited.granted_by_account_id is None
    duplicate_history = await authority_history(db_session, duplicate.id)
    assert [g.id for g in duplicate_history.grants if g.revoked_at is None] == [
        existing.id
    ]
    (transfer,) = (await authority_history(db_session, owned.id)).transfers
    assert transfer.reason == "account_merge"
    assert transfer.actor_account_id is None
    assert owned.created_by_user_id == source.id


async def test_database_preserves_creator_and_authority_history(
    db_session, default_league
):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.tournament_authority import (
        grant_director,
        revoke_director,
        transfer_ownership,
    )

    owner = await make_user(db_session, "sql-owner")
    guest = await make_user(db_session, "sql-guest")
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    grant = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=guest.id
    )
    await revoke_director(
        db_session, tournament.id, actor_id=owner.id, grant_id=grant.id
    )
    await transfer_ownership(
        db_session, tournament.id, actor_id=owner.id, account_id=guest.id
    )
    await db_session.commit()
    statements = [
        "UPDATE tournaments SET created_by_user_id = :guest WHERE id = :tournament",
        "UPDATE tournament_account_grants SET account_id = :owner WHERE id = :grant",
        "UPDATE tournament_account_grants SET revoked_at = NULL, "
        "revoked_by_account_id = NULL, revocation_reason = NULL WHERE id ="
        " :grant",
        "DELETE FROM tournament_account_grants WHERE id = :grant",
        "UPDATE tournament_ownership_transfers SET actor_account_id = "
        ":guest WHERE tournament_id = :tournament",
        "DELETE FROM tournament_ownership_transfers WHERE tournament_id = :tournament",
    ]
    for statement in statements:
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement),
                    {
                        "guest": guest.id,
                        "owner": owner.id,
                        "tournament": tournament.id,
                        "grant": grant.id,
                    },
                )


async def test_sql_rejects_invalid_grant_provenance_and_allows_parent_cleanup(
    db_session, default_league
):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    from app.account_merge import merge_user
    from app.tournament_authority import authority_history, grant_director
    from app.tournament_lifecycle import delete_tournament

    owner = await make_user(db_session, "constraints-owner")
    source = await make_user(db_session, "constraints-source")
    target = await make_user(db_session, "constraints-target")
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    other = Tournament(
        name="Other", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add_all([tournament, other])
    await db_session.commit()
    grant = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=source.id
    )
    await db_session.commit()
    base = (
        "INSERT INTO tournament_account_grants (id, tournament_id, "
        "account_id, role, granted_by_account_id, reason, "
        "inherited_from_grant_id) VALUES (:id, :tournament, :target, "
        ":role, :actor, :reason, :origin)"
    )
    bad_rows = [
        dict(role="umpire", actor=owner.id, reason="explicit", origin=None),
        dict(role="director", actor=None, reason="explicit", origin=None),
        dict(role="director", actor=None, reason="account_merge", origin=None),
        dict(role="director", actor=None, reason="account_merge", origin=grant.id),
    ]
    for row in bad_rows:
        with pytest.raises(DBAPIError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(base),
                    dict(id=uuid.uuid4(), tournament=other.id, target=target.id, **row),
                )
    await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)
    await db_session.commit()
    tournament_id = tournament.id
    await delete_tournament(db_session, tournament_id=tournament_id, actor=owner)
    assert not (await authority_history(db_session, tournament_id)).grants


async def test_delegated_director_can_score_and_read_matching_score_flags(db_session):
    from sqlalchemy import select

    from app.match_scoring import load_match_for_write
    from app.match_serialization import resolve_viewer_is_director
    from app.models import Tournament
    from app.tournament_authority import grant_director
    from tests._helpers import directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="authority-score", rated=False
    )
    guest = await make_user(db_session, "score-guest")
    tournament = await db_session.scalar(
        select(Tournament).where(Tournament.owner_account_id == owner.id)
    )
    await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=guest.id
    )
    await db_session.commit()
    loaded = await load_match_for_write(db_session, match.id, guest.id, lock=True)
    assert loaded.id == match.id
    assert await resolve_viewer_is_director(db_session, loaded, guest.id)


async def test_delegated_director_manages_entries(db_session):
    from app.tournament_authority import grant_director
    from app.tournament_entries import enter_event, withdraw_from_event
    from tests.test_tournament_entries import _make_event

    owner = await make_user(db_session, "entries-owner")
    director = await make_user(db_session, "entries-director")
    entrant = await make_user(db_session, "entries-player")
    event = await _make_event(db_session, owner=owner)
    await grant_director(
        db_session, event.tournament_id, actor_id=owner.id, account_id=director.id
    )
    await db_session.commit()
    entry = await enter_event(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event.id,
        actor=director,
        user_id=entrant.primary_player.id,
    )
    assert entry.user_id == entrant.primary_player.id
    await withdraw_from_event(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event.id,
        entry_id=entry.id,
        actor=director,
    )


async def test_delegated_director_can_correct_live_roster(db_session):
    from sqlalchemy import text

    from app.models import EventFormat, TournamentStatus
    from app.tournament_authority import grant_director
    from tests.test_entry_members import seed_doubles_match

    event, players, entries, match, fixture = await seed_doubles_match(db_session)
    event.format = EventFormat.teams
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.live
    director = await make_user(db_session, "roster-director")
    await grant_director(
        db_session,
        tournament.id,
        actor_id=tournament.owner_account_id,
        account_id=director.id,
    )
    await db_session.commit()
    await db_session.execute(
        text(
            "INSERT INTO tournament_entry_members (entry_id, player_id, "
            "joined_by_account_id) VALUES (:entry, :player, :actor)"
        ),
        dict(entry=entries[0].id, player=players[4].player_id, actor=director.id),
    )
    await db_session.commit()


async def test_delegated_director_can_preview_schedule(db_session, default_league):
    from app.schedule_preview_solve import ensure_preview_access
    from app.tournament_authority import grant_director

    owner = await make_user(db_session, "preview-owner")
    director = await make_user(db_session, "preview-director")
    tournament = Tournament(
        name="Preview", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=director.id
    )
    await db_session.commit()
    await ensure_preview_access(db_session, tournament.id, director)


async def _wait_until_blocked(observer, task, blocker_pid):
    import asyncio

    import pytest
    from sqlalchemy import text

    async with asyncio.timeout(5):
        while True:
            if task.done():
                pytest.fail(
                    "privileged operation completed before authority lock was released"
                )
            if await observer.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE :pid = "
                    "ANY(pg_blocking_pids(pid)))"
                ),
                {"pid": blocker_pid},
            ):
                return
            await asyncio.sleep(0.01)


@pytest.mark.parametrize("change", ["revoke", "transfer"])
@pytest.mark.parametrize("operation", ["edit", "preview"])
async def test_authority_change_winning_the_lock_denies_waiting_privileged_edit(
    db_session, engine, default_league, change, operation
):
    import asyncio

    import pytest
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.schedule_preview_solve import ensure_preview_access
    from app.tournament_authority import (
        grant_director,
        revoke_director,
        transfer_ownership,
    )
    from app.tournament_errors import NotTournamentOwnerError

    owner = await make_user(db_session, "race-owner")
    director = await make_user(db_session, "race-director")
    tournament = Tournament(
        name="Unchanged", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    grant = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=director.id
    )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as revoker, sessions() as editor:
        if change == "revoke":
            await revoke_director(
                revoker, tournament.id, actor_id=owner.id, grant_id=grant.id
            )
            editing_actor = director
        else:
            await transfer_ownership(
                revoker, tournament.id, actor_id=owner.id, account_id=director.id
            )
            editing_actor = owner
        blocker_pid = await revoker.scalar(text("SELECT pg_backend_pid()"))
        action = (
            edit_tournament(
                editor,
                tournament_id=tournament.id,
                actor=editing_actor,
                updates=TournamentUpdate(name="Must not save", details_version=1),
                geocoder=FakeGeocoder(),
            )
            if operation == "edit"
            else ensure_preview_access(editor, tournament.id, editing_actor)
        )
        task = asyncio.create_task(action)
        try:
            await _wait_until_blocked(db_session, task, blocker_pid)
            await revoker.commit()
            with pytest.raises(NotTournamentOwnerError):
                await asyncio.wait_for(task, 5)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


async def test_merge_locks_one_sorted_union_of_sporting_and_authority_tournaments(
    db_session, engine, default_league
):
    import asyncio
    import uuid

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.account_merge import merge_user
    from app.models import TournamentEntry
    from tests.test_tournament_entries import _make_event

    source = await make_user(db_session, "union-source")
    target = await make_user(db_session, "union-target")
    event = await _make_event(db_session)
    authority = Tournament(
        id=uuid.UUID(int=(1 << 128) - 1),
        name="Last authority lock",
        league_id=default_league.id,
        created_by_user_id=source.id,
    )
    db_session.add_all(
        [
            authority,
            TournamentEntry(event_id=event.id, user_id=source.primary_player.id),
        ]
    )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as gatekeeper, sessions() as merging, sessions() as probe:
        await gatekeeper.execute(
            text("SELECT id FROM tournaments WHERE id = :id FOR UPDATE"),
            {"id": event.tournament_id},
        )
        blocker_pid = await gatekeeper.scalar(text("SELECT pg_backend_pid()"))
        task = asyncio.create_task(
            merge_user(merging, from_user_id=source.id, to_user_id=target.id)
        )
        try:
            await _wait_until_blocked(db_session, task, blocker_pid)
            # A larger authority parent must not be held while waiting on a smaller
            # sporting parent. Opposite ownership/participation would deadlock.
            await probe.execute(
                text("SELECT id FROM tournaments WHERE id = :id FOR UPDATE NOWAIT"),
                {"id": authority.id},
            )
        finally:
            await probe.rollback()
            await gatekeeper.rollback()
            await asyncio.wait_for(task, 5)
            await merging.rollback()


async def test_sql_default_owner_no_grants_and_active_recipient_constraints(
    db_session, default_league
):
    import uuid
    from datetime import UTC, datetime

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    owner = await make_user(db_session, "sql-default-owner")
    retired = await make_user(db_session, "sql-default-retired")
    retired.merged_at = datetime.now(UTC)
    retired.merged_into_user_id = owner.id
    await db_session.commit()
    tournament_id = await db_session.scalar(
        text(
            "INSERT INTO tournaments (name, league_id, created_by_user_id) "
            "VALUES ('SQL Open', :league, :owner) RETURNING id"
        ),
        {"league": default_league.id, "owner": owner.id},
    )
    assert (
        await db_session.scalar(
            text("SELECT owner_account_id FROM tournaments WHERE id = :id"),
            {"id": tournament_id},
        )
        == owner.id
    )
    assert (
        await db_session.scalar(
            text(
                "SELECT count(*) FROM tournament_account_grants WHERE "
                "tournament_id = :id"
            ),
            {"id": tournament_id},
        )
        == 0
    )
    statements = [
        "INSERT INTO tournament_account_grants (id, tournament_id, "
        "account_id, role, granted_by_account_id, reason) VALUES (:grant, "
        ":id, :retired, 'director', :owner, 'explicit')",
        "UPDATE tournaments SET owner_account_id = :retired WHERE id = :id",
    ]
    for statement in statements:
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement),
                    {
                        "grant": uuid.uuid4(),
                        "id": tournament_id,
                        "retired": retired.id,
                        "owner": owner.id,
                    },
                )


async def test_scoring_winning_the_lock_stands_before_revocation(db_session, engine):
    import asyncio

    from sqlalchemy import select, text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.match_scoring import enter_game_score, load_match_for_write
    from app.tournament_authority import grant_director, revoke_director
    from tests._helpers import directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="score-race", rated=False
    )
    director = await make_user(db_session, "score-race-delegate")
    tournament = await db_session.scalar(
        select(Tournament).where(Tournament.owner_account_id == owner.id)
    )
    grant = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=director.id
    )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as scorer, sessions() as revoker:
        await load_match_for_write(scorer, match.id, director.id, lock=True)
        blocker_pid = await scorer.scalar(text("SELECT pg_backend_pid()"))
        task = asyncio.create_task(
            revoke_director(
                revoker, tournament.id, actor_id=owner.id, grant_id=grant.id
            )
        )
        try:
            await _wait_until_blocked(db_session, task, blocker_pid)
            scored = await enter_game_score(
                scorer,
                match.id,
                director.id,
                game_number=1,
                side_1_points=11,
                side_2_points=5,
            )
            assert len(scored.games) == 1
            await asyncio.wait_for(task, 5)
            await revoker.commit()
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


async def test_sql_active_grants_unique_and_revocation_provenance_is_complete(
    db_session, default_league
):
    import uuid

    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.tournament_authority import grant_director

    owner = await make_user(db_session, "sql-revoke-owner")
    director = await make_user(db_session, "sql-revoke-director")
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    grant = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=director.id
    )
    await db_session.commit()
    statements = [
        "INSERT INTO tournament_account_grants (id, tournament_id, "
        "account_id, role, granted_by_account_id, reason) VALUES (:new, "
        ":tournament, :director, 'director', :owner, 'explicit')",
        "UPDATE tournament_account_grants SET revoked_at = "
        "clock_timestamp() WHERE id = :grant",
        "UPDATE tournament_account_grants SET revoked_by_account_id = "
        ":owner WHERE id = :grant",
        "UPDATE tournament_account_grants SET revoked_at = "
        "clock_timestamp(), revocation_reason = 'account_merge', "
        "revoked_by_account_id = :owner WHERE id = :grant",
    ]
    for statement in statements:
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement),
                    dict(
                        new=uuid.uuid4(),
                        tournament=tournament.id,
                        director=director.id,
                        owner=owner.id,
                        grant=grant.id,
                    ),
                )


async def test_revocation_waits_for_recipient_merge_before_tournament_lock(
    db_session, engine, default_league
):
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.account_merge import merge_user
    from app.tournament_authority import grant_director, revoke_director

    owner = await make_user(db_session, "revoke-merge-owner")
    source = await make_user(db_session, "revoke-merge-source")
    target = await make_user(db_session, "revoke-merge-target")
    tournament = Tournament(
        name="Open", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    grant = await grant_director(
        db_session, tournament.id, actor_id=owner.id, account_id=source.id
    )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as merging, sessions() as revoker:
        await merging.execute(
            text("SELECT id FROM accounts WHERE id = :id FOR UPDATE"), {"id": source.id}
        )
        blocker_pid = await merging.scalar(text("SELECT pg_backend_pid()"))
        task = asyncio.create_task(
            revoke_director(
                revoker, tournament.id, actor_id=owner.id, grant_id=grant.id
            )
        )
        try:
            await _wait_until_blocked(db_session, task, blocker_pid)
            await merge_user(merging, from_user_id=source.id, to_user_id=target.id)
            await merging.commit()
            await asyncio.wait_for(task, 5)
            await revoker.commit()
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def test_waiting_merge_refreshes_a_preloaded_account_tombstone(
    db_session, engine
):
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.account_merge import merge_user
    from app.models import Account

    source = await make_user(db_session, "stale-merge-source")
    target = await make_user(db_session, "stale-merge-target")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as first, sessions() as second:
        cached_source = await second.get(Account, source.id)
        assert cached_source.merged_at is None
        await merge_user(first, from_user_id=source.id, to_user_id=target.id)
        blocker_pid = await first.scalar(text("SELECT pg_backend_pid()"))
        task = asyncio.create_task(
            merge_user(second, from_user_id=source.id, to_user_id=target.id)
        )
        try:
            await _wait_until_blocked(db_session, task, blocker_pid)
            await first.commit()
            with pytest.raises(ValueError, match="tombstoned"):
                await asyncio.wait_for(task, 5)
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
