"""Domain rules about *ratings*, independent of any one surface that shows them.

Storage-agnostic and framework-agnostic: no SQLAlchemy, no Pydantic, no FastAPI.
Both the rating wire schema (``app.schemas.rating``) and the match-details extras
domain (``app.domain.match.extras``) import from here, so neither has to reach
into the other.
"""

from __future__ import annotations


def rating_delta(before: float | None, after: float) -> float | None:
    """The rating movement a completed match produced — or ``None`` when there was
    no movement to report, because the match ESTABLISHED the rating rather than
    moving it.

    A player who was already rated MOVED: ``1338 → 1503``, delta ``+165``. A player
    whose FIRST rated match this is had no rating going in (``before is None``:
    CONTEXT.md, "a player who has never finished a rated match has no rating"), and
    they did not move by nothing — a rating came into existence. There is no
    distance to report between "Unrated" and 1268, so there is no delta.

    ``None``, never ``0.0``. A zero is not a harmless stand-in for the missing
    number: it renders as **"+0"**, which claims a rated match moved the player's
    rating by nothing — the phantom of #952, one widget away from the same page
    correctly calling them Unrated.

    The single home for that rule: ``schemas.rating.RatingChange.delta``
    (the dashboard's path) and ``domain.match.extras.RatingChange.delta`` — via
    ``MatchDetailsRepository.rating_changes`` (the match-details path) — both call
    it, so the two surfaces cannot drift into disagreeing about the same player's
    delta. Never inline ``after - before`` at a call site; that is how they drift.

    ``before`` is the rating the player is REPORTED as having held going in, which
    is not the raw ``rating_history.previous_rating_value`` the Glicko-2 update
    started from — see ``app.ratings.rated.reported_rating_before``, the one reader
    of that column, which resolves the seeded 1500 prior to ``None``."""
    return after - before if before is not None else None
