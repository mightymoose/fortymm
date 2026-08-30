"""The match-flow domain exception family.

A neutral leaf that holds every domain exception the match-flow services
(``match_creation``, ``match_scoring``, ``result_proposal``, ``result_acceptance``)
raise, so those services don't have to import one another just to share an
exception type — dissolving the import cycle that pulled them together when the
family lived on ``result_acceptance``.

None of these is ever an ``HTTPException``: each service is transport-neutral and
signals a rejection with a plain domain exception, and each adapter (the HTTP
router, the MCP tools) maps it back to the exact response it produced before.

It imports only ``app.models`` and ``app.schemas.match`` for the two exceptions
that carry a payload (``NegotiationConflictError`` a :class:`Match`,
``ScoreConflictError`` a :class:`MatchDetailsScore`) — both leaf modules — so it
stays cycle-free.
"""

from app.models import Match
from app.schemas.match import MatchDetailsScore


class SelfMatchError(Exception):
    """Raised by the match-creation service when the requested opponent is the
    acting user themselves. The HTTP adapter maps this to the existing 422
    ``"You cannot start a match against yourself."``."""


class OpponentNotFoundError(Exception):
    """Raised by the match-creation service when the requested opponent id does
    not resolve to a live (non-tombstoned) user. The HTTP adapter maps this to
    the existing 404 ``"Opponent not found."``."""


class RatedNeedsRegisteredOpponentError(Exception):
    """Raised by the match-creation service when a rated match is requested
    without a registered opponent (a solo match cannot be rated). The HTTP
    adapter maps this to the existing 422
    ``"A rated match needs a registered opponent."``."""


class MatchClosedError(Exception):
    """Raised by :func:`app.result_proposal.propose_result` when the match has
    reached a terminal status (``completed``/``voided``) and is closed to new
    proposals. The HTTP adapter maps this to the existing 409
    ``"This match is no longer open to results."``. Never an ``HTTPException`` —
    the caller adapts it to its transport."""


class UndecidedBoardError(Exception):
    """Raised by :func:`app.result_proposal.propose_result` when the proposed
    board fails the strict finalize validator (empty, gappy-past-decider,
    duplicate/out-of-range game numbers, or still-undecided) — i.e. it can't be
    a result. Carries the validator's human-readable ``ValueError`` message; the
    HTTP adapter maps it to the existing 422 ``str`` body. Never an
    ``HTTPException``."""


class NegotiationConflictError(Exception):
    """Raised by :func:`app.result_proposal.propose_result` when the propose lost
    the negotiation race: a first post found a result already exists, a counter
    targeted a ``supersedes_result_id`` that is no longer the live standing
    proposal, or the ``uq_match_results_supersedes_result_id`` unique constraint
    tripped at commit (two concurrent counters superseding the same parent).

    Carries the loaded (or reloaded) :class:`Match` so the HTTP adapter can build
    the exact viewer-relative negotiation snapshot (``_negotiation_conflict`` /
    ``negotiation``) it produced before, letting a client that lost the race
    re-render from the 409 body without an extra round-trip. Never an
    ``HTTPException`` — the caller adapts it to its transport."""

    def __init__(self, match: Match) -> None:
        super().__init__("The standing proposal has moved on.")
        self.match = match


class StandingResultConflictError(Exception):
    """Raised when the ``result_id`` handed to
    :func:`app.result_acceptance.accept_standing_result` is no longer the live
    standing proposal — a concurrent counter superseded it, it was already
    accepted, or there is no standing proposal at all. The router maps this to
    the existing 409 carrying the moved-on negotiation state."""


class PostedGamesNotDecisiveError(Exception):
    """Raised when the match's committed games no longer decide a winner at the
    moment of acceptance. Practically unreachable (a result only stands once its
    board is decided, and the board is frozen while it stands), but the core
    stays total rather than silently stamping no winner. The router maps this to
    the existing 409 ``"The posted games no longer decide this match."``."""


class ResultNotFoundError(Exception):
    """Raised by :func:`app.result_acceptance.accept_result` when the target
    ``result_id`` is not a result on the loaded match at all (as opposed to being
    present but no longer the live standing proposal, which is
    :class:`StandingResultConflictError`). The HTTP adapter maps this to the
    existing 404 ``"Result not found."``. Never an ``HTTPException`` — the caller
    adapts it to its transport."""

    def __init__(self) -> None:
        super().__init__("Result not found.")


class CannotAcceptOwnProposalError(Exception):
    """Raised by :func:`app.result_acceptance.accept_result` when the accepting
    user is a participant on the *submitter's* side of the standing proposal. The
    proposing side already consented by proposing, so only a participant on the
    opposing side may accept (in singles, the submitter themselves can't accept
    their own proposal). The HTTP adapter maps this to the existing 409
    ``"You can't accept your own proposal."``. Never an ``HTTPException`` — the
    caller adapts it to its transport."""

    def __init__(self) -> None:
        super().__init__("You can't accept your own proposal.")


class MatchNotFoundError(Exception):
    """Raised by the per-game score service (``app.match_scoring``) when the
    write target can't be resolved — either the match id is absent, or the
    acting user is neither a participant nor the director of the tournament
    that materialized this match (#1523) — today's score endpoints collapse
    all three into one opaque 404 so an unauthorized caller can't probe match
    existence — or, on the update/delete paths, the addressed game score
    doesn't exist.

    Carries the exact ``message`` the HTTP adapter must reproduce as its 404
    ``detail``: ``"Match not found."`` for an absent match or an unauthorized
    caller, ``"Score not found."`` for a missing game score. Never an
    ``HTTPException`` — it has no HTTP context; the caller adapts it to its
    transport."""

    def __init__(self, message: str = "Match not found.") -> None:
        super().__init__(message)
        self.message = message


class MatchNotScorableError(Exception):
    """Raised by the per-game score service when the loaded match can't be
    scored. It carries the exact ``http_status`` (422 or 409) **and** ``message``
    for each of ``ensure_scorable``'s four reason-specific outcomes — no
    opponent (422), a posted result (409), an uncalled scheduled match (409), or
    any other non-scorable/terminal state (409) — so the HTTP adapter reproduces
    the identical response byte-for-byte while the MCP adapter reads the message.
    Never an ``HTTPException`` — the caller adapts it to its transport."""

    def __init__(self, *, http_status: int, message: str) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.message = message


class ScoreNotAllowedError(Exception):
    """Raised by the per-game score service when a scratchpad write is legal to
    attempt but disallowed by a cross-game rule — the addressed game exceeds the
    match's ``best_of`` range, or the prospective board would leave the match
    decided before its last scored game (overrun). Both map to a 422 carrying
    this exception's exact message. Never an ``HTTPException``."""


class ScoreConflictError(Exception):
    """Raised by the per-game score service (``app.match_scoring``) when a
    scratchpad write loses a concurrent-participant race: a create finds the
    game already scored (or trips the unique constraint at commit), or an
    update's ``expected_version`` no longer matches the committed row.

    Carries ``committed_score`` — the game's score as it actually stands now,
    including its ``version`` — so the HTTP adapter can rebuild the exact 409
    ``MatchGameScoreConflict`` body (``_score_conflict``) and the MCP adapter can
    point the agent back at ``get_match``. It is ``None`` only when the committed
    row could not be re-read (the match vanished). Never an ``HTTPException`` —
    it has no HTTP context; the caller adapts it to its transport."""

    def __init__(self, *, committed_score: MatchDetailsScore | None) -> None:
        super().__init__("This game was saved by someone else while you were editing.")
        self.committed_score = committed_score
