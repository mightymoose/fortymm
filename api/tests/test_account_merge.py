"""Unit tests for the ephemeral→verified merge primitive in app.account_merge."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import account_merge
from app import queue as queue_module
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
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    User,
    UserLeagueRating,
    UserRole,
    UserToken,
)
from app.roles import grant_default_role
from app.sessions import SESSION_TOKEN_CONTEXT
from app.tournament_draws import cut_draw
from app.tournament_event_stages import mint_stages
from app.tournament_queries import stage_ids_for_events
from tests._helpers import (
    event_groups,
    start_session,
    venue_tables,
)


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


async def _default_league_id(db: AsyncSession) -> uuid.UUID:
    """The default league's id — ``tournaments.league_id`` is NOT NULL (ADR-0783)
    and nothing in this file turns on *which* ladder a tournament is run on."""
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"
    return league.id


async def test_merge_repoints_tournament_ownership(db_session: AsyncSession):
    """``tournaments.created_by_user_id`` is RESTRICT on delete; the merge
    re-points it to the verified user so the final tombstone delete isn't
    blocked and the tournament keeps its owner (and its events)."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")

    tournament = Tournament(
        name="Guest Cup",
        league_id=await _default_league_id(db_session),
        created_by_user_id=ephemeral.id,
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(("Table 1", "A")),
    )
    tournament.events.append(
        TournamentEvent(
            name="Open Singles",
            format=EventFormat.singles,
            draw_settings=TournamentEventDrawSettings.for_draw_type(
                DrawType.single_elim
            ),
            max_players=32,
            entry_fee=40,
            timezone="America/Chicago",
            slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
            match_settings={"rated": True, "length_games": 5},
            predicates=[],
            stages=mint_stages(DrawType.single_elim),
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
    """A singles event on a tournament ``owner`` created. An event has no entry
    counter to set: the count is derived from the entries themselves."""
    tournament = Tournament(
        name="Guest Cup",
        league_id=await _default_league_id(db),
        created_by_user_id=owner.id,
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(("Table 1", "A")),
    )
    event = TournamentEvent(
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.single_elim),
        tournament=tournament,
        max_players=32,
        entry_fee=40,
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        stages=mint_stages(DrawType.single_elim),
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


async def _enter(
    db: AsyncSession,
    event: TournamentEvent,
    user: User,
    *,
    status: TournamentEntryStatus = TournamentEntryStatus.entered,
    added_by: User | None = None,
    seed: int | None = None,
    created_at: datetime | None = None,
) -> TournamentEntry:
    """``added_by=None`` is not "unspecified" — it is self-registration, the
    default state of every entry (ADR-0784). Pass a user to make it a *director*
    entry: that user put this player in the event.

    ``created_at`` is settable because registration order is **load-bearing** — it
    is the draw's ordering tie-break (``app.draws.order_entrants``) — so the
    collision tests below need to say which of two entries came first rather than
    hope the server clock separated two commits."""
    entry = TournamentEntry(
        event_id=event.id,
        user_id=user.id,
        status=status,
        added_by_user_id=added_by.id if added_by is not None else None,
        seed=seed,
    )
    if created_at is not None:
        # Assigned rather than passed to the constructor: ``created_at`` carries a
        # server default, and handing it an explicit ``None`` would insert NULL into
        # a NOT NULL column instead of falling back to ``now()``.
        entry.created_at = created_at
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


async def _entries_for(
    db: AsyncSession, event: TournamentEvent
) -> list[TournamentEntry]:
    # ``merge_user`` re-points entries with a bulk statement, which the identity
    # map never sees, and the test sessionmaker sets ``expire_on_commit=False`` —
    # so a plain SELECT hands back stale copies still carrying the *pre-merge*
    # ``user_id``, making a correct merge look as though it did nothing.
    # ``populate_existing`` overwrites them from the row that came back, so what
    # we assert on is what the database actually holds.
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


async def test_merge_repoints_the_entry_adder_onto_survivor(
    db_session: AsyncSession,
):
    """The *second* users FK on ``tournament_entries``: ``added_by_user_id``, who
    put this player in the event (ADR-0784).

    A guest DIRECTOR entered somebody, then signed in. The entry itself is not in
    question — a real player is really entered, and their ``user_id`` is not the
    guest's to move. What must not survive is the *pointer*: the guest is about to
    become a tombstone, and an unhandled FK would leave the entry saying "added by
    <ghost>" — a user that no listing, search or auth query will ever return. The
    adder and the survivor are the same human, so the adder follows the merge.
    """
    director_guest = await _make_ephemeral(db_session, "drifting-grouse")
    director = await _make_verified(db_session, "rita@example.com")
    player = await _make_verified(db_session, "pete@example.com")
    event = await _make_event(db_session, director_guest)

    entry = await _enter(db_session, event, player, added_by=director_guest)

    await merge_user(db_session, from_user_id=director_guest.id, to_user_id=director.id)
    await db_session.commit()

    await db_session.refresh(entry)
    assert entry.added_by_user_id == director.id, (
        "the adder must point at the LIVE survivor, not the tombstoned guest"
    )
    # The entrant is a third party and is untouched: this merge is about who
    # *added* them, not about who they are.
    assert entry.user_id == player.id
    assert entry.status is TournamentEntryStatus.entered

    entries = await _entries_for(db_session, event)
    assert not [e for e in entries if e.added_by_user_id == director_guest.id]


async def test_merge_nulls_the_adder_when_the_director_turns_out_to_be_the_entrant(
    db_session: AsyncSession,
):
    """The degenerate case of the re-point, and the reason it is a ``CASE`` rather
    than a flat ``SET added_by_user_id = :to_id``.

    I run a tournament as a guest and add "Rita" (an existing account) from the
    player search. Then I sign in — and I *am* Rita. Post-merge, one person both
    added the entry and is the entry. That is self-registration, and
    self-registration is spelled ``NULL`` (ADR-0784). A flat re-point would instead
    write ``added_by_user_id == user_id``, a second, contradictory encoding of "she
    entered herself" that the entrants list would render as "added by the
    director" — a director who is the player.
    """
    director_guest = await _make_ephemeral(db_session, "drifting-grouse")
    rita = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, director_guest)

    entry = await _enter(db_session, event, rita, added_by=director_guest)

    await merge_user(db_session, from_user_id=director_guest.id, to_user_id=rita.id)
    await db_session.commit()

    await db_session.refresh(entry)
    assert entry.user_id == rita.id
    assert entry.added_by_user_id is None, (
        "one person adding themselves IS self-registration — collapse it to NULL"
    )


async def test_merge_leaves_the_adder_alone_when_the_ENTRANT_is_the_one_merged(
    db_session: AsyncSession,
):
    """The mirror image, and the guard against the re-point over-firing: here it is
    the *player* who was a guest, and the director is a bystander. The entry's
    ``user_id`` moves to the survivor; the record of who added them must not be
    touched — least of all nulled, which would erase a director entry into a
    self-registration that never happened."""
    player_guest = await _make_ephemeral(db_session, "drifting-grouse")
    player = await _make_verified(db_session, "pete@example.com")
    director = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, director)

    entry = await _enter(db_session, event, player_guest, added_by=director)

    await merge_user(db_session, from_user_id=player_guest.id, to_user_id=player.id)
    await db_session.commit()

    await db_session.refresh(entry)
    assert entry.user_id == player.id
    assert entry.added_by_user_id == director.id


async def test_merge_collapses_a_guest_who_both_added_and_is_the_entry(
    db_session: AsyncSession,
):
    """**The statement ORDER inside ``merge_user`` is load-bearing, and this is the only
    test that pins it.**

    ``merge_user`` re-points ``tournament_entries.user_id`` onto the survivor, and only
    *then* runs the ``CASE`` over ``added_by_user_id`` — a CASE whose condition
    (``user_id = :to_id``) reads the **post-merge** ``user_id``. Swap the two statements
    and every other test in this file still passes, because in all of them the entry's
    ``user_id`` is either already the survivor's or is never the adder's.

    The shape that tells the two orders apart is the one where the guest is **both** the
    entrant and the adder — ``user_id == added_by == from_id``:

    * **Correct order.** ``user_id`` becomes ``to_id``; the CASE then sees
      ``user_id = to_id`` and writes **NULL** — one person adding themselves *is*
      self-registration, and self-registration is spelled NULL (ADR-0784).
    * **Reversed.** The CASE runs while ``user_id`` is still the guest's, so it does not
      match ``to_id`` and writes ``added_by = to_id``; the re-point then sets
      ``user_id = to_id`` as well. The merge has *manufactured* ``added_by == user_id``
      — the second, contradictory encoding of "they entered themselves" that the CASE
      exists to prevent, rendered by the entrants list as "added by the director" on an
      entry whose director is the player.

    The row is written **directly**, and deliberately so: the entry route refuses to
    mint this shape (an owner naming their own ``user_id`` is self-registration, stored
    NULL — ``test_the_owner_entering_themselves_by_user_id_records_no_adder``), and
    there is no CHECK constraint standing behind it either, because the entry route maps
    ``IntegrityError`` to a ``already_entered`` 409 and a constraint violation would
    surface to a player as a false "you have already entered this event". Normalising in
    the handler is what keeps the column clean; *this* is what keeps the merge from
    quietly undoing that.
    """
    guest = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, guest)

    # The guest is the entrant AND the adder: user_id == added_by_user_id == from_id.
    entry = await _enter(db_session, event, guest, added_by=guest)

    await merge_user(db_session, from_user_id=guest.id, to_user_id=verified.id)
    await db_session.commit()

    await db_session.refresh(entry)
    assert entry.user_id == verified.id
    assert entry.added_by_user_id is None, (
        "the CASE must read the POST-merge user_id: run it before the user_id re-point "
        "and it writes added_by = user_id, the very encoding it exists to collapse"
    )
    assert entry.added_by_user_id != entry.user_id


async def test_merge_collapses_the_adder_when_the_ENTRANT_merges_into_the_director(
    db_session: AsyncSession,
):
    """The **mirror** of the case above, and the one the merge could *manufacture*.

    There, the guest was both the entrant and the adder before the merge. Here neither
    id is contradictory to begin with — the merge makes it so:

    * Director **D** (a real account) enters **guest player P** through
      ``POST …/entries`` (ADR-0784), so the row is ``user_id = P``, ``added_by = D``.
      Both perfectly ordinary; this is the shape the director's arm of the entry route
      writes every time it is used.
    * P signs in — and turns out to BE D (the director had a guest session of their own
      on the club laptop). ``merge_user(from=P, to=D)``.
    * The ``user_id`` re-point rewrites ``user_id`` to D. ``added_by`` is *already* D.

    One person is now both the entrant and the adder, so — exactly as in the case above
    — this is self-registration and must be spelled ``NULL``. A CASE guarded by
    ``WHERE added_by_user_id = :from_id`` alone never even looks at this row (its adder
    is the *survivor*, not the guest), and leaves ``added_by == user_id``: the second,
    contradictory encoding of "she entered herself", written by the merge itself.
    ``WHERE added_by_user_id IN (:from_id, :to_id)`` is what closes it.

    Note what this is NOT: the entrant merging into a *bystander* director must leave
    the adder alone (``test_merge_leaves_the_adder_alone_when_the_ENTRANT_is_the_one_
    merged``). The difference is whether the director and the survivor are the same
    person — which is the only thing that makes "added by the director" a lie.
    """
    player_guest = await _make_ephemeral(db_session, "drifting-grouse")
    director = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, director)

    # The row the director's entry route writes: a real player, added by a real
    # director. Nothing contradictory about it — yet.
    entry = await _enter(db_session, event, player_guest, added_by=director)

    # ...and the guest player turns out to be the director.
    await merge_user(db_session, from_user_id=player_guest.id, to_user_id=director.id)
    await db_session.commit()

    await db_session.refresh(entry)
    assert entry.user_id == director.id
    assert entry.added_by_user_id is None, (
        "the merge just made the adder and the entrant one person — that is "
        "self-registration, and it is spelled NULL, never added_by == user_id"
    )
    assert entry.added_by_user_id != entry.user_id


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


async def test_entry_dedup_status_is_bound_from_the_enum_not_a_sql_literal(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
):
    """Drift guard for the dedup's status predicate.

    Which status counts as *active* must come from ``TournamentEntryStatus``, not
    from an ``'entered'`` spelled into the raw SQL. A literal there passes every
    other test in this file today and rots silently the day the enum's value is
    renamed: the model, the routes and the partial unique index all follow the
    enum, the SQL doesn't, so the dedup's EXISTS matches nothing, deletes nothing,
    and the unconditional re-point that follows collides with the index — every
    merge where both users actively entered the same event dies on IntegrityError.

    Nothing static catches that, so pin it behaviourally: repoint the single seam
    (``_ACTIVE_ENTRY_STATUS``) at ``withdrawn`` and assert the SQL *follows*. Under
    the correct implementation the pair of withdrawn rows is now the colliding
    pair, so the guest's is deduped away and one survives. Under a hardcoded
    ``'entered'`` the seam is ignored, nothing is deduped, and both rows survive
    (i.e. the test that would have caught the drift goes red).
    """
    monkeypatch.setattr(
        account_merge, "_ACTIVE_ENTRY_STATUS", TournamentEntryStatus.withdrawn.value
    )
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_event(db_session, verified)

    await _enter(db_session, event, ephemeral, status=TournamentEntryStatus.withdrawn)
    survivor_withdrawn = await _enter(
        db_session, event, verified, status=TournamentEntryStatus.withdrawn
    )

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    entries = await _entries_for(db_session, event)
    assert [e.id for e in entries] == [survivor_withdrawn.id], (
        "the dedup must treat whatever the enum says is active as active — "
        "with the seam pointed at 'withdrawn', the withdrawn duplicate is the "
        "one it drops; a hardcoded 'entered' in the SQL would drop nothing"
    )


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


# ----- entry collisions vs. a cut draw ------------------------------------
#
# The hazard the tests below pin (ADR-0786): ``tournament_fixtures`` references
# ``tournament_entries`` with ON DELETE CASCADE, and the collision dedup above
# HARD-DELETES the guest's duplicate active entry. Left alone, that silently
# cascades away every fixture seating the guest — holes in a cut draw. The merge
# instead un-cuts the event's draw, because a draw cut from a field that
# double-counted a human is wrong throughout (its group sizes and snake seeding
# were computed against N+1 entrants), and carries the guest's earlier
# registration onto the surviving entry, because registration order is the draw's
# ordering tie-break.


async def _make_rr_event(
    db: AsyncSession,
    owner: User,
    *,
    tournament: Tournament | None = None,
    name: str = "Open Singles",
) -> TournamentEvent:
    """A **cuttable-into-groups** event: round-robin with one group. ``_make_event``
    above is single-elim, which cuts an ungrouped bracket instead — no group for every
    entrant to meet every other in.

    One group, not two, so that *every* entrant is seated in a fixture against every
    other — which is what makes "the guest's entry is in this draw" true by
    construction rather than by luck of the snake. Pass ``tournament`` to hang a
    second event off the same tournament (the un-cut must be scoped to the event
    that collided, not the tournament).
    """
    if tournament is None:
        tournament = Tournament(
            name="Guest Cup",
            league_id=await _default_league_id(db),
            created_by_user_id=owner.id,
            address={
                "venue": "Berkeley TT Club",
                "street": "2727 Milvia St",
                "city": "Berkeley",
                "region": "CA",
                "postal": "94703",
                "country": "USA",
                "latitude": 37.8703,
                "longitude": -122.2731,
            },
            tables=venue_tables(("Table 1", "A")),
        )
    db.add(tournament)
    # Flushed before the event is composed, because the reservation below reserves a
    # table and a reservation row carries the tournament's id — which is the
    # database's to mint (ADR 20260801).
    await db.flush()
    slot = {"date": "2026-06-13", "start": "09:00", "end": "18:00"}
    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        # By id rather than by ``tournament.events.append``: the tournament is flushed
        # above (its reservations need its id), and appending to a *persistent*
        # tournament's un-loaded ``events`` collection is a lazy load in sync context.
        tournament_id=tournament.id,
        name=name,
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=32,
        entry_fee=40,
        timezone="America/Chicago",
        slot=slot,
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        stages=stages,
    )
    stages[0].groups = event_groups(
        [{"name": "Reservation A", "slot": slot, "table_ids": ["t1"]}],
        event=event,
        tournament=tournament,
    )
    db.add(event)
    await db.commit()
    # ``groups`` explicitly: ``_cut`` below hands this event straight to ``cut_draw``,
    # which reads ``event.groups`` synchronously — a plain refresh leaves that VIEWONLY
    # association unloaded (ADR 20260815), and the read would be an async lazy load.
    await db.refresh(event, attribute_names=["groups"])
    return event


async def _cut(db: AsyncSession, event: TournamentEvent) -> list[TournamentFixture]:
    """Cut the event's draw and hand back the fixtures it wrote. ``cut_draw`` does
    not commit (the route owns the transaction), so this does."""
    await cut_draw(db, event)
    await db.commit()
    return await _fixtures_for(db, event)


async def _fixtures_for(
    db: AsyncSession, event: TournamentEvent
) -> list[TournamentFixture]:
    # ``populate_existing`` for the same reason ``_entries_for`` uses it: the merge
    # writes with bulk statements the identity map never sees, and the test
    # sessionmaker does not expire on commit — a plain SELECT would hand back stale
    # copies of rows the un-cut deleted.
    return list(
        (
            await db.execute(
                select(TournamentFixture)
                .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event.id])))
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )


def _seats(fixtures: list[TournamentFixture]) -> set[tuple]:
    """The identity + contents of each fixture — what a re-point onto the survivor
    (or a cascade hole) would change, and a genuinely untouched draw would not."""
    return {
        (f.id, f.group_id, f.round, f.position, f.entry_a_id, f.entry_b_id)
        for f in fixtures
    }


async def _fixtures_referencing(db: AsyncSession, entry_id: uuid.UUID) -> int:
    """How many fixtures **anywhere** name this entry, on any of its three entry
    columns. A merge that re-pointed the guest's fixtures onto the survivor would
    leave this at zero too — which is why the tests assert it *alongside* the
    event's fixture count, never instead of it."""
    return len(
        (
            await db.execute(
                select(TournamentFixture.id).where(
                    (TournamentFixture.entry_a_id == entry_id)
                    | (TournamentFixture.entry_b_id == entry_id)
                    | (TournamentFixture.winner_entry_id == entry_id)
                )
            )
        )
        .scalars()
        .all()
    )


async def test_merge_uncuts_the_draw_when_the_collision_double_counted_a_human(
    db_session: AsyncSession,
):
    """The whole point (ADR-0786). Guest and survivor are BOTH actively entered in an
    event whose draw is already cut — so the cut draw seats one human twice, and every
    group size and seeding decision in it was computed against a field of N+1.

    The dedup deletes the guest's duplicate entry, and ``tournament_fixtures`` cascades
    on that delete — so doing nothing else would leave the draw **holed**: fixtures
    silently gone from a draw the director still believes is cut. The tempting repair
    (re-point the guest's fixtures onto the surviving entry) is worse than the holes: it
    seats one person in two slots of the same group, and because the go-live currency
    check compares entrant *sets*, the corrupted draw would satisfy it and go live.

    So the draw is **un-cut**: zero fixtures, and the director re-cuts from the field
    that actually exists.
    """
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")
    event = await _make_rr_event(db_session, verified)

    earlier = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
    guest_entry = await _enter(db_session, event, ephemeral, created_at=earlier)
    survivor_entry = await _enter(
        db_session, event, verified, created_at=earlier + timedelta(hours=2)
    )
    await _enter(db_session, event, other, created_at=earlier + timedelta(hours=3))

    before = await _cut(db_session, event)
    assert len(before) == 3, "a one-group round-robin of three seats three fixtures"
    assert await _fixtures_referencing(db_session, guest_entry.id) == 2, (
        "precondition: the guest's entry really is in this draw — without it the "
        "assertions below would pass against a draw that never seated them"
    )

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    assert await _fixtures_for(db_session, event) == [], (
        "the draw must be UN-CUT, not holed: a field that double-counted a human is "
        "wrong throughout, so it is re-cut, never patched"
    )
    assert await _fixtures_referencing(db_session, guest_entry.id) == 0
    assert await _fixtures_referencing(db_session, survivor_entry.id) == 0, (
        "and the guest's fixtures must not have been re-pointed onto the survivor — "
        "that seats one human in two slots and would pass the go-live currency check"
    )

    entries = await _entries_for(db_session, event)
    active = [e for e in entries if e.status is TournamentEntryStatus.entered]
    assert {e.id for e in active} == {
        survivor_entry.id,
        *(e.id for e in entries if e.user_id == other.id),
    }
    mine = [e for e in active if e.user_id == verified.id]
    assert [e.id for e in mine] == [survivor_entry.id], (
        "one person, one active entry — the survivor's row is the one that stands"
    )


async def test_merge_carries_the_earlier_registration_onto_the_surviving_entry(
    db_session: AsyncSession,
):
    """Registration order is **load-bearing**: it is the draw's ordering tie-break for
    the unseeded (``app.draws.order_entrants`` — seed ascending where set, then
    ``created_at``). The guest registered FIRST and the survivor second, so keeping the
    survivor's row untouched would silently move that player *down* the next draw — a
    place they lose by having signed in.

    So the survivor's entry inherits the earlier ``created_at``, and the guest's seed
    where the survivor has none (a seed is a director's decision about this player, and
    it does not evaporate because they turned out to already have an account).
    """
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_rr_event(db_session, verified)

    earlier = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
    later = datetime(2026, 6, 2, 9, 0, tzinfo=UTC)
    await _enter(db_session, event, ephemeral, created_at=earlier, seed=3)
    survivor_entry = await _enter(db_session, event, verified, created_at=later)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    entries = await _entries_for(db_session, event)
    assert [e.id for e in entries] == [survivor_entry.id]
    assert entries[0].created_at == earlier, (
        "the surviving entry must carry the EARLIER of the two registrations — "
        "keeping the survivor's own timestamp demotes them in the next draw"
    )
    assert entries[0].seed == 3, (
        "an unseeded survivor adopts the guest's seed; the seeding is a fact about "
        "the player, not about which of their two sessions holds the row"
    )


async def test_merge_keeps_the_survivors_seed_when_both_entries_carry_one(
    db_session: AsyncSession,
):
    """The other arm of the seed rule. The survivor's row is the one that stands, so
    where BOTH entries carry a seed, the survivor's wins — the merge is not licensed to
    overwrite a seed the director set on the row it is keeping. (The earlier
    ``created_at`` still carries: the two are independent.)"""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    event = await _make_rr_event(db_session, verified)

    earlier = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
    await _enter(db_session, event, ephemeral, created_at=earlier, seed=7)
    survivor_entry = await _enter(
        db_session,
        event,
        verified,
        created_at=earlier + timedelta(days=1),
        seed=2,
    )

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    entries = await _entries_for(db_session, event)
    assert [e.id for e in entries] == [survivor_entry.id]
    assert entries[0].seed == 2, "the survivor's own seed stands"
    assert entries[0].created_at == earlier


async def test_a_merge_without_a_collision_leaves_a_cut_draw_completely_intact(
    db_session: AsyncSession,
):
    """The other half of the contract, and the one an over-eager fix would break. Only
    the GUEST was entered — there is no collision, nothing is double-counted, and the
    merge simply re-points ``tournament_entries.user_id`` onto the survivor. The entry
    ids do not change, so the draw cut from them still seats exactly the field it always
    did.

    Un-cutting *this* draw would destroy a perfectly good one every time a director who
    entered a player signs in. Same fixture ids, same count, same contents.
    """
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")
    event = await _make_rr_event(db_session, verified)

    guest_entry = await _enter(db_session, event, ephemeral)
    await _enter(db_session, event, other)

    before = await _cut(db_session, event)
    assert len(before) == 1, "two entrants in one group meet exactly once"
    before_seats = _seats(before)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    after = await _fixtures_for(db_session, event)
    assert _seats(after) == before_seats, (
        "no collision, no double count — the draw must be untouched: same fixture "
        "ids, same sides. The entry the guest held simply belongs to the survivor now."
    )
    entries = await _entries_for(db_session, event)
    assert guest_entry.id in {e.id for e in entries}
    assert {e.user_id for e in entries} == {verified.id, other.id}


async def test_the_uncut_is_scoped_to_the_event_that_collided(
    db_session: AsyncSession,
):
    """The un-cut is a fact about one **event**, not about the tournament or the player.
    A second event of the same tournament, drawn from a field that never double-counted
    anybody, is a good draw — and losing it would make every merge a tournament-wide
    demolition.
    """
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")

    collided = await _make_rr_event(db_session, verified, name="Open Singles")
    tournament = (
        await db_session.execute(
            select(Tournament)
            .where(Tournament.id == collided.tournament_id)
            .options(selectinload(Tournament.events))
        )
    ).scalar_one()
    bystander = await _make_rr_event(
        db_session, verified, tournament=tournament, name="Over 40s"
    )

    # The collision, on the first event only.
    await _enter(db_session, event=collided, user=ephemeral)
    await _enter(db_session, event=collided, user=verified)
    await _enter(db_session, event=collided, user=other)
    # The second event's field is unremarkable: the survivor and a bystander.
    await _enter(db_session, event=bystander, user=verified)
    await _enter(db_session, event=bystander, user=other)

    assert len(await _cut(db_session, collided)) == 3
    bystander_seats = _seats(await _cut(db_session, bystander))
    assert len(bystander_seats) == 1

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    assert await _fixtures_for(db_session, collided) == []
    assert _seats(await _fixtures_for(db_session, bystander)) == bystander_seats, (
        "the un-cut must be scoped to the event whose field double-counted a human — "
        "a sibling event's good draw is not the merge's to throw away"
    )


# ----- the merge is a scheduling-input mutation (ADR "the schedule is solved;
# the call is pinned") ------------------------------------------------------
#
# Every arm of the entry-collision resolution changes solver inputs — a
# withdrawal from a played draw, an un-cut of an unplayed one — so each must
# funnel into the one coalesced ``request_solve``, exactly as the withdraw and
# un-cut routes do. Under conftest's autouse *synchronous* fake solver queue
# the enqueued job runs inline, finds no committed ``queued`` row, and no-ops —
# so the committed ledger row is exactly what these tests read.


async def _solve_rows(
    db: AsyncSession, tournament_id: uuid.UUID
) -> list[ScheduleSolve]:
    return list(
        (
            await db.execute(
                select(ScheduleSolve)
                .where(ScheduleSolve.tournament_id == tournament_id)
                .order_by(ScheduleSolve.requested_at, ScheduleSolve.id)
            )
        )
        .scalars()
        .all()
    )


async def _all_solve_rows(db: AsyncSession) -> list[ScheduleSolve]:
    return list((await db.execute(select(ScheduleSolve))).scalars().all())


async def _mark_played(db: AsyncSession, fixture: TournamentFixture) -> None:
    """Give one fixture a ``winner_entry_id`` — the ``draw_has_play`` evidence
    that flips its event onto the withdrawal arm (no ``Match`` row needed)."""
    fixture.winner_entry_id = fixture.entry_a_id
    await db.commit()


class _DeadQueue:
    def enqueue(self, *args: object, **kwargs: object) -> None:
        raise RedisError("redis is down")


async def test_merge_withdrawal_from_a_played_draw_enqueues_one_settings_solve(
    db_session: AsyncSession,
):
    """The withdrawal arm. The guest's colliding entry is seated in a **played**
    draw, so the merge withdraws it — a scheduling-input mutation the solver must
    hear about (it is what activates the broken-pin repair for any fixture that
    promised the withdrawn entrant). Exactly one ``settings_changed`` row, same
    doctrine as the withdraw route's seated-entrant trigger."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")
    event = await _make_rr_event(db_session, verified)

    guest_entry = await _enter(db_session, event, ephemeral)
    await _enter(db_session, event, verified)
    await _enter(db_session, event, other)

    before = await _cut(db_session, event)
    assert len(before) == 3
    assert await _fixtures_referencing(db_session, guest_entry.id) == 2, (
        "precondition: the guest really is seated — the solve gate turns on it"
    )
    await _mark_played(db_session, before[0])

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    (row,) = await _solve_rows(db_session, event.tournament_id)
    assert row.trigger is ScheduleSolveTrigger.settings_changed
    assert row.status is ScheduleSolveStatus.queued

    # And the merge outcome itself is unchanged: the played draw survives whole,
    # the guest's entry is withdrawn (not deleted) and now belongs to the survivor.
    assert {f.id for f in await _fixtures_for(db_session, event)} == {
        f.id for f in before
    }, "a played draw is never un-cut by the merge"
    entries = await _entries_for(db_session, event)
    withdrawn = [e for e in entries if e.id == guest_entry.id]
    assert [e.status for e in withdrawn] == [TournamentEntryStatus.withdrawn]
    assert withdrawn[0].user_id == verified.id


async def test_merge_withdrawal_of_an_unseated_entry_enqueues_no_solve(
    db_session: AsyncSession,
):
    """The withdrawal arm's gate, negatively. The guest entered AFTER the cut, so
    their entry seats no fixture — entries reach the solver only through
    fixtures, so this withdrawal changes no solver input and owes no solve (the
    withdraw route's exact doctrine: their leaving matters at the re-cut, which
    triggers on its own)."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")
    event = await _make_rr_event(db_session, verified)

    await _enter(db_session, event, verified)
    await _enter(db_session, event, other)
    before = await _cut(db_session, event)
    assert len(before) == 1
    await _mark_played(db_session, before[0])
    # The collision arrives after the cut: the guest is entered but never seated.
    guest_entry = await _enter(db_session, event, ephemeral)
    assert await _fixtures_referencing(db_session, guest_entry.id) == 0

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    assert await _solve_rows(db_session, event.tournament_id) == [], (
        "an entrant with no fixture is invisible to the solver — no solve is owed"
    )
    entries = await _entries_for(db_session, event)
    withdrawn = [e for e in entries if e.id == guest_entry.id]
    assert [e.status for e in withdrawn] == [TournamentEntryStatus.withdrawn], (
        "the withdrawal itself still happens; only the solve is gated"
    )


async def test_merge_uncut_enqueues_a_solve_when_a_drawn_sibling_survives(
    db_session: AsyncSession,
):
    """The un-cut arm. The collided event's unplayed draw is destroyed, which
    frees its tables and windows for the sibling event that is still drawn — so
    one ``settings_changed`` solve is owed, exactly as the un-cut route's
    drawn-sibling gate decides it."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")

    collided = await _make_rr_event(db_session, verified, name="Open Singles")
    tournament = (
        await db_session.execute(
            select(Tournament)
            .where(Tournament.id == collided.tournament_id)
            .options(selectinload(Tournament.events))
        )
    ).scalar_one()
    bystander = await _make_rr_event(
        db_session, verified, tournament=tournament, name="Over 40s"
    )

    await _enter(db_session, event=collided, user=ephemeral)
    await _enter(db_session, event=collided, user=verified)
    await _enter(db_session, event=bystander, user=verified)
    await _enter(db_session, event=bystander, user=other)

    assert len(await _cut(db_session, collided)) == 1
    bystander_seats = _seats(await _cut(db_session, bystander))

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    (row,) = await _solve_rows(db_session, tournament.id)
    assert row.trigger is ScheduleSolveTrigger.settings_changed
    assert row.status is ScheduleSolveStatus.queued
    # The merge outcome is unchanged: collided un-cut, bystander untouched.
    assert await _fixtures_for(db_session, collided) == []
    assert _seats(await _fixtures_for(db_session, bystander)) == bystander_seats


async def test_merge_uncut_of_the_only_drawn_event_enqueues_no_solve(
    db_session: AsyncSession,
):
    """Un-cutting the tournament's ONLY draw leaves nothing to place — a solve
    row over an empty board is a no-op ledger entry, so none is made (the un-cut
    route's gate, mirrored)."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")
    event = await _make_rr_event(db_session, verified)

    await _enter(db_session, event, ephemeral)
    await _enter(db_session, event, verified)
    await _enter(db_session, event, other)
    assert len(await _cut(db_session, event)) == 3

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    assert await _fixtures_for(db_session, event) == [], "the un-cut still happened"
    assert await _solve_rows(db_session, event.tournament_id) == [], (
        "no drawn event survived the un-cut, so no solve is owed"
    )


async def test_merge_without_a_tournament_collision_enqueues_no_solve(
    db_session: AsyncSession,
):
    """A merge with no entry collision mutates no scheduling input — the guest's
    entry simply re-points onto the survivor and the cut draw stands — so the
    solve ledger stays empty."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")
    event = await _make_rr_event(db_session, verified)

    await _enter(db_session, event, ephemeral)
    await _enter(db_session, event, other)
    before = await _cut(db_session, event)
    before_seats = _seats(before)

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    assert await _all_solve_rows(db_session) == []
    assert _seats(await _fixtures_for(db_session, event)) == before_seats


async def test_merge_survives_a_dead_scheduling_queue(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    """Redis down at the merge moment costs the solve, never the merge — a
    sign-in must not fail because the scheduler could not hear about it. And no
    zombie ``queued`` row survives to absorb every later trigger while no job
    ever runs (``request_solve`` takes its row back out)."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    other = await _make_verified(db_session, "pete@example.com")
    event = await _make_rr_event(db_session, verified)

    guest_entry = await _enter(db_session, event, ephemeral)
    await _enter(db_session, event, verified)
    await _enter(db_session, event, other)
    before = await _cut(db_session, event)
    await _mark_played(db_session, before[0])
    monkeypatch.setattr(queue_module, "get_queue", lambda: _DeadQueue())

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    assert await _all_solve_rows(db_session) == [], (
        "the enqueue failed, so no row may survive — a zombie would absorb "
        "every later trigger while no job ever runs"
    )
    # The merge itself landed whole: draw intact, entry withdrawn onto the survivor.
    assert {f.id for f in await _fixtures_for(db_session, event)} == {
        f.id for f in before
    }
    entries = await _entries_for(db_session, event)
    withdrawn = [e for e in entries if e.id == guest_entry.id]
    assert [e.status for e in withdrawn] == [TournamentEntryStatus.withdrawn]
    assert withdrawn[0].user_id == verified.id


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


async def test_merge_collapses_the_default_role_both_sides_hold(
    db_session: AsyncSession, default_role: Role
):
    """Every user now holds the default role (ADR-0016), so *every* merge is a
    both-sides-hold-the-same-role merge — the case the NOT EXISTS guard exists
    for. Granting through the production seam (``grant_default_role``) rather
    than hand-adding rows is what makes this exercise the real thing.

    The survivor must end up holding it exactly once: not twice (a PK collision,
    or a duplicate row), and not zero times (a dropped grant)."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")

    await grant_default_role(db_session, ephemeral.id)
    await grant_default_role(db_session, verified.id)
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
    assert survivor_role_ids == [default_role.id]

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


async def test_merge_keeps_the_default_role_and_carries_an_extra_one(
    db_session: AsyncSession, default_role: Role
):
    """The realistic shape now: both sides hold the default role and the guest
    also holds something the survivor doesn't. The de-dupe must not swallow the
    extra grant along with the duplicate one."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")

    extra = Role(name="tournament-director")
    db_session.add(extra)
    await grant_default_role(db_session, ephemeral.id)
    await grant_default_role(db_session, verified.id)
    await db_session.flush()
    db_session.add(UserRole(user_id=ephemeral.id, role_id=extra.id))
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
    assert set(survivor_role_ids) == {default_role.id, extra.id}
    assert len(survivor_role_ids) == 2


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


# ----- the unique Auth0 binding (users.auth0_sub) -------------------------
#
# ``auth0_sub`` is a plain UNIQUE column, not an FK to ``users.id`` — so the merge
# moves-or-nulls it rather than re-pointing an FK. The invariant the tests below
# pin: the merge never leaves the tombstoned ghost holding the unique binding (it
# would occupy the value so the real human could never re-link) and never clobbers
# a binding the survivor already holds.


async def _auth0_subs(
    db: AsyncSession, *user_ids: uuid.UUID
) -> dict[uuid.UUID, str | None]:
    """Read ``auth0_sub`` straight from the rows (``populate_existing`` because the
    merge writes with bulk statements the identity map never sees, and the test
    sessionmaker does not expire on commit)."""
    return dict(
        (
            await db.execute(
                select(User.id, User.auth0_sub)
                .where(User.id.in_(user_ids))
                .execution_options(populate_existing=True)
            )
        )
        .tuples()
        .all()
    )


async def test_merge_moves_auth0_sub_to_a_survivor_that_lacks_one(
    db_session: AsyncSession,
):
    """The rare linked-ephemeral case. The ephemeral holds a unique ``auth0_sub``
    and the survivor has none — the binding is the same human's, so it FOLLOWS the
    merge onto the survivor, and the tombstone is left with ``auth0_sub = NULL``.
    Nothing may strand the unique value on the tombstoned ghost (which would occupy
    the ``sub`` so the real human could never re-link it)."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.auth0_sub = "auth0|guest-linked-sub"
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    subs = await _auth0_subs(db_session, ephemeral.id, verified.id)
    assert subs[verified.id] == "auth0|guest-linked-sub", (
        "the binding is the same human's — it must follow the merge onto the survivor"
    )
    assert subs[ephemeral.id] is None, (
        "the tombstoned ghost must not be left holding the unique auth0_sub"
    )


async def test_merge_keeps_the_survivors_auth0_sub_and_nulls_the_ephemerals(
    db_session: AsyncSession,
):
    """Both parties are linked (contrived — a guest virtually never links, and a
    ``sub`` is one-to-one so the two values differ). The survivor's link stands
    untouched and the ephemeral's is dropped, so the tombstone ends with
    ``auth0_sub = NULL`` and the survivor keeps the binding it already held."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.auth0_sub = "auth0|guest-sub"
    verified.auth0_sub = "auth0|survivor-sub"
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    subs = await _auth0_subs(db_session, ephemeral.id, verified.id)
    assert subs[verified.id] == "auth0|survivor-sub", (
        "the survivor's own binding is not the merge's to overwrite"
    )
    assert subs[ephemeral.id] is None, (
        "the ephemeral's binding is dropped so the tombstone strands nothing"
    )


async def test_merge_is_a_no_op_when_the_ephemeral_has_no_auth0_sub(
    db_session: AsyncSession,
):
    """The common case: a guest never links, so the ephemeral's ``auth0_sub`` is
    NULL. The block is a clean no-op — the survivor's binding (whether it has one
    or not) is untouched, and the tombstone has NULL either way."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    verified.auth0_sub = "auth0|survivor-sub"
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    subs = await _auth0_subs(db_session, ephemeral.id, verified.id)
    assert subs[verified.id] == "auth0|survivor-sub", (
        "the survivor's link is untouched when the ephemeral never linked"
    )
    assert subs[ephemeral.id] is None


# ----- the agent-access state riding alongside that binding ----------------
#
# ADR ``20260728-disconnecting-an-agent-is-a-user-held-revocation-checked-at-the-
# mcp-transport``: "account_merge must carry the flag: merging a revoked account
# into another must not silently re-enable agent access." Two columns, two rules:
#
#   * ``agent_access_linked_at`` is a fact about the BINDING ("Connected <date>"),
#     so it moves exactly where the ``auth0_sub`` moves.
#   * ``agent_access_revoked_at`` is a per-user, sticky fact the PLAYER set, so the
#     merge takes the union — set on the survivor if either party had it set,
#     never cleared. It does not depend on a binding moving, because disconnect
#     clears ``auth0_sub`` as it stamps the revocation: a revoked account normally
#     has no binding left to move.


async def _agent_access(
    db: AsyncSession, *user_ids: uuid.UUID
) -> dict[uuid.UUID, tuple[str | None, datetime | None, datetime | None]]:
    """``(auth0_sub, agent_access_linked_at, agent_access_revoked_at)`` per user,
    read straight from the rows (``populate_existing`` — the merge writes with
    bulk statements the identity map never sees)."""
    rows = (
        (
            await db.execute(
                select(
                    User.id,
                    User.auth0_sub,
                    User.agent_access_linked_at,
                    User.agent_access_revoked_at,
                )
                .where(User.id.in_(user_ids))
                .execution_options(populate_existing=True)
            )
        )
        .tuples()
        .all()
    )
    return {row[0]: (row[1], row[2], row[3]) for row in rows}


async def test_merge_carries_a_revoked_ephemerals_revocation_onto_the_survivor(
    db_session: AsyncSession,
):
    """THE SECURITY CASE. The ephemeral switched agent access off and still holds
    the Auth0 binding; the survivor has neither. The binding follows the merge — so
    the revocation must follow it too, or the merge hands the survivor a *working*
    agent connection the player had explicitly switched off (the MCP transport only
    refuses a revoked user, so an already-issued JWT for that ``sub`` would resolve
    to the survivor and be allowed straight through)."""
    revoked_at = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
    linked_at = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.auth0_sub = "auth0|revoked-sub"
    ephemeral.agent_access_linked_at = linked_at
    ephemeral.agent_access_revoked_at = revoked_at
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    state = await _agent_access(db_session, ephemeral.id, verified.id)
    # Asserted on its own, ahead of the tuple compare below, so this failing means
    # the silent re-grant and nothing else.
    assert state[verified.id][2] == revoked_at, (
        "the adopted binding must arrive still revoked — a merge may not switch "
        "agent access back on for an identity the player switched off"
    )
    assert state[verified.id] == ("auth0|revoked-sub", linked_at, revoked_at)
    assert state[ephemeral.id][0] is None
    assert state[ephemeral.id][1] is None


async def test_merge_carries_revocation_even_when_no_binding_moves(
    db_session: AsyncSession,
):
    """The shape a real disconnect leaves: ``agent_access_revoked_at`` stamped and
    ``auth0_sub`` already NULL (disconnect clears it). Nothing moves through the
    binding block at all — so a carry gated on a moved binding would be dead code
    in exactly the case the ADR is about. The survivor inherits the revocation, and
    its own binding is left in place: the transport refuses a revoked user, so
    clearing the ``sub`` too would only be cosmetic and is not this code's job."""
    revoked_at = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
    survivor_linked_at = datetime(2026, 6, 1, 8, 0, tzinfo=UTC)
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.agent_access_revoked_at = revoked_at
    verified.auth0_sub = "auth0|survivor-sub"
    verified.agent_access_linked_at = survivor_linked_at
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    state = await _agent_access(db_session, ephemeral.id, verified.id)
    assert state[verified.id] == (
        "auth0|survivor-sub",
        survivor_linked_at,
        revoked_at,
    ), "the player's revocation is a per-user fact and does not need a binding to ride"
    assert state[ephemeral.id][2] == revoked_at, (
        "the tombstone keeps its own revocation — nothing here may un-revoke an "
        "account, and its session cookie still resolves to this row"
    )


async def test_merge_adopting_a_binding_does_not_clear_a_revoked_survivor(
    db_session: AsyncSession,
):
    """The other direction, through the BINDING block. The survivor switched agent
    access off; the ephemeral is unrevoked and holds a binding. Adopting that binding
    must not hand the survivor a usable connection either — the survivor's own
    revocation stands, at its own moment, un-rewritten.

    Note what this does NOT reach: the ephemeral is unrevoked, so
    ``ephemeral_revoked_at is None`` and the revocation carry never runs at all. The
    guard *inside* that carry — the survivor's ``IS NULL`` predicate — is pinned by
    ``test_merge_keeps_a_revoked_survivors_own_revocation_moment`` below, which is
    the both-revoked case this one cannot express."""
    survivor_revoked_at = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
    linked_at = datetime(2026, 7, 25, 9, 0, tzinfo=UTC)
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.auth0_sub = "auth0|guest-linked-sub"
    ephemeral.agent_access_linked_at = linked_at
    verified.agent_access_revoked_at = survivor_revoked_at
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    state = await _agent_access(db_session, ephemeral.id, verified.id)
    assert state[verified.id] == (
        "auth0|guest-linked-sub",
        linked_at,
        survivor_revoked_at,
    ), "adopting a binding must not clear the survivor's own revocation"


async def test_merge_keeps_a_revoked_survivors_own_revocation_moment(
    db_session: AsyncSession,
):
    """BOTH parties revoked — the only case that exercises the carry's survivor
    guard (``agent_access_revoked_at IS NULL``), and the reason it is a guard rather
    than an unconditional write.

    The union is already satisfied here: the survivor is revoked, so there is nothing
    to inherit. What is at stake is *whose moment* the survivor ends up holding. The
    column is when THIS account's holder switched agent access off — the settings
    page's "Disconnected <date>", and the audit answer to "when did I turn this off".
    Overwriting it with the guest session's later stamp would silently rewrite that
    history to a moment this account's holder never acted at, and would make a
    re-allow's "off since" read wrong.

    Both stamps are set with no binding anywhere — the shape a real disconnect leaves
    (``disconnect_agent_access`` clears ``auth0_sub`` as it stamps) — so the binding
    block is a no-op and the only thing under test is the carry.
    """
    survivor_revoked_at = datetime(2026, 6, 15, 8, 0, tzinfo=UTC)
    ephemeral_revoked_at = datetime(2026, 7, 25, 17, 0, tzinfo=UTC)
    assert ephemeral_revoked_at != survivor_revoked_at, (
        "the two moments must differ or the assertion below cannot tell them apart"
    )
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.agent_access_revoked_at = ephemeral_revoked_at
    verified.agent_access_revoked_at = survivor_revoked_at
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    state = await _agent_access(db_session, ephemeral.id, verified.id)
    assert state[verified.id][2] == survivor_revoked_at, (
        "an already-revoked survivor keeps its OWN revocation moment — the carry "
        "exists to make a revocation stick, not to restamp one that already did"
    )
    assert state[ephemeral.id][2] == ephemeral_revoked_at, (
        "the tombstone keeps its own moment too — revocation is a historical fact "
        "about that account and the merge does not rewrite either party's"
    )


async def test_merge_moves_the_link_time_with_an_adopted_binding(
    db_session: AsyncSession,
):
    """The honesty case. A survivor that adopts a binding reads ``connected`` on the
    settings page, so it must arrive with the binding's "Connected <date>" rather
    than a connection with no date — and the tombstone must not keep a stamp for a
    link it no longer holds. Neither party is revoked, so neither ends up revoked:
    the carry above is a union, not a blanket."""
    linked_at = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.auth0_sub = "auth0|guest-linked-sub"
    ephemeral.agent_access_linked_at = linked_at
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    state = await _agent_access(db_session, ephemeral.id, verified.id)
    assert state[verified.id] == ("auth0|guest-linked-sub", linked_at, None), (
        "the link time follows the binding, so the survivor is not 'connected' "
        "with a blank date"
    )
    assert state[ephemeral.id] == (None, None, None), (
        "the tombstone holds neither the binding nor a stamp describing it"
    )


async def test_merge_leaves_the_survivors_link_time_when_its_own_binding_stands(
    db_session: AsyncSession,
):
    """Both parties are linked, so the ephemeral's binding is dropped rather than
    adopted. The survivor's stamp describes the link it kept — the dropped binding's
    date must not overwrite it — while the tombstone's stamp goes with the binding
    it lost."""
    survivor_linked_at = datetime(2026, 6, 1, 8, 0, tzinfo=UTC)
    ephemeral_linked_at = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    ephemeral.auth0_sub = "auth0|guest-sub"
    ephemeral.agent_access_linked_at = ephemeral_linked_at
    verified.auth0_sub = "auth0|survivor-sub"
    verified.agent_access_linked_at = survivor_linked_at
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    state = await _agent_access(db_session, ephemeral.id, verified.id)
    assert state[verified.id] == ("auth0|survivor-sub", survivor_linked_at, None), (
        "a dropped binding's link time is not the survivor's to inherit"
    )
    assert state[ephemeral.id] == (None, None, None)
