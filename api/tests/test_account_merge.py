"""Unit tests for the ephemeral→verified merge primitive in app.account_merge."""

import hashlib
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account_merge import merge_user
from app.leagues import add_user_to_default_league, get_default_league
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
    Tournament,
    TournamentEvent,
    User,
    UserLeagueRating,
    UserToken,
)
from app.sessions import SESSION_TOKEN_CONTEXT


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


async def _record_match(db: AsyncSession, creator: User, *players: User) -> Match:
    league = await get_default_league(db)
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=False)
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
            entered=0,
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
    # summary under-report it as zero matches moved (#235).
    assert summary.matches_moved == 1

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
