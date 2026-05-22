from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from app.models.rating_history import RatingHistory


class RatingChange(BaseModel):
    """A user's rating delta on a single completed match."""

    before: float | None
    after: float
    delta: float

    @classmethod
    def from_history(cls, row: RatingHistory) -> RatingChange:
        prev = row.previous_rating_value
        delta = row.rating_value - prev if prev is not None else 0.0
        return cls(before=prev, after=row.rating_value, delta=delta)
