"""Unit tests for the ephemeral→verified merge primitive in app.account_merge."""

import hashlib
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account_merge import merge_user
from app.leagues import add_user_to_default_league, get_default_league
from app.models import (
    LeagueMembership,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchSignature,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
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


# ----- skip cases handled by the endpoint guard ---------------------------
# (`merge_user` itself doesn't check verified-ness or same-id — those are
# the caller's responsibility, enforced in sessions._maybe_merge_prior_session.)


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


async def test_merge_repoints_match_signatures(db_session: AsyncSession):
    """``match_signatures`` is RESTRICT on user_id, so the merge must re-point
    every signature row from the ephemeral user onto the verified user — same
    contract as ``match_side_players``. Otherwise the final ephemeral-user
    delete would either fail (RESTRICT block) or orphan the audit row."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    opponent = await _make_ephemeral(db_session, "spinning-otter")
    match = await _record_match(db_session, ephemeral, ephemeral, opponent)

    db_session.add(MatchSignature(match_id=match.id, user_id=ephemeral.id))
    db_session.add(MatchSignature(match_id=match.id, user_id=opponent.id))
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    sigs = (
        (
            await db_session.execute(
                select(MatchSignature).where(MatchSignature.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    user_ids = {sig.user_id for sig in sigs}
    assert user_ids == {verified.id, opponent.id}
    # And the ephemeral user is tombstoned, not dropped — the RESTRICT FK on
    # match_signatures.user_id was satisfied by the re-point above.
    ephemeral_row = (
        await db_session.execute(select(User).where(User.id == ephemeral.id))
    ).scalar_one_or_none()
    assert ephemeral_row is not None
    assert ephemeral_row.merged_into_user_id == verified.id


async def test_merge_with_match_signature_collision_drops_ephemeral(
    db_session: AsyncSession,
):
    """If both users somehow already signed the same match, the NOT EXISTS
    guard skips the re-point and the defensive DELETE in ``merge_user`` drops
    the leftover ephemeral row so the user delete still succeeds."""
    ephemeral = await _make_ephemeral(db_session, "drifting-grouse")
    verified = await _make_verified(db_session, "rita@example.com")
    opponent = await _make_ephemeral(db_session, "spinning-otter")
    match = await _record_match(db_session, ephemeral, ephemeral, opponent)

    # Both users carry a signature on the same match — impossible in normal
    # flow but defended against here.
    db_session.add(MatchSignature(match_id=match.id, user_id=ephemeral.id))
    db_session.add(MatchSignature(match_id=match.id, user_id=verified.id))
    await db_session.commit()

    await merge_user(db_session, from_user_id=ephemeral.id, to_user_id=verified.id)
    await db_session.commit()

    sigs = (
        (
            await db_session.execute(
                select(MatchSignature).where(MatchSignature.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    # Verified's pre-existing signature survives; ephemeral's is dropped.
    assert [sig.user_id for sig in sigs] == [verified.id]
