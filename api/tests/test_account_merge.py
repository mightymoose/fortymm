"""Unit tests for the ephemeral→verified merge primitive in app.account_merge."""

import hashlib
import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.account_merge import merge_user
from app.leagues import add_user_to_default_league, get_default_league
from app.match_voiding import void_match
from app.models import (
    DrawType,
    EventFormat,
    LeagueMembership,
    Match,
    MatchResult,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    Role,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    User,
    UserLeagueRating,
    UserRole,
    UserToken,
)
from app.sessions import SESSION_TOKEN_CONTEXT
from tests._helpers import start_session


async def _make_ephemeral(db: AsyncSession, username: str) -> User:
    user = User(username=username)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await add_user_to_default_league(db, user.id)
    await db.commit()
    return user


async def _make_verified(db: AsyncSession, email: str) -> User:
    user = User(
        username=email.split("@")[0],
        email=email,
        confirmed_at=datetime.now(UTC),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _record_match(
    db: AsyncSession,
    creator: User,
    *players: User,
    affects_rating: bool = False,
) -> Match:
    """A completed match. ``affects_rating=True`` makes it rated, so a self-play
    collision on it exercises the void path rather than the unrated prune."""
    league = await get_default_league(db)
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=affects_rating)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=creator.id,
        status=MatchStatus.completed,
    )
    for side_number, player in enumerate(players, start=1):
        side = MatchSide(match=match, side_number=side_number)
        side.players.append(MatchSidePlayer(match=match, user=player))
    db.add(match)
    await db.commit()
    await db.refresh(match)
    return match


async def _record_rated_match(db: AsyncSession, creator: User, *players: User) -> Match:
    return await _record_match(db, creator, *players, affects_rating=True)


async def _seed_match_rating_row(
    db: AsyncSession,
    *,
    match: Match,
    user: User,
    rating_strategy_id: uuid.UUID,
) -> None:
    """Append a match-sourced ``RatingHistory`` row for ``user`` on ``match`` —
    the kind of row a completed rated match produces, and the one a self-play
    collision must delete (the survivor's, which otherwise strands an inflated
    rating)."""
    db.add(
        RatingHistory(
            league_id=match.league_id,
            user_id=user.id,
            match_id=match.id,
            rating_strategy_id=rating_strategy_id,
            rating_value=1500.0,
            rating_state={"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
            source=RatingHistorySource.match,
        )
    )
    await db.commit()


async def _record_solo_match(db: AsyncSession, creator: User) -> Match:
    """An opponent-less match: side 1 holds the creator, side 2 is the
    intentional player-less "sentinel" side (mirrors matches._add_side)."""
    league = await get_default_league(db)
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=False)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=creator.id,
        status=MatchStatus.in_progress,
    )
    side_one = MatchSide(match=match, side_number=1)
    side_one.players.append(MatchSidePlayer(match=match, user=creator))
    MatchSide(match=match, side_number=2)  # sentinel: no players
    db.add(match)
    await db.commit()
    await db.refresh(match)
    return match


async def _record_result(
    db: AsyncSession,
    match: Match,
    *,
    submitted_by: User,
    accepted_by: User | None = None,
) -> MatchResult:
    """Attach a ``MatchResult`` to ``match``. ``accepted_by`` stamps the
    acceptor (the opposing-side participant who ratified the proposal) so the
    merge's ``accepted_by_user_id`` re-point can be exercised; left ``None`` the
    result is still standing (unaccepted)."""
    result = MatchResult(
        match_id=match.id,
        submitted_by_user_id=submitted_by.id,
        games=[],
        accepted_by_user_id=accepted_by.id if accepted_by is not None else None,
        accepted_at=datetime.now(UTC) if accepted_by is not None else None,
    )
    db.add(result)
    await db.commit()
    await db.refresh(result)
    return result


# ----- happy path ---------------------------------------------------------


async def test_merge_repoints_match_side_players_and_creator(
    db_session: AsyncSession,
):
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    opponent = await _make_ephemeral(db_session, "spinning-otter")

    match = await _record_match(db_session, ephemeral, ephemeral, opponent)

    summary = await merge_user(
        db_session, from_user_id=ephemeral.id, to_user_id=verified.id
    )
    await db_session.commit()

    assert summary.matches_moved == 1

    players = (
        (
            await db_session.execute(
                select(MatchSidePlayer).where(MatchSidePlayer.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    user_ids = {p.user_id for p in players}
    assert user_ids == {verified.id, opponent.id}

    creator_id = (
        await db_session.execute(
            select(Match.created_by_user_id).where(Match.id == match.id)
        )
    ).scalar_one()
    assert creator_id == verified.id


async def test_merge_tombstones_ephemeral_user_keeping_session_token(
    db_session: AsyncSession,
):
    """Soft-delete: the ephemeral row survives with ``merged_into_user_id`` set,
    its *session* token is kept (so its cookie still resolves and the auth layer
    can report the merge), and its non-session tokens are dropped."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")

    db_session.add(
        UserToken(
            user_id=ephemeral.id,
            context=SESSION_TOKEN_CONTEXT,
            token=hashlib.sha256(b"raw").digest(),
        )
    )
    db_session.add(
        UserToken(
            user_id=ephemeral.id,
            context="login",
            token=hashlib.sha256(b"login-raw").digest(),
        )
    )
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    tombstoned = (
        await db_session.execute(select(User).where(User.id == ephemeral.id))
    ).scalar_one_or_none()
    assert tombstoned is not None
    assert tombstoned.merged_into_user_id == verified.id
    assert tombstoned.merged_at is not None

    leftover = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.user_id == ephemeral.id)
            )
        )
        .scalars()
        .all()
    )
    # Session token kept (tombstone key); the login token dropped.
    assert [t.context for t in leftover] == [SESSION_TOKEN_CONTEXT]


# ----- atomicity ----------------------------------------------------------


async def test_merge_rolls_back_on_intra_transaction_failure(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
):
    """``merge_user`` runs inside the caller's transaction and never commits, so
    a failure partway through must leave *nothing* applied once the caller
    unwinds: the ephemeral user stays live (not tombstoned) and its match stays
    owned by it. The other merge tests only assert the committed happy path —
    this locks in the atomicity guarantee (#240). It bites against any
    regression that slips a commit into the middle of the merge."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    opponent = await _make_ephemeral(db_session, "spinning-otter")
    match = await _record_match(db_session, ephemeral, ephemeral, opponent)
    # Capture ids up front: the rollback below expires every ORM instance, after
    # which even reading `.id` would emit a lazy load outside the async loop.
    ephemeral_id = ephemeral.id
    verified_id = verified.id
    opponent_id = opponent.id
    match_id = match.id

    class _MergeInterrupted(Exception):
        pass

    # Detonate at the final tombstone step — `datetime.now(UTC)` in the closing
    # `update(User)` — *after* the match ownership has already been re-pointed
    # earlier in the same transaction.
    class _ExplodingDatetime:
        @staticmethod
        def now(tz: object = None) -> datetime:
            raise _MergeInterrupted("merge interrupted mid-transaction")

    monkeypatch.setattr("app.account_merge.datetime", _ExplodingDatetime)

    with pytest.raises(_MergeInterrupted):
        await merge_user(db_session, from_user_id=ephemeral_id, to_user_id=verified_id)
    # The caller unwinds the failed request transaction.
    await db_session.rollback()

    # Ephemeral user is still live — not tombstoned. Select the columns directly
    # rather than the ORM object: after the rollback the identity-map instance is
    # expired, so attribute access would emit a lazy load outside the async loop.
    tombstone = (
        await db_session.execute(
            select(User.merged_into_user_id, User.merged_at).where(
                User.id == ephemeral_id
            )
        )
    ).one()
    assert tombstone.merged_into_user_id is None
    assert tombstone.merged_at is None

    # Match ownership and the side player are untouched.
    creator_id = (
        await db_session.execute(
            select(Match.created_by_user_id).where(Match.id == match_id)
        )
    ).scalar_one()
    assert creator_id == ephemeral_id
    player_ids = set(
        (
            await db_session.execute(
                select(MatchSidePlayer.user_id).where(
                    MatchSidePlayer.match_id == match_id
                )
            )
        )
        .scalars()
        .all()
    )
    assert player_ids == {ephemeral_id, opponent_id}


async def test_merge_moves_league_membership_when_target_has_none(
    db_session: AsyncSession,
):
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    # verified is NOT in the default league yet

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    league = await get_default_league(db_session)
    memberships = (
        (
            await db_session.execute(
                select(LeagueMembership).where(LeagueMembership.league_id == league.id)
            )
        )
        .scalars()
        .all()
    )
    user_ids = {m.user_id for m in memberships}
    assert verified.id in user_ids
    assert ephemeral.id not in user_ids


async def test_merge_skips_membership_when_target_already_a_member(
    db_session: AsyncSession,
):
    """UNIQUE(league_id, user_id) means we must NOT EXISTS-guard the re-point.
    The ephemeral row gets cascade-deleted with the user."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    await add_user_to_default_league(db_session, verified.id)
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    league = await get_default_league(db_session)
    memberships = (
        (
            await db_session.execute(
                select(LeagueMembership).where(LeagueMembership.league_id == league.id)
            )
        )
        .scalars()
        .all()
    )
    user_ids = [m.user_id for m in memberships]
    assert user_ids == [verified.id]


async def test_merge_repoints_tournament_ownership(db_session: AsyncSession):
    """``tournaments.created_by_user_id`` is RESTRICT on delete; the merge
    re-points it to the verified user so the final tombstone delete isn't
    blocked and the tournament keeps its owner (and its events)."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")

    tournament = Tournament(
        name="Guest Cup",
        created_by_user_id=ephemeral.id,
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        table_catalogue=[{"id": "t1", "label": "Table 1", "court": "A"}],
    )
    tournament.events.append(
        TournamentEvent(
            name="Open Singles",
            format=EventFormat.singles,
            draw_type=DrawType.single_elim,
            max_players=32,
            entry_fee=40,
            slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
            match_settings={"rated": True, "length_games": 5},
            predicates=[],
            pools=[],
        )
    )
    db_session.add(tournament)
    await db_session.commit()
    await db_session.refresh(tournament)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    await db_session.refresh(tournament)
    assert tournament.created_by_user_id == verified.id

    # The cascade-owned event survives the merge with its tournament.
    events = (
        (
            await db_session.execute(
                select(TournamentEvent).where(
                    TournamentEvent.tournament_id == tournament.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert [e.name for e in events] == ["Open Singles"]


# ----- tournament entries -------------------------------------------------


async def _make_event(db: AsyncSession, owner: User) -> TournamentEvent:
    """A singles event on a tournament ``owner`` created. ``entered`` is left to
    its server default — it is a dead counter being retired, and an entry's
    existence is the truth."""
    tournament = Tournament(
        name="Guest Cup",
        created_by_user_id=owner.id,
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        table_catalogue=[{"id": "t1", "label": "Table 1", "court": "A"}],
    )
    event = TournamentEvent(
        name="Open Singles",
        format=EventFormat.singles,
        draw_type=DrawType.single_elim,
        max_players=32,
        entry_fee=40,
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        pools=[],
    )
    tournament.events.append(event)
    db.add(tournament)
    await db.commit()
    await db.refresh(event)
    return event


async def _enter(
    db: AsyncSession,
    event: TournamentEvent,
    user: User,
    *,
    status: TournamentEntryStatus = TournamentEntryStatus.entered,
) -> TournamentEntry:
    entry = TournamentEntry(event_id=event.id, user_id=user.id, status=status)
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


async def _entries_for(
    db: AsyncSession, event: TournamentEvent
) -> list[TournamentEntry]:
    # ``merge_user`` re-points entries with a bulk statement, and the test
    # sessionmaker sets ``expire_on_commit=False`` — so a plain SELECT would hand
    # back the identity map's stale copies and happily "prove" the merge did
    # nothing. ``populate_existing`` overwrites them from the row that came back,
    # so what we assert on is what the database actually holds.
    return list(
        (
            await db.execute(
                select(TournamentEntry)
                .where(TournamentEntry.event_id == event.id)
                .order_by(TournamentEntry.created_at)
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )


async def test_merge_repoints_tournament_entry_onto_survivor(
    db_session: AsyncSession,
):
    """``tournament_entries.user_id`` is RESTRICT, but the merge TOMBSTONES the
    guest rather than deleting it — so ON DELETE never fires and an unhandled
    entry would be left registered to a ghost user (and would seed a draw with
    it). The merge re-points it, and the event's active-entry count is unchanged:
    the same one person is still entered."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, verified)

    entry = await _enter(db_session, event, ephemeral)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    await db_session.refresh(entry)
    assert entry.user_id == verified.id
    assert entry.status is TournamentEntryStatus.entered

    entries = await _entries_for(db_session, event)
    active = [e for e in entries if e.status is TournamentEntryStatus.entered]
    assert len(active) == 1, "the event's active-entry count must not change"
    # Nothing left pointing at the tombstone.
    assert not [e for e in entries if e.user_id == ephemeral.id]


async def test_merge_dedups_entry_when_both_users_entered_same_event(
    db_session: AsyncSession,
):
    """The collision case. Both users hold an ACTIVE entry in the SAME event —
    legal today (they are different ``user_id``s), fatal on a naive re-point: the
    partial unique index ``(event_id, user_id) WHERE status = 'entered'`` would
    reject the second ``(event, survivor, entered)`` row and blow the whole merge
    up with an IntegrityError. The merge must instead drop the guest's losing row
    and keep exactly one active entry — the survivor's."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, verified)

    survivor_entry = await _enter(db_session, event, verified)
    guest_entry = await _enter(db_session, event, ephemeral)
    assert survivor_entry.id != guest_entry.id

    # A naive ``UPDATE ... SET user_id = survivor`` raises IntegrityError here.
    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    entries = await _entries_for(db_session, event)
    assert [e.id for e in entries] == [survivor_entry.id], (
        "the survivor's entry stands and the guest's duplicate is dropped"
    )
    assert entries[0].user_id == verified.id
    assert entries[0].status is TournamentEntryStatus.entered


async def test_merge_keeps_withdrawn_entry_when_survivor_is_actively_entered(
    db_session: AsyncSession,
):
    """The index is PARTIAL, so a guest's WITHDRAWN row for an event the survivor
    is actively entered in does not collide with anything — it must ride onto the
    survivor, not be mistaken for the duplicate-active case and deleted. The
    active count still comes out at one."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, verified)

    withdrawn = await _enter(
        db_session, event, ephemeral, status=TournamentEntryStatus.withdrawn
    )
    survivor_entry = await _enter(db_session, event, verified)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    entries = await _entries_for(db_session, event)
    assert {e.id for e in entries} == {withdrawn.id, survivor_entry.id}
    assert all(e.user_id == verified.id for e in entries)
    active = [e for e in entries if e.status is TournamentEntryStatus.entered]
    assert [e.id for e in active] == [survivor_entry.id]


async def test_merge_carries_both_users_withdrawn_entries_for_one_event(
    db_session: AsyncSession,
):
    """Two WITHDRAWN rows for the same (event, user) pair are legal — the unique
    index only covers ``status = 'entered'``. So both users' withdrawn history
    must survive the merge on the survivor, with no active entry conjured and
    nothing spuriously deduped."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, verified)

    guest_withdrawn = await _enter(
        db_session, event, ephemeral, status=TournamentEntryStatus.withdrawn
    )
    survivor_withdrawn = await _enter(
        db_session, event, verified, status=TournamentEntryStatus.withdrawn
    )

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    entries = await _entries_for(db_session, event)
    assert {e.id for e in entries} == {guest_withdrawn.id, survivor_withdrawn.id}
    assert all(e.user_id == verified.id for e in entries)
    assert all(e.status is TournamentEntryStatus.withdrawn for e in entries)


async def test_merge_repoints_active_entry_over_survivors_withdrawn_row(
    db_session: AsyncSession,
):
    """The survivor withdrew from an event the guest is actively entered in. The
    guest's ACTIVE row does NOT collide (the survivor has no active row), so it
    re-points — the merged player stays entered, and the withdrawn row sits
    alongside it."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, verified)

    survivor_withdrawn = await _enter(
        db_session, event, verified, status=TournamentEntryStatus.withdrawn
    )
    guest_active = await _enter(db_session, event, ephemeral)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    entries = await _entries_for(db_session, event)
    assert {e.id for e in entries} == {survivor_withdrawn.id, guest_active.id}
    assert all(e.user_id == verified.id for e in entries)
    active = [e for e in entries if e.status is TournamentEntryStatus.entered]
    assert [e.id for e in active] == [guest_active.id]


async def test_merge_repoints_rating_history_created_by(
    db_session: AsyncSession,
    rating_strategies: dict,
):
    """`rating_history.created_by_user_id` is SET NULL on delete; the merge
    re-points it so the audit trail still records who acted."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    league = await get_default_league(db_session)

    row = RatingHistory(
        league_id=league.id,
        user_id=verified.id,
        rating_strategy_id=rating_strategies["glicko2"].id,
        rating_value=1500.0,
        rating_state={"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
        source=RatingHistorySource.manual,
        created_by_user_id=ephemeral.id,
        note="moderator override",
    )
    db_session.add(row)
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    await db_session.refresh(row)
    assert row.created_by_user_id == verified.id


async def test_merge_repoints_match_result_submitted_by(db_session: AsyncSession):
    """``match_results.submitted_by_user_id`` is RESTRICT and the result is match
    history we keep — so the merge re-points it onto the survivor, otherwise the
    posted result would keep crediting the tombstoned ghost."""
    ephemeral = await _make_ephemeral(db_session, "wandering-heron")
    verified = await _make_verified(db_session, "submitter@example.com")
    opponent = await _make_verified(db_session, "opponent@example.com")

    match = await _record_match(db_session, ephemeral, ephemeral, opponent)
    result = await _record_result(db_session, match, submitted_by=ephemeral)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    await db_session.refresh(result)
    assert result.submitted_by_user_id == verified.id


# ----- roles --------------------------------------------------------------


async def test_merge_carries_role_the_survivor_lacks(db_session: AsyncSession):
    """A role granted to the ephemeral session must ride onto the survivor —
    dropping it would silently revoke a grant the moment the guest signs in.
    ``user_roles`` PKs on (user_id, role_id) with no ON DELETE CASCADE firing on
    a tombstone, so the merge re-points the grant explicitly."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")

    role = Role(name="tournament-director")
    db_session.add(role)
    await db_session.commit()
    db_session.add(UserRole(user_id=ephemeral.id, role_id=role.id))
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    survivor_role_ids = (
        (
            await db_session.execute(
                select(UserRole.role_id).where(UserRole.user_id == verified.id)
            )
        )
        .scalars()
        .all()
    )
    assert survivor_role_ids == [role.id]

    # The tombstoned ephemeral user ends with no roles.
    ephemeral_role_ids = (
        (
            await db_session.execute(
                select(UserRole.role_id).where(UserRole.user_id == ephemeral.id)
            )
        )
        .scalars()
        .all()
    )
    assert ephemeral_role_ids == []


async def test_merge_role_held_by_both_does_not_collide(db_session: AsyncSession):
    """When both users already hold the same role, the (user_id, role_id) PK
    would collide on a naïve re-point. The NOT EXISTS guard skips it; the merge
    does not raise and the survivor keeps the role exactly once, while the
    ephemeral duplicate is cleared by the tombstone cleanup."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")

    role = Role(name="tournament-director")
    db_session.add(role)
    await db_session.commit()
    db_session.add_all(
        [
            UserRole(user_id=ephemeral.id, role_id=role.id),
            UserRole(user_id=verified.id, role_id=role.id),
        ]
    )
    await db_session.commit()

    # Must not raise on the composite PK.
    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    survivor_role_ids = (
        (
            await db_session.execute(
                select(UserRole.role_id).where(UserRole.user_id == verified.id)
            )
        )
        .scalars()
        .all()
    )
    # Held exactly once — no duplicate row.
    assert survivor_role_ids == [role.id]

    ephemeral_role_ids = (
        (
            await db_session.execute(
                select(UserRole.role_id).where(UserRole.user_id == ephemeral.id)
            )
        )
        .scalars()
        .all()
    )
    assert ephemeral_role_ids == []


# ----- counts -------------------------------------------------------------


async def test_merge_summary_counts_distinct_matches(
    db_session: AsyncSession,
):
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    opp1 = await _make_ephemeral(db_session, "opp-one")
    opp2 = await _make_ephemeral(db_session, "opp-two")

    await _record_match(db_session, ephemeral, ephemeral, opp1)
    await _record_match(db_session, ephemeral, ephemeral, opp2)

    summary = await merge_user(
        db_session, from_user_id=ephemeral.id, to_user_id=verified.id
    )
    await db_session.commit()
    assert summary.matches_moved == 2


async def test_merge_summary_zero_when_ephemeral_played_nothing(
    db_session: AsyncSession,
):
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    summary = await merge_user(
        db_session, from_user_id=ephemeral.id, to_user_id=verified.id
    )
    await db_session.commit()
    assert summary.matches_moved == 0


async def test_merge_self_merge_raises(db_session: AsyncSession):
    # A self-merge would no-op every UPDATE and then tombstone-delete the only
    # remaining account. merge_user refuses it rather than losing the user.
    user = await _make_verified(db_session, "self@example.com")
    with pytest.raises(ValueError, match="must not equal"):
        await merge_user(db_session, from_user_id=user.id, to_user_id=user.id)


# ----- skip cases handled by the endpoint guard ---------------------------
# (`merge_user` itself doesn't check verified-ness — that's the caller's
# responsibility, enforced in sessions._maybe_merge_prior_session. Same-id is
# guarded inside merge_user; see test_merge_self_merge_raises.)


async def test_merge_with_user_league_rating_collision_drops_ephemeral(
    db_session: AsyncSession,
):
    """When both users have a UserLeagueRating in the same league (both got
    seeded into the default league), the NOT EXISTS guard skips the re-point
    and the ephemeral row cascade-deletes with the user."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    await add_user_to_default_league(db_session, verified.id)
    await db_session.commit()

    league = await get_default_league(db_session)
    # Sanity: both have a rating row pre-merge.
    pre = (
        (
            await db_session.execute(
                select(UserLeagueRating).where(UserLeagueRating.league_id == league.id)
            )
        )
        .scalars()
        .all()
    )
    assert {r.user_id for r in pre} == {ephemeral.id, verified.id}

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    rows = (
        (
            await db_session.execute(
                select(UserLeagueRating).where(UserLeagueRating.league_id == league.id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.user_id for r in rows] == [verified.id]


async def test_merge_repoints_match_result_accepted_by(db_session: AsyncSession):
    """``match_results.accepted_by_user_id`` is a nullable RESTRICT FK to users,
    so the merge must re-point an accepted result from the ephemeral acceptor
    onto the verified survivor — otherwise the final ephemeral-user delete would
    be blocked by the RESTRICT FK (or orphan history pointing at a ghost)."""
    submitter = await _make_ephemeral(db_session, "spinning-otter")
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    match = await _record_match(db_session, submitter, submitter, ephemeral)
    # The ephemeral user is the acceptor; submitter proposed.
    result = await _record_result(
        db_session, match, submitted_by=submitter, accepted_by=ephemeral
    )

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    await db_session.refresh(result)
    assert result.accepted_by_user_id == verified.id
    # The ephemeral user is tombstoned, not dropped — the RESTRICT FK on
    # accepted_by_user_id was satisfied by the re-point above.
    ephemeral_row = (
        await db_session.execute(select(User).where(User.id == ephemeral.id))
    ).scalar_one_or_none()
    assert ephemeral_row is not None
    assert ephemeral_row.merged_into_user_id == verified.id


async def test_merge_self_play_drops_orphaned_match_side(db_session: AsyncSession):
    """Self-play across two guest sessions (e.g. same person on two devices)
    leaves both sides of a match pointing at the same real user after merge.
    The NOT EXISTS guard skips re-pointing the ephemeral side; the belt-and-
    braces DELETE then removes that MatchSidePlayer, which would previously
    leave a playerless MatchSide rendering as 'No opponent' / 'vs Guest'.
    The fix: the empty MatchSide is cleaned up in the same merge transaction."""
    # guest_a played guest_b (same real person, two devices) before merging.
    guest_a = await _make_ephemeral(db_session, "ghost-device-a")
    guest_b = await _make_ephemeral(db_session, "ghost-device-b")
    verified = await _make_verified(db_session, "rita@example.com")

    # An unrelated user's solo match carries an intentional player-less
    # "sentinel" side 2 (opponent-less matches still have two sides). The merge
    # cleanup must NOT touch it — it belongs to neither merged user.
    bystander = await _make_ephemeral(db_session, "uninvolved-newt")
    solo_match = await _record_solo_match(db_session, bystander)

    # guest_b merges first — side 2 now belongs to verified.
    match = await _record_match(db_session, guest_a, guest_a, guest_b)
    await merge_user(db_session, from_user_id=guest_b.id, to_user_id=verified.id)
    await db_session.commit()

    # Now merge guest_a → verified. Side 1's player can't re-point (verified
    # is already on the match); the belt-and-braces DELETE fires; without the
    # fix, side 1 would be left playerless.
    summary = await merge_user(
        db_session, from_user_id=guest_a.id, to_user_id=verified.id
    )
    await db_session.commit()

    # guest_a played this one match — the NOT EXISTS guard skipping the
    # re-point (because verified was already on the match) must not make the
    # summary under-report it as zero matches moved (#235). An UNRATED collision
    # is not voided, so it stays a moved match and nothing is voided.
    assert summary.matches_moved == 1
    assert summary.matches_voided == 0

    result = await db_session.execute(
        select(MatchSide).where(MatchSide.match_id == match.id)
    )
    sides = result.scalars().all()
    # The orphaned side must be gone; only verified's side survives.
    assert len(sides) == 1, f"expected 1 side after self-play merge, got {len(sides)}"

    # The bystander's solo match keeps both sides — its player-less sentinel
    # side must survive a merge it had nothing to do with.
    solo_sides = (
        (
            await db_session.execute(
                select(MatchSide).where(MatchSide.match_id == solo_match.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(solo_sides) == 2, (
        f"unrelated solo match lost a side after merge, got {len(solo_sides)}"
    )


async def test_merge_rated_self_play_collision_voids_match(
    db_session: AsyncSession,
    rating_strategies: dict,
):
    """A guest merging into a claimed account they had already PLAYED on a
    *rated* match (self-play collision, ADR-0013): the match must be VOIDED, its
    emptied side left player-less (not pruned), and its rating_history deleted
    for BOTH users — so it contributes nothing to the survivor's rating.

    This is the #750 fix. Pre-chore the emptied side is pruned (half-delete): the
    match stays ``completed`` with one side while the survivor's rating_history
    row survives, permanently inflating their rating. This test FAILS on the
    pre-chore code (side count 1, status completed, orphaned rating row).
    """
    # Same real person on two guest devices, later signing into one account.
    guest_a = await _make_ephemeral(db_session, "ghost-device-a")
    guest_b = await _make_ephemeral(db_session, "ghost-device-b")
    verified = await _make_verified(db_session, "rita@example.com")

    # A rated match guest_a vs guest_b on OPPOSITE sides.
    match = await _record_rated_match(db_session, guest_a, guest_a, guest_b)

    # guest_b merges first: side 2 now belongs to verified.
    await merge_user(db_session, from_user_id=guest_b.id, to_user_id=verified.id)
    await db_session.commit()

    # The completed rated match produced a rating_history row for each
    # participant — now guest_a (side 1) and verified (side 2, ex-guest_b).
    await _seed_match_rating_row(
        db_session,
        match=match,
        user=guest_a,
        rating_strategy_id=rating_strategies["glicko2"].id,
    )
    await _seed_match_rating_row(
        db_session,
        match=match,
        user=verified,
        rating_strategy_id=rating_strategies["glicko2"].id,
    )

    # guest_a merges: verified is already on the match → self-play collision.
    summary = await merge_user(
        db_session, from_user_id=guest_a.id, to_user_id=verified.id
    )
    await db_session.commit()

    # A VOIDED rated collision does NOT count toward the "we brought your N
    # matches" toast — it transferred to the survivor but no longer counts, so
    # matches_moved excludes it and matches_voided records it. (Contrast the
    # UNRATED self-play test above, which still reports matches_moved == 1: an
    # unrated collision isn't voided, so it stays a moved match — #235.)
    assert summary.matches_moved == 0
    assert summary.matches_voided == 1

    await db_session.refresh(match)
    # Voided, not left completed.
    assert match.status == MatchStatus.voided, (
        f"expected voided, got {match.status} — half-deleted rather than voided?"
    )

    # Both sides survive; the guest's side is player-less (the solo-sentinel
    # shape), NOT pruned away.
    sides = (
        (
            await db_session.execute(
                select(MatchSide)
                .where(MatchSide.match_id == match.id)
                .options(selectinload(MatchSide.players))
                .order_by(MatchSide.side_number)
            )
        )
        .scalars()
        .all()
    )
    assert len(sides) == 2, (
        f"expected 2 sides (emptied side left player-less), got {len(sides)}"
    )
    player_counts = [len(s.players) for s in sides]
    assert sorted(player_counts) == [0, 1], (
        f"expected one player-less side and one with the survivor, got {player_counts}"
    )
    # The surviving player on the populated side is the survivor.
    populated = next(s for s in sides if s.players)
    assert populated.players[0].user_id == verified.id

    # No rating_history for this match survives, for EITHER user — the void
    # deleted them (the survivor's row is the one the pre-chore cascade orphaned).
    rating_rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert rating_rows == [], (
        f"voided match must leave no rating_history, found {len(rating_rows)}"
    )


async def test_void_match_clears_won_and_keeps_sides_intact(
    db_session: AsyncSession,
):
    """``void_match`` clears the decision on BOTH sides — ``won is None`` — while
    leaving the sides and their players intact.

    "Voided ⟹ no winner, no rating history" is one indivisible fact: any surface
    that derives a result from ``MatchSide.won`` (the profile match table) must
    see no winner. The sides/players themselves are kept — the match is a record,
    not a deletion (ADR-0013)."""
    creator = await _make_ephemeral(db_session, "creator")
    opponent = await _make_ephemeral(db_session, "opponent")
    match = await _record_rated_match(db_session, creator, creator, opponent)

    # Stamp the decision the way a completed match does (creator won, opp lost).
    sides = (
        (
            await db_session.execute(
                select(MatchSide)
                .where(MatchSide.match_id == match.id)
                .order_by(MatchSide.side_number)
            )
        )
        .scalars()
        .all()
    )
    sides[0].won = True
    sides[1].won = False
    await db_session.commit()

    match_id = match.id
    creator_id = creator.id
    opponent_id = opponent.id
    await void_match(db_session, match)
    await db_session.commit()

    # The Core UPDATE won't refresh already-loaded ORM objects — re-query.
    db_session.expire_all()
    reloaded = (
        (
            await db_session.execute(
                select(MatchSide)
                .where(MatchSide.match_id == match_id)
                .options(selectinload(MatchSide.players))
                .order_by(MatchSide.side_number)
            )
        )
        .scalars()
        .all()
    )

    await db_session.refresh(match)
    assert match.status == MatchStatus.voided
    # Both sides survive, decision cleared on both.
    assert len(reloaded) == 2
    assert [side.won for side in reloaded] == [None, None]
    # Players untouched — the match is kept as a record, not half-deleted.
    assert [len(side.players) for side in reloaded] == [1, 1]
    assert reloaded[0].players[0].user_id == creator_id
    assert reloaded[1].players[0].user_id == opponent_id


async def test_merge_self_play_collision_shows_no_result_on_survivor_profile(
    api_client: AsyncClient,
    db_session: AsyncSession,
    rating_strategies: dict,
):
    """End-to-end regression for the P1: after a merge voids a self-play
    collision, the survivor's profile match table must report NO win and NO loss
    for that match, agreeing with the hero's career W-L.

    The bug: the void flipped ``Match.status`` to ``voided`` but left
    ``MatchSide.won`` stamped, so the status-gated hero read "W-L 0-0" while the
    ungated profile match table derived a phantom LOSS from ``won is False`` — the
    page contradicted itself. Guards the whole merge → ``void_match`` → profile
    chain, not just the pieces. FAILS before ``void_match`` clears ``won`` (the
    survivor's row reports "L")."""
    guest_a = await _make_ephemeral(db_session, "ghost-device-a")
    guest_b = await _make_ephemeral(db_session, "ghost-device-b")
    verified = await _make_verified(db_session, "rita@example.com")

    # A completed rated match guest_a (side 1, won) vs guest_b (side 2, lost) —
    # ``won`` stamped on both sides the way a real completed match is (#485).
    match = await _record_rated_match(db_session, guest_a, guest_a, guest_b)
    sides = (
        (
            await db_session.execute(
                select(MatchSide)
                .where(MatchSide.match_id == match.id)
                .order_by(MatchSide.side_number)
            )
        )
        .scalars()
        .all()
    )
    sides[0].won = True
    sides[1].won = False
    await db_session.commit()

    # guest_b merges first: side 2 (the loser) now belongs to verified.
    await merge_user(db_session, from_user_id=guest_b.id, to_user_id=verified.id)
    await db_session.commit()
    # guest_a merges: verified is already on the match → self-play collision, voided.
    summary = await merge_user(
        db_session, from_user_id=guest_a.id, to_user_id=verified.id
    )
    await db_session.commit()
    assert summary.matches_voided == 1

    # A viewer loads the survivor's profile bundle.
    await start_session(api_client, db_session)
    response = await api_client.get(f"/v1/players/{verified.id}")
    assert response.status_code == 200
    body = response.json()
    # The voided match is kept as a record — still in history — but shows no W/L.
    items = body["matches"]["items"]
    assert len(items) == 1
    assert items[0]["status"] == "voided"
    assert items[0]["result"] is None
    # The hero agrees: the voided match counts toward neither.
    assert body["wins"] == 0
    assert body["losses"] == 0


async def test_merge_no_collision_when_account_never_played(
    db_session: AsyncSession,
    rating_strategies: dict,
):
    """A guest merging into an account they NEVER played: nothing is voided and
    every match moves across intact. Guards against over-voiding — the void is
    strictly the opposite-sides collision case."""
    guest = await _make_ephemeral(db_session, "wandering-heron")
    verified = await _make_verified(db_session, "rita@example.com")
    opponent = await _make_ephemeral(db_session, "genuine-opponent")

    # A rated match the guest played against a real, unrelated opponent — the
    # verified account was never a participant. Seed the OPPONENT's rating row:
    # they are neither merge party, so nothing (least of all a void) should
    # touch it. A void would delete it by match_id — its survival proves no void.
    match = await _record_rated_match(db_session, guest, guest, opponent)
    await _seed_match_rating_row(
        db_session,
        match=match,
        user=opponent,
        rating_strategy_id=rating_strategies["glicko2"].id,
    )

    summary = await merge_user(
        db_session, from_user_id=guest.id, to_user_id=verified.id
    )
    await db_session.commit()

    assert summary.matches_moved == 1

    await db_session.refresh(match)
    # Not voided — this is not a self-play collision.
    assert match.status == MatchStatus.completed

    # The match moved wholly to the survivor: both sides intact, the guest's
    # side re-pointed onto verified, the opponent untouched.
    sides = (
        (
            await db_session.execute(
                select(MatchSide)
                .where(MatchSide.match_id == match.id)
                .options(selectinload(MatchSide.players))
                .order_by(MatchSide.side_number)
            )
        )
        .scalars()
        .all()
    )
    assert len(sides) == 2
    user_ids = {s.players[0].user_id for s in sides}
    assert user_ids == {verified.id, opponent.id}

    # The uninvolved opponent's rating_history row for the match survives — no
    # void ran (a void deletes by match_id, which would have taken it).
    rating_rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.user_id for r in rating_rows] == [opponent.id]


async def test_merge_solo_match_survives_with_sentinel_side(
    db_session: AsyncSession,
):
    """A SOLO match owned by the guest is not a self-play collision (the survivor
    is not a participant — the sentinel side is player-less). It must move across
    with both sides intact: side 1 re-pointed onto the survivor, side 2 still the
    player-less sentinel. Proves collision detection can't mistake a solo match
    for a collision and void it."""
    guest = await _make_ephemeral(db_session, "solo-wanderer")
    verified = await _make_verified(db_session, "rita@example.com")

    solo_match = await _record_solo_match(db_session, guest)

    await merge_user(db_session, from_user_id=guest.id, to_user_id=verified.id)
    await db_session.commit()

    await db_session.refresh(solo_match)
    # Not voided — a solo match is not a collision.
    assert solo_match.status == MatchStatus.in_progress

    sides = (
        (
            await db_session.execute(
                select(MatchSide)
                .where(MatchSide.match_id == solo_match.id)
                .options(selectinload(MatchSide.players))
                .order_by(MatchSide.side_number)
            )
        )
        .scalars()
        .all()
    )
    assert len(sides) == 2, f"solo match should keep both sides, got {len(sides)}"
    # Side 1 re-pointed onto the survivor; side 2 is still the player-less
    # sentinel (untouched by any prune or void).
    assert [len(s.players) for s in sides] == [1, 0]
    assert sides[0].players[0].user_id == verified.id
