"""Rebuild ``rating_history`` and ``user_league_ratings`` after data changes
upstream of the rating timeline (e.g. an ephemeral→verified account merge
moved matches onto a user). Operates one league at a time.

The cascade: if user A's rating changes for match M1, and A then played B in
match M2 > M1, B's post-M2 rating is also stale; anyone B played after M2
is stale too. We walk forward chronologically from the earliest affected
match, growing the affected-users set as we discover them.
"""

import uuid

from sqlalchemy import delete, select
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
    UserLeagueRating,
)
from app.ratings.base import state_rating_value
from app.ratings.registry import get_calculator
from app.ratings.validation import validate_state


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

    # Earliest match (by updated_at) involving a seed user. updated_at is set
    # when the match completes, which is the moment ratings move.
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
                .options(
                    selectinload(Match.sides).selectinload(MatchSide.players)
                )
                .order_by(Match.updated_at.asc(), Match.id.asc())
            )
        )
        .scalars()
        .all()
    )

    affected_users: set[uuid.UUID] = set(seed_user_ids)
    affected_matches: list[Match] = []
    for match in matches:
        winning_side = next((s for s in match.sides if s.won is True), None)
        losing_side = next((s for s in match.sides if s.won is False), None)
        if (
            winning_side is None
            or losing_side is None
            or not winning_side.players
            or not losing_side.players
        ):
            # Defensive: completed matches always have a winner + loser side,
            # but skipping a malformed row beats raising mid-cascade.
            continue
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

    states_by_user: dict[uuid.UUID, dict] = {}
    for user_id in affected_users:
        last_pre = (
            await db.execute(
                select(RatingHistory)
                .where(
                    RatingHistory.league_id == league_id,
                    RatingHistory.user_id == user_id,
                    RatingHistory.created_at < t_start,
                )
                .order_by(RatingHistory.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if last_pre is not None:
            states_by_user[user_id] = dict(last_pre.rating_state)
        elif strategy.initial_state is not None:
            states_by_user[user_id] = dict(strategy.initial_state)
        # else: no seed state — skip below.

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
        winning_side = next(s for s in match.sides if s.won is True)
        losing_side = next(s for s in match.sides if s.won is False)
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

        new_winner_value = state_rating_value(new_winner_state)
        new_loser_value = state_rating_value(new_loser_state)

        # Stamp the rewritten history rows with the match's completion time
        # so the chronological ordering used by ``_load_pre_match_rating`` and
        # the dashboard sparkline survives the rebuild.
        db.add(
            RatingHistory(
                league_id=league_id,
                user_id=winner_id,
                match_id=match.id,
                rating_strategy_id=strategy.id,
                rating_value=new_winner_value,
                rating_state=new_winner_state,
                previous_rating_value=prev_winner_value,
                source=RatingHistorySource.match,
                created_at=match.updated_at,
            )
        )
        db.add(
            RatingHistory(
                league_id=league_id,
                user_id=loser_id,
                match_id=match.id,
                rating_strategy_id=strategy.id,
                rating_value=new_loser_value,
                rating_state=new_loser_state,
                previous_rating_value=prev_loser_value,
                source=RatingHistorySource.match,
                created_at=match.updated_at,
            )
        )

        rating_by_user[winner_id].rating_state = new_winner_state
        rating_by_user[winner_id].rating_value = new_winner_value
        rating_by_user[loser_id].rating_state = new_loser_state
        rating_by_user[loser_id].rating_value = new_loser_value

    await db.flush()
