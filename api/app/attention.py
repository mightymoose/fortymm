"""Current-user-aware attention classification.

A single source of truth, shared by the dashboard's "Needs your attention"
panel (``app.dashboard``) and the matches list's Attention filter
(``app.matches``), for two questions about one of the current user's *open*
matches:

- which actionable bucket does it fall in for this user, and
- how urgent is that bucket relative to the others.

The classification is current-user-aware: the poster and the reviewer of the
same posted result land in different buckets (the poster has signed, so for
them the match is *waiting on the opponent*; the reviewer hasn't, so they get a
``review``). Keeping this here — rather than re-deriving it in each router —
means the list and the dashboard can never disagree about who owes a move.
"""

import uuid
from typing import Literal

from app.models import Match, MatchStatus, ResultOutcome

# The bucket an open match falls in for the current user. A superset of the
# dashboard's narrower ``AttentionKind``: the list also surfaces the passive
# "waiting" rows the dashboard folds into a count, so a user can see *why* a
# match is parked, not just that it needs someone else.
#
#   dispute          — a disputed match, reopened for correction (either side
#                      may re-score and re-post).
#   review           — the opponent posted a result; the current user must
#                      confirm or dispute it.
#   score            — an in-progress match with no posted result; the current
#                      user can still enter scores.
#   waiting_opponent — the current user posted a result; it's awaiting the
#                      opponent's sign-off.
#   waiting_others   — a pending/scheduled match (nobody has started scoring).
ListAttentionKind = Literal[
    "dispute",
    "review",
    "score",
    "waiting_opponent",
    "waiting_others",
]


def list_attention_kind(
    match: Match, current_user_id: uuid.UUID
) -> ListAttentionKind | None:
    """Classify one of the current user's matches into an attention bucket, or
    ``None`` when it isn't an attention row at all.

    ``None`` covers a non-participant (a spectator browsing the list), a
    completed/voided match (nothing left to do), and — defensively — any future
    status that isn't open. Only matches the user actually plays in and that are
    still live in some sense produce a bucket.
    """
    if not _is_participant(match, current_user_id):
        return None

    match match.status:
        case MatchStatus.disputed:
            return "dispute"
        case MatchStatus.pending:
            return "waiting_others"
        case MatchStatus.in_progress:
            # A pending posted result is awaiting a confirm/dispute. The poster
            # (who confirmed at post time) is waiting on the opponent; the other
            # side owes a review. Inlined rather than importing matches.py's
            # ``pending_result`` to keep this module free of the router.
            pending = next(
                (r for r in match.results if r.outcome == ResultOutcome.pending),
                None,
            )
            if pending is not None:
                i_responded = any(
                    resp.user_id == current_user_id for resp in pending.responses
                )
                return "waiting_opponent" if i_responded else "review"
            return "score"
        case MatchStatus.completed | MatchStatus.voided:
            return None


# Attention-priority ranking (PRD §"Sort Behavior"): lower number = more
# urgent. ``score`` splits rated-above-unrated by ``affects_rating``; the
# passive ``waiting`` buckets sink to the bottom. Within a bucket the caller
# orders oldest-first so a long-stalled match floats to the top.
_DISPUTE_PRIORITY = 0
_REVIEW_PRIORITY = 1
_RATED_SCORE_PRIORITY = 2
_UNRATED_SCORE_PRIORITY = 3
_WAITING_OPPONENT_PRIORITY = 4
_WAITING_OTHERS_PRIORITY = 5


def attention_priority(kind: ListAttentionKind, affects_rating: bool) -> int:
    """Sort rank for an attention row. Exhaustive over ``ListAttentionKind`` —
    adding a member is a type error until it's handled here."""
    match kind:
        case "dispute":
            return _DISPUTE_PRIORITY
        case "review":
            return _REVIEW_PRIORITY
        case "score":
            return _RATED_SCORE_PRIORITY if affects_rating else _UNRATED_SCORE_PRIORITY
        case "waiting_opponent":
            return _WAITING_OPPONENT_PRIORITY
        case "waiting_others":
            return _WAITING_OTHERS_PRIORITY


def _is_participant(match: Match, user_id: uuid.UUID) -> bool:
    # Inlined rather than imported from ``app.matches`` to keep this module
    # free of the 1700-line router (and the import cycle that would create:
    # matches imports attention).
    return any(any(p.user_id == user_id for p in side.players) for side in match.sides)
