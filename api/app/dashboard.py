import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.attention import attention_priority, list_attention_kind
from app.db import get_session
from app.matches import (
    _attention_matches_query,
    current_game_number,
    match_eager_options,
    my_standing_proposal_exists,
    opponent_username,
    participant_filter,
    side_win_counts,
)
from app.matches import (
    my_side as resolve_my_side,
)
from app.models import (
    League,
    Match,
    MatchStatus,
    RatingHistory,
    User,
    UserLeagueRating,
)
from app.ratings import RatingStrategyKey, parse_strategy_key
from app.ratings.rated import is_rated_member, is_rating_change
from app.ratings.stats import (
    current_streak_for_user,
    league_peak_rating,
    league_percentile,
)
from app.retirement import retirement_deadline
from app.schemas.dashboard import (
    AttentionKind,
    DashboardAttentionItem,
    DashboardRating,
    DashboardRatingStat,
    DashboardRecentResult,
    DashboardResponse,
    DashboardStreak,
)
from app.schemas.rating import RatingChange
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

RECENT_RESULTS_LIMIT = 5
SPARK_WINDOW_DAYS = 30
SPARK_MAX_POINTS = 30
# Most attention rows the panel *displays* at once. We load and rank EVERY
# actionable match (so the highest-priority row can never be dropped before
# ranking — the #838 bug was capping the DB read on ``updated_at``, an axis
# unrelated to priority), then slice the ranked list to this many for display
# and roll the rest into a "+N more" count. This is a post-ranking display cap,
# not a DB/eager-load cap (see ADR 0011).
ATTENTION_BANNERS_LIMIT = 10
# The open statuses an attention row can hold — the only ones where the user
# still owes (or is owed) a move. Bounds the count scan to a handful of rows.
_OPEN_STATUSES = (
    MatchStatus.pending,
    MatchStatus.in_progress,
)


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> DashboardResponse:
    # EVERY actionable open match the user participates in is pulled in full
    # (results + sides are needed to classify each into an attention bucket and
    # to deep-link a "score" row); completed matches feed the recent-results
    # table. We load the whole actionable set — no DB cap — because ranking by
    # attention priority happens in Python (``_build_attention``); capping the
    # read first (the old ``ORDER BY updated_at ASC LIMIT``) drops the
    # highest-priority row on an axis unrelated to priority (#838, ADR 0011).
    # We reuse the list Attention tab's own membership query so the panel and the
    # tab agree on exactly *who is actionable*; ``ATTENTION_BANNERS_LIMIT`` then
    # caps the ranked *display* list, and ``attention_total_count`` is that
    # ranked list's length.
    #
    # ``_attention_matches_query``'s filter excludes the passive "waiting on the
    # opponent" case (an in_progress match where the current user proposed the
    # *standing* result — the unaccepted head of the supersede chain): those are
    # never attention rows, only a waiting count. The current user owes a move on
    # every actionable match — either no result yet ("score") or a standing
    # result the *other* side proposed ("review"). The Python classifier
    # (``list_attention_kind``) refines which per row.
    my_standing_proposal = my_standing_proposal_exists(current_user.id)
    actionable_q = _attention_matches_query(None, current_user.id).options(
        *match_eager_options()
    )
    completed_q = (
        participant_filter(select(Match), current_user.id)
        .where(Match.status == MatchStatus.completed)
        .options(*match_eager_options())
        # Recent-first by the stable completion time, not the mutable
        # ``updated_at`` — editing an old completed match must not bump it back
        # to the top of recent results.
        .order_by(Match.completed_at.desc())
        .limit(RECENT_RESULTS_LIMIT)
    )
    # The passive "waiting" total feeds the footer's "waiting on others" line —
    # matches the user can't act on yet, so they're never loaded above. This
    # mirrors the passive half of ``app.attention.list_attention_kind`` in SQL
    # (COUNT can't run the Python classifier): ``waiting_opponent`` (in_progress
    # where the user *has* a standing proposal awaiting acceptance) plus
    # ``waiting_others`` (pending/scheduled) fold into waiting. If that
    # classifier's status routing ever changes, this filter must follow. The
    # actionable total is no longer counted here — it's ``len`` of the ranked
    # list below (every actionable match is loaded), so the panel and its "+N
    # more" footer share one definition of who is actionable.
    waiting_count_q = participant_filter(
        select(
            func.count(Match.id).filter(
                or_(
                    Match.status == MatchStatus.pending,
                    and_(
                        Match.status == MatchStatus.in_progress,
                        my_standing_proposal,
                    ),
                )
            ),
        ),
        current_user.id,
    ).where(Match.status.in_(_OPEN_STATUSES))

    actionable = (await db.execute(actionable_q)).scalars().all()
    completed = (await db.execute(completed_q)).scalars().all()
    waiting_count = int((await db.execute(waiting_count_q)).scalar_one())

    # When completed_q didn't hit its LIMIT, we already have the exact count
    # and can skip the extra round-trip; only the user-with-history case pays
    # for a separate COUNT.
    if len(completed) < RECENT_RESULTS_LIMIT:
        completed_match_count = len(completed)
    else:
        completed_count_q = participant_filter(
            select(func.count(Match.id)), current_user.id
        ).where(Match.status == MatchStatus.completed)
        completed_match_count = int((await db.execute(completed_count_q)).scalar_one())

    rating_changes = await _load_my_rating_changes(
        db, current_user.id, [m.id for m in completed]
    )

    # Rank the *full* actionable set, then cap for display: the total is the
    # ranked list's length (the list tab's "its length IS the count" trick) and
    # the panel shows the top ATTENTION_BANNERS_LIMIT (#838, ADR 0011).
    ranked_attention = _build_attention(actionable, current_user.id)
    attention_total_count = len(ranked_attention)
    attention = ranked_attention[:ATTENTION_BANNERS_LIMIT]
    recent_results = [
        _build_recent_result(match, current_user.id, rating_changes.get(match.id))
        for match in completed
    ]
    rating = await _build_rating(db, current_user.id)

    return DashboardResponse(
        attention=attention,
        attention_total_count=attention_total_count,
        waiting_count=waiting_count,
        recent_results=recent_results,
        rating=rating,
        completed_match_count=completed_match_count,
    )


async def _load_my_rating_changes(
    db: AsyncSession,
    user_id: uuid.UUID,
    match_ids: Sequence[uuid.UUID],
) -> dict[uuid.UUID, RatingChange]:
    if not match_ids:
        return {}
    rows = (
        (
            await db.execute(
                select(RatingHistory).where(
                    RatingHistory.match_id.in_(match_ids),
                    RatingHistory.user_id == user_id,
                )
            )
        )
        .scalars()
        .all()
    )
    changes: dict[uuid.UUID, RatingChange] = {}
    for row in rows:
        assert row.match_id is not None  # IN-filtered to non-null match_ids
        changes[row.match_id] = RatingChange.from_history(row)
    return changes


def _build_attention(
    actionable: Sequence[Match],
    current_user_id: uuid.UUID,
) -> list[DashboardAttentionItem]:
    """Rank the user's actionable open matches into priority-ordered attention
    rows.

    The caller passes *every* actionable match — in_progress matches where the
    user hasn't proposed the standing result — unbounded, so ranking sees the
    full set and the highest-priority row can never be dropped before ranking
    (#838). The caller slices the returned list to ``ATTENTION_BANNERS_LIMIT``
    for display and takes its length as the exact actionable total. Passive
    "waiting" matches (our standing proposal awaiting acceptance,
    pending/scheduled) never reach here; they feed ``waiting_count`` via a
    separate aggregate. Classification + ranking come from the shared
    ``app.attention`` module so this panel and the matches-list Attention filter
    never disagree about who owes a move.
    """
    # (priority, sort_ts, item) — sorted by priority then oldest-first so a
    # long-stalled match floats to the top of its bucket.
    ranked: list[tuple[int, datetime, DashboardAttentionItem]] = []

    for match in actionable:
        kind = list_attention_kind(match, current_user_id)
        # Only actionable kinds become rows. The caller filters out the passive
        # "waiting" buckets, but we skip them (and the non-participant ``None``)
        # defensively so a stray match can never produce a bogus row.
        if kind is None or kind == "waiting_opponent" or kind == "waiting_others":
            continue
        # kind is now narrowed to AttentionKind (review / score).
        ranked.append(
            (
                attention_priority(kind, match.match_settings.affects_rating),
                match.updated_at,
                _attention_item(match, current_user_id, kind),
            )
        )

    ranked.sort(key=lambda row: (row[0], row[1]))
    return [item for _, _, item in ranked]


def _attention_item(
    match: Match, current_user_id: uuid.UUID, kind: AttentionKind
) -> DashboardAttentionItem:
    return DashboardAttentionItem(
        match_id=match.id,
        opponent_username=opponent_username(match, current_user_id),
        kind=kind,
        affects_rating=match.match_settings.affects_rating,
        # Only ``score`` rows deep-link to the scoring page; review rows
        # route to match detail and carry no game number.
        current_game_number=current_game_number(match) if kind == "score" else None,
        retirement_deadline=retirement_deadline(match),
    )


def _build_recent_result(
    match: Match,
    current_user_id: uuid.UUID,
    my_rating_change: RatingChange | None,
) -> DashboardRecentResult:
    mine = resolve_my_side(match, current_user_id)
    assert mine is not None  # query filters to participants
    # The completed_q filters status == completed, so completed_at is set.
    assert match.completed_at is not None
    side_wins = side_win_counts(match)
    my_games_won = side_wins.get(mine.side_number, 0)
    opp_games_won = sum(
        wins for number, wins in side_wins.items() if number != mine.side_number
    )
    return DashboardRecentResult(
        match_id=match.id,
        opponent_username=opponent_username(match, current_user_id),
        is_win=my_games_won > opp_games_won,
        my_games_won=my_games_won,
        opponent_games_won=opp_games_won,
        completed_at=match.completed_at,
        my_rating_change=my_rating_change,
    )


async def _build_rating(db: AsyncSession, user_id: uuid.UUID) -> DashboardRating | None:
    """Resolve the user's headline rating row — or ``None``, and no card at all.

    Picks the default league's rating if they hold one there, otherwise the oldest
    league they DO hold one in. "Hold" is ``is_rated_member()``: the widget stays
    hidden until the league is actually scoring you, which is what this docstring
    has always claimed and what the row filter now makes true.

    It was not true. Joining a league seeds a 1500 row, so a guest who had never
    played anything got the full card — current 1500, peak 1500, RD 350, a
    one-point sparkline — every number of which is the strategy's PRIOR rather than
    anything they did. The percentile was suppressed for them (#382) precisely
    because it was the most obviously absurd of the five; the fix is the same one
    the profile now makes, applied once and to all of them: a player who has never
    finished a rated match has no rating, so there is no rating card. They see the
    same "Unrated" story here as on their profile instead of a fabricated one.

    (The alternative — keep the card and null out ``peak``/``percentile`` — would
    make ``DashboardRating.peak`` nullable, i.e. an OpenAPI change, and would still
    print a rating of 1500 next to a profile that says Unrated. Hiding the card
    needs no schema change: ``rating`` is already ``DashboardRating | None`` for
    manual-strategy leagues, and the client already renders that.)

    ``completed_match_count`` is no longer a parameter: it was a PROXY for "is this
    player rated" (#382), and we now have the predicate itself. A rated player has,
    by definition, completed a rated match — so the old gate could no longer fire,
    and a dead guard that looks live is worse than no guard.
    """
    rating_row = await _resolve_user_rating(db, user_id)
    if rating_row is None or rating_row.rating_value is None:
        return None
    strategy = rating_row.league.rating_strategy
    if not strategy.is_automatic:
        return None

    current = rating_row.rating_value
    league_id = rating_row.league_id
    spark, delta = await _spark_and_delta(db, user_id, league_id)
    peak = await league_peak_rating(db, user_id, league_id, current)
    percentile = await league_percentile(db, league_id, current)
    streak = await current_streak_for_user(db, user_id)

    return DashboardRating(
        league_id=league_id,
        league_name=rating_row.league.name,
        strategy_key=strategy.key,
        current=current,
        delta=delta,
        peak=peak,
        percentile=percentile,
        spark_data=spark,
        streak=(
            None if streak is None else DashboardStreak(kind=streak.kind, n=streak.n)
        ),
        stats=_strategy_stats(strategy.key, rating_row.rating_state or {}),
    )


async def _resolve_user_rating(
    db: AsyncSession, user_id: uuid.UUID
) -> UserLeagueRating | None:
    # The default league's rating first; failing that, the oldest league the user
    # is actually rated in, so a player who only plays on a side ladder still gets
    # a card — for THAT ladder. Eager-load the league and strategy so the caller
    # can read is_automatic without an extra round trip.
    #
    # Both reads are gated on ``is_rated_member()``, so "no row" and "a row holding
    # nothing but the seed the league handed them on join" answer the same way:
    # ``None``, and no card. Without it the default-league branch always hits — every
    # user is seeded there the moment their session is minted — and the fallback
    # below was dead code for everyone.
    options = (
        selectinload(UserLeagueRating.league).selectinload(League.rating_strategy),
    )
    default = (
        await db.execute(
            select(UserLeagueRating)
            .join(League, League.id == UserLeagueRating.league_id)
            .where(
                UserLeagueRating.user_id == user_id,
                League.is_default.is_(True),
                is_rated_member(),
            )
            .options(*options)
            .limit(1)
        )
    ).scalar_one_or_none()
    if default is not None:
        return default
    return (
        await db.execute(
            select(UserLeagueRating)
            .where(
                UserLeagueRating.user_id == user_id,
                is_rated_member(),
            )
            .options(*options)
            .order_by(UserLeagueRating.created_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _spark_and_delta(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID
) -> tuple[list[float], float]:
    """Pull the most-recent history rows once, then derive both the sparkline
    (last 30 days, oldest-first) and the last-match delta from them. Ordering
    DESC + reversing avoids the latent bug where ``LIMIT 30 ORDER BY ASC``
    would silently truncate today's points on a power user with >30 events in
    the window.

    ``is_rating_change()``: the ``initial`` seed row is not a point on this line,
    for the same reason it is not one on the profile's chart — it is the prior the
    league handed the player on join, not a rating they held. The sparkline and the
    chart plot the same table for the same purpose, and must not disagree about
    what a rating point is. A player one rated match old therefore has a
    single-point spark (their result), not a two-point line rising out of 1500."""
    cutoff = datetime.now(UTC) - timedelta(days=SPARK_WINDOW_DAYS)
    rows = (
        await db.execute(
            select(
                RatingHistory.rating_value,
                RatingHistory.previous_rating_value,
                RatingHistory.created_at,
            )
            .where(
                RatingHistory.user_id == user_id,
                RatingHistory.league_id == league_id,
                is_rating_change(),
            )
            .order_by(RatingHistory.created_at.desc())
            .limit(SPARK_MAX_POINTS)
        )
    ).all()
    if not rows:
        return [], 0.0
    latest = rows[0]
    delta = (
        latest.rating_value - latest.previous_rating_value
        if latest.previous_rating_value is not None
        else 0.0
    )
    spark = [float(r.rating_value) for r in reversed(rows) if r.created_at >= cutoff]
    return spark, delta


def _strategy_stats(
    strategy_key: str, state: dict[str, object]
) -> list[DashboardRatingStat]:
    """Strategy-specific tiles for the rating card's stats grid.

    Keeps the API contract generic — the frontend renders whatever labels
    come back without needing to know which fields a given strategy carries.

    ``strategy_key`` arrives as a raw ``str`` off ``RatingStrategy.key``, so it
    is parsed to the closed enum at this boundary — an unrecognised key parses
    to ``None`` and yields no tiles, rather than silently missing an ``==``.
    """
    if parse_strategy_key(strategy_key) is RatingStrategyKey.glicko2:
        rd = _as_float(state.get("rd"))
        volatility = _as_float(state.get("volatility"))
        return [
            DashboardRatingStat(
                label="RD",
                value=str(round(rd)) if rd is not None else "—",
            ),
            DashboardRatingStat(
                label="Volatility",
                value=f"{volatility:.3f}" if volatility is not None else "—",
            ),
        ]
    return []


def _as_float(value: object) -> float | None:
    # Excludes bool (which is an int subclass) — Glicko-2 state never carries
    # booleans, but coercing True → 1.0 silently would be a bad surprise.
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None
