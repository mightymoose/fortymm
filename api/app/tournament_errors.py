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

from enum import StrEnum


class EntryRefusal(StrEnum):
    """Why an entry into a tournament event was refused (ADR-0968).

    A closed set, not a loose ``str``: a code the client cannot switch on is a code
    the server should not be able to invent (and every member here is a case the
    client is expected to have copy for). ``StrEnum``, so a member *is* its wire
    value — it serialises straight into the response body with no mapping step to
    drift.

    It lives here, in the transport-neutral domain-error leaf, rather than beside the
    HTTP ``entry_refused`` factory, precisely so the FastAPI-free ``enter_event`` verb
    can name the refusal it hit (on :class:`EntryRefusedError`) without importing a
    module that imports FastAPI. ``app.tournament_entry_refusals`` re-exports it for
    the existing HTTP call sites and its ``entry_refused`` 409 factory.
    """

    already_entered = "already_entered"
    """The player already holds an *active* entry in this event. Withdrawing frees
    them to enter again, so this is transient, not permanent."""

    registration_closed = "registration_closed"
    """The tournament's registration window is shut — today, because its status is
    ``draft``, ``live`` or ``archived`` (its status *is* its window, ADR-0017)."""

    event_full = "event_full"
    """The event holds ``max_players`` *active* entries already. Transient, like
    ``already_entered``: somebody withdrawing frees the slot (withdrawn entries are
    not entrants, ADR-0016), so the caller may be told something different a minute
    from now — which is exactly why it is a 409 and not a 403.

    Unreachable for an **uncapped** event (``max_players`` is NULL, ADR-0935): with no
    limit there is nothing for the field to reach, so no number of entrants can produce
    this refusal."""

    rating_ineligible = "rating_ineligible"
    """The player's rating on the tournament's ladder fails one of the event's
    eligibility rules (ADR-0783) — the "Under 1500" event, entered by a 1650 player.

    A 409 like the others, and for the same reason: the request is fine (it has no
    body at all), it is the *state of the world* that forbids the entry — and this
    state moves too. A rating is a fact about a player *today*: the same request wins
    or loses depending on how their last rated match went, so "not now" (409) is the
    truth, where 403 would claim a permission they have never lacked.

    Note what does **not** land here: a player with **no rating at all** passes every
    rule and is never refused with this code (ADR-0783 §3). Unrated is not "fails the
    rule"; it is "there is no fact to judge", and the beginners' event is exactly the
    one a brand-new player needs to get into."""


class EntryRefusedError(Exception):
    """Raised by the ``enter_event`` verb for one of the four machine-readable entry
    refusals (ADR-0968): ``already_entered``, ``registration_closed``, ``event_full``,
    ``rating_ineligible``.

    Carries the :class:`EntryRefusal` code (the contract a client switches on) and a
    fallback message (the prose a client that does not know the code, or a human,
    reads).
    The HTTP adapter rebuilds the exact 409 body by handing both straight to
    ``app.tournament_entry_refusals.entry_refused`` — so the coded ``{"detail": {"code":
    ..., "message": ...}}`` shape is byte-for-byte what the route sent inline; the MCP
    adapter turns it into ``ToolError`` prose naming which refusal fired. It is always a
    409 (every one of the four is a state conflict, not a permission or a not-found), so
    the code alone carries the *why*. Never an ``HTTPException``."""

    def __init__(self, refusal: EntryRefusal, message: str) -> None:
        super().__init__(message)
        self.refusal = refusal


class NotAllowedToEnterError(Exception):
    """Raised by the ``enter_event`` verb on the **self-registration** arm when the
    caller does not hold the ``tournament.enter`` permission (ADR-0784).

    This is the one authorization the entry verb judges itself, and only on the self
    path: a player entering *themselves* is not the tournament's owner, so it cannot go
    through the owner gate — it is a data-authz permission, asked (as the HTTP route
    asked it inline) once the fork has decided this is a self-registration. A director
    entering somebody else is gated by ownership instead
    (:class:`NotTournamentOwnerError`)
    and is never refused for lacking a permission about entering themselves. The HTTP
    adapter maps this to the existing 403 ``"Forbidden."``; the MCP tool to
    ``ToolError``
    prose. Never an ``HTTPException``."""


class PlayerNotFoundError(Exception):
    """Raised by the ``enter_event`` verb on the **director** arm when the named
    ``user_id`` resolves to no enterable player — an absent id, or a tombstoned
    (merged-away) user, which are excluded exactly as ``/v1/players/search`` excludes
    them (a ghost can neither sign in, be notified, nor play, ADR-0784).

    A not-found, not a 422: the id is well-formed, it simply names nobody enterable. It
    is judged only *after* the ownership gate, so a stranger poking at the endpoint
    learns
    nothing about which user ids exist. The HTTP adapter maps this to the existing 404
    ``"Player not found."``; the MCP tool to ``ToolError`` prose. Never an
    ``HTTPException``."""


class NonSinglesEntryError(Exception):
    """Raised by the ``enter_event`` verb when the addressed event is **not a singles
    event** (ADR-0016). Not a policy — a modelling limit: an entry is one row per
    player, with nowhere to record a partner or a team, so a doubles/teams event cannot
    be entered directly through this verb (in any status, which is why it outranks the
    registration 409 — it is the fact that will not change).

    Carries the event's ``format`` so the HTTP adapter can rebuild the existing 400
    ``"Only singles events can be entered directly, not {format}."``; the MCP tool names
    it in ``ToolError`` prose. Never an ``HTTPException``."""

    def __init__(self, event_format: str) -> None:
        super().__init__(
            f"Only singles events can be entered directly, not {event_format}."
        )
        self.event_format = event_format


class EntryNotFoundError(Exception):
    """Raised by the ``withdraw_from_event`` verb when the ``entry_id`` resolves to no
    row **under the named event** — a well-formed triple that names no addressable
    entry (an entry that exists but hangs off a *different* event included, so a
    cross-event withdrawal is a miss, not a soft-delete). Judged after the tournament
    and event 404s, so a stranger's refusal never leaks whether the entry exists before
    the URL's own path is confirmed. The HTTP adapter maps this to the existing 404
    ``"Entry not found."``. Never an ``HTTPException`` — the caller adapts it to its
    transport."""


class NotAllowedToWithdrawError(Exception):
    """Raised by the ``withdraw_from_event`` verb when the caller is **neither the
    entry's own player nor the tournament's owner** (ADR-0784). Withdrawal mirrors
    entry: the player themselves (with ``tournament.enter``) may take back their own
    entry, and the owner may withdraw any entry in their tournament — anybody else is
    refused.

    This is the director-arm mirror of :class:`NotAllowedToEnterError`: where entering
    somebody else is owner-gated, withdrawing somebody else's entry is too, and a
    non-owner reaching for an entry that is not theirs is refused. Judged **after** the
    tournament/event/entry 404s (the row must be loaded before the fork can be read off
    it) and **before** the registration-window 409, because "not yours" is the fact
    that will not change where "not now" invites a pointless retry. The HTTP adapter
    maps this to the existing 403 ``"You can only withdraw your own entry."``; the MCP
    tool to ``ToolError`` prose. Never an ``HTTPException``."""


class WithdrawalRegistrationClosedError(Exception):
    """Raised by the ``withdraw_from_event`` verb when an **active** entry would be
    withdrawn while the tournament's registration window is shut (ADR-0017): a
    ``draft`` (registration not opened), ``live`` (the field is sealed and the draw is
    cut from it) or ``archived`` (it is over) tournament.

    Deliberately **separate** from the entry endpoint's coded ``EntryRefusedError``
    (ADR-0968): the withdraw route's refusal is still bare prose with no
    machine-readable ``code`` (ADR-0968 scopes the coded refusals to the *entry*
    endpoint), so this carries only the exact, domain-authored sentence
    (``tournament_registration.registration_refusal_detail`` — the same words the enter
    leg uses, only un-coded) which the HTTP adapter rebuilds verbatim into the existing
    409 with ``str(exc)``. It is a 409, not a 403 (ADR-0017): the caller is permitted
    and the entry is theirs to take back — it is the tournament that is in the wrong
    state, and the same request becomes legal the moment it is published again. An entry
    that is **already withdrawn** never reaches this — it has nothing left to lock, so
    it is a 204 in every status. Never an ``HTTPException``."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


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


class GroupSetFrozenError(Exception):
    """Raised by the update-event verb when a ``reservations`` payload would change
    *which groups* an event with a **cut draw** has (ADR-0786). A fixture names its
    group by a foreign key onto the event's own groups, and adding or removing a
    reservation adds or removes its mapped group in lockstep — so removing one orphans
    every fixture drawn into it and adding one arrives with no fixtures — integrity the
    database cannot enforce, so the freeze does.

    It is a 409, not a 403 (ADR-0017): the caller is the owner and the payload is
    well-formed — it is the *resource* that is in the wrong state, and the same request
    becomes legal the moment the draw is removed. Carries the exact, domain-authored
    sentence the HTTP handler used to compose inline (rebuilt verbatim with
    ``str(exc)``) plus structured detail for any adapter that wants to reshape rather
    than echo: ``removed``, the labels of the groups that would go, and ``added``, a
    **count** of the groups that would arrive. Added groups are counted and not labelled
    because a label is derived from a position this very payload rewrites — see
    ``app.tournament_events._group_set_frozen_detail``. Never an ``HTTPException`` — the
    caller adapts it to its transport."""

    def __init__(self, message: str, *, removed: list[str], added: int) -> None:
        super().__init__(message)
        self.removed = removed
        self.added = added


class ReservationNotInEventError(Exception):
    """Raised by the update-event verb when an entry of a submitted ``reservations``
    list cites an ``id`` that names no reservation of **this** event (ADR 20260801).

    The exact twin of :class:`TableNotInCatalogueError`, one resource over. It could not
    exist while a reservation id was the client's to author — an id the server had never
    seen still named the reservation the client meant, so a new id was an *addition*.
    The id is a server-minted uuid now, so one the server did not mint names nothing,
    and minting a fresh reservation for it would hand the client back a different id
    than it asked for while quietly *removing* the reservation it meant to keep: the two
    failures a diff must never confuse.

    It is judged **after** the group-set freeze, so an event whose draw is cut answers
    the 409 that names its groups rather than this 422 — the freeze is the refusal a
    director can act on, and a cited-but-unknown id is an addition as far as a standing
    draw is concerned.

    Carries the ``index`` of the offending entry as well as the id, because the
    reservations are a list and a refusal a client cannot attribute to a row is a
    refusal it cannot render: the HTTP adapter names
    ``loc: ["body", "reservations", index, "id"]``, the same shape the schema's own
    422s on this field have. Never an ``HTTPException``."""

    def __init__(self, index: int, reservation_id: str) -> None:
        super().__init__("This event has no reservation with that id.")
        self.index = index
        self.reservation_id = reservation_id


class TableNotInCatalogueError(Exception):
    """Raised by the edit verb when an entry of a submitted ``table_catalogue`` cites an
    ``id`` that names no table of **this** tournament's catalogue (ADR 20260801).

    The sibling of :class:`PlacementTableNotFoundError`, one verb over, and refused for
    the same reason: the id does not resolve, so the field is wrong and will go on being
    wrong until the client sends a different one. Silently minting a fresh table for it
    would hand the client back a different id than it asked for, and quietly *remove*
    whatever table it meant to keep — the two failures a diff must never confuse.

    Carries the ``index`` of the offending entry as well as the id, because a catalogue
    is a list and a refusal a client cannot attribute to a row is a refusal it cannot
    render: the HTTP adapter names ``loc: ["body", "table_catalogue", index, "id"]``,
    the same shape the schema's own 422s on this field have. Never an
    ``HTTPException``."""

    def __init__(self, index: int, table_id: str) -> None:
        super().__init__("This tournament's venue catalogue has no table with that id.")
        self.index = index
        self.table_id = table_id


class TableInUseError(Exception):
    """Raised by the edit verb when a submitted ``table_catalogue`` would **remove a
    table that matches are placed at**, without the unplace-and-remove opt-in
    (ADR 20260801, "a placement names a real table, and only that is an invariant").

    This is the loud half of the ADR's deliberate split. A **reservation** that merely
    reserves a removed table is not consulted at all — it quietly reserves one fewer,
    because a table breaking or freeing up is ordinary venue traffic. A **placement**
    gets the refusal, because silently clearing one destroys information on an
    *unrelated* write: the fixture would stop being "placed at a table that vanished"
    and become indistinguishable from "nobody ever placed this", as an invisible side
    effect of renaming the venue. The database refuses by default (``ON DELETE
    RESTRICT``); the director says yes on purpose.

    It is a 409, not a 403 or a 422 (the same reasoning as :class:`GroupSetFrozenError`,
    whose house style its sentence follows): the caller is the owner and the payload is
    well-formed — it is the *state of the world* that forbids the edit, and the
    identical request succeeds the moment the matches are moved off the table, or the
    moment the caller sends the opt-in.

    Carries the domain-authored sentence the adapters rebuild verbatim with
    ``str(exc)``, plus the structured ``tables`` (the at-fault tables' **labels**, never
    their ids — an id tells a director looking at a page of named tables nothing to act
    on) and ``placements`` (how many matches would be unplaced) for any adapter that
    wants to reshape rather than echo. **Nothing is written when it is raised**: it is
    judged before the diff touches a row, so a refused edit leaves the tournament
    exactly as it was. Never an ``HTTPException``."""

    def __init__(self, message: str, *, tables: list[str], placements: int) -> None:
        super().__init__(message)
        self.tables = tables
        self.placements = placements


class DrawTypeFrozenError(Exception):
    """Raised by the update-event verb when a ``draw_type`` payload would change the
    draw type of an event that **has a draw** (ADR-0786). A draw type is the strategy
    that dealt the event's fixtures, so re-typing it under a standing draw leaves the
    event claiming a shape its fixtures do not have — a corruption the go-live currency
    check cannot catch (re-labelling moves neither the entrants nor the fixtures).

    Sibling of :class:`GroupSetFrozenError`, and a 409 for the same reason: the caller
    is the owner and the payload is well-formed; it is the resource that is in the wrong
    state, and the same request becomes legal the moment the draw is removed. Carries
    the exact sentence the HTTP handler composed inline (rebuilt verbatim with
    ``str(exc)``) plus the current ``draw_type`` value. Never an ``HTTPException``."""

    def __init__(self, message: str, *, draw_type: str) -> None:
        super().__init__(message)
        self.draw_type = draw_type


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
    fixtures no longer seat exactly its active entrants), or an event whose draw a dry
    run finds it can **never** cut (a field under two entrants, or a non-singles
    event) — ``undrawable``, #1300.

    Going live seals the field and turns every ready fixture into a real match, both
    computed from the draw — so the draw must be right at the instant the tournament
    starts. It carries the composed, director-facing sentence (naming the at-fault
    events **by name**, never by id) so the HTTP adapter rebuilds the exact 409 body
    with ``str(exc)`` and the MCP tool its equivalent ``ToolError`` prose, plus the
    structured lists (``uncut`` / ``stale`` / ``undrawable`` names, ``no_events``) for
    any adapter that wants to reshape rather than echo. It is a 409, not a 403: the
    same request succeeds the moment the draws are cut (or the undrawable events are
    fixed or removed), which is what a conflict means. Never an ``HTTPException``."""

    def __init__(
        self,
        message: str,
        *,
        uncut: list[str],
        stale: list[str],
        undrawable: list[str],
        no_events: bool,
    ) -> None:
        super().__init__(message)
        self.uncut = uncut
        self.stale = stale
        self.undrawable = undrawable
        self.no_events = no_events


class FixtureNotFoundError(Exception):
    """Raised by the place-fixture verb when the ``fixture_id`` resolves to no row
    **under the named tournament** — a well-formed pair that names no addressable
    fixture (a right fixture id under the wrong tournament id included, so a
    cross-tournament placement is a miss, not an edit). Judged after the tournament
    404/owner 403, so a stranger's refusal never leaks whether the fixture exists.
    The HTTP adapter maps this to the existing 404 ``"Fixture not found."``. Never an
    ``HTTPException`` — the caller adapts it to its transport."""


class FixturePlacementFrozenError(Exception):
    """Raised by the place-fixture verb when a fixture whose linked match is
    ``completed`` or ``voided`` would be (re)placed — the ONE hard rule of an
    otherwise-soft endpoint (ADR-0790). A played-out fixture's placement records
    where and when the match actually happened, so the move is refused.

    It is a 409, not a 403 (ADR-0017): the caller is the owner and the request is
    well-formed — it is the *fixture* that is past the point where a placement means
    anything. Carries the match's ``status`` so the HTTP adapter rebuilds the exact
    409 body (``"This fixture's match is already {status}, so its placement can no
    longer be changed."``, via ``str(exc)``) and the MCP tool its equivalent
    ``ToolError`` prose. Never an ``HTTPException``."""

    def __init__(self, match_status: str) -> None:
        super().__init__(
            f"This fixture's match is already {match_status}, so its placement can "
            "no longer be changed."
        )
        self.match_status = match_status


class PlacementTableNotFoundError(Exception):
    """Raised by the place-fixture verb when the placement's ``table_id`` names no
    table in the tournament's venue catalogue — the ONE thing about a placement that is
    an **invariant** rather than a flag (ADR 20260801, "a placement names a real table,
    and only that is an invariant").

    It is deliberately *not* a sibling of :class:`FixturePlacementFrozenError`'s 409.
    The freeze is about the state of the resource; this is about the **content of the
    body**: the id sent does not resolve, so the field is wrong, and it will go on being
    wrong until the client sends a different one. The HTTP adapter therefore names the
    field the way every other refused field on this route is named — a 422 whose
    ``detail`` carries ``loc: ["body", "table_id"]``, the same shape the schema's own
    422s have, so a client needs no second parser for it.

    Everything else about a placement stays soft (ADR-0790, undisturbed): an
    out-of-window start, a table outside the fixture's group, and a double-booking all
    still SAVE and surface as flags derived on read. Only "does this reference resolve
    at all" is hard, because a placement whose table does not exist is not a state the
    director chose — it is a dangling pointer nothing downstream can render.

    Carries the offending ``table_id`` verbatim (the string as sent, which need not even
    be a well-formed UUID) so the adapter can echo it back as the ``input`` of the
    validation error. Never an ``HTTPException``."""

    def __init__(self, table_id: str) -> None:
        super().__init__("This tournament's venue catalogue has no table with that id.")
        self.table_id = table_id


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
