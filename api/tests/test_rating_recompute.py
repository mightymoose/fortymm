"""Coverage for ``app.ratings.recompute`` — the forward-walking cascade
algorithm that rebuilds ratings after a merge moves matches onto a user."""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    League,
    Match,
    MatchGame,
    MatchGameScore,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    UserLeagueRating,
)
from app.ratings.recompute import recompute_league_ratings
from tests._helpers import make_user


# ----- fixtures + helpers -------------------------------------------------


async def _seed_rating(
    db: AsyncSession,
    league: League,
    user_id: uuid.UUID,
    strategy: RatingStrategy,
) -> UserLeagueRating:
    """Stand up a fresh ``UserLeagueRating`` row seeded from the strategy.
    The default-league fixture only attaches the session user; tests build
    extra users by hand and need their rating rows wired up explicitly."""
    rating = UserLeagueRating.seed_for_strategy(league.id, user_id, strategy)
    db.add(rating)
    await db.commit()
    await db.refresh(rating)
    return rating


async def _build_completed_match(
    db: AsyncSession,
    league: League,
    winner,
    loser,
    completed_at: datetime,
    affects_rating: bool = True,
) -> Match:
    """Persist a singles match with a single 11-4 game and a fixed
    completion timestamp. ``updated_at`` is what ``recompute_league_ratings``
    orders by, so we overwrite it via raw SQL to control the chronology
    without sleeping in tests."""
    settings = MatchSettings(
        team_size=1, best_of=1, affects_rating=affects_rating
    )
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=winner.id,
        status=MatchStatus.completed,
    )
    side1 = MatchSide(match=match, side_number=1, won=True, score=1)
    side1.players.append(MatchSidePlayer(match=match, user=winner))
    side2 = MatchSide(match=match, side_number=2, won=False, score=0)
    side2.players.append(MatchSidePlayer(match=match, user=loser))
    game = MatchGame(match=match, game_number=1)
    game.score = MatchGameScore(side_1_points=11, side_2_points=4)
    db.add(match)
    await db.commit()
    await db.refresh(match)

    await db.execute(
        text(
            "UPDATE matches SET created_at = :ts, updated_at = :ts "
            "WHERE id = :id"
        ),
        {"ts": completed_at, "id": match.id},
    )
    await db.commit()
    await db.refresh(match)
    return match


# ----- no-op cases --------------------------------------------------------


async def test_recompute_no_matches_is_noop(
    db_session: AsyncSession,
):
    league = await get_default_league(db_session)
    me = await make_user(db_session, "loner")

    await recompute_league_ratings(db_session, league.id, {me.id})

    rows = (
        await db_session.execute(select(RatingHistory))
    ).scalars().all()
    assert rows == []


async def test_recompute_manual_strategy_is_noop(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A manual league skips the cascade even when the user has matches —
    the calculator is None, there's nothing to recompute."""
    default = await get_default_league(db_session)
    default.rating_strategy_id = rating_strategies["manual"].id
    await db_session.commit()
    await db_session.refresh(default)

    me = await make_user(db_session, "me")
    opp = await make_user(db_session, "opp")
    await _build_completed_match(
        db_session, default, me, opp, datetime(2026, 5, 1, tzinfo=timezone.utc)
    )

    await recompute_league_ratings(db_session, default.id, {me.id})

    rows = (
        await db_session.execute(select(RatingHistory))
    ).scalars().all()
    assert rows == []


# ----- cascade graph ------------------------------------------------------


async def test_recompute_cascade_propagates_through_shared_matches(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A→B at T1, B→C at T2, C→D at T3. Seed = {A}. The cascade pulls in B
    (via T1), C (via T2), and D (via T3) — all three matches get new
    history rows."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    a = await make_user(db_session, "alpha")
    b = await make_user(db_session, "bravo")
    c = await make_user(db_session, "charlie")
    d = await make_user(db_session, "delta")
    for user in (a, b, c, d):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m1 = await _build_completed_match(
        db_session, league, a, b, base
    )
    m2 = await _build_completed_match(
        db_session, league, b, c, base + timedelta(hours=1)
    )
    m3 = await _build_completed_match(
        db_session, league, c, d, base + timedelta(hours=2)
    )

    await recompute_league_ratings(db_session, league.id, {a.id})
    await db_session.commit()

    rows = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id.in_([m1.id, m2.id, m3.id])
            )
        )
    ).scalars().all()
    assert {row.match_id for row in rows} == {m1.id, m2.id, m3.id}
    assert len(rows) == 6

    by_match = {m.id: m for m in (m1, m2, m3)}
    for row in rows:
        assert row.created_at == by_match[row.match_id].updated_at

    a_rating = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == a.id)
        )
    ).scalar_one()
    d_rating = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == d.id)
        )
    ).scalar_one()
    assert a_rating.rating_value > 1500.0
    assert d_rating.rating_value < 1500.0


async def test_recompute_leaves_unrelated_matches_alone(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """X→Y is independent of the seed user's match. The cascade walks past
    it without rewriting its history."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    me = await make_user(db_session, "me")
    opp = await make_user(db_session, "opp")
    x = await make_user(db_session, "ex")
    y = await make_user(db_session, "why")
    for user in (me, opp, x, y):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=timezone.utc)
    my_match = await _build_completed_match(db_session, league, me, opp, base)
    unrelated = await _build_completed_match(
        db_session, league, x, y, base + timedelta(hours=1)
    )

    # Pre-seed a rating_history row for the unrelated match so we can prove
    # it's untouched. Source isn't `match` so it falls outside the wipe
    # filter — but we use match-sourced rows to mirror real data.
    pre_existing = RatingHistory(
        league_id=league.id,
        user_id=x.id,
        match_id=unrelated.id,
        rating_strategy_id=strategy.id,
        rating_value=1234.5,
        rating_state={"rating": 1234.5, "rd": 200.0, "volatility": 0.06},
        source=RatingHistorySource.match,
    )
    db_session.add(pre_existing)
    await db_session.commit()
    await db_session.refresh(pre_existing)
    pre_id = pre_existing.id

    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()

    # The pre-seeded row survives unchanged.
    surviving = (
        await db_session.execute(
            select(RatingHistory).where(RatingHistory.id == pre_id)
        )
    ).scalar_one()
    assert surviving.rating_value == 1234.5

    # The seed user's match did produce its own history rows.
    mine = (
        await db_session.execute(
            select(RatingHistory).where(RatingHistory.match_id == my_match.id)
        )
    ).scalars().all()
    assert {row.user_id for row in mine} == {me.id, opp.id}


# ----- pre-window state ---------------------------------------------------


async def test_recompute_restores_user_to_last_pre_window_rating(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """An older history row before T_start is the baseline the recompute
    walks forward from — not the strategy's seed value. This guards against
    silently wiping a player back to 1500 every time a peer merges."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    me = await make_user(db_session, "me")
    opp = await make_user(db_session, "opp")
    later_opp = await make_user(db_session, "later-opp")
    for user in (me, opp, later_opp):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=timezone.utc)
    # Pre-window: opp already played a match and sits at 1550 going in.
    pre_match = await _build_completed_match(
        db_session, league, opp, later_opp, base - timedelta(days=30)
    )
    db_session.add(
        RatingHistory(
            league_id=league.id,
            user_id=opp.id,
            match_id=pre_match.id,
            rating_strategy_id=strategy.id,
            rating_value=1550.0,
            rating_state={"rating": 1550.0, "rd": 300.0, "volatility": 0.06},
            source=RatingHistorySource.match,
            previous_rating_value=1500.0,
        )
    )
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE rating_history SET created_at = :ts WHERE match_id = :id"
        ),
        {"ts": base - timedelta(days=30), "id": pre_match.id},
    )
    await db_session.commit()

    # Window match: me beats opp. The recompute should seed opp from 1550,
    # not from 1500.
    in_window = await _build_completed_match(db_session, league, me, opp, base)

    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()

    opp_row = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id == in_window.id,
                RatingHistory.user_id == opp.id,
            )
        )
    ).scalar_one()
    assert opp_row.previous_rating_value == 1550.0


# ----- idempotency --------------------------------------------------------


async def test_recompute_is_idempotent(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    me = await make_user(db_session, "me")
    opp = await make_user(db_session, "opp")
    for user in (me, opp):
        await _seed_rating(db_session, league, user.id, strategy)

    await _build_completed_match(
        db_session, league, me, opp, datetime(2026, 5, 1, tzinfo=timezone.utc)
    )

    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()
    first = {
        r.user_id: r.rating_value
        for r in (
            await db_session.execute(select(UserLeagueRating))
        ).scalars().all()
    }

    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()
    second = {
        r.user_id: r.rating_value
        for r in (
            await db_session.execute(select(UserLeagueRating))
        ).scalars().all()
    }

    assert first == second
    # And only one set of history rows survives.
    rows = (
        await db_session.execute(
            select(RatingHistory).where(RatingHistory.user_id == me.id)
        )
    ).scalars().all()
    assert len(rows) == 1
