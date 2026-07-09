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

from sqlalchemy import DateTime, column, delete, func, select, text, values
from sqlalchemy.dialects.postgresql import UUID
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
    rating delta, so the cascade skips it rather than crashing on the lookup.

    Also returns ``None`` when a decided side has no players — the solo-match
    sentinel side, or a forfeit that stamped ``won`` on a player-less side. The
    live rating path guards this explicitly (``app/matches.py``) and writes no
    ``RatingHistory``, so the callers' ``players[0]`` lookups below would
    otherwise ``IndexError`` on a match that never contributed a delta."""
    winning_side = next((s for s in match.sides if s.won is True), None)
    losing_side = next((s for s in match.sides if s.won is False), None)
    if winning_side is None or losing_side is None:
        return None
    if not winning_side.players or not losing_side.players:
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
    a recompute. Manual / non-automatic strategies are no-ops.

    When the seed users have no completed rated match in this league their
    timeline is *empty*, and an empty timeline resolves to the strategy's
    initial state: each seed user's ``UserLeagueRating`` is reset to that
    baseline and their stale match-sourced ``rating_history`` rows are dropped
    (see ``_reset_users_to_initial_state``). This is what makes the module's
    "rewrites state deterministically" invariant hold for the empty input too.

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

    # completed_at is stamped once when the match completes and kept stable
    # thereafter — the moment ratings move, and the axis the rest of the
    # codebase (history/form/H2H) anchors on. We order the replay by it, not by
    # the mutable updated_at, so editing an old completed match can't silently
    # reorder the timeline. Every query here filters status == completed, so
    # completed_at is non-null in practice (see the narrowing asserts below).
    t_start = (
        await db.execute(
            select(Match.completed_at)
            .join(MatchSidePlayer, MatchSidePlayer.match_id == Match.id)
            .join(MatchSettings, MatchSettings.id == Match.match_settings_id)
            .where(
                Match.league_id == league_id,
                Match.status == MatchStatus.completed,
                MatchSettings.affects_rating.is_(True),
                MatchSettings.team_size == 1,
                MatchSidePlayer.user_id.in_(seed_user_ids),
            )
            .order_by(Match.completed_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if t_start is None:
        # No completed rated singles match remains for the seed users in this
        # league (e.g. their only rated match was just voided). Their rating
        # timeline is *empty*, so their state is the strategy's initial state —
        # not the stale value a since-voided match left on the row. The
        # recompute owns this: returning here (the old behaviour) stranded the
        # inflated rating, falsifying the module's "rewrites state
        # deterministically" claim for the one input — the empty timeline —
        # that could break it.
        await _reset_users_to_initial_state(db, league_id, seed_user_ids, strategy)
        return

    matches = (
        (
            await db.execute(
                select(Match)
                .join(MatchSettings, MatchSettings.id == Match.match_settings_id)
                .where(
                    Match.league_id == league_id,
                    Match.status == MatchStatus.completed,
                    Match.completed_at >= t_start,
                    MatchSettings.affects_rating.is_(True),
                    MatchSettings.team_size == 1,
                )
                .options(selectinload(Match.sides).selectinload(MatchSide.players))
                .order_by(Match.completed_at.asc(), Match.id.asc())
            )
        )
        .scalars()
        .all()
    )

    affected_users: set[uuid.UUID] = set(seed_user_ids)
    affected_matches: list[Match] = []
    # The completion instant of the FIRST affected match each user joins the
    # cascade through. Matches are walked in ``completed_at`` order, so the
    # first ``setdefault`` for a user records their earliest affected match —
    # the per-user cutoff we seed them from (#749). A user who joins late (via
    # a later match against an already-affected user) must be seeded from the
    # state as of *their own* first affected match, not the global ``t_start``,
    # or a non-affected match they played in between is neither replayed nor
    # reflected in their seed.
    cutoffs: dict[uuid.UUID, datetime] = {}
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
            # Loaded under status == completed, so completed_at is non-null.
            assert match.completed_at is not None
            for user_id in participants:
                cutoffs.setdefault(user_id, match.completed_at)

    if not affected_matches:
        return

    affected_match_ids = [m.id for m in affected_matches]
    await db.execute(
        delete(RatingHistory).where(
            RatingHistory.league_id == league_id,
            RatingHistory.match_id.in_(affected_match_ids),
        )
    )

    states_by_user = await _seed_states(db, league_id, cutoffs, strategy)

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

        # Every match here was loaded under status == completed, so completed_at
        # is non-null — narrow it for the created_at stamp below. It is the
        # stable axis the live path already writes (its func.now() default lands
        # in the same transaction as mark_completed()).
        assert match.completed_at is not None

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
                    created_at=match.completed_at,
                )
            )
            rating_by_user[user_id].rating_state = new_state
            rating_by_user[user_id].rating_value = new_value

    await db.flush()


async def _reset_users_to_initial_state(
    db: AsyncSession,
    league_id: uuid.UUID,
    user_ids: set[uuid.UUID],
    strategy: RatingStrategy,
) -> None:
    """Reset each of ``user_ids`` in ``league_id`` to ``strategy``'s initial
    state — the resolution of an *empty* rating timeline.

    Deletes their match-sourced ``rating_history`` rows. A match row is only
    ever written for a completed, rated, ``team_size == 1`` match, and an empty
    timeline (the ``t_start is None`` caller) means no such match exists for
    these users here — so every surviving match row is necessarily stale (e.g.
    a since-voided match). The voiding path already deletes a voided match's
    rows, so in the canonical flow this is a no-op; it stands as the
    deterministic backstop that makes "empty timeline ⟹ zero match-sourced
    rows" true regardless of what upstream did.

    The non-match rows — ``initial`` (written by ``seed_user_league_rating``
    when the user joined), ``manual``, ``import`` — are the empty timeline
    itself and stay untouched; no new event is appended. The
    ``UserLeagueRating`` row is reset in place, never deleted: every member
    keeps exactly one from seeding.

    Runs inside the caller's transaction — does not commit.
    """
    if not user_ids:
        return

    await db.execute(
        delete(RatingHistory).where(
            RatingHistory.league_id == league_id,
            RatingHistory.user_id.in_(user_ids),
            RatingHistory.source == RatingHistorySource.match,
        )
    )

    ratings = (
        (
            await db.execute(
                select(UserLeagueRating).where(
                    UserLeagueRating.league_id == league_id,
                    UserLeagueRating.user_id.in_(user_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    initial_state = strategy.initial_state
    for ulr in ratings:
        ulr.rating_state = dict(initial_state) if initial_state is not None else None
        ulr.rating_value = strategy.initial_rating_value

    await db.flush()


async def _seed_states(
    db: AsyncSession,
    league_id: uuid.UUID,
    cutoffs: dict[uuid.UUID, datetime],
    strategy: RatingStrategy,
) -> dict[uuid.UUID, dict[str, Any]]:
    """Per-user rating state as of the moment just before that user's own
    cutoff: their most recent ``rating_history`` row in this league strictly
    before ``cutoffs[user_id]``, or the strategy's initial state if they have
    none. Users with no history and no initial state (e.g. manual strategy with
    no seed) are omitted.

    Each affected user seeds from the state as of *their own* first affected
    match, not one global cutoff (#749). Reading a non-affected match's stored
    row as the seed is sound: both its participants were at unchanged incoming
    ratings, so the row is already bit-for-bit what a replay would produce.

    Manual / import / initial rows carry no ``match_id`` and keep their
    wall-clock ``created_at``, which shares an axis with the (immutable,
    wall-clock) ``completed_at`` the cutoffs are drawn from — so they stay
    selectable as seeds.

    A per-user VALUES join keeps this to one round trip — N affected users
    would otherwise be N queries."""
    if not cutoffs:
        return {}
    cutoff_values = values(
        column("user_id", UUID(as_uuid=True)),
        column("cutoff", DateTime(timezone=True)),
        name="cutoffs",
    ).data(list(cutoffs.items()))
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
        .join(
            cutoff_values,
            cutoff_values.c.user_id == RatingHistory.user_id,
        )
        .where(
            RatingHistory.league_id == league_id,
            RatingHistory.created_at < cutoff_values.c.cutoff,
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
        for user_id in cutoffs:
            states.setdefault(user_id, dict(strategy.initial_state))
    return states
