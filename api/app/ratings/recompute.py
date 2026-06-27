"""Rebuild ``rating_history`` and ``user_league_ratings`` after data changes
upstream of the rating timeline (e.g. an ephemeral→verified account merge
moved matches onto a user). Operates one league at a time.

The cascade: if user A's rating changes for match M1, and A then played B in
match M2 > M1, B's post-M2 rating is also stale; anyone B played after M2
is stale too. We walk forward chronologically from the earliest affected
match, growing the affected-users set as we discover them.

Idempotent: reads current state and rewrites it deterministically, so a
retried call lands on the same result.

Concurrent safety: two workers recomputing the same league would interleave
DELETE/INSERT under READ COMMITTED and produce a corrupt final row.
``recompute_league_ratings`` acquires a per-league ``pg_advisory_xact_lock``
before touching any data; the lock is held for the life of the caller's
transaction and released on commit or rollback.  The caller must not commit
mid-loop across multiple leagues, or locks for earlier leagues are released
before later ones are acquired (see ``app.ratings.jobs``).
"""

import struct
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    League,
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
from app.ratings.base import state_rating_value
from app.ratings.registry import get_calculator
from app.ratings.validation import validate_state


def _league_lock_key(league_id: uuid.UUID) -> int:
    """Fold the 128-bit league UUID into a signed 64-bit advisory-lock key.

    XOR of the two 64-bit halves keeps the key stable and collision-free
    enough for advisory locking (a collision only causes harmless extra
    serialisation between two different leagues)."""
    hi, lo = struct.unpack(">qq", league_id.bytes)
    return int(hi) ^ int(lo)


def _decided_sides(match: Match) -> tuple[MatchSide, MatchSide] | None:
    """Return ``(winning_side, losing_side)`` for a decided binary result, or
    ``None`` when the match has no clear winner/loser — a forfeit/void/partial
    write leaves ``MatchSide.won`` as ``None``. Such a match never produced a
    rating delta, so the cascade skips it rather than crashing on the lookup."""
    winning_side = next((s for s in match.sides if s.won is True), None)
    losing_side = next((s for s in match.sides if s.won is False), None)
    if winning_side is None or losing_side is None:
        return None
    return winning_side, losing_side


async def recompute_league_ratings(
    db: AsyncSession,
    league_id: uuid.UUID,
    seed_user_ids: set[uuid.UUID],
) -> None:
    """Rebuild rating state for ``league_id`` starting from the earliest
    completed rated match involving any of ``seed_user_ids``.

    Walks forward in time, propagating staleness through shared matches:
    once a user's rating is recomputed, every later match they played becomes
    a recompute. Manual / non-automatic strategies are no-ops. No-op when
    the seed users have no rated completed matches in this league.

    Runs inside the caller's transaction — does not commit.
    """
    league = (
        await db.execute(
            select(League)
            .where(League.id == league_id)
            .options(selectinload(League.rating_strategy))
        )
    ).scalar_one_or_none()
    if league is None:
        return
    strategy = league.rating_strategy
    if not strategy.is_automatic:
        return
    calculator = get_calculator(strategy.key)
    if calculator is None:
        return

    # Serialise concurrent recomputes for this league. Two workers racing on
    # the same league would interleave DELETE/INSERT under READ COMMITTED and
    # corrupt the final rating row. The lock is transaction-scoped and released
    # automatically when the caller commits or rolls back.
    await db.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {"key": _league_lock_key(league_id)},
    )

    # updated_at is set when the match completes, which is the moment
    # ratings move — and what we order the replay by.
    t_start = (
        await db.execute(
            select(Match.updated_at)
            .join(MatchSidePlayer, MatchSidePlayer.match_id == Match.id)
            .join(MatchSettings, MatchSettings.id == Match.match_settings_id)
            .where(
                Match.league_id == league_id,
                Match.status == MatchStatus.completed,
                MatchSettings.affects_rating.is_(True),
                MatchSettings.team_size == 1,
                MatchSidePlayer.user_id.in_(seed_user_ids),
            )
            .order_by(Match.updated_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if t_start is None:
        return

    matches = (
        (
            await db.execute(
                select(Match)
                .join(MatchSettings, MatchSettings.id == Match.match_settings_id)
                .where(
                    Match.league_id == league_id,
                    Match.status == MatchStatus.completed,
                    Match.updated_at >= t_start,
                    MatchSettings.affects_rating.is_(True),
                    MatchSettings.team_size == 1,
                )
                .options(selectinload(Match.sides).selectinload(MatchSide.players))
                .order_by(Match.updated_at.asc(), Match.id.asc())
            )
        )
        .scalars()
        .all()
    )

    affected_users: set[uuid.UUID] = set(seed_user_ids)
    affected_matches: list[Match] = []
    for match in matches:
        decided = _decided_sides(match)
        if decided is None:
            continue
        winning_side, losing_side = decided
        participants = {
            winning_side.players[0].user_id,
            losing_side.players[0].user_id,
        }
        if affected_users & participants:
            affected_users |= participants
            affected_matches.append(match)

    if not affected_matches:
        return

    affected_match_ids = [m.id for m in affected_matches]
    await db.execute(
        delete(RatingHistory).where(
            RatingHistory.league_id == league_id,
            RatingHistory.match_id.in_(affected_match_ids),
        )
    )

    states_by_user = await _seed_states(
        db, league_id, affected_users, t_start, strategy
    )

    ratings = (
        (
            await db.execute(
                select(UserLeagueRating).where(
                    UserLeagueRating.league_id == league_id,
                    UserLeagueRating.user_id.in_(affected_users),
                )
            )
        )
        .scalars()
        .all()
    )
    rating_by_user = {r.user_id: r for r in ratings}

    for user_id in affected_users:
        state = states_by_user.get(user_id)
        if state is None:
            continue
        value = state_rating_value(state)
        ulr = rating_by_user.get(user_id)
        if ulr is None:
            ulr = UserLeagueRating(
                league_id=league_id,
                user_id=user_id,
                rating_state=state,
                rating_value=value,
            )
            db.add(ulr)
            rating_by_user[user_id] = ulr
        else:
            ulr.rating_state = state
            ulr.rating_value = value

    for match in affected_matches:
        decided = _decided_sides(match)
        if decided is None:
            continue
        winning_side, losing_side = decided
        winner_id = winning_side.players[0].user_id
        loser_id = losing_side.players[0].user_id
        if winner_id not in states_by_user or loser_id not in states_by_user:
            continue

        prev_winner_value = state_rating_value(states_by_user[winner_id])
        prev_loser_value = state_rating_value(states_by_user[loser_id])

        new_winner_state, new_loser_state = calculator.update_singles(
            states_by_user[winner_id], states_by_user[loser_id]
        )
        validate_state(new_winner_state, strategy)
        validate_state(new_loser_state, strategy)

        states_by_user[winner_id] = new_winner_state
        states_by_user[loser_id] = new_loser_state

        for user_id, new_state, prev_value in (
            (winner_id, new_winner_state, prev_winner_value),
            (loser_id, new_loser_state, prev_loser_value),
        ):
            new_value = state_rating_value(new_state)
            db.add(
                RatingHistory(
                    league_id=league_id,
                    user_id=user_id,
                    match_id=match.id,
                    rating_strategy_id=strategy.id,
                    rating_value=new_value,
                    rating_state=new_state,
                    previous_rating_value=prev_value,
                    source=RatingHistorySource.match,
                    created_at=match.updated_at,
                )
            )
            rating_by_user[user_id].rating_state = new_state
            rating_by_user[user_id].rating_value = new_value

    await db.flush()


async def _seed_states(
    db: AsyncSession,
    league_id: uuid.UUID,
    user_ids: set[uuid.UUID],
    t_start: datetime,
    strategy: RatingStrategy,
) -> dict[uuid.UUID, dict[str, Any]]:
    """Per-user rating state as of the moment just before ``t_start``: the
    user's most recent ``rating_history`` row in this league, or the
    strategy's initial state if they have none. Users with no history and no
    initial state (e.g. manual strategy with no seed) are omitted.

    A window function gets all users in one round trip — N affected users
    would otherwise be N queries."""
    row_number = func.row_number().over(
        partition_by=RatingHistory.user_id,
        order_by=RatingHistory.created_at.desc(),
    )
    subq = (
        select(
            RatingHistory.user_id,
            RatingHistory.rating_state,
            row_number.label("rn"),
        )
        .where(
            RatingHistory.league_id == league_id,
            RatingHistory.user_id.in_(user_ids),
            RatingHistory.created_at < t_start,
        )
        .subquery()
    )
    latest_per_user = await db.execute(
        select(subq.c.user_id, subq.c.rating_state).where(subq.c.rn == 1)
    )

    states: dict[uuid.UUID, dict[str, Any]] = {
        user_id: dict(state) for user_id, state in latest_per_user.all()
    }
    if strategy.initial_state is not None:
        for user_id in user_ids:
            states.setdefault(user_id, dict(strategy.initial_state))
    return states
