"""Record rating-only facts and rebuild their current projection atomically."""

import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, RatingInput
from app.models.rating_input import RatingInputSource


async def rating_inputs(
    db: AsyncSession, league_id: uuid.UUID, player_id: uuid.UUID
) -> list[RatingInput]:
    """Retained originals and replacements, ordered by effective time then recording.

    Replay separately restores a replacement to its root input's timeline slot.
    """
    return list(
        (
            await db.scalars(
                select(RatingInput)
                .where(
                    RatingInput.league_id == league_id,
                    func.entry_canonical_player(RatingInput.player_id)
                    == func.entry_canonical_player(player_id),
                )
                .order_by(RatingInput.effective_at, RatingInput.sequence)
            )
        ).all()
    )


async def record_rating_input(
    db: AsyncSession,
    league_id: uuid.UUID,
    player_id: uuid.UUID,
    *,
    actor_account_id: uuid.UUID,
    rating: float,
    source: RatingInputSource,
    effective_at: datetime,
    note: str | None = None,
) -> RatingInput:
    from app.ratings.recompute import recompute_league_ratings

    async with db.begin_nested():
        league = await db.get(League, league_id)
        if league is None:
            raise ValueError("League does not exist")
        row = RatingInput(
            league_id=league_id,
            player_id=player_id,
            actor_account_id=actor_account_id,
            rating=rating,
            source=source,
            effective_at=effective_at,
            note=note,
            rating_strategy_id=league.rating_strategy_id,
        )
        db.add(row)
        await db.flush()
        await recompute_league_ratings(db, league_id, {player_id})
        return row


async def replace_rating_input(
    db: AsyncSession,
    input_id: uuid.UUID,
    *,
    actor_account_id: uuid.UUID,
    rating: float,
    note: str,
) -> RatingInput:
    from app.ratings.recompute import recompute_league_ratings

    async with db.begin_nested():
        original = await db.get(RatingInput, input_id)
        if original is None:
            raise ValueError("Rating input does not exist")
        replacement = RatingInput(
            league_id=original.league_id,
            player_id=original.player_id,
            actor_account_id=actor_account_id,
            rating=rating,
            source=original.source,
            effective_at=original.effective_at,
            note=note,
            rating_strategy_id=original.rating_strategy_id,
            supersedes_id=original.id,
        )
        db.add(replacement)
        await db.flush()
        await recompute_league_ratings(db, original.league_id, {original.player_id})
        return replacement


def active_inputs(rows: list[RatingInput]) -> list[tuple[int, RatingInput]]:
    """A replacement occupies its original fact's stable timeline slot."""
    by_id = {row.id: row for row in rows}
    superseded = {row.supersedes_id for row in rows if row.supersedes_id}
    active = []
    for row in rows:
        if row.id in superseded:
            continue
        root = row
        while root.supersedes_id is not None:
            root = by_id[root.supersedes_id]
        active.append((root.sequence, row))
    return active


async def canonical_player(db: AsyncSession, player_id: uuid.UUID) -> uuid.UUID:
    value: uuid.UUID = (
        await db.execute(select(func.entry_canonical_player(player_id)))
    ).scalar_one()
    return value
