"""Domain rules about *ratings*, independent of any one surface that shows them.

Storage-agnostic and framework-agnostic: no SQLAlchemy, no Pydantic, no FastAPI.
Both the rating wire schema (``app.schemas.rating``) and the match-details extras
domain (``app.domain.match.extras``) import from here, so neither has to reach
into the other.
"""

from __future__ import annotations


def rating_delta(before: float | None, after: float) -> float:
    """The rating movement a completed match produced. A player who had no
    rating in the league going in moved by nothing, not by their whole rating.

    The single home for that rule: ``schemas.rating.RatingChange.from_history``
    (the dashboard's path) and ``domain.match.extras.RatingChange.delta`` — via
    ``MatchDetailsRepository.rating_changes`` (the match-details path) — both call
    it, so the two surfaces cannot drift into disagreeing about the same player's
    delta. Never inline ``after - before`` at a call site; that is how they drift."""
    return after - before if before is not None else 0.0
