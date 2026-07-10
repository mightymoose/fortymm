"""Coverage for ``app.ratings.recompute`` — the forward-walking cascade
algorithm that rebuilds ratings after a merge moves matches onto a user."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
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
    User,
    UserLeagueRating,
)
from app.ratings import RatingStrategyMismatchError
from app.ratings import jobs as ratings_jobs
from app.ratings.base import state_rating_value
from app.ratings.recompute import (
    _league_lock_key,
    _reset_users_to_initial_state,
    recompute_league_ratings,
)
from app.ratings.registry import get_calculator
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
    match_id: uuid.UUID | None = None,
) -> Match:
    """Persist a singles match with a single 11-4 game and a fixed
    completion timestamp. ``completed_at`` is what ``recompute_league_ratings``
    orders by, so we overwrite it via raw SQL to control the chronology
    without sleeping in tests. We stamp ``updated_at`` to the same instant so a
    freshly-built match starts on a single axis; tests that need the two to
    diverge bump ``updated_at`` afterwards.

    ``match_id`` lets a test pin the primary key when it needs to control the
    replay's ``(completed_at, id)`` tiebreak — e.g. forcing a non-affected match
    to sort before an affected one that shares its instant. Left ``None``, the
    ``gen_random_uuid()`` server default assigns it (passing ``id=None`` would
    emit ``INSERT ... id=NULL`` and violate the NOT NULL PK)."""
    settings = MatchSettings(team_size=1, best_of=1, affects_rating=affects_rating)
    match_kwargs = {} if match_id is None else {"id": match_id}
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=winner.id,
        status=MatchStatus.completed,
        **match_kwargs,
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
            "UPDATE matches SET created_at = :ts, updated_at = :ts, "
            "completed_at = :ts WHERE id = :id"
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
        assert row.created_at == by_match[row.match_id].completed_at

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


async def test_recompute_seeds_late_joiner_from_own_first_affected_match(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """#749: a user who joins the cascade *late* — via a later match against an
    already-affected user — must be seeded from the state as of THEIR OWN first
    affected match, not the global ``t_start``.

    Timeline (all rated singles in the default league):
      M1  @ t_start      A beats X     (A is the seed → M1 is affected)
      M_b @ t_start+1h   B beats Y     (B, Y not yet affected → NON-affected)
      M2  @ t_start+2h   A beats B     (affected via A → B joins the cascade)

    B played the non-affected ``M_b`` between ``t_start`` and their own first
    affected match ``M2``. ``M_b`` is neither replayed (not affected) nor — on
    the buggy global-cutoff seed — reflected in B's seed, because its
    ``rating_history`` row postdates ``t_start``. So the old code seeds B from
    the strategy initial (1500) and B's recomputed rating and its
    ``previous_rating_value`` chain are silently wrong.

    The fix seeds B from ``M_b``'s stored row (1600). We prove B's replayed
    winner/loser numbers AND ``previous_rating_value`` chain match a from-scratch
    ``update_singles`` of B's true sequence, and that the discriminator (1600) is
    genuinely distinct from the strategy initial so this fails pre-chore."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    calculator = get_calculator(strategy.key)
    assert calculator is not None
    initial_rating = state_rating_value(strategy.initial_state)

    a = await make_user(db_session, "alpha")
    x = await make_user(db_session, "xray")
    b = await make_user(db_session, "bravo")
    y = await make_user(db_session, "yankee")
    for user in (a, x, b, y):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    m1 = await _build_completed_match(db_session, league, a, x, base)
    m_b = await _build_completed_match(
        db_session, league, b, y, base + timedelta(hours=1)
    )
    m2 = await _build_completed_match(
        db_session, league, a, b, base + timedelta(hours=2)
    )

    # B's only pre-M2 history is the NON-affected M_b row, sitting at 1600 —
    # distinct from the strategy initial so the seed source is observable. There
    # is deliberately NO B row before t_start, so the buggy global cutoff falls
    # all the way back to the initial state.
    b_seed_state = {"rating": 1600.0, "rd": 200.0, "volatility": 0.06}
    assert b_seed_state["rating"] != initial_rating
    db_session.add(
        RatingHistory(
            league_id=league.id,
            user_id=b.id,
            match_id=m_b.id,
            rating_strategy_id=strategy.id,
            rating_value=1600.0,
            rating_state=b_seed_state,
            source=RatingHistorySource.match,
            previous_rating_value=initial_rating,
        )
    )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE rating_history SET created_at = :ts WHERE match_id = :id"),
        {"ts": m_b.completed_at, "id": m_b.id},
    )
    await db_session.commit()

    await recompute_league_ratings(db_session, league.id, {a.id})
    await db_session.commit()

    # M_b was non-affected: its row is left in place, untouched.
    m_b_rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == m_b.id)
            )
        )
        .scalars()
        .all()
    )
    assert {row.user_id for row in m_b_rows} == {b.id}
    assert m_b_rows[0].rating_value == 1600.0

    # A's post-M1 state is the winner input to M2; B's seed is M_b's stored row.
    a_after_m1 = (
        await db_session.execute(
            select(RatingHistory.rating_state).where(
                RatingHistory.match_id == m1.id, RatingHistory.user_id == a.id
            )
        )
    ).scalar_one()

    # From-scratch replay of B's true sequence: A(post-M1) beats B(seeded 1600).
    expected_a, expected_b = calculator.update_singles(
        dict(a_after_m1), dict(b_seed_state)
    )

    m2_a = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id == m2.id, RatingHistory.user_id == a.id
            )
        )
    ).scalar_one()
    m2_b = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id == m2.id, RatingHistory.user_id == b.id
            )
        )
    ).scalar_one()

    # The load-bearing #749 assertion: B is seeded from M_b (1600), not initial.
    assert m2_b.previous_rating_value == 1600.0
    assert m2_a.previous_rating_value == state_rating_value(a_after_m1)

    # And the full replayed numbers match a from-scratch update_singles.
    assert m2_a.rating_value == state_rating_value(expected_a)
    assert m2_b.rating_value == state_rating_value(expected_b)

    b_rating = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == b.id)
        )
    ).scalar_one()
    assert b_rating.rating_value == m2_b.rating_value


async def test_recompute_seeds_across_completed_at_tie_by_match_id(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """Regression for the cutoff-tie bug: a user's NON-affected match that shares
    a ``completed_at`` exactly with their first affected match must still seed
    them, because it sorts *before* that affected match under the replay's
    ``(completed_at, id)`` order.

    Two matches can share a ``completed_at`` byte-for-byte — Postgres ``now()`` is
    the transaction timestamp, so any two matches completed in one transaction tie
    exactly. The replay tiebreaks on ``id``; the seed must agree.

    Timeline (all rated singles in the default league):
      M1  @ base        A beats X   (A is the seed → affected)
      M_b @ base+1h     B beats Y   (NON-affected; id pinned to sort FIRST)
      M2  @ base+1h     A beats B   (SAME instant as M_b; affected via A → B joins)

    ``M_b`` and ``M2`` share ``completed_at`` exactly, and ``M_b.id`` is pinned
    below ``M2.id`` so the walk reaches ``M_b`` while B is still un-affected (if
    ``M2`` sorted first B would already be affected and ``M_b`` would be replayed,
    not seeded-from). B's cutoff is thus ``(base+1h, M2.id)`` and B's only pre-cutoff
    row is ``M_b`` at ``(base+1h, M_b.id)``.

    On the buggy ``created_at < cutoff`` seed, ``M_b``'s ``created_at`` equals the
    cutoff instant, so the strict ``<`` drops it — B is seeded from the strategy
    initial (1500), and ``M_b`` is never replayed either. The lexicographic
    ``(created_at, match_id) < (cutoff_completed_at, cutoff_match_id)`` seed
    includes it (``M_b.id < M2.id``), seeding B from ``M_b``'s stored 1600."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    calculator = get_calculator(strategy.key)
    assert calculator is not None
    initial_rating = state_rating_value(strategy.initial_state)

    a = await make_user(db_session, "alpha")
    x = await make_user(db_session, "xray")
    b = await make_user(db_session, "bravo")
    y = await make_user(db_session, "yankee")
    for user in (a, x, b, y):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    tie = base + timedelta(hours=1)  # M_b and M2 share this instant exactly.
    # Pin ids so the NON-affected M_b sorts before the affected M2 on the tie.
    m_b_id = uuid.UUID(int=1)
    m2_id = uuid.UUID(int=2)
    assert m_b_id < m2_id

    m1 = await _build_completed_match(db_session, league, a, x, base)
    m_b = await _build_completed_match(db_session, league, b, y, tie, match_id=m_b_id)
    m2 = await _build_completed_match(db_session, league, a, b, tie, match_id=m2_id)
    # Byte-identical completion instant is the whole point — prove it.
    assert m_b.completed_at == m2.completed_at

    # B's only pre-M2 history is the NON-affected M_b row at 1600, distinct from
    # the strategy initial so the seed source is observable. No B row precedes the
    # tie instant, so the buggy strict-``<`` cutoff falls all the way to initial.
    b_seed_state = {"rating": 1600.0, "rd": 200.0, "volatility": 0.06}
    assert b_seed_state["rating"] != initial_rating
    db_session.add(
        RatingHistory(
            league_id=league.id,
            user_id=b.id,
            match_id=m_b.id,
            rating_strategy_id=strategy.id,
            rating_value=1600.0,
            rating_state=b_seed_state,
            source=RatingHistorySource.match,
            previous_rating_value=initial_rating,
        )
    )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE rating_history SET created_at = :ts WHERE match_id = :id"),
        {"ts": m_b.completed_at, "id": m_b.id},
    )
    await db_session.commit()

    await recompute_league_ratings(db_session, league.id, {a.id})
    await db_session.commit()

    # M_b was non-affected: its row is left in place, untouched.
    m_b_rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == m_b.id)
            )
        )
        .scalars()
        .all()
    )
    assert {row.user_id for row in m_b_rows} == {b.id}
    assert m_b_rows[0].rating_value == 1600.0

    # A's post-M1 state is the winner input to M2; B's seed is M_b's stored row.
    a_after_m1 = (
        await db_session.execute(
            select(RatingHistory.rating_state).where(
                RatingHistory.match_id == m1.id, RatingHistory.user_id == a.id
            )
        )
    ).scalar_one()
    expected_a, expected_b = calculator.update_singles(
        dict(a_after_m1), dict(b_seed_state)
    )

    m2_b = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id == m2.id, RatingHistory.user_id == b.id
            )
        )
    ).scalar_one()
    m2_a = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id == m2.id, RatingHistory.user_id == a.id
            )
        )
    ).scalar_one()

    # Load-bearing: B is seeded from the tie-instant M_b row (1600), not initial.
    assert m2_b.previous_rating_value == 1600.0
    assert m2_a.previous_rating_value == state_rating_value(a_after_m1)
    assert m2_a.rating_value == state_rating_value(expected_a)
    assert m2_b.rating_value == state_rating_value(expected_b)


async def test_recompute_seed_is_deterministic_on_created_at_tie(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """The seed's ``row_number`` window must tiebreak on ``match_id`` so a user
    with two candidate rows at byte-identical ``created_at`` seeds deterministically
    — the module's "rewrites state deterministically" invariant.

    U plays two NON-affected matches P1, P2 completed at the *same* instant (ids
    pinned P1 < P2), each leaving a distinct stored rating state, then joins the
    cascade later via M2 against the already-affected A. Both P-rows precede U's
    cutoff and both qualify as seeds. With no tiebreak the window picks between the
    two tied rows arbitrarily; the fixed ``(created_at DESC, match_id DESC)`` order
    deterministically picks the higher-``match_id`` row (P2 → 1700)."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    calculator = get_calculator(strategy.key)
    assert calculator is not None
    initial_rating = state_rating_value(strategy.initial_state)

    a = await make_user(db_session, "alpha")
    x = await make_user(db_session, "xray")
    u = await make_user(db_session, "uniform")
    z1 = await make_user(db_session, "zulu-one")
    z2 = await make_user(db_session, "zulu-two")
    for user in (a, x, u, z1, z2):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    tie = base + timedelta(hours=1)  # P1 and P2 share this instant exactly.
    p1_id = uuid.UUID(int=1)
    p2_id = uuid.UUID(int=2)
    assert p1_id < p2_id

    m1 = await _build_completed_match(db_session, league, a, x, base)
    p1 = await _build_completed_match(db_session, league, u, z1, tie, match_id=p1_id)
    p2 = await _build_completed_match(db_session, league, u, z2, tie, match_id=p2_id)
    m2 = await _build_completed_match(
        db_session, league, a, u, base + timedelta(hours=2)
    )
    assert p1.completed_at == p2.completed_at

    # Two candidate seed rows for U at the SAME created_at, distinct states. The
    # window must deterministically prefer the higher match_id (P2 → 1700).
    lower_state = {"rating": 1600.0, "rd": 200.0, "volatility": 0.06}
    higher_state = {"rating": 1700.0, "rd": 180.0, "volatility": 0.055}
    for match, state in ((p1, lower_state), (p2, higher_state)):
        db_session.add(
            RatingHistory(
                league_id=league.id,
                user_id=u.id,
                match_id=match.id,
                rating_strategy_id=strategy.id,
                rating_value=state["rating"],
                rating_state=state,
                source=RatingHistorySource.match,
                previous_rating_value=initial_rating,
            )
        )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE rating_history SET created_at = :ts WHERE match_id IN (:p1, :p2)"),
        {"ts": tie, "p1": p1.id, "p2": p2.id},
    )
    await db_session.commit()

    await recompute_league_ratings(db_session, league.id, {a.id})
    await db_session.commit()

    a_after_m1 = (
        await db_session.execute(
            select(RatingHistory.rating_state).where(
                RatingHistory.match_id == m1.id, RatingHistory.user_id == a.id
            )
        )
    ).scalar_one()
    _expected_a, expected_u = calculator.update_singles(
        dict(a_after_m1), dict(higher_state)
    )

    m2_u = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id == m2.id, RatingHistory.user_id == u.id
            )
        )
    ).scalar_one()
    # Deterministic: seeded from the higher-match-id row (1700), never 1600/initial.
    assert m2_u.previous_rating_value == 1700.0
    assert m2_u.rating_value == state_rating_value(expected_u)


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
        text(
            "UPDATE matches SET created_at = :ts, updated_at = :ts, "
            "completed_at = :ts WHERE id = :id"
        ),
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


async def test_recompute_skips_decided_match_with_a_player_less_side(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A completed, rated match with a decided (``won`` set) side that has no
    players — the solo-match sentinel side, or a forfeit that stamped ``won``
    on a player-less side — produced no rating delta (the live path guards it,
    ``app/matches.py``). The cascade must skip it rather than ``IndexError`` on
    ``players[0]``, which would otherwise roll back the whole league recompute."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    me = await make_user(db_session, "me")
    opp = await make_user(db_session, "opp")
    for user in (me, opp):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    # A normal decided match the cascade should still process...
    decided = await _build_completed_match(db_session, league, me, opp, base)
    # ...and a decided match whose losing side has no players.
    settings = MatchSettings(team_size=1, best_of=1, affects_rating=True)
    player_less = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=me.id,
        status=MatchStatus.completed,
    )
    side1 = MatchSide(match=player_less, side_number=1, won=True, score=1)
    side1.players.append(MatchSidePlayer(match=player_less, user=me))
    # The losing side is decided (won=False) but carries no players.
    MatchSide(match=player_less, side_number=2, won=False, score=0)
    db_session.add(player_less)
    await db_session.commit()
    await db_session.refresh(player_less)
    await db_session.execute(
        text(
            "UPDATE matches SET created_at = :ts, updated_at = :ts, "
            "completed_at = :ts WHERE id = :id"
        ),
        {"ts": base + timedelta(hours=1), "id": player_less.id},
    )
    await db_session.commit()

    # Must not raise.
    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()

    # The decided match still produced its history; the player-less one produced none.
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(
                    RatingHistory.match_id.in_([decided.id, player_less.id])
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


# ----- timeline anchored on completed_at, not updated_at -------------------


async def test_recompute_ignores_updated_at_bump_after_completion(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """The replay is anchored on the stable ``completed_at``, never the mutable
    ``updated_at``. A, B play three times in a fixed completion order whose
    outcomes alternate, so the Glicko-2 sequence is order-sensitive: replaying
    them in a different order lands on different ratings and a different
    ``created_at``/``previous_rating_value`` chain.

    We recompute, snapshot the result, then bump the *first* match's
    ``updated_at`` to after the *last* match's — the kind of touch an edit to an
    old completed match produces — and recompute again. Ordering by
    ``updated_at`` would now replay [m2, m3, m1] and produce different numbers;
    ordering by ``completed_at`` is immune. The snapshot must be identical.

    Regression guard for ADR-0012: on the old ``updated_at``-anchored code this
    assertion fails."""
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    a = await make_user(db_session, "alpha")
    b = await make_user(db_session, "bravo")
    for user in (a, b):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    # Alternating outcomes → the replay is order-sensitive.
    m1 = await _build_completed_match(db_session, league, a, b, base)
    m2 = await _build_completed_match(
        db_session, league, b, a, base + timedelta(hours=1)
    )
    m3 = await _build_completed_match(
        db_session, league, a, b, base + timedelta(hours=2)
    )

    async def snapshot() -> tuple[
        dict[uuid.UUID, float | None],
        list[tuple[uuid.UUID, datetime, float, float | None]],
    ]:
        """Final ratings plus the full history chain, ordered on the axis the
        recompute claims to use — ``created_at``. If the replay reordered, both
        the numbers and this ordered chain move."""
        ratings = {
            r.user_id: r.rating_value
            for r in (await db_session.execute(select(UserLeagueRating)))
            .scalars()
            .all()
        }
        history = [
            (row.user_id, row.created_at, row.rating_value, row.previous_rating_value)
            for row in (
                await db_session.execute(
                    select(RatingHistory)
                    .where(RatingHistory.match_id.in_([m1.id, m2.id, m3.id]))
                    .order_by(
                        RatingHistory.created_at.asc(), RatingHistory.user_id.asc()
                    )
                )
            )
            .scalars()
            .all()
        ]
        return ratings, history

    await recompute_league_ratings(db_session, league.id, {a.id})
    await db_session.commit()
    before = await snapshot()

    # The chain must actually be order-sensitive, or the test proves nothing:
    # the three matches sit at three distinct completion instants, so a reorder
    # is observable. (created_at == each match's completed_at.)
    assert {row[1] for row in before[1]} == {
        m1.completed_at,
        m2.completed_at,
        m3.completed_at,
    }

    # Touch the earliest match well after the latest one — as editing an old
    # completed match would. updated_at moves; completed_at does not.
    await db_session.execute(
        text("UPDATE matches SET updated_at = :ts WHERE id = :id"),
        {"ts": base + timedelta(hours=3), "id": m1.id},
    )
    await db_session.commit()

    await recompute_league_ratings(db_session, league.id, {a.id})
    await db_session.commit()
    after = await snapshot()

    assert after == before


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


# ----- per-league commit in the after-merge job (issue #248) --------------


async def _two_league_setup(
    db_session: AsyncSession,
    strategy: RatingStrategy,
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """Stand up a user with a rated singles win in each of two leagues, plus a
    rating row in both (so ``_recompute_after_merge``'s league discovery reaches
    each). Returns plain ids — ``(user_id, first_processed_id,
    second_processed_id)`` — sorted the way the job walks ``sorted(league_ids)``,
    so the caller knows which league the loop reaches first. Ids (not ORM
    objects) so a later ``expire_all`` can't trigger a sync lazy-load."""
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

    me = await make_user(db_session, "merged-multi")
    opp_a = await make_user(db_session, "rival-a")
    opp_b = await make_user(db_session, "rival-b")
    await _seed_rating(db_session, league_a, me.id, strategy)
    await _seed_rating(db_session, league_a, opp_a.id, strategy)
    await _seed_rating(db_session, league_b, me.id, strategy)
    await _seed_rating(db_session, league_b, opp_b.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    # A win in each league, so a committed recompute moves the rating above the
    # 1500 initial and a rolled-back one leaves it exactly at the seeded initial.
    await _build_completed_match(db_session, league_a, me, opp_a, base)
    await _build_completed_match(db_session, league_b, me, opp_b, base)

    # The job processes leagues in ``sorted(league_ids)`` order.
    first_id, second_id = sorted((league_a.id, league_b.id))
    return me.id, first_id, second_id


async def _rating_value(
    db_session: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID
) -> float | None:
    row = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.user_id == user_id,
                UserLeagueRating.league_id == league_id,
            )
        )
    ).scalar_one()
    return row.rating_value


async def test_recompute_after_merge_commits_each_league_before_the_next(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    rating_strategies: dict[str, RatingStrategy],
):
    """Issue #248: the after-merge job commits each league independently, so a
    league that raises mid-loop does NOT take its already-processed predecessors
    down with it.

    The user has a rated win in two leagues. We wrap ``recompute_league_ratings``
    so the SECOND call (the second league in ``sorted`` order) runs its real
    recompute and then raises — the failure lands after the work but before the
    job's per-league commit. The job must propagate the error, yet the FIRST
    league's recompute must already be committed while the second is rolled back.

    Pre-chore (a single commit after the whole loop) this fails: the raise
    unwinds the ``async with`` and rolls back BOTH leagues, so the first league's
    rating is left at the seeded initial too."""
    strategy = rating_strategies["glicko2"]
    me_id, first_id, second_id = await _two_league_setup(db_session, strategy)

    real_recompute = ratings_jobs.recompute_league_ratings
    calls = {"n": 0}

    async def flaky(
        session: AsyncSession,
        league_id: uuid.UUID,
        seed_user_ids: set[uuid.UUID],
    ) -> None:
        calls["n"] += 1
        # Do the real work in the session, then blow up on the 2nd league only —
        # after its writes are flushed but before the job commits them.
        await real_recompute(session, league_id, seed_user_ids)
        if calls["n"] == 2:
            raise RuntimeError("boom recomputing the second league")

    monkeypatch.setattr(ratings_jobs, "recompute_league_ratings", flaky)
    # Point the job's own engine (opened via ``get_engine()``) at the test
    # container so its committed work is visible to ``db_session``.
    monkeypatch.setattr(ratings_jobs, "get_engine", lambda: engine)

    with pytest.raises(RuntimeError, match="second league"):
        await ratings_jobs._recompute_after_merge(me_id)

    assert calls["n"] == 2

    # Fresh read: the first league committed (rating moved above initial); the
    # second rolled back with the raising transaction (still at the seeded 1500).
    db_session.expire_all()
    first_value = await _rating_value(db_session, me_id, first_id)
    second_value = await _rating_value(db_session, me_id, second_id)
    assert first_value is not None and first_value > 1500.0
    assert second_value == 1500.0


async def test_recompute_after_merge_settles_every_league_on_the_happy_path(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    rating_strategies: dict[str, RatingStrategy],
):
    """When nothing raises, the per-league-commit job still settles every league:
    the real ``_recompute_after_merge`` over two leagues commits both. Guards the
    per-league commit boundary against a regression that drops later leaders."""
    strategy = rating_strategies["glicko2"]
    me_id, first_id, second_id = await _two_league_setup(db_session, strategy)

    monkeypatch.setattr(ratings_jobs, "get_engine", lambda: engine)
    await ratings_jobs._recompute_after_merge(me_id)

    db_session.expire_all()
    first_value = await _rating_value(db_session, me_id, first_id)
    second_value = await _rating_value(db_session, me_id, second_id)
    # A win in each league → both ratings moved above the initial and persisted.
    assert first_value is not None and first_value > 1500.0
    assert second_value is not None and second_value > 1500.0


# ----- empty-timeline reset (ADR-0013) ------------------------------------

# A rating clearly distinct from the strategy initial (1500), so a reset to the
# baseline is observable and cannot be mistaken for a no-op.
_STALE_RATING = 1600.0


async def _seed_stale_empty_timeline(
    db: AsyncSession,
    league: League,
    strategy: RatingStrategy,
    username: str,
) -> tuple[User, Match]:
    """Build a user whose rating timeline is *empty* yet whose row still carries
    a stale, inflated rating — the shape a self-play void leaves behind.

    Concretely, mirroring real data:
      * a live ``UserLeagueRating`` row bumped to ``_STALE_RATING`` (1600),
      * the ``initial`` history event at the strategy baseline, exactly as
        ``seed_user_league_rating`` writes it on join,
      * a now-**voided** match, and
      * a stale *match-sourced* history row for that voided match — the winning
        row a void should have swept.

    No completed rated singles match survives for the user, so
    ``recompute_league_ratings`` computes ``t_start is None``: the empty-timeline
    branch under test."""
    me = await make_user(db, username)
    opp = await make_user(db, f"{username}-opp")

    # A match, then voided: it must NOT count as a completed rated match, so the
    # user's timeline reads empty.
    match = await _build_completed_match(
        db, league, me, opp, datetime(2026, 5, 1, tzinfo=UTC)
    )
    match.status = MatchStatus.voided
    await db.commit()

    # The live rating row, seeded then inflated to the stale value.
    rating = UserLeagueRating.seed_for_strategy(league.id, me.id, strategy)
    rating.rating_value = _STALE_RATING
    rating.rating_state = {"rating": _STALE_RATING, "rd": 200.0, "volatility": 0.06}
    db.add(rating)
    # The `initial` baseline event every member gets on join.
    db.add(
        RatingHistory(
            league_id=league.id,
            user_id=me.id,
            match_id=None,
            rating_strategy_id=strategy.id,
            rating_value=strategy.initial_rating_value,
            rating_state=dict(strategy.initial_state),
            previous_rating_value=None,
            source=RatingHistorySource.initial,
        )
    )
    # The stale match-sourced row the void left orphaned on the timeline.
    db.add(
        RatingHistory(
            league_id=league.id,
            user_id=me.id,
            match_id=match.id,
            rating_strategy_id=strategy.id,
            rating_value=_STALE_RATING,
            rating_state={"rating": _STALE_RATING, "rd": 200.0, "volatility": 0.06},
            previous_rating_value=strategy.initial_rating_value,
            source=RatingHistorySource.match,
        )
    )
    await db.commit()
    return me, match


async def test_recompute_empty_timeline_resets_user_to_initial_state(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """An empty rating timeline resolves to the strategy's initial state. A user
    whose only rated match was voided keeps a live ``UserLeagueRating`` row and
    an ``initial`` event but no completed rated match, so ``t_start is None``.

    The recompute must reset the row to the strategy baseline (not leave the
    inflated 1600 stranded) and drop the stale match-sourced history row, while
    keeping the ``initial`` event — that event *is* the empty timeline. On the
    pre-chore code the cascade returned at ``t_start is None`` and this fails:
    the row stays at 1600 and the stale match row survives."""
    league = await get_default_league(db_session)
    assert league is not None
    strategy = rating_strategies["glicko2"]
    initial_value = strategy.initial_rating_value
    initial_state = dict(strategy.initial_state)
    assert _STALE_RATING != initial_value

    me, _voided = await _seed_stale_empty_timeline(
        db_session, league, strategy, "stale"
    )
    me_id = me.id

    # Precondition: the row is genuinely stale and the match-sourced row exists.
    before = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == me_id)
        )
    ).scalar_one()
    assert before.rating_value == _STALE_RATING
    stale_match_rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(
                    RatingHistory.user_id == me_id,
                    RatingHistory.source == RatingHistorySource.match,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(stale_match_rows) == 1

    await recompute_league_ratings(db_session, league.id, {me_id})
    await db_session.commit()
    db_session.expire_all()

    # The row is reset to the strategy's initial state.
    reset = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == me_id)
        )
    ).scalar_one()
    assert reset.rating_value == initial_value
    assert reset.rating_state == initial_state

    # The stale match-sourced row is gone; the `initial` event remains.
    remaining = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.user_id == me_id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.source for r in remaining] == [RatingHistorySource.initial]


async def test_recompute_after_merge_reaches_empty_timeline_league(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    rating_strategies: dict[str, RatingStrategy],
):
    """The post-merge job must reach a league whose only rated match the merge
    just voided. Discovery keys off the rating row, not "has a completed rated
    match", so the empty-timeline league is found and reset.

    Drives the real ``_recompute_after_merge`` — including its league-discovery
    query, the guard this chore widens — with the job's engine pointed at the
    test container. On the pre-chore code the match-based discovery finds no
    league, the job returns before the cascade runs, and the stale 1600
    survives; this assertion fails."""
    league = await get_default_league(db_session)
    assert league is not None
    strategy = rating_strategies["glicko2"]
    initial_value = strategy.initial_rating_value
    initial_state = dict(strategy.initial_state)

    me, _voided = await _seed_stale_empty_timeline(
        db_session, league, strategy, "merged"
    )
    me_id = me.id

    # Point the job's own engine (opened via ``get_engine()``) at the test
    # container so its committed reset is visible to ``db_session``.
    monkeypatch.setattr(ratings_jobs, "get_engine", lambda: engine)
    await ratings_jobs._recompute_after_merge(me_id)

    db_session.expire_all()
    reset = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == me_id)
        )
    ).scalar_one()
    assert reset.rating_value == initial_value
    assert reset.rating_state == initial_state


# ----- manual strategy, empty timeline: NEVER reset -----------------------

# An externally-supplied ("hand-set") rating, distinct from any automatic
# baseline. A manual strategy's ``initial_rating_value`` and ``initial_state``
# are both None, so a wrongly-fired empty-timeline reset would BLANK this row to
# None — silent loss of imported data. The value therefore doubles as the
# discriminator: "unchanged" (1725.0) vs "reset" (None) is unambiguous.
_MANUAL_RATING = 1725.0
_MANUAL_STATE = {"rating": 1725.0}


async def _seed_manual_hand_set_rating(
    db: AsyncSession,
    league: League,
    strategy: RatingStrategy,
    username: str,
) -> User:
    """Stand up a user in a MANUAL-strategy league with an externally-supplied
    rating and NO completed rated match, so ``recompute_league_ratings`` computes
    ``t_start is None`` — the empty-timeline input that, absent the guards, would
    enter the reset branch.

    Also writes ``manual`` and ``import`` history rows: the externally-supplied
    timeline that must survive untouched. (Note these are *not* ``match``-sourced,
    so ``_reset_users_to_initial_state`` would leave them alone even on a wrongful
    reset — they document the invariant; the load-bearing discriminator is the
    ``UserLeagueRating`` row's value/state, which a reset blanks to None.)"""
    me = await make_user(db, username)

    # The row is built directly, not via ``seed_for_strategy`` — that would copy
    # the strategy's None baseline, which is exactly the value a reset produces.
    db.add(
        UserLeagueRating(
            league_id=league.id,
            user_id=me.id,
            rating_strategy_id=strategy.id,
            rating_value=_MANUAL_RATING,
            rating_state=dict(_MANUAL_STATE),
        )
    )
    for source in (RatingHistorySource.manual, RatingHistorySource.import_):
        db.add(
            RatingHistory(
                league_id=league.id,
                user_id=me.id,
                match_id=None,
                rating_strategy_id=strategy.id,
                rating_value=_MANUAL_RATING,
                rating_state=dict(_MANUAL_STATE),
                previous_rating_value=None,
                source=source,
            )
        )
    await db.commit()
    return me


async def _make_default_league_manual(
    db: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
) -> tuple[League, RatingStrategy]:
    """Repoint the default league at the manual strategy and return both."""
    league = await get_default_league(db)
    assert league is not None
    strategy = rating_strategies["manual"]
    league.rating_strategy_id = strategy.id
    await db.commit()
    await db.refresh(league)
    # ``commit`` expired the strategy; reload it so later attribute reads
    # (``initial_state`` etc.) don't trigger a sync lazy-load in the test body.
    await db.refresh(strategy)
    return league, strategy


async def test_recompute_manual_strategy_empty_timeline_preserves_rating(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A MANUAL-strategy league whose seed user has an EMPTY rating timeline
    (no completed rated match → ``t_start is None``) must keep its
    externally-supplied rating COMPLETELY untouched — not None, not an initial
    value, exactly the hand-set 1725.

    Chore 3b regression: 3a widened ``_recompute_after_merge``'s discovery to
    "leagues where the user has a rating row", so the post-merge job now reaches
    manual leagues, and 3a made ``t_start is None`` reset the row + drop match
    rows. Manual ratings are imported, so a reset here is silent data loss. The
    ``is_automatic`` guard (and, redundantly, the calculator-None guard) return
    before the reset branch. A manual strategy's initial state is None, so a
    wrongful reset would blank this row to None — the assertions below flip red
    if the reset branch is ever reached for a manual league.

    The existing ``test_recompute_manual_strategy_is_noop`` gives the user a
    completed match, so ``t_start`` is never None and it never exercises this
    branch; this fills that gap."""
    league, strategy = await _make_default_league_manual(db_session, rating_strategies)
    # The trap the guards defend against: a reset reads these as the new state.
    assert strategy.initial_rating_value is None
    assert strategy.initial_state is None

    me = await _seed_manual_hand_set_rating(db_session, league, strategy, "manual-me")
    me_id = me.id

    await recompute_league_ratings(db_session, league.id, {me_id})
    await db_session.commit()
    db_session.expire_all()

    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == me_id)
        )
    ).scalar_one()
    # Load-bearing: exactly the hand-set value/state, explicitly NOT reset to None.
    assert rating.rating_value is not None
    assert rating.rating_value == _MANUAL_RATING
    assert rating.rating_state == _MANUAL_STATE

    # The externally-supplied (manual + import) history rows survive untouched.
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.user_id == me_id)
            )
        )
        .scalars()
        .all()
    )
    assert {r.source for r in rows} == {
        RatingHistorySource.manual,
        RatingHistorySource.import_,
    }
    assert all(r.rating_value == _MANUAL_RATING for r in rows)


async def test_recompute_after_merge_manual_strategy_empty_timeline_preserved(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    rating_strategies: dict[str, RatingStrategy],
):
    """The post-merge job discovers leagues by rating row (chore 3a), so it now
    reaches a MANUAL-strategy league it never touched before. Drive the real
    ``_recompute_after_merge`` — its widened discovery query included — with the
    job's own engine pointed at the test container, and assert the guards spare
    the externally-supplied rating from the empty-timeline reset.

    Without the guards the job would blank the row to None; this exercises the
    exact code path (job discovery → per-league recompute) the widening opened."""
    league, strategy = await _make_default_league_manual(db_session, rating_strategies)
    me = await _seed_manual_hand_set_rating(
        db_session, league, strategy, "manual-merged"
    )
    me_id = me.id

    # Point the job's engine (opened via ``get_engine()``) at the test container
    # so its committed state is visible to ``db_session``.
    monkeypatch.setattr(ratings_jobs, "get_engine", lambda: engine)
    await ratings_jobs._recompute_after_merge(me_id)

    db_session.expire_all()
    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == me_id)
        )
    ).scalar_one()
    assert rating.rating_value is not None
    assert rating.rating_value == _MANUAL_RATING
    assert rating.rating_state == _MANUAL_STATE


# ----- strategy-snapshot mismatch guard (issue #184) ----------------------


async def _make_second_automatic_strategy(db: AsyncSession) -> RatingStrategy:
    """A second ``is_automatic`` strategy with its OWN state shape, distinct from
    the seeded glicko2. Only glicko2 has a registered calculator, so this strategy
    is never the league's *live* calculator — it stands in as the *old* strategy a
    ``user_league_ratings`` row was snapshotted under, whose ``rating_state`` is in
    a shape the current (glicko2) strategy would misread. That an automatic->
    automatic difference (not a manual one) is what trips the guard is the point:
    a manual switch would freeze the row before the rating hook (see #184)."""
    strategy = RatingStrategy(
        key="glicko2_experimental",
        name="Experimental (test only)",
        description="Second automatic strategy with an incompatible state shape.",
        state_schema={
            "type": "object",
            "required": ["score"],
            "properties": {"score": {"type": "number"}},
            "additionalProperties": False,
        },
        initial_state={"score": 1000.0},
        initial_rating_value=1000.0,
        is_automatic=True,
    )
    db.add(strategy)
    await db.commit()
    await db.refresh(strategy)
    return strategy


async def test_recompute_refuses_row_snapshotted_under_a_different_strategy(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A rating row snapshotted under a *different* automatic strategy than its
    league now runs must make the next recompute raise
    ``RatingStrategyMismatchError`` — never silently overwrite the row and leave
    its snapshot lying (issue #184).

    The league runs glicko2 (the one strategy with a calculator); the rows carry
    a snapshot of a second automatic strategy whose ``rating_state`` shape glicko2
    cannot interpret. The guard fires before the overwrite."""
    league = await get_default_league(db_session)
    glicko2 = rating_strategies["glicko2"]
    other = await _make_second_automatic_strategy(db_session)
    assert league.rating_strategy_id == glicko2.id

    winner = await make_user(db_session, "mismatch-w")
    loser = await make_user(db_session, "mismatch-l")
    # Snapshot both rows under the OTHER strategy — as if the league switched
    # from it to glicko2 after these rows were written.
    await _seed_rating(db_session, league, winner.id, other)
    await _seed_rating(db_session, league, loser.id, other)
    await _build_completed_match(
        db_session, league, winner, loser, datetime(2026, 5, 1, tzinfo=UTC)
    )

    with pytest.raises(RatingStrategyMismatchError) as exc_info:
        await recompute_league_ratings(db_session, league.id, {winner.id})

    err = exc_info.value
    assert err.league_id == league.id
    assert err.user_id in {winner.id, loser.id}
    assert err.row_strategy_id == other.id
    assert err.league_strategy_id == glicko2.id


async def test_recompute_freshly_seeded_row_does_not_raise(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A row this recompute *creates* is stamped with the league's current
    strategy, so it can never mismatch — the guard must not fire on it (#184,
    subtlety a). Neither player has a pre-existing rating row here."""
    league = await get_default_league(db_session)
    glicko2 = rating_strategies["glicko2"]
    # Prove there's a second automatic strategy around; it just isn't snapshotted
    # on any row, so nothing mismatches.
    await _make_second_automatic_strategy(db_session)

    winner = await make_user(db_session, "fresh-w")
    loser = await make_user(db_session, "fresh-l")
    await _build_completed_match(
        db_session, league, winner, loser, datetime(2026, 5, 1, tzinfo=UTC)
    )

    await recompute_league_ratings(db_session, league.id, {winner.id})
    await db_session.commit()

    ratings = (
        (
            await db_session.execute(
                select(UserLeagueRating).where(
                    UserLeagueRating.user_id.in_([winner.id, loser.id])
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(ratings) == 2
    assert {r.rating_strategy_id for r in ratings} == {glicko2.id}


async def test_reset_to_initial_state_heals_and_restamps_a_mismatched_row(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """``_reset_users_to_initial_state`` is the one write that legitimately heals
    a mismatched row (#184, DECISION 4): it overwrites ``rating_state`` from the
    current strategy's ``initial_state`` AND re-stamps ``rating_strategy_id`` to
    the current strategy — never raising."""
    league = await get_default_league(db_session)
    glicko2 = rating_strategies["glicko2"]
    other = await _make_second_automatic_strategy(db_session)

    me = await make_user(db_session, "reset-me")
    await _seed_rating(db_session, league, me.id, other)

    await _reset_users_to_initial_state(db_session, league.id, {me.id}, glicko2)
    await db_session.commit()

    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == me.id)
        )
    ).scalar_one()
    assert rating.rating_strategy_id == glicko2.id
    assert rating.rating_state == glicko2.initial_state
    assert rating.rating_value == glicko2.initial_rating_value
