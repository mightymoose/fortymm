"""Rebuild current ratings from immutable inputs and official results.

Replay holds a league advisory lock; live completion serialization remains a
separate concern. Callers own the transaction, and independent leagues/components
are untouched.
"""

import struct
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    delete,
    func,
    select,
    text,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    League,
    Match,
    MatchSettings,
    MatchSide,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingInput,
    UserLeagueRating,
)
from app.ratings.inputs import active_inputs, canonical_player
from app.ratings.registry import calculator_for_version
from app.ratings.state import ManualState, RatingState, parse_rating_state
from app.ratings.validation import RatingStrategyMismatchError, validate_state


def _league_lock_key(league_id: uuid.UUID) -> int:
    """Fold the 128-bit league UUID into a signed 64-bit advisory-lock key.

    XOR of the two 64-bit halves keeps the key stable and collision-free
    enough for advisory locking (a collision only causes harmless extra
    serialisation between two different leagues)."""
    hi, lo = struct.unpack(">qq", league_id.bytes)
    return int(hi) ^ int(lo)


def _decided_sides(match: Match) -> tuple[MatchSide, MatchSide] | None:
    """Resolve participants from the durable current official score snapshot."""
    revision = match.current_official_result
    if revision is None:
        return None
    side_one_wins = sum(
        game["side_1_points"] > game["side_2_points"] for game in revision.games
    )
    winning_number = 1 if side_one_wins > len(revision.games) - side_one_wins else 2
    winning_side = next(
        (s for s in match.sides if s.side_number == winning_number), None
    )
    losing_side = next(
        (s for s in match.sides if s.side_number != winning_number), None
    )
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
    """Rebuild the connected sporting history from durable facts, without committing.

    Earlier opponents are dependencies too: their incoming uncertainty cannot be
    recovered from a projection that may have been deleted. Other components and
    leagues remain untouched. This lock coordinates replay workers only; live
    completion writers have a separately tracked concurrency defect.
    """
    league = await db.scalar(
        select(League)
        .where(League.id == league_id)
        .options(selectinload(League.rating_strategy))
    )
    if league is None or not seed_user_ids:
        return
    strategy = league.rating_strategy
    calculator = calculator_for_version(strategy)
    if strategy.is_automatic and calculator is None:
        raise ValueError(f"Unsupported rating strategy: {strategy.key}")
    await db.execute(
        text("SELECT pg_advisory_xact_lock(:key)"), {"key": _league_lock_key(league_id)}
    )
    matches = (
        list(
            (
                await db.scalars(
                    select(Match)
                    .join(MatchSettings)
                    .where(
                        Match.league_id == league_id,
                        Match.status == MatchStatus.completed,
                        MatchSettings.affects_rating.is_(True),
                        MatchSettings.team_size == 1,
                    )
                    .options(
                        selectinload(Match.sides).selectinload(MatchSide.players),
                        selectinload(Match.current_official_result),
                    )
                    .execution_options(populate_existing=True)
                    .order_by(Match.completed_at, Match.id)
                )
            ).all()
        )
        if strategy.is_automatic
        else []
    )
    affected = {await canonical_player(db, user_id) for user_id in seed_user_ids}
    neighbors: dict[uuid.UUID, set[uuid.UUID]] = {}
    for match in matches:
        sides = _decided_sides(match)
        if sides is not None:
            first, second = sides[0].players[0].user_id, sides[1].players[0].user_id
            neighbors.setdefault(first, set()).add(second)
            neighbors.setdefault(second, set()).add(first)
    pending = list(affected)
    while pending:
        player = pending.pop()
        newly_affected = neighbors.get(player, set()) - affected
        affected.update(newly_affected)
        pending.extend(newly_affected)
    matches = [
        match
        for match in matches
        if any(p.user_id in affected for side in match.sides for p in side.players)
    ]
    inputs = list(
        (
            await db.scalars(
                select(RatingInput)
                .where(
                    RatingInput.league_id == league_id,
                    func.entry_canonical_player(RatingInput.player_id).in_(affected),
                )
                .order_by(RatingInput.effective_at, RatingInput.sequence)
            )
        ).all()
    )
    input_players = {
        row.id: await canonical_player(db, row.player_id) for row in inputs
    }
    rows = list(
        (
            await db.scalars(
                select(UserLeagueRating).where(
                    UserLeagueRating.league_id == league_id,
                    UserLeagueRating.user_id.in_(affected),
                )
            )
        ).all()
    )
    ratings = {row.user_id: row for row in rows}
    for row in rows:
        if row.rating_strategy_id != strategy.id:
            raise RatingStrategyMismatchError(
                league_id=league_id,
                user_id=row.user_id,
                row_strategy_id=row.rating_strategy_id,
                league_strategy_id=strategy.id,
            )
    for user_id in affected:
        if user_id not in ratings:
            row = UserLeagueRating.seed_for_strategy(league_id, user_id, strategy)
            db.add(row)
            ratings[user_id] = row

    def decode_state(raw: dict[str, Any]) -> RatingState:
        validate_state(raw, strategy)
        decoded = parse_rating_state(strategy.key, raw)
        if decoded is None:
            raise ValueError("Unsupported rating state")
        return decoded

    initial = decode_state(strategy.initial_state) if strategy.initial_state else None
    states: dict[uuid.UUID, RatingState | None] = {
        user_id: initial for user_id in affected
    }
    await db.execute(
        delete(RatingHistory).where(
            RatingHistory.league_id == league_id,
            RatingHistory.user_id.in_(affected),
            RatingHistory.source != RatingHistorySource.initial,
        )
    )

    revisions = {match.id: match.current_official_result_id for match in matches}

    def project(
        user_id: uuid.UUID,
        state: RatingState,
        previous: float | None,
        at: datetime,
        match_id: uuid.UUID | None,
        source: RatingHistorySource,
        adjustment: RatingInput | None = None,
    ) -> None:
        states[user_id] = state
        db.add(
            RatingHistory(
                league_id=league_id,
                user_id=user_id,
                match_id=match_id,
                rating_strategy_id=strategy.id,
                official_result_id=revisions.get(match_id) if match_id else None,
                rating_value=state.rating,
                rating_state=state.model_dump(),
                previous_rating_value=previous,
                source=source,
                rating_input_id=adjustment.id if adjustment else None,
                created_at=at,
                note=adjustment.note if adjustment else None,
                created_by_user_id=adjustment.actor_account_id if adjustment else None,
            )
        )

    events: list[tuple[datetime, int, int, Match | RatingInput]] = [
        (row.effective_at, 0, sequence, row) for sequence, row in active_inputs(inputs)
    ]
    for match in matches:
        if match.completed_at is None:
            raise ValueError("Completed match has no completion time")
        events.append((match.completed_at, 1, match.id.int, match))
    for at, _, _, event in sorted(events, key=lambda item: item[:3]):
        if isinstance(event, RatingInput):
            if event.rating_strategy_id != strategy.id:
                raise ValueError("Rating input belongs to another strategy")
            player_id = input_players[event.id]
            old = states[player_id]
            state = (
                old.model_copy(update={"rating": event.rating})
                if old
                else ManualState(rating=event.rating)
            )
            validate_state(state.model_dump(), strategy)
            project(
                player_id,
                state,
                old.rating if old else None,
                at,
                None,
                RatingHistorySource(event.source),
                event,
            )
            continue
        sides = _decided_sides(event)
        if sides is None or calculator is None:
            continue
        winner, loser = sides[0].players[0].user_id, sides[1].players[0].user_id
        before_winner, before_loser = states[winner], states[loser]
        if before_winner is None or before_loser is None:
            continue
        after_winner, after_loser = calculator.update_singles(
            before_winner.model_dump(), before_loser.model_dump()
        )
        for user_id, before, after in (
            (winner, before_winner, after_winner),
            (loser, before_loser, after_loser),
        ):
            project(
                user_id,
                decode_state(after),
                before.rating,
                at,
                event.id,
                RatingHistorySource.match,
            )
    for user_id, final_state in states.items():
        ratings[user_id].rating_state = (
            final_state.model_dump() if final_state else None
        )
        ratings[user_id].rating_value = final_state.rating if final_state else None
    await db.flush()
