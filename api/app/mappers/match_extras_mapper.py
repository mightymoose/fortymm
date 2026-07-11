"""Serializes the domain match-details extras (``app.domain.match.extras``) into
the *existing* ``MatchDetails`` response schemas — the ``recent_form`` and
``head_to_head`` blocks and the per-side ``RatingChange``.

This is the only place that knows both the domain shapes and the wire shapes;
the repository yields the former and the router consumes the latter, so neither
has to know the other exists. (Distinct from ``match_details_mapper``, which
builds the in-progress ``schemas.view`` replacement under the ``data`` key.)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.domain.match.extras import HeadToHead as HeadToHeadModel
from app.domain.match.extras import MatchViewExtras
from app.domain.match.extras import PlayerForm as PlayerFormModel
from app.domain.match.extras import RatingChange as RatingChangeModel
from app.schemas.match import (
    MatchDetailsFormResult,
    MatchDetailsH2H,
    MatchDetailsH2HMeeting,
    MatchDetailsPlayerForm,
)
from app.schemas.rating import RatingChange


@dataclass(frozen=True)
class MatchDetailsExtras:
    """The serialized extras, ready to drop onto ``MatchDetails``."""

    rating_changes: dict[uuid.UUID, RatingChange]
    recent_form: list[MatchDetailsPlayerForm]
    head_to_head: MatchDetailsH2H | None


def _rating_change(change: RatingChangeModel) -> RatingChange:
    return RatingChange(before=change.before, after=change.after, delta=change.delta)


def _player_form(form: PlayerFormModel) -> MatchDetailsPlayerForm:
    return MatchDetailsPlayerForm(
        user_id=form.user_id,
        recent_results=[
            MatchDetailsFormResult(
                match_id=result.match_id,
                is_win=result.is_win,
                player_games_won=result.player_games_won,
                opponent_games_won=result.opponent_games_won,
                opponent_username=result.opponent_username,
                completed_at=result.completed_at,
            )
            for result in form.recent_results
        ],
        rating_before=form.rating_before.value,
        rating_history=form.rating_before.history,
        career_matches_before=form.career_before.matches,
        career_wins_before=form.career_before.wins,
    )


def _head_to_head(h2h: HeadToHeadModel) -> MatchDetailsH2H:
    return MatchDetailsH2H(
        total_meetings=h2h.total_meetings,
        side_1_wins=h2h.side_1_wins,
        side_2_wins=h2h.side_2_wins,
        recent_meetings=[
            MatchDetailsH2HMeeting(
                match_id=meeting.match_id,
                completed_at=meeting.completed_at,
                side_1_games_won=meeting.side_1_games_won,
                side_2_games_won=meeting.side_2_games_won,
                winner_side_number=meeting.winner_side_number,
                rated=meeting.rated,
            )
            for meeting in h2h.recent_meetings
        ],
    )


def serialize_match_extras(extras: MatchViewExtras) -> MatchDetailsExtras:
    return MatchDetailsExtras(
        rating_changes={
            user_id: _rating_change(change)
            for user_id, change in extras.rating_changes.items()
        },
        recent_form=[_player_form(form) for form in extras.recent_form],
        head_to_head=(
            _head_to_head(extras.head_to_head)
            if extras.head_to_head is not None
            else None
        ),
    )


# The extras a non-participant sees: none of them (#515).
EMPTY_EXTRAS = serialize_match_extras(MatchViewExtras.empty())
