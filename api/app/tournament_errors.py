"""The tournament-flow domain exception family.

A neutral leaf holding the domain exceptions the transport-neutral tournament
verbs (``tournament_edit`` today; cut/uncut and solve as they are extracted)
raise, mirroring ``app.match_errors``.

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
