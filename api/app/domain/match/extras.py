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


def rating_delta(before: float | None, after: float) -> float:
    """The rating movement a completed match produced. A player who had no
    rating in the league going in moved by nothing, not by their whole rating.

    The single home for that rule: ``schemas.rating.RatingChange.from_history``
    (the dashboard's path) and ``MatchDetailsRepository.rating_changes`` (the
    match-details path) both call it, so the two surfaces cannot drift into
    disagreeing about the same player's delta."""
    return after - before if before is not None else 0.0


@dataclass(frozen=True)
class RatingChange:
    """A player's rating delta on the match being viewed. ``before`` is ``None``
    for a player who had no rating in the league going in.

    ``delta`` is *derived*, never stored: it is by definition
    ``rating_delta(before, after)``, so a ``RatingChange`` that disagrees with its
    own endpoints cannot be constructed."""

    before: float | None
    after: float

    @property
    def delta(self) -> float:
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
