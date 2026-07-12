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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType

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
    """The serialized extras, ready to drop onto ``MatchDetails``.

    Deeply immutable, on purpose. ``frozen=True`` only stops attributes being
    *rebound* — it would happily hand every caller the same mutable ``dict`` /
    ``list``. So the collections are read-only too: ``Mapping`` / ``Sequence``
    make ``extras.rating_changes[uid] = ...`` and ``extras.recent_form.append(...)``
    a type error, and the ``MappingProxyType`` / ``tuple`` behind them make such a
    write a ``TypeError`` at runtime rather than a silent shared-state mutation.
    See ``empty_extras`` for why that matters."""

    rating_changes: Mapping[uuid.UUID, RatingChange]
    recent_form: Sequence[MatchDetailsPlayerForm]
    head_to_head: MatchDetailsH2H | None


def _rating_change(change: RatingChangeModel) -> RatingChange:
    # ``delta`` is not passed: on the wire model it is a ``@computed_field`` over
    # ``before``/``after`` (as it is a ``@property`` on the domain model), and both
    # derive it from ``app.domain.rating.rating_delta``. Copying it across would be
    # copying a value the target recomputes anyway — and would be the one way the
    # two could disagree.
    return RatingChange(before=change.before, after=change.after)


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
        rating_changes=MappingProxyType(
            {
                user_id: _rating_change(change)
                for user_id, change in extras.rating_changes.items()
            }
        ),
        recent_form=tuple(_player_form(form) for form in extras.recent_form),
        head_to_head=(
            _head_to_head(extras.head_to_head)
            if extras.head_to_head is not None
            else None
        ),
    )


def empty_extras() -> MatchDetailsExtras:
    """The extras a non-participant sees: none of them (#515).

    A *function*, not a module-level ``EMPTY_EXTRAS`` constant — do not "optimize"
    it back into one. A shared instance is a shared object: every spectator and
    anonymous share-URL viewer would be handed the same collections, so a single
    stray write anywhere (``extras.rating_changes[uid] = ...``) would poison the
    process and leak one real player's ratings/form into every later response.
    A fresh instance per call means there is nothing shared to poison — and the
    read-only collections on ``MatchDetailsExtras`` mean a future field added here
    can't quietly re-arm the trap."""
    return serialize_match_extras(MatchViewExtras.empty())
