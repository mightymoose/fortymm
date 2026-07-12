"""Domain models for the match-details *view extras* — the rating changes,
per-player recent form, and head-to-head block that hang off a match a
participant is looking at.

Like ``app.domain.match.models`` these are in-process, storage-agnostic shapes:
no SQLAlchemy, no Pydantic. ``app.repositories.match_details_repository`` builds
them from persisted rows and ``app.mappers.match_extras_mapper`` turns them into
the response schemas, so the router never sees either end.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from app.domain.rating import rating_delta


@dataclass(frozen=True)
class RatingChange:
    """A player's rating delta on the match being viewed. ``before`` is ``None``
    for a player who had no rating in the league going in — resolved by
    ``app.ratings.rated.reported_rating_before``, since the raw stored
    ``previous_rating_value`` for a first rated match is the 1500 the league seeded
    them with, not a rating they held.

    ``delta`` is *derived*, never stored: it is by definition
    ``app.domain.rating.rating_delta(before, after)``, so a ``RatingChange`` that
    disagrees with its own endpoints cannot be constructed. It is ``None`` — not
    ``0.0`` — for that first rated match: the match ESTABLISHED the rating rather
    than moving it, and a zero would render as "+0" (#952)."""

    before: float | None
    after: float

    @property
    def delta(self) -> float | None:
        return rating_delta(self.before, self.after)


@dataclass(frozen=True)
class FormResult:
    """One past completed match, framed from the cited *player's* perspective
    (not from a side number in that past match)."""

    match_id: uuid.UUID
    is_win: bool
    player_games_won: int
    opponent_games_won: int
    opponent_username: str | None
    completed_at: datetime


@dataclass(frozen=True)
class PreMatchRating:
    """A player's rating in this match's league as it stood *before* this match:
    the chronological (oldest-first) trail of every value they carried into it.

    ``value`` — the rating they actually took into the match — is *derived*, never
    stored: it is the last entry of the trail, and ``None`` exactly when the trail
    is empty (a player with no prior rating in the league). Storing both would let
    a value drift from the history it is supposed to end."""

    history: list[float]

    @property
    def value(self) -> float | None:
        return self.history[-1] if self.history else None


@dataclass(frozen=True)
class CareerRecord:
    """A player's cross-league completed-match totals as of some instant."""

    matches: int
    wins: int


@dataclass(frozen=True)
class PlayerForm:
    """One player's form going into this match, keyed by ``user_id`` so the
    mapper (and the FE) can attach it to whichever side carries that user."""

    user_id: uuid.UUID
    recent_results: list[FormResult]
    rating_before: PreMatchRating
    career_before: CareerRecord


@dataclass(frozen=True)
class HeadToHeadMeeting:
    """One past meeting between the two players in the match being viewed. Game
    counts are aligned to *this* match's side numbers, not the side numbers of
    the historical match."""

    match_id: uuid.UUID
    completed_at: datetime
    side_1_games_won: int
    side_2_games_won: int
    winner_side_number: int | None
    rated: bool


@dataclass(frozen=True)
class HeadToHead:
    """The rivalry going into this match: totals over every prior meeting, plus
    the most recent few of them."""

    total_meetings: int
    side_1_wins: int
    side_2_wins: int
    recent_meetings: list[HeadToHeadMeeting]


@dataclass(frozen=True)
class MatchViewExtras:
    """The whole participant-only extras block. Non-participants (anonymous
    holders of the share URL, signed-in spectators) get ``empty()`` — see #515."""

    rating_changes: dict[uuid.UUID, RatingChange]
    recent_form: list[PlayerForm]
    head_to_head: HeadToHead | None

    @classmethod
    def empty(cls) -> MatchViewExtras:
        return cls(rating_changes={}, recent_form=[], head_to_head=None)
