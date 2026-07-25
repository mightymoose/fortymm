"""Rating *statistics* — the derived, read-side facts about a player's rating.

Distinct from the rest of ``app.ratings``, which is about *producing* ratings
(the calculators, the registry, the recompute pass). These are the reads that
several surfaces want to display: a player's peak in a league, where they sit
in it, and how their recent results run.

They live here rather than on any one router because more than one BFF needs
them (the dashboard's rating card and the player profile's hero), and routers
must not import each other's internals.

The streak helpers are deliberately split into a *fetch* (``completed_results``)
and a *pure* fold over that sequence (``current_streak``), so a caller that
wants more than one statistic — e.g. the current run *and* the longest-ever run
— pays for a single scan and folds it twice.

The two profile-hero blocks — ``player_standing`` and ``player_confidence`` —
are the read-side *compositions* of the statistics above, and live here for the
same reason the parts do. ``player_confidence`` in particular is here and NOT in
``app.ratings.confidence`` (whose ``rating_interval`` it calls): that module is a
LEAF on purpose — ``app.schemas.rating`` imports it for the ``level``
``@computed_field`` — so a read that builds a ``RatingConfidence`` cannot live
there without closing an import cycle.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.models import (
    Match,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    UserLeagueRating,
)
from app.ratings.confidence import rating_interval
from app.ratings.rated import had_rating_before, is_rated_member, is_rating_change
from app.ratings.state import Glicko2State, parse_rating_state
from app.schemas.player import PlayerSummary
from app.schemas.rating import RatingChange, RatingConfidence, RatingInterval

# How many of a player's most-recent completed matches the *current*-streak scan
# reads. A run longer than this is vanishingly rare and would only under-report
# the count, never mis-report its kind. A caller that needs an untruncated scan
# (a longest-ever streak) passes ``limit=None`` to ``completed_results``.
STREAK_SCAN_LIMIT = 100

# The smallest rated population for which "Top N%" is a statement rather than a
# flourish. Below it the profile withholds `percentile` entirely: in a
# twelve-player league "top 8%" only ever means "you are first", and dressing
# that up as a percentile is a lie of precision. The number is a provisional
# guess — the *principle* (withhold it while the league is too small) is what is
# settled, so move it freely.
#
# Applied in `league_percentile_if_ranked` and not inside `league_percentile`
# itself, so the floor is the editorial policy about when a percentile is worth
# printing — not part of the base helper's arithmetic. Both surfaces that render a
# standing (the dashboard's card and the profile's hero) read the switch through
# that one helper, so below the floor they agree on showing RANK ("#N of M")
# instead of a percentile, and a future move of the provisional 50 moves them
# together (ADR 20260725). What the callers also share is the population itself —
# `is_rated_member()`, via `league_rated_population` — which is arithmetic, not
# policy.
PERCENTILE_MIN_RATED_PLAYERS = 50


@dataclass(frozen=True)
class Streak:
    """A run of consecutive same-result matches: ``W`` for wins, ``L`` for
    losses, ``n`` matches long. Never zero-length — the absence of a streak is
    ``None``, not ``n=0``."""

    kind: Literal["W", "L"]
    n: int


async def league_peak_rating(
    db: AsyncSession,
    user_id: uuid.UUID,
    league_id: uuid.UUID,
    current: float,
) -> float:
    """The highest rating the user has ever HELD in this league.

    HELD, not "was ever written next to their name": ``is_rating_change()`` drops
    the ``initial`` seed row, because 1500 is the prior the league hands out on
    join and at that instant the player was Unrated — they never held it. Count it
    and a player who lost their first rated match and sits at 1450 is told their
    peak is 1500: a high they are supposed to have fallen from, which they never
    reached. That is the same lie as an unrated guest's "PEAK 1500", one match
    later.

    ``current`` remains the floor — belt and braces. Callers ask this only of a
    rated player (``is_rated_member()``), who therefore has at least one change row,
    so the ``None`` branch is unreachable for them; it stands so that a caller who
    one day asks about an unrated player gets today's value rather than a crash.
    """
    history_peak = (
        await db.execute(
            select(func.max(RatingHistory.rating_value)).where(
                RatingHistory.league_id == league_id,
                RatingHistory.user_id == user_id,
                is_rating_change(),
            )
        )
    ).scalar()
    if history_peak is None:
        return current
    return max(current, history_peak)


async def league_rated_population(db: AsyncSession, league_id: uuid.UUID) -> int:
    """How many players the league's rating ladder actually ranks.

    The denominator behind a rank — "#3" flatters in a twelve-player league and
    means something in a four-hundred-player one, so the profile hero renders
    "#3 of 42" (CONTEXT.md, "Rank").

    The population is EXACTLY the one ranks are computed over, because it is the
    same predicate and not a WHERE clause that agrees with it —
    ``is_rated_member()``, shared with ``player_summary._load_player_ranks`` and
    ``league_percentile``. So ``rank <= league_rated_population`` always holds. A
    tombstoned ghost or a seeded-but-never-played member leaking in here would make
    the denominator disagree with the numerator, which is exactly what "#2 of 5" on
    a ladder of two real players and three fresh guests was.
    """
    return (
        await db.execute(
            select(func.count(UserLeagueRating.id)).where(
                UserLeagueRating.league_id == league_id,
                is_rated_member(),
            )
        )
    ).scalar_one()


async def latest_rated_match_change(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID
) -> RatingChange | None:
    """The user's rating change from their MOST RECENT RATED MATCH in this
    league — the hero's headline "the last one moved you +12" chip.

    ``None``, never a zero change, for a player who has never finished a rated
    match: a zero would claim a rated match moved their rating by nothing.

    When that most recent match is also their FIRST, the change carries no delta at
    all (``RatingChange``): it established their rating rather than moving it, so
    ``had_rating_before()`` rides along with the row and the chip has nothing to
    report. That is why this reads a ``(row, was-already-rated)`` pair rather than
    the row alone.

    Reading from ``rating_history`` and INNER JOINing ``matches`` is what makes
    this "most recent *rated* match" rather than "most recent match": only a
    rated, completed match writes a history row carrying a ``match_id``, so a
    newer unrated or still-in-play match has no row to find and correctly does
    not displace the answer, and a voided one (whose rows are deleted) stops
    counting. The join also drops the manual / import / initial history rows,
    which have no ``match_id`` to join on — so no explicit NULL filter is needed
    here, and adding one back would be a guard that does no work.

    Ordered by ``Match.created_at`` — not the history row's own ``created_at``,
    which a recompute rewrites — so this is the same row the newest rated match
    in the profile's Recent-matches card shows in its own Δ column.
    """
    row = (
        await db.execute(
            select(RatingHistory, had_rating_before().label("had_rating_before"))
            .join(Match, Match.id == RatingHistory.match_id)
            .where(
                RatingHistory.user_id == user_id,
                RatingHistory.league_id == league_id,
            )
            .order_by(Match.created_at.desc(), RatingHistory.created_at.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    history, had_rating_before_this = row
    return RatingChange.from_history(history, had_rating_before=had_rating_before_this)


async def league_percentile(
    db: AsyncSession, league_id: uuid.UUID, my_rating: float
) -> int | None:
    """ "Top N%" rank within the league: the share of RATED MEMBERS at or above
    the user's rating, so the strongest player reads a *small* percentage (e.g.
    "Top 1%") and weaker players a larger one. Clamped to at least 1 so the top
    player never reads "Top 0%". Returns None for leagues of one — nothing to
    compare to.

    "Rated members" is ``is_rated_member()``, the SAME population
    ``league_rated_population`` counts and ``_load_player_ranks`` ranks over — so
    the "Top 8%" and the "#3 of 42" printed beside it are two readings of one
    ladder. They were not: this was the one read in this file with no tombstone
    exclusion (#944), and none of them excluded the seeded-but-never-played, who
    sit at exactly 1500 — mid-pack — and so corrupted the numerator and the
    denominator at once. On a real league (every guest who ever loaded the site
    holds a 1500 row) that made "Top 1%" reachable by beating nobody.
    """
    total, at_or_above = (
        await db.execute(
            select(
                func.count(UserLeagueRating.id),
                func.count(UserLeagueRating.id).filter(
                    UserLeagueRating.rating_value >= my_rating
                ),
            ).where(
                UserLeagueRating.league_id == league_id,
                is_rated_member(),
            )
        )
    ).one()
    if total <= 1:
        return None
    return max(1, round(int(at_or_above) / int(total) * 100))


async def league_rank(
    db: AsyncSession, league_id: uuid.UUID, user_id: uuid.UUID
) -> int | None:
    """The user's 1-based position on the league's rating ladder, or ``None`` when
    they are not a rated member of it.

    STANDARD COMPETITION RANKING (SQL ``RANK()``) over the SAME population
    ``league_rated_population`` counts and ``league_percentile`` compares against —
    ``is_rated_member()`` — so the ``#N`` and the ``of M`` beside it are two reads of
    one ladder, never two WHERE clauses that agree by luck. Ties share a rank; an
    unrated (seed-only) or tombstoned row is not on the ladder and answers ``None``.

    A single-player read (the dashboard card), so it ranks the whole league and
    picks out one row, unlike ``_load_player_ranks`` which does a batch for the
    roster — the window and its predicate are deliberately the same.
    """
    ranked = (
        select(
            UserLeagueRating.user_id.label("user_id"),
            func.rank()
            .over(order_by=UserLeagueRating.rating_value.desc())
            .label("rank"),
        ).where(
            UserLeagueRating.league_id == league_id,
            is_rated_member(),
        )
    ).subquery()
    rank = (
        await db.execute(select(ranked.c.rank).where(ranked.c.user_id == user_id))
    ).scalar_one_or_none()
    return None if rank is None else int(rank)


async def league_percentile_if_ranked(
    db: AsyncSession,
    league_id: uuid.UUID,
    my_rating: float,
    population: int,
) -> int | None:
    """The league percentile — but ONLY once the ladder is big enough for "Top N%"
    to be a statement rather than a flourish (``PERCENTILE_MIN_RATED_PLAYERS``).

    Below the threshold both the dashboard's rating card and the profile hero render
    RANK ("#N of M") instead, so this returns ``None`` and the caller shows the rank.
    THE shared rank-vs-percentile decision (ADR 20260725): the dashboard used to call
    ``league_percentile`` unconditionally and printed "Top 100%" to the lowest-rated
    player of a small league (#959). Both surfaces read the switch here so a future
    move of the provisional 50 moves them together.

    ``population`` is passed in — each caller already counts it
    (``league_rated_population``) alongside the rank it renders next to the
    percentile — so the threshold reads that count rather than issuing its own.
    """
    if population < PERCENTILE_MIN_RATED_PLAYERS:
        return None
    return await league_percentile(db, league_id, my_rating)


async def completed_results(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    limit: int | None = STREAK_SCAN_LIMIT,
) -> list[bool]:
    """The user's decided results, newest-first: ``True`` for a win, ``False``
    for a loss.

    Ordered by completion time (stable under later edits, unlike
    ``updated_at``), and capped at ``limit`` rows — pass ``limit=None`` to scan
    the whole history. One scan feeds every streak fold below.
    """
    q = (
        select(MatchSide.won)
        .join(Match, Match.id == MatchSide.match_id)
        .join(
            MatchSidePlayer,
            MatchSidePlayer.match_side_id == MatchSide.id,
        )
        .where(
            MatchSidePlayer.user_id == user_id,
            Match.status == MatchStatus.completed,
            MatchSide.won.is_not(None),
        )
        # Most-recent-completion first; stable under later edits.
        .order_by(Match.completed_at.desc())
    )
    if limit is not None:
        q = q.limit(limit)
    rows = (await db.execute(q)).scalars().all()
    # ``won`` is nullable in the DB (an undecided side), but the filter above
    # excludes those rows; the cast is what tells the type checker so.
    return [bool(won) for won in rows]


def current_streak(results: Sequence[bool]) -> Streak | None:
    """Count the run at the head of a newest-first result sequence: the
    consecutive wins (or losses) the user is on right now. ``None`` when they
    have no decided matches."""
    if not results:
        return None
    head_kind: Literal["W", "L"] = "W" if results[0] else "L"
    n = 1
    for won in results[1:]:
        kind: Literal["W", "L"] = "W" if won else "L"
        if kind != head_kind:
            break
        n += 1
    return Streak(kind=head_kind, n=n)


def best_win_streak(results: Sequence[bool]) -> Streak | None:
    """The LONGEST WINNING RUN in a result sequence — the player's best streak
    ever (CONTEXT.md, "Streak"). ``None`` when they have never won: a best
    streak is a *winning* run, so a player who has only ever lost has no best
    streak at all (``n=0`` would be a zero-length streak, which ``Streak``
    forbids). It is therefore always ``kind="W"`` when present, unlike
    ``current_streak``, which reports whichever run they are on right now.

    Order-agnostic (a longest run is the same read forwards or backwards), so
    it takes the same newest-first sequence ``current_streak`` folds — the whole
    point of ``completed_results`` being a separate fetch: ONE scan, folded
    twice.

    The caller must have scanned the player's WHOLE history
    (``completed_results(..., limit=None)``). Fold a ``STREAK_SCAN_LIMIT``-capped
    sequence and a run that ended 120 matches ago is invisible, so the answer is
    "best streak in the last 100 matches" — a different, and wrong, statistic.
    """
    best = 0
    run = 0
    for won in results:
        run = run + 1 if won else 0
        best = max(best, run)
    if best == 0:
        return None
    return Streak(kind="W", n=best)


async def current_streak_for_user(
    db: AsyncSession, user_id: uuid.UUID
) -> Streak | None:
    """The user's current streak across every league, or ``None`` if they have
    no decided matches. Scans at most ``STREAK_SCAN_LIMIT`` matches — enough to
    count any run a real player is on."""
    return current_streak(await completed_results(db, user_id))


@dataclass(frozen=True)
class _Standing:
    """The hero's "where this player stands" block, computed once and handed to
    the response model as typed fields (not a ``dict[str, Any]`` seam)."""

    peak: float | None
    rank_of: int | None
    percentile: int | None
    rating_delta: RatingChange | None


async def player_standing(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID, summary: PlayerSummary
) -> _Standing:
    """Peak, the size of the ladder behind the player's rank, a percentile (only
    once the league is big enough for one to mean anything), and the rating
    change from their most recent rated match.

    At most four round trips for the whole block — this is a single-player
    surface, so every read below is one query scoped to that one player, never
    one query per statistic per row.

    Everything here hangs off the player HAVING a rating in this league. An
    unrated player (never finished a rated match) has no rank, and so no peak, no
    ladder position and no percentile: reporting a peak of 1500 for them would
    present the seed rating as an achievement they earned.

    Below ``PERCENTILE_MIN_RATED_PLAYERS`` the ``percentile`` is withheld and the
    hero renders RANK ("#N of M", ``summary.rank`` out of ``rank_of``) instead —
    the same rank-vs-percentile switch the dashboard makes, so the two surfaces
    cannot disagree. That switch is ``league_percentile_if_ranked``: the shared
    helper reads the threshold once (ADR 20260725), so this no longer applies the
    floor inline. ``rank`` and ``rank_of`` are populated for any rated player at
    any league size, so the below-threshold hero shows "#N of M", never a blank.
    """
    rating = summary.rating
    population = await league_rated_population(db, league_id)
    rating_delta = await latest_rated_match_change(db, user_id, league_id)
    peak = (
        None
        if rating is None
        else await league_peak_rating(db, user_id, league_id, rating)
    )
    percentile = (
        None
        if rating is None
        else await league_percentile_if_ranked(db, league_id, rating, population)
    )
    return _Standing(
        peak=peak,
        # None exactly when `rank` is None — no rank, no ladder to stand on.
        rank_of=None if summary.rank is None else population,
        percentile=percentile,
        rating_delta=rating_delta,
    )


async def player_confidence(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID
) -> RatingConfidence | None:
    """How settled this player's rating is on THIS ladder (CONTEXT.md, "Rating
    confidence") — league-scoped, like rating / rank / peak, and unlike career.

    ``None`` — the card does not render at all — in three cases, none of which
    is an error:

    * the player is UNRATED on this ladder: no rating row, a NULL rating in it, or
      — the case that matters, because it is every fresh guest — a row holding
      nothing but the 1500 the league seeded them with when they joined. Nothing
      has moved it, they have never finished a rated match, the hero says
      "Unrated", and there is nothing to be confident *about*. The gate is
      ``is_rated_member()``, the same predicate ``rating`` and ``rank`` are read
      through, so the card cannot appear beside a hero that says Unrated —
      "Provisional · somewhere between 814 and 2186" is the seed's own RD of 350
      talking, i.e. the system stating it knows nothing, dressed up as a finding;
    * the rating came from a MANUAL strategy — an imported USATT number carries
      no deviation, so it has no confidence to report. This is why the state is
      parsed rather than indexed: ``state["rd"]`` on a manual row is a
      ``KeyError``, while a ``ManualState`` simply has no ``rd`` to reach for and
      the type checker makes us say what happens instead.

    The state is decoded with the strategy off the RATING ROW (not the league):
    a row written under a superseded strategy still holds state in that
    strategy's shape.

    The interval is centred on the state's own rating — the Glicko-2 mean its RD
    describes — which is the same number the hero displays: every write sets
    ``rating_value`` from ``state_rating_value(state)``.
    """
    row = (
        await db.execute(
            select(UserLeagueRating)
            .where(
                UserLeagueRating.user_id == user_id,
                UserLeagueRating.league_id == league_id,
                is_rated_member(),
            )
            # Many-to-one (``user_league_ratings.rating_strategy_id``): a
            # LEFT JOIN folded into this query, not a second SELECT.
            .options(joinedload(UserLeagueRating.rating_strategy))
        )
    ).scalar_one_or_none()
    if row is None or row.rating_value is None:
        return None
    state = parse_rating_state(
        row.rating_strategy.key, row.rating_state, row.rating_value
    )
    if not isinstance(state, Glicko2State):
        return None
    low, high = rating_interval(state.rating, state.rd)
    return RatingConfidence(
        deviation=state.rd,
        volatility=state.volatility,
        interval=RatingInterval(low=low, high=high),
    )
