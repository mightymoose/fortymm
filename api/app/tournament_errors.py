"""The tournament-flow domain exception family.

A neutral leaf holding the domain exceptions the transport-neutral tournament
verbs (``tournament_edit`` and the cut/uncut draw verbs in
``tournament_draw_service`` today; solve as it is extracted) raise, mirroring
``app.match_errors``.

None of these is ever an ``HTTPException``: each verb is transport-neutral and
signals a refusal with a plain domain exception, and each adapter (the HTTP
router, the MCP tools) maps it back to the exact response it produced before.
This module imports nothing but the standard library, so it stays a cycle-free
leaf both the services and their adapters can import.
"""


class TournamentNotFoundError(Exception):
    """Raised by the edit verb when the addressed tournament id does not resolve
    to a row. The HTTP adapter maps this to the existing 404
    ``"Tournament not found."``. Never an ``HTTPException`` — the caller adapts
    it to its transport."""


class NotTournamentOwnerError(Exception):
    """Raised by the edit verb when the acting user is not the tournament's
    creator. Tournament mutations are owner-gated (``created_by_user_id ==
    actor``), not RBAC-gated. The HTTP adapter maps this to the existing 403
    ``"You can only modify tournaments you created."``. Never an
    ``HTTPException``."""


class EventNotFoundError(Exception):
    """Raised by the draw verbs when the addressed event id does not resolve to a
    row **under the named tournament** — a well-formed pair that names no
    addressable event (a right event id under the wrong tournament id included, so
    a cross-tournament draw is a miss, not an edit). The HTTP adapter maps this to
    the existing 404 ``"Event not found."``. Never an ``HTTPException`` — the caller
    adapts it to its transport."""


class DrawUnderWayError(Exception):
    """Raised by the draw verbs when an event's draw shows **evidence of play** — a
    fixture with a recorded winner or a linked match — the single gate on both
    cutting and un-cutting a draw (ADR-0786). A cut replaces the draw wholesale and
    an un-cut destroys it, so either one over a played fixture would throw away a
    result a player produced.

    Carries the exact sentence the HTTP handler used to compose inline, so the
    adapter can rebuild the existing 409 body verbatim with ``str(exc)``. It is a
    409, not a 403: the caller is the owner and the draw is theirs — it is the draw
    that is past the point where a re-cut means anything. Never an ``HTTPException``."""

    def __init__(self) -> None:
        super().__init__(
            "This event's draw is already under way — at least one fixture has a "
            "match or a recorded winner — so it can no longer be cut or removed."
        )


class LeagueNotEditableError(Exception):
    """Raised by the edit verb when the payload would change the tournament's
    ``league_id`` after it has left ``draft`` (ADR-0783): once published,
    registration is open and eligibility is live, so the ladder is settled.
    Carries the tournament's current status so the HTTP adapter can rebuild the
    exact 409 body (``"This tournament is {status}; its league can only be
    changed while it is a draft."``). Never an ``HTTPException``."""

    def __init__(self, status: str) -> None:
        super().__init__(
            f"This tournament is {status}; its league can only be changed "
            "while it is a draft."
        )
        self.status = status


class LeagueNotFoundError(Exception):
    """Raised by the edit verb when the payload names a ``league_id`` that
    resolves to no league — the transport-neutral equivalent of the strict
    ``resolve_league`` 404 (``app.leagues``), which raises an ``HTTPException``
    the FastAPI-free verb must not. The HTTP adapter maps this to the existing
    404 ``"League not found."``. Never an ``HTTPException``."""


class NoDefaultLeagueError(Exception):
    """Raised by the create verb when the caller names no ``league_id`` and the
    deployment has no default league configured — the transport-neutral equivalent
    of ``resolve_league``'s 500 (``_default_league_or_500``, ``app.leagues``), which
    raises an ``HTTPException`` the FastAPI-free verb must not. A tournament's
    ``league_id`` column is NOT NULL and an omitted league resolves to the default
    (ADR-0783), so with no default there is nothing to bind the row to — a broken
    deployment, not a client error. The HTTP adapter maps this to the existing 500
    ``"No default league configured."``. Never an ``HTTPException``."""


class TournamentAlreadyInStatusError(Exception):
    """Raised by the transition verb when the caller asks to move a tournament to
    the status it **already holds** (a ``live → live``, say). ADR-0017 makes a
    re-asserted status a **conflict, not an idempotent no-op**: a stale tab clicking
    "Start tournament" on a tournament somebody already started is the common case,
    and it deserves the fact it is missing — that it is already done — rather than a
    silent 201.

    It carries the current status so the HTTP adapter can rebuild the exact 409 body
    (``"This tournament is already {status}."``) and the MCP tool its equivalent
    ``ToolError`` prose. It is deliberately a **separate type** from
    :class:`IllegalTournamentTransitionError`: the self-transition gets its own
    single-ended sentence (the two-ended one degenerates into tautology — "this
    tournament is live; it cannot be moved to live" tells the player nothing), so the
    distinction has to survive to the adapter. Never an ``HTTPException``."""

    def __init__(self, status: str) -> None:
        super().__init__(f"This tournament is already {status}.")
        self.status = status


class IllegalTournamentTransitionError(Exception):
    """Raised by the transition verb for a genuinely illegal lifecycle edge — walking
    backwards, skipping a stage, or moving out of the terminal ``archived`` — i.e. any
    ``(from, to)`` pair not in the forward-only legal table AND whose ends differ (the
    equal-ends case is :class:`TournamentAlreadyInStatusError`).

    It carries **both** ends of the edge, because the same ``to`` that is legal from
    one status is a conflict from another, so the target alone does not say why it was
    refused. The HTTP adapter rebuilds the exact 409 body (``"This tournament is
    {status}; it cannot be moved to {to}."``) from ``str(exc)`` and the MCP tool its
    equivalent ``ToolError`` prose. It is a 409, not a 403 (ADR-0017): the caller is
    the owner and the move is theirs to make — it is the *tournament* that is in the
    wrong state for it. Never an ``HTTPException``."""

    def __init__(self, status: str, to: str) -> None:
        super().__init__(f"This tournament is {status}; it cannot be moved to {to}.")
        self.status = status
        self.to = to


class TournamentNotReadyToGoLiveError(Exception):
    """Raised by the transition verb when the ``published → live`` precondition fails
    (ADR-0786): the tournament has **no events**, or an event with **no draw**, or an
    event whose **draw is stale** (cut before somebody entered or withdrew, so its
    fixtures no longer seat exactly its active entrants).

    Going live seals the field and turns every ready fixture into a real match, both
    computed from the draw — so the draw must be right at the instant the tournament
    starts. It carries the composed, director-facing sentence (naming the at-fault
    events **by name**, never by id) so the HTTP adapter rebuilds the exact 409 body
    with ``str(exc)`` and the MCP tool its equivalent ``ToolError`` prose, plus the
    structured lists (``uncut`` / ``stale`` names, ``no_events``) for any adapter that
    wants to reshape rather than echo. It is a 409, not a 403: the same request
    succeeds the moment the draws are cut, which is what a conflict means. Never an
    ``HTTPException``."""

    def __init__(
        self, message: str, *, uncut: list[str], stale: list[str], no_events: bool
    ) -> None:
        super().__init__(message)
        self.uncut = uncut
        self.stale = stale
        self.no_events = no_events


class NoDrawnEventsError(Exception):
    """Raised by the request-schedule-solve verb when no event of the addressed
    tournament has a **cut draw** — nothing the solver can place, so a run would
    succeed at placing zero fixtures (a green ledger row that answers a question
    nobody asked). The HTTP adapter maps this to the existing 422 with the
    machine-readable ``{"code": "no_drawn_events", "message": ...}`` body
    (``app.tournaments._no_drawn_events_refusal``): a bare marker like
    :class:`TournamentNotFoundError`, its transport copy lives in the adapter,
    not here. Never an ``HTTPException``."""


class TournamentNotPreLiveError(Exception):
    """Raised by the request-schedule-preview verb when the addressed tournament
    is no longer **pre-live** — a preview is a "would this config even fit before
    anyone registers?" question, so it is allowed only while the tournament is a
    ``draft`` or ``published`` (registration open, nothing drawn yet) and refused
    once it is ``live`` (there is a real field and a real solve to look at) or
    ``archived`` (it is over). Carries the current status so the HTTP adapter can
    build the machine-readable refusal body. Never an ``HTTPException`` — the
    caller adapts it to its transport."""

    def __init__(self, status: str) -> None:
        super().__init__(
            f"This tournament is {status}; a schedule preview is only available "
            "while it is a draft or published."
        )
        self.status = status


class ScheduleQueueUnavailableError(Exception):
    """Raised by the request-schedule-solve verb when the enqueue itself could
    not be placed on the queue (Redis down): :func:`app.schedule_solves.request_solve`
    catches the ``RedisError`` internally, takes its just-inserted row back out
    (a zombie row would absorb every later trigger while no job ever runs) and
    returns ``None``. This verb turns that ``None`` into this exception so its
    own return type stays a non-optional :class:`~app.models.ScheduleSolve` —
    the caller gets a real ledger row or a refusal, never an ambiguous ``None``.
    The HTTP adapter maps this to the existing 503 ``"The scheduling queue is
    unavailable, …"``; nothing was queued and the same request is safe to retry.
    Never an ``HTTPException``."""
