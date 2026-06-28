"""Coverage for ``app.ratings.recompute`` — the forward-walking cascade
algorithm that rebuilds ratings after a merge moves matches onto a user."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.leagues import get_default_league
from app.models import (
    League,
    LeagueVisibility,
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
from app.ratings.recompute import _league_lock_key, recompute_league_ratings
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
    settings = MatchSettings(team_size=1, best_of=1, affects_rating=affects_rating)
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
        text("UPDATE matches SET created_at = :ts, updated_at = :ts WHERE id = :id"),
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

    rows = (await db_session.execute(select(RatingHistory))).scalars().all()
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
        db_session, default, me, opp, datetime(2026, 5, 1, tzinfo=UTC)
    )

    await recompute_league_ratings(db_session, default.id, {me.id})

    rows = (await db_session.execute(select(RatingHistory))).scalars().all()
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

    base = datetime(2026, 5, 1, tzinfo=UTC)
    m1 = await _build_completed_match(db_session, league, a, b, base)
    m2 = await _build_completed_match(
        db_session, league, b, c, base + timedelta(hours=1)
    )
    m3 = await _build_completed_match(
        db_session, league, c, d, base + timedelta(hours=2)
    )

    await recompute_league_ratings(db_session, league.id, {a.id})
    await db_session.commit()

    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(
                    RatingHistory.match_id.in_([m1.id, m2.id, m3.id])
                )
            )
        )
        .scalars()
        .all()
    )
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

    base = datetime(2026, 5, 1, tzinfo=UTC)
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
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == my_match.id)
            )
        )
        .scalars()
        .all()
    )
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

    base = datetime(2026, 5, 1, tzinfo=UTC)
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
        text("UPDATE rating_history SET created_at = :ts WHERE match_id = :id"),
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


# ----- non-binary outcomes ------------------------------------------------


async def test_recompute_skips_matches_without_a_decided_outcome(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A completed-but-undecided match (e.g. a void/forfeit that leaves
    ``MatchSide.won`` as ``None``) has no rating delta to rebuild. The cascade
    must skip it rather than crash on the ``next(...)`` winner lookup, which
    would otherwise roll back every league in the same recompute run."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    me = await make_user(db_session, "me")
    opp = await make_user(db_session, "opp")
    for user in (me, opp):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    # A normal decided match the cascade should still process...
    decided = await _build_completed_match(db_session, league, me, opp, base)
    # ...and an undecided one sharing both players: no winner/loser flag.
    settings = MatchSettings(team_size=1, best_of=1, affects_rating=True)
    undecided = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=me.id,
        status=MatchStatus.completed,
    )
    side1 = MatchSide(match=undecided, side_number=1, won=None, score=0)
    side1.players.append(MatchSidePlayer(match=undecided, user=me))
    side2 = MatchSide(match=undecided, side_number=2, won=None, score=0)
    side2.players.append(MatchSidePlayer(match=undecided, user=opp))
    db_session.add(undecided)
    await db_session.commit()
    await db_session.refresh(undecided)
    await db_session.execute(
        text("UPDATE matches SET created_at = :ts, updated_at = :ts WHERE id = :id"),
        {"ts": base + timedelta(hours=1), "id": undecided.id},
    )
    await db_session.commit()

    # Must not raise.
    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()

    # The decided match still produced its history; the undecided one produced none.
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(
                    RatingHistory.match_id.in_([decided.id, undecided.id])
                )
            )
        )
        .scalars()
        .all()
    )
    assert {row.match_id for row in rows} == {decided.id}


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
        db_session, league, me, opp, datetime(2026, 5, 1, tzinfo=UTC)
    )

    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()
    first = {
        r.user_id: r.rating_value
        for r in (await db_session.execute(select(UserLeagueRating))).scalars().all()
    }

    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()
    second = {
        r.user_id: r.rating_value
        for r in (await db_session.execute(select(UserLeagueRating))).scalars().all()
    }

    assert first == second
    # And only one set of history rows survives.
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.user_id == me.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1


# ----- advisory lock -------------------------------------------------------


async def test_recompute_holds_advisory_lock_for_transaction(
    db_session: AsyncSession,
    engine: AsyncEngine,
) -> None:
    """``recompute_league_ratings`` must hold a per-league advisory lock for
    the duration of the caller's transaction so a concurrent worker cannot
    interleave its own DELETE/INSERT on the same league.

    Proof: call recompute in session 1 (no commit), then try to grab the same
    lock from session 2 — ``pg_try_advisory_xact_lock`` must return ``false``."""
    league = await get_default_league(db_session)

    # Session 1 acquires the lock (no seed users → early-exit after lock,
    # before any match data is needed).
    await recompute_league_ratings(db_session, league.id, set())

    lock_key = _league_lock_key(league.id)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    async with sm() as session2:
        result = await session2.execute(
            text("SELECT pg_try_advisory_xact_lock(:key)"),
            {"key": lock_key},
        )
        acquired = result.scalar_one()

    assert acquired is False, (
        "advisory lock should be held by session 1's open transaction"
    )


# ----- multi-league cascade -----------------------------------------------


async def test_recompute_after_merge_rebuilds_each_league_independently(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """The merged user holds rated matches in two leagues.
    ``_recompute_after_merge`` loops over *every* league the user has a
    completed rated match in and rebuilds each one's timeline; the rest of the
    suite only exercises the single-league path. Drive that loop here — calling
    ``recompute_league_ratings`` per league exactly as the job does (the job
    itself opens its own engine via ``get_engine()`` and so can't run against
    the test container) — and assert no cross-league leakage (#245).

    Fortymm ships a single default league today, so this is forward-looking:
    the loop already exists and would regress silently without coverage."""
    strategy = rating_strategies["glicko2"]
    league_a = await get_default_league(db_session)
    league_b = League(
        name="Second League",
        description="A second glicko-2 league.",
        visibility=LeagueVisibility.public,
        is_default=False,
        rating_strategy_id=strategy.id,
    )
    db_session.add(league_b)
    await db_session.commit()
    await db_session.refresh(league_b)

    me = await make_user(db_session, "survivor")
    opp_a = await make_user(db_session, "rival-a")
    opp_b = await make_user(db_session, "rival-b")
    await _seed_rating(db_session, league_a, me.id, strategy)
    await _seed_rating(db_session, league_a, opp_a.id, strategy)
    await _seed_rating(db_session, league_b, me.id, strategy)
    await _seed_rating(db_session, league_b, opp_b.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    # I win in league A and lose in league B — asymmetric, so any cross-league
    # bleed would visibly corrupt one league's rating.
    match_a = await _build_completed_match(db_session, league_a, me, opp_a, base)
    match_b = await _build_completed_match(
        db_session, league_b, opp_b, me, base + timedelta(hours=1)
    )

    # Mirror ``_recompute_after_merge``'s per-league loop over every league the
    # merged user has a completed rated match in.
    for league_id in (league_a.id, league_b.id):
        await recompute_league_ratings(db_session, league_id, {me.id})
    await db_session.commit()

    # My rating moved up in the league I won and down in the one I lost — proof
    # each league's recompute saw only its own match.
    rating_a = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.user_id == me.id,
                UserLeagueRating.league_id == league_a.id,
            )
        )
    ).scalar_one()
    rating_b = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.user_id == me.id,
                UserLeagueRating.league_id == league_b.id,
            )
        )
    ).scalar_one()
    assert rating_a.rating_value is not None and rating_a.rating_value > 1500.0
    assert rating_b.rating_value is not None and rating_b.rating_value < 1500.0

    # My history rows stay partitioned by league: each league references only
    # its own match, never the other's.
    history = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.user_id == me.id)
            )
        )
        .scalars()
        .all()
    )
    a_match_ids = {
        r.match_id
        for r in history
        if r.league_id == league_a.id and r.match_id is not None
    }
    b_match_ids = {
        r.match_id
        for r in history
        if r.league_id == league_b.id and r.match_id is not None
    }
    assert a_match_ids == {match_a.id}
    assert b_match_ids == {match_b.id}
