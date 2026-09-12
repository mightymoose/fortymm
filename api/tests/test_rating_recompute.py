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
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    UserLeagueRating,
)
from app.player_matches import _load_match_rating_changes
from app.ratings import RatingStrategyMismatchError
from app.ratings import jobs as ratings_jobs
from app.ratings.recompute import (
    _league_lock_key,
    recompute_league_ratings,
)
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
    """Seed participants, then complete through real proposal/acceptance interfaces.

    Fixed timestamps and IDs exercise timeline ordering; official provenance comes
    from actual participant consent, never a fabricated rating-history reference.
    """
    from app.result_acceptance import accept_result
    from app.result_proposal import propose_result
    from app.schemas.match import MatchResultsGameWrite

    match = Match(
        **({"id": match_id} if match_id is not None else {}),
        match_settings=MatchSettings(
            team_size=1, best_of=1, affects_rating=affects_rating
        ),
        league=league,
        created_by_user_id=winner.id,
        status=MatchStatus.in_progress,
    )
    for number, user in ((1, winner), (2, loser)):
        side = MatchSide(match=match, side_number=number)
        side.players.append(MatchSidePlayer(match=match, user=user.primary_player))
    db.add(match)
    await db.commit()
    outcome = await propose_result(
        db,
        match.id,
        winner.id,
        games=[MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)],
        supersedes_result_id=None,
    )
    if affects_rating:
        await accept_result(
            db, match.id, loser.id, result_id=outcome.match.results[0].id
        )
    await db.commit()
    await db.execute(
        text(
            "UPDATE matches SET created_at = :ts, updated_at = :ts, "
            "completed_at = :ts WHERE id = :id"
        ),
        {"ts": completed_at, "id": match.id},
    )
    await db.execute(
        text("UPDATE rating_history SET created_at = :ts WHERE match_id = :id"),
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
    """Manual leagues do not calculate match-derived rating changes."""
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


async def test_recompute_keeps_the_first_change_first(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A RECOMPUTE must not turn every rated match back into a "first" one.

    The read side decides whether a change ESTABLISHED a rating or MOVED one by
    asking whether an earlier rating change exists (``had_rating_before``, #952), and
    it orders that question on ``RatingHistory.created_at``. A recompute rewrites
    EVERY affected row in a SINGLE transaction — so if it stamped them with
    ``func.now()``, all of them would share one instant, no row would be earlier than
    any other, and every match in the league would suddenly report itself as the
    player's first: no ``before``, no delta, platform-wide.

    It doesn't: it stamps ``created_at = match.completed_at`` (asserted directly
    above), which is the same axis the live path writes on and the order the replay
    actually computed ``previous_rating_value`` in. This test pins that from the READ
    side, through the loader the profile's Δ column uses — the only place the
    consequence is visible. Every other rating test seeds its rows in separate
    commits and would stay green either way.
    """
    league = await get_default_league(db_session)
    strategy = rating_strategies["glicko2"]
    me = await make_user(db_session, "recomputed")
    opp = await make_user(db_session, "sparring")
    for user in (me, opp):
        await _seed_rating(db_session, league, user.id, strategy)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    first = await _build_completed_match(db_session, league, me, opp, base)
    second = await _build_completed_match(
        db_session, league, me, opp, base + timedelta(hours=1)
    )

    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()

    changes = await _load_match_rating_changes(db_session, me.id, [first.id, second.id])

    # Their first rated match established the rating; it did not move one.
    assert changes[first.id].before is None
    assert changes[first.id].delta is None

    # And the second still MOVED the rating the first established — a real before,
    # a real delta. This is the assertion a same-instant stamp would break.
    assert changes[second.id].before == changes[first.id].after
    assert changes[second.id].delta == pytest.approx(
        changes[second.id].after - changes[first.id].after
    )
    assert changes[second.id].delta != 0


async def test_recompute_leaves_unrelated_matches_alone(db_session, rating_strategies):
    league = await get_default_league(db_session)
    me, opp, x, y = [
        await make_user(db_session, name) for name in ("me", "opp", "ex", "why")
    ]
    base = datetime(2026, 5, 1, tzinfo=UTC)
    mine = await _build_completed_match(db_session, league, me, opp, base)
    unrelated = await _build_completed_match(
        db_session, league, x, y, base + timedelta(hours=1)
    )
    before = [
        (row.id, row.rating_state)
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == unrelated.id)
            )
        ).all()
    ]
    await recompute_league_ratings(db_session, league.id, {me.id})
    after = [
        (row.id, row.rating_state)
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == unrelated.id)
            )
        ).all()
    ]
    assert before == after
    assert (
        len(
            (
                await db_session.scalars(
                    select(RatingHistory).where(RatingHistory.match_id == mine.id)
                )
            ).all()
        )
        == 2
    )


# ----- pre-window state ---------------------------------------------------


async def test_recompute_preserves_an_explicit_pre_match_adjustment(db_session):
    from app.ratings.inputs import record_rating_input

    league = await get_default_league(db_session)
    me, opp, earlier = [
        await make_user(db_session, name) for name in ("me", "opp", "earlier")
    ]
    base = datetime(2026, 5, 1, tzinfo=UTC)
    await _build_completed_match(
        db_session, league, opp, earlier, base - timedelta(days=30)
    )
    await record_rating_input(
        db_session,
        league.id,
        opp.id,
        actor_account_id=opp.id,
        rating=1550,
        source="manual",
        effective_at=base - timedelta(days=1),
    )
    match = await _build_completed_match(db_session, league, me, opp, base)
    await recompute_league_ratings(db_session, league.id, {me.id})
    row = await db_session.scalar(
        select(RatingHistory).where(
            RatingHistory.match_id == match.id, RatingHistory.user_id == opp.id
        )
    )
    assert row.previous_rating_value == 1550


@pytest.mark.parametrize("tied", [False, True])
async def test_recompute_reconstructs_late_opponents_prior_matches(db_session, tied):
    """An opponent's intervening match counts with no cached history (#749)."""
    from sqlalchemy import delete

    from app.ratings.glicko2 import CALCULATOR

    league = await get_default_league(db_session)
    a, x, b, y = [
        await make_user(db_session, name)
        for name in ("alpha", "xray", "bravo", "yankee")
    ]
    base = datetime(2026, 5, 1, tzinfo=UTC)
    await _build_completed_match(db_session, league, a, x, base)
    prior = await _build_completed_match(
        db_session, league, b, y, base + timedelta(hours=1), match_id=uuid.UUID(int=1)
    )
    last = await _build_completed_match(
        db_session,
        league,
        a,
        b,
        base + timedelta(hours=1 if tied else 2),
        match_id=uuid.UUID(int=2),
    )
    initial = dict(league.rating_strategy.initial_state)
    a_state, _ = CALCULATOR.update_singles(initial, initial)
    b_state, _ = CALCULATOR.update_singles(initial, initial)
    expected_a, expected_b = CALCULATOR.update_singles(a_state, b_state)
    await db_session.execute(delete(RatingHistory))
    await db_session.execute(delete(UserLeagueRating))
    await recompute_league_ratings(db_session, league.id, {a.id})
    rows = {
        row.user_id: row
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == last.id)
            )
        ).all()
    }
    assert rows[b.id].previous_rating_value == b_state["rating"]
    assert rows[a.id].rating_state == expected_a
    assert rows[b.id].rating_state == expected_b
    assert (
        len(
            (
                await db_session.scalars(
                    select(RatingHistory).where(RatingHistory.match_id == prior.id)
                )
            ).all()
        )
        == 2
    )


async def test_recompute_orders_tied_matches_by_id_not_insertion(db_session):
    from sqlalchemy import delete

    from app.ratings.glicko2 import CALCULATOR

    league = await get_default_league(db_session)
    me, one, two = [await make_user(db_session, name) for name in ("me", "one", "two")]
    at = datetime(2026, 5, 1, tzinfo=UTC)
    later = await _build_completed_match(
        db_session, league, two, me, at, match_id=uuid.UUID(int=2)
    )
    await _build_completed_match(
        db_session, league, me, one, at, match_id=uuid.UUID(int=1)
    )
    initial = dict(league.rating_strategy.initial_state)
    first, _ = CALCULATOR.update_singles(initial, initial)
    _, expected = CALCULATOR.update_singles(initial, first)
    await db_session.execute(delete(RatingHistory))
    await recompute_league_ratings(db_session, league.id, {me.id})
    row = await db_session.scalar(
        select(RatingHistory).where(
            RatingHistory.match_id == later.id, RatingHistory.user_id == me.id
        )
    )
    assert row.previous_rating_value == first["rating"]
    assert row.rating_state == expected


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
    side1.players.append(MatchSidePlayer(match=undecided, user=me.primary_player))
    side2 = MatchSide(match=undecided, side_number=2, won=None, score=0)
    side2.players.append(MatchSidePlayer(match=undecided, user=opp.primary_player))
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
    side1.players.append(MatchSidePlayer(match=player_less, user=me.primary_player))
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

    # Session 1 requests replay for a player and retains its transaction lock.
    player = await make_user(db_session, "lock-holder")
    await recompute_league_ratings(db_session, league.id, {player.id})

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

    for league in (league_a, league_b):
        row = await db_session.scalar(
            select(UserLeagueRating).where(
                UserLeagueRating.user_id == me.id,
                UserLeagueRating.league_id == league.id,
            )
        )
        row.rating_value = strategy.initial_rating_value
        row.rating_state = dict(strategy.initial_state)
    await db_session.commit()
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


async def _seed_stale_empty_timeline(db, league, strategy, username):
    """A retained void with stale, disposable projections exercises repair."""
    me = await make_user(db, username)
    opp = await make_user(db, f"{username}-opp")
    match = await _build_completed_match(
        db, league, me, opp, datetime(2026, 5, 1, tzinfo=UTC)
    )
    match.status = MatchStatus.voided
    rating = await db.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.user_id == me.id, UserLeagueRating.league_id == league.id
        )
    )
    rating.rating_value = _STALE_RATING
    rating.rating_state = {"rating": _STALE_RATING, "rd": 200.0, "volatility": 0.06}
    db.add(
        RatingHistory(
            league_id=league.id,
            user_id=me.id,
            rating_strategy_id=strategy.id,
            rating_value=strategy.initial_rating_value,
            rating_state=dict(strategy.initial_state),
            source=RatingHistorySource.initial,
        )
    )
    await db.commit()
    return me, match


async def test_recompute_empty_timeline_resets_user_to_initial_state(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """Replay repairs a stale snapshot after the only rated match is voided."""
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


async def _seed_manual_hand_set_rating(db, league, strategy, username):
    from app.ratings.inputs import record_rating_input

    me = await make_user(db, username)
    for source in ("manual", "import"):
        await record_rating_input(
            db,
            league.id,
            me.id,
            actor_account_id=me.id,
            rating=_MANUAL_RATING,
            source=source,
            effective_at=datetime(2026, 5, 1, tzinfo=UTC),
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
    """An empty match list still replays durable manual and imported inputs."""
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

    # Both durable inputs are represented in the rebuilt timeline.
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
    """The post-merge job reaches manual leagues and preserves explicit inputs."""
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
    """An unsupported formula exercises snapshot refusal."""
    strategy = RatingStrategy(
        key="glicko2_experimental",
        name="Experimental (test only)",
        description="Second automatic strategy with an incompatible state shape.",
        state_schema={
            "type": "object",
            "required": ["rating"],
            "properties": {"rating": {"type": "number"}},
            "additionalProperties": False,
        },
        initial_state={"rating": 1000.0},
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
    """Refuse a snapshot whose formula differs from the durable match basis."""
    league = await get_default_league(db_session)
    glicko2 = rating_strategies["glicko2"]
    other = await _make_second_automatic_strategy(db_session)
    assert league.rating_strategy_id == glicko2.id

    winner = await make_user(db_session, "mismatch-w")
    loser = await make_user(db_session, "mismatch-l")
    # Snapshot both rows under the OTHER strategy — as if the league switched
    # from it to glicko2 after these rows were written.
    await _build_completed_match(
        db_session, league, winner, loser, datetime(2026, 5, 1, tzinfo=UTC)
    )

    for user in (winner, loser):
        row = await db_session.scalar(
            select(UserLeagueRating).where(UserLeagueRating.user_id == user.id)
        )
        row.rating_strategy_id = other.id
        row.rating_value = other.initial_rating_value
        row.rating_state = dict(other.initial_state)
    await db_session.commit()
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
    """Reconstruction records the formula that originally applied to the match."""
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


async def test_recompute_refuses_mismatched_snapshot_even_without_matches(
    db_session, rating_strategies
):
    league = await get_default_league(db_session)
    other = await _make_second_automatic_strategy(db_session)
    me = await make_user(db_session, "mismatch-empty")
    await _seed_rating(db_session, league, me.id, other)
    with pytest.raises(RatingStrategyMismatchError):
        await recompute_league_ratings(db_session, league.id, {me.id})


async def test_recompute_ignores_seed_row_written_under_a_superseded_strategy(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A disposable initial projection from another formula cannot seed replay."""
    league = await get_default_league(db_session)
    glicko2 = rating_strategies["glicko2"]
    other = await _make_second_automatic_strategy(db_session)
    assert league.rating_strategy_id == glicko2.id
    initial_value = glicko2.initial_rating_value

    me = await make_user(db_session, "superseded-me")
    opp = await make_user(db_session, "superseded-opp")
    await _seed_rating(db_session, league, me.id, glicko2)
    await _seed_rating(db_session, league, opp.id, glicko2)

    base = datetime(2026, 5, 1, tzinfo=UTC)
    # A stale enrollment projection has a different formula and state shape.
    stale_state = {"rating": 1000.0}
    assert "rd" not in stale_state  # not a complete Glicko-2 state.
    db_session.add(
        RatingHistory(
            league_id=league.id,
            user_id=me.id,
            match_id=None,
            rating_strategy_id=other.id,
            rating_value=1000.0,
            rating_state=dict(stale_state),
            previous_rating_value=None,
            source=RatingHistorySource.initial,
            created_at=base - timedelta(days=1),
        )
    )
    await db_session.commit()

    match = await _build_completed_match(db_session, league, me, opp, base)

    # Reconstruct from the durable formula, not the old enrollment projection.
    await recompute_league_ratings(db_session, league.id, {me.id})
    await db_session.commit()

    me_match_row = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.match_id == match.id,
                RatingHistory.user_id == me.id,
            )
        )
    ).scalar_one()
    # The replay seeded ``me`` from B's initial (1500), NOT the stale A row (1000).
    assert me_match_row.previous_rating_value == initial_value
    # ``me``'s produced state is B-shaped (glicko2 keys), never A-shaped.
    assert set(me_match_row.rating_state) == {"rating", "rd", "volatility"}
    assert "score" not in me_match_row.rating_state
    assert me_match_row.rating_strategy_id == glicko2.id

    # ``me`` won, so the healed live row moved above the glicko2 initial and stays
    # stamped under the current strategy.
    me_rating = (
        await db_session.execute(
            select(UserLeagueRating).where(UserLeagueRating.user_id == me.id)
        )
    ).scalar_one()
    assert me_rating.rating_strategy_id == glicko2.id
    assert me_rating.rating_value is not None and me_rating.rating_value > initial_value

    # The old enrollment projection remains display-compatible but never seeds play.
    stale_row = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.user_id == me.id,
                RatingHistory.source == RatingHistorySource.initial,
            )
        )
    ).scalar_one()
    assert stale_row.rating_strategy_id == other.id
    assert stale_row.rating_state == stale_state
