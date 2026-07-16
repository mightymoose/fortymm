"""Message templates for the "Match calls" notification category (ADR
2026-07-16 — the schedule is solved; the call is pinned).

Three message kinds share the single ``match_calls`` prefs category: a *call*
("you're up soon" — the fixture was pinned and both players are told), a
*moved* correction (the pin was broken by physics — its table was removed or
an input changed under it — and re-placed), and a *cancelled* correction (the
pin was voided, e.g. the opponent withdrew). The kinds are copy variants, not
separate prefs rows — a ``notification_types`` row *is* a prefs category in
this schema, and the ADR treats called/moved/cancelled as one prefs unit.

Copy is built here by typed builders (mirroring ``_result_confirmation_copy``
in ``app.matches``, but importable — the pin service that sends these lands in
a later chore) so no caller ever assembles ad-hoc strings. Builders take
domain values — table label, estimated start, opponent, tournament context —
and return a ``MatchCallMessage`` ready to map onto a ``NotificationJob``
title/body per recipient.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import assert_never

from app.notifications.taxonomy import NotificationCategory

# The prefs category every match-call message is delivered under.
MATCH_CALLS_CATEGORY = NotificationCategory.MATCH_CALLS

# Separator matching the existing cross-context copy style (e.g. the em-dash /
# middle-dot conventions in matches.py notification copy).
_CONTEXT_SEP = " · "


class MatchCallKind(StrEnum):
    """The closed set of match-call message kinds within the ``match_calls``
    category — usable later as push collapse-id / APNs-category suffixes."""

    MATCH_CALLED = "match_called"
    MATCH_CALL_MOVED = "match_call_moved"
    MATCH_CALL_CANCELLED = "match_call_cancelled"


class MatchCallCancellationReason(StrEnum):
    """Why a called match was cancelled — a closed set so the copy for each
    case is exhaustively handled (no catch-all)."""

    OPPONENT_WITHDREW = "opponent_withdrew"
    SCHEDULE_CHANGE = "schedule_change"


@dataclass(frozen=True)
class MatchCallContext:
    """Where the fixture lives, in the player's terms: tournament and event
    always exist for a scheduled fixture; the pool name is present only for
    pooled draws (``TournamentFixture.pool_id`` may be NULL)."""

    tournament_name: str
    event_name: str
    pool_name: str | None = None

    @property
    def label(self) -> str:
        parts = [self.tournament_name, self.event_name]
        if self.pool_name is not None:
            parts.append(self.pool_name)
        return _CONTEXT_SEP.join(parts)


@dataclass(frozen=True)
class MatchCallMessage:
    """A rendered match-call notification: the kind plus the title/body pair
    that feeds ``NotificationJob`` (and the in-app ``Notification`` row)."""

    kind: MatchCallKind
    title: str
    body: str


def _time_label(estimated_start: datetime) -> str:
    """``"14:35"`` for the player-facing "around <time>" phrasing. Callers pass
    the estimate already in the tournament's local time — templates format,
    they don't convert."""
    return estimated_start.strftime("%H:%M")


def match_called_message(
    *,
    table_label: str,
    estimated_start: datetime,
    opponent_name: str,
    context: MatchCallContext,
) -> MatchCallMessage:
    """The call: the fixture's projected start entered the call-ahead window
    (or a table freed with no warning) and it was pinned — a promise, not an
    estimate, so the copy says where and roughly when to show up."""
    return MatchCallMessage(
        kind=MatchCallKind.MATCH_CALLED,
        title=f"You're up soon — {table_label}",
        body=(
            f"Your {context.label} match against {opponent_name} starts around "
            f"{_time_label(estimated_start)} on {table_label}. Head to the table."
        ),
    )


def match_call_moved_message(
    *,
    new_table_label: str,
    new_estimated_start: datetime,
    opponent_name: str,
    context: MatchCallContext,
) -> MatchCallMessage:
    """The moved correction: a pin we already announced was broken by physics
    and re-placed, so the player gets the new table and new time."""
    return MatchCallMessage(
        kind=MatchCallKind.MATCH_CALL_MOVED,
        title=f"Your match moved to {new_table_label}",
        body=(
            f"Your {context.label} match against {opponent_name} now starts "
            f"around {_time_label(new_estimated_start)} on {new_table_label}."
        ),
    )


def match_call_cancelled_message(
    *,
    reason: MatchCallCancellationReason,
    opponent_name: str,
    context: MatchCallContext,
) -> MatchCallMessage:
    """The cancelled correction: a pin we already announced was voided —
    the reason phrasing is exhaustively matched, per the enum-mapping rule."""
    return MatchCallMessage(
        kind=MatchCallKind.MATCH_CALL_CANCELLED,
        title="Your match was cancelled",
        body=(
            f"Your {context.label} match against {opponent_name} was "
            f"cancelled — {_cancellation_phrase(reason)}."
        ),
    )


def _cancellation_phrase(reason: MatchCallCancellationReason) -> str:
    # Exhaustive match (no catch-all): adding a reason becomes a mypy error at
    # the assert_never, per api/CLAUDE.md's enum-mapping rule.
    match reason:
        case MatchCallCancellationReason.OPPONENT_WITHDREW:
            return "your opponent withdrew"
        case MatchCallCancellationReason.SCHEDULE_CHANGE:
            return "the schedule changed"
    assert_never(reason)
