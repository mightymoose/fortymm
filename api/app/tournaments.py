import hashlib
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from pyrate_limiter import Duration, Rate
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.draws import (
    DrawError,
    draw_error_detail,
)
from app.geocoding import AddressNotGeocodableError, Geocoder
from app.geocoding.dependencies import get_geocoder
from app.models import (
    Tournament,
    User,
)
from app.rate_limiting import RedisRateLimiter
from app.rbac import require_permission
from app.schedule_preview_solve import (
    cancel_preview,
    ensure_preview_access,
    preview_job_state,
)
from app.schedule_preview_solve import (
    request_schedule_preview as _request_schedule_preview,
)
from app.schemas.schedule_preview import (
    PreviewEnqueued,
    PreviewJobState,
    PreviewRequest,
)
from app.schemas.tournament import (
    GeocodePreview,
    ScheduleSolveRead,
    TournamentCreate,
    TournamentDetailRead,
    TournamentEntrantRead,
    TournamentEntryCreate,
    TournamentEventCreate,
    TournamentEventRead,
    TournamentEventUpdate,
    TournamentFixturePlacementUpdate,
    TournamentFixtureRead,
    TournamentRead,
    TournamentTransitionCreate,
    TournamentUpdate,
)
from app.sessions import SESSION_COOKIE_NAME, get_current_user
from app.tournament_draw_service import cut_event_draw as _cut_event_draw
from app.tournament_draw_service import uncut_event_draw as _uncut_event_draw
from app.tournament_edit import edit_tournament
from app.tournament_entries import enter_event as enter_event_core
from app.tournament_entries import withdraw_from_event as withdraw_from_event_core
from app.tournament_entry_refusals import entry_refused
from app.tournament_errors import (
    DrawTypeFrozenError,
    DrawUnderWayError,
    EntryNotFoundError,
    EntryRefusedError,
    EventNotFoundError,
    FixtureNotFoundError,
    FixturePlacementFrozenError,
    IllegalTournamentTransitionError,
    LeagueNotEditableError,
    LeagueNotFoundError,
    NoDefaultLeagueError,
    NoDrawnEventsError,
    NonSinglesEntryError,
    NotAllowedToEnterError,
    NotAllowedToWithdrawError,
    NotTournamentOwnerError,
    PlacementTableNotFoundError,
    PlayerNotFoundError,
    PoolNotInEventError,
    PoolSetFrozenError,
    ScheduleQueueUnavailableError,
    TableInUseError,
    TableNotInCatalogueError,
    TournamentAlreadyInStatusError,
    TournamentNotFoundError,
    TournamentNotPreLiveError,
    TournamentNotReadyToGoLiveError,
    WithdrawalRegistrationClosedError,
)
from app.tournament_events import create_event as create_event_core
from app.tournament_events import delete_event as delete_event_core
from app.tournament_events import update_event as update_event_core
from app.tournament_geocoding import (
    ADDRESS_NOT_GEOCODABLE_MESSAGE,
    AddressNotGeocodable,
)
from app.tournament_lifecycle import create_tournament as create_tournament_core
from app.tournament_lifecycle import delete_tournament as delete_tournament_core
from app.tournament_lifecycle import transition_tournament
from app.tournament_list import (
    NearMeFilter,
    list_tournament_details,
    tournament_detail,
)
from app.tournament_placement import place_fixture as place_fixture_core
from app.tournament_queries import visible_to as _visible_to
from app.tournament_serialization import (
    serialize,
    shape_created_event_read,
    shape_event_read,
)
from app.tournament_solve_service import (
    request_schedule_solve as _request_schedule_solve,
)

# Reads are gated on ``tournament.view``, creation on ``tournament.create``, and
# entering an event as a player on ``tournament.enter`` (all three granted to the
# Beta-tester role in ``scripts/seed_rbac.py``). The owner-facing mutating routes
# — PATCH, DELETE, and every event mutation — carry NO permission gate: they're
# owner-only, available solely to the user who created the tournament (the owner gate
# the transport-neutral write verbs enforce). There is deliberately no
# ``tournament.edit``/``tournament.delete``/``tournament.publish`` permission;
# managing a tournament you created is a property of ownership, not a role grant.
# Player self-registration is the exception that needs its own permission: a
# player entering *themselves* is not the tournament's owner, so it cannot be an
# ownership check.
#
# The two ENTRY routes hold BOTH of those authorizations at once, because a single
# endpoint serves both actors (ADR-0784): a player entering themselves is gated on
# ``tournament.enter``, and a director entering somebody else — or withdrawing an
# entry that is not their own — is gated on ownership. Which gate applies is decided
# by the request, so neither can be a router dependency (a dependency runs before the
# handler has seen the body, and would refuse an owner for lacking a grant that has
# nothing to do with what they are doing). Both routes therefore take
# ``get_current_user`` and the entry verbs ask the enter-permission / ownership gate in
# the arm of the fork that owns them. The authorizations are disjoint — a stranger
# self-registering is not the owner; an owner adding somebody else is not
# self-registering — so this is a fork, not a tangle.
TOURNAMENT_VIEW = "tournament.view"
TOURNAMENT_CREATE = "tournament.create"
TOURNAMENT_ENTER = "tournament.enter"

require_view = require_permission(TOURNAMENT_VIEW)
require_create = require_permission(TOURNAMENT_CREATE)

# The tournament lifecycle (ADR-0017) — ``draft → published → live → archived`` — now
# lives with the verb: the forward-only edge table (``LEGAL_TRANSITIONS``) and the
# go-live precondition (``_enforce_ready_to_go_live``, ADR-0786) moved onto the
# transport-neutral ``transition_tournament`` in ``app.tournament_lifecycle``, so the
# HTTP route and the MCP tool judge the same edges and run the same go-live side
# effects. The route below is a thin adapter over that verb.

router = APIRouter(prefix="/v1")


# ----- helpers -------------------------------------------------------------


# The tournament loaders and the owner gate that used to live here are gone: every
# owner-only write now loads its tournament through the transport-neutral verbs' shared
# ``_load_owned_tournament_for_update`` (``app.tournament_edit``) — the row lock, then
# the 404 → 403 owner gate — so the router keeps no bare/owner/for-update loader of its
# own. The `tournament.enter` self-registration gate and the entry-by-event 404 that the
# entry routes used to ask through router helpers likewise moved to the entry verbs
# (``app.tournament_entries``): ``enter_event`` asks the permission through the shared
# ``user_has_permission`` on its self arm, and both verbs load the entry themselves.


# The league-editable-only-while-draft rule (ADR-0783) now lives on the
# transport-neutral edit verb: ``edit_tournament`` (``app.tournament_edit``)
# raises ``LeagueNotEditableError``, which the PATCH adapter below maps to the 409
# this router used to raise inline. It is not a router helper any more precisely so
# the rule has one home the MCP tool shares too.


def _address_not_geocodable() -> HTTPException:
    """The coded ``409`` for a venue address that resolved to zero candidates.

    A coded refusal, following the entry endpoint's ``entry_refused`` precedent
    (ADR-0968): the machine-readable ``code`` is the contract a client switches on, the
    ``message`` is fallback prose. The ``create``/``update`` verbs raise the
    transport-neutral ``AddressNotGeocodableError``; this adapter turns it into the
    ``{"detail": {"code": ..., "message": ...}}`` body — the same word
    (:data:`ADDRESS_NOT_GEOCODABLE_CODE`, carried on the :class:`AddressNotGeocodable`
    model) the MCP tool names in its ``ToolError``, so a client holds one copy table
    whichever surface refused it.

    A ``409``, deliberately **not** a ``422``: FastAPI reserves ``422`` for its own
    ``HTTPValidationError``, whose ``detail`` is an **array**, so a hand-rolled ``422``
    object body drifts the generated ``schema.d.ts``/``Types.swift`` to a shape these
    endpoints never return — and the strict-Codable iOS client cannot decode the real
    object body (ADR-0968 rejects "one status, two body shapes" and uses coded ``409``).
    The body is modeled (:class:`AddressNotGeocodable`) and declared on each route's
    ``responses={409: ...}`` so the generated clients describe exactly what is sent."""
    return HTTPException(
        status_code=409,
        # ``AddressNotGeocodable`` carries the code (its default) + message;
        # ``.model_dump`` gives the ``{"code", "message"}`` object FastAPI nests under
        # ``detail`` — the same ``{"detail": {"code", "message"}}`` envelope the entry
        # endpoint's coded refusals send (``entry_refused`` / ``_score_conflict``).
        detail=AddressNotGeocodable(
            message=ADDRESS_NOT_GEOCODABLE_MESSAGE
        ).model_dump(),
    )


# The transport-neutral tournament write verbs (``tournament_edit`` /
# ``tournament_draw_service`` / ``tournament_solve_service``) each raise this closed
# family of domain exceptions for the refusals that map identically across every
# owner-only write; ``_map_tournament_write_error`` reproduces the exact status +
# body each adapter produced inline. ``_TOURNAMENT_WRITE_ERRORS`` is the shared
# ``except`` tuple; the alias types the mapper. Mirrors the score-write precedent
# (``matches._map_score_write_error`` + ``_SCORE_WRITE_ERRORS``). The genuinely
# verb-specific arms — the strict league 404, the no-drawn-events 422, the
# queue-down 503, and the ``DrawError`` family's 422 — stay inline in their adapters,
# because each is one adapter's alone.
_TournamentWriteError = (
    TournamentNotFoundError
    | NotTournamentOwnerError
    | EventNotFoundError
    | DrawUnderWayError
    | LeagueNotEditableError
)
_TOURNAMENT_WRITE_ERRORS = (
    TournamentNotFoundError,
    NotTournamentOwnerError,
    EventNotFoundError,
    DrawUnderWayError,
    LeagueNotEditableError,
)


def _map_tournament_write_error(exc: _TournamentWriteError) -> HTTPException:
    """Adapt a shared tournament-write domain exception to its historical HTTP
    response: ``TournamentNotFoundError`` → 404 ``"Tournament not found."``,
    ``NotTournamentOwnerError`` → 403 ``"You can only modify tournaments you
    created."``, ``EventNotFoundError`` → 404 ``"Event not found."``, and both
    ``DrawUnderWayError`` and ``LeagueNotEditableError`` → 409 with their own
    carried, domain-authored sentence (``str(exc)``)."""
    if isinstance(exc, TournamentNotFoundError):
        return HTTPException(status_code=404, detail="Tournament not found.")
    if isinstance(exc, NotTournamentOwnerError):
        return HTTPException(
            status_code=403,
            detail="You can only modify tournaments you created.",
        )
    if isinstance(exc, EventNotFoundError):
        return HTTPException(status_code=404, detail="Event not found.")
    # ``DrawUnderWayError`` and ``LeagueNotEditableError`` both carry the exact 409
    # sentence the handler used to compose inline — rebuilt verbatim with ``str``.
    return HTTPException(status_code=409, detail=str(exc))


# ----- tournament routes ---------------------------------------------------


def _near_me_or_422(
    *, lat: float | None, lng: float | None, radius_miles: float | None
) -> NearMeFilter | None:
    """Parse the list's ``lat``/``lng``/``radius_miles`` query triple into a
    :class:`NearMeFilter`, enforcing **all-or-nothing** at the boundary.

    The three are one filter, not three independent knobs: a point without a radius
    (or a radius without a point) cannot describe "near me", so a *partial* triple is a
    client bug worth a 422, not something to silently ignore (parse-at-boundaries). All
    three absent is the unfiltered list — the request every caller already sends — and
    returns ``None``; all three present returns the filter the haversine reads. Each
    value's own range is checked by the ``Query`` bounds on the handler, so this only
    decides the cross-field "present together or not at all" rule."""
    if lat is None and lng is None and radius_miles is None:
        return None
    if lat is None or lng is None or radius_miles is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "lat, lng and radius_miles must be supplied together (or all "
                "omitted) to filter tournaments near a location."
            ),
        )
    return NearMeFilter(lat=lat, lng=lng, radius_miles=radius_miles)


@router.get(
    "/tournaments",
    response_model=list[TournamentDetailRead],
    dependencies=[Depends(require_view)],
)
async def list_tournaments(
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    # ``Annotated`` (not ``= Query(...)``) so the runtime default is a real ``None``:
    # the handler is called directly, without FastAPI, by the statement-count tripwire
    # in tests/test_tournaments.py, and a ``Query(None)`` sentinel default would reach
    # ``_near_me_or_422`` as a non-null value.
    lat: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    lng: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    radius_miles: Annotated[float | None, Query(gt=0.0)] = None,
) -> list[TournamentDetailRead]:
    """List the tournaments the caller may see, newest first, each as the full detail
    aggregate the list cards render.

    Pass an **all-or-nothing** `lat` / `lng` / `radius_miles` triple to filter to
    tournaments **near a point**: only those whose venue is within `radius_miles` of
    `(lat, lng)` come back, each carrying its `distance_miles` (a haversine
    great-circle distance, in miles). Supplying some but not all three is a `422` — the
    three describe one location filter, not three independent knobs. Omit all three
    (the default) for every visible tournament, with `distance_miles` null.
    """
    # The list page's cards render event-derived stats (event count, total
    # entries, table count), so the list returns the full aggregate — events, their
    # entrants and their draws included — rather than a thinner summary. The FIVE-query
    # batched read (no N+1, whatever the number of tournaments or events) lives in the
    # shared ``list_tournament_details`` so the MCP ``list_my_tournaments`` tool runs
    # the exact same shape; this handler only supplies the WHERE and the optional
    # near-me filter.
    #
    # Scoped by ``_visible_to``: somebody else's draft is not the caller's to see, so it
    # never enters the result set — and, because the filter is a WHERE clause on the
    # first of the five queries, the events and entrants queries are keyed off the
    # surviving ids and cannot leak a hidden tournament's contents either. A predicate
    # costs no extra statement, so the statement-count tripwire in
    # tests/test_tournaments.py still reads the same count — the near-me distance column
    # and radius WHERE ride on that same first query too.
    near_me = _near_me_or_422(lat=lat, lng=lng, radius_miles=radius_miles)
    return await list_tournament_details(
        db,
        where=_visible_to(current_user.id),
        current_user_id=current_user.id,
        near_me=near_me,
    )


@router.post(
    "/tournaments",
    response_model=TournamentRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_create)],
    responses={409: {"model": AddressNotGeocodable}},
)
async def create_tournament(
    payload: TournamentCreate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    geocoder: Geocoder = Depends(get_geocoder),
) -> TournamentRead:
    # Thin adapter over the transport-neutral ``create_tournament`` verb: it owns
    # the STRICT (FastAPI-free) league resolution, the on-write geocode and the write,
    # and signals each refusal with a domain exception. This handler maps each back to
    # the exact status + body it produced before, plus the geocode-failure 409:
    #
    #   LeagueNotFoundError         -> 404 "League not found."
    #   NoDefaultLeagueError        -> 500 "No default league configured."
    #   AddressNotGeocodableError   -> 409 coded ``address_not_geocodable`` refusal
    try:
        tournament = await create_tournament_core(
            db, actor=current_user, payload=payload, geocoder=geocoder
        )
    except LeagueNotFoundError as exc:
        # The STRICT resolution: a ``league_id`` that names no league is a 404,
        # never a silent fall back to the default (ADR-0783).
        raise HTTPException(status_code=404, detail="League not found.") from exc
    except AddressNotGeocodableError as exc:
        # The venue address resolved to zero candidates: a coded 409 refusal, never a
        # coordinate-less write (the columns are NOT NULL). The verb geocodes before
        # ``db.add``, so nothing was written.
        raise _address_not_geocodable() from exc
    except NoDefaultLeagueError as exc:
        # An omitted league binds the default, so a deployment with no default is a
        # broken configuration — the 500 ``resolve_league`` raised inline before.
        raise HTTPException(
            status_code=500, detail="No default league configured."
        ) from exc
    return serialize(
        tournament,
        created_by_username=current_user.username,
        current_user_id=current_user.id,
    )


@router.get(
    "/geocode",
    response_model=GeocodePreview,
    dependencies=[Depends(require_create)],
    responses={409: {"model": AddressNotGeocodable}},
)
async def preview_geocode(
    address: Annotated[str, Query(min_length=1)],
    geocoder: Geocoder = Depends(get_geocoder),
) -> GeocodePreview:
    """Resolve a free-text ``address`` string to coordinates for the web
    "Preview location" pin, without writing anything.

    Its own BFF-style endpoint (root ``CLAUDE.md``, "BFF endpoints"): it fetches
    on a user action — the previewer typing/blurring the venue fields — not on
    page load, so it is not folded into a page endpoint. It resolves through the
    same injected :class:`~app.geocoding.Geocoder` the create/edit write path
    geocodes with, so the pin the previewer sees matches the coordinates a
    subsequent write would record.

    Gated on ``tournament.create``: previewing a venue is part of composing a
    tournament, so the same grant that lets a user create one lets them preview
    its location — this is deliberately not a wide-open geocoding proxy.

    A zero-result / unresolvable address is the same coded ``409`` the write path
    answers (:func:`_address_not_geocodable`, ``address_not_geocodable``), so the
    preview and the write agree on the refusal. Any other geocoder failure
    (:class:`~app.geocoding.GeocoderError`) is unexpected and propagates to the
    ``500`` handler.
    """
    try:
        result = await geocoder.geocode(address)
    except AddressNotGeocodableError as exc:
        raise _address_not_geocodable() from exc
    return GeocodePreview(
        latitude=result.latitude,
        longitude=result.longitude,
        formatted=result.formatted,
    )


@router.get(
    "/tournaments/{tournament_id}",
    response_model=TournamentDetailRead,
    dependencies=[Depends(require_view)],
)
async def get_tournament(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentDetailRead:
    # Fetch the row and creator username in one joined query. The inner join
    # can't drop the row (RESTRICT FK guarantees the creator exists), so a
    # missing row means the tournament itself is absent.
    #
    # ``_visible_to`` rides in the same WHERE as the id lookup, so a hidden
    # tournament leaves by the same 404 as an absent one (see _visible_to).
    row = (
        await db.execute(
            select(Tournament, User.username)
            .join(User, User.id == Tournament.created_by_user_id)
            .where(Tournament.id == tournament_id, _visible_to(current_user.id))
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    tournament, username = row
    # The seven-statement batched composition — events, their entrants, their draws,
    # the completed matches' games (standings), the caller's one ladder rating, the
    # newest solve, and the selectable draw formats the event form's picker renders
    # — lives in the shared ``tournament_detail`` reader, which the
    # MCP ``get_tournament`` tool composes too, so the two surfaces cannot drift. The
    # statement-count pin (tests/test_tournaments.py) is measured against this route,
    # which is the reader plus this one visibility-scoped load.
    return await tournament_detail(
        db,
        tournament,
        created_by_username=username,
        current_user_id=current_user.id,
    )


def _table_not_in_catalogue(exc: TableNotInCatalogueError) -> RequestValidationError:
    """The 422 for a catalogue entry citing a table ``id`` this tournament does not have
    (ADR 20260801) — as a **validation error on that entry's field**, not a hand-rolled
    body.

    The sibling of :func:`_placement_table_not_found`, and the same argument: the body's
    ``id`` did not validate, the only reason the schema could not judge it is that the
    answer lives in the database, and a client should not need a second parser to tell
    "your id is malformed" (a schema 422) from "your id names nothing" (this one).
    Raising the exception the schema raises puts it through the app's own handler, so
    the body is byte-shape-identical to every other 422 this route can produce and no
    new response schema reaches the generated clients.

    The ``loc`` carries the entry's **index** — ``["body", "table_catalogue", i, "id"]``
    — because a catalogue is a list and a client renders a validation error under the
    input that caused it. A refusal that named the array alone would leave the director
    hunting the row across a page of tables.
    """
    return RequestValidationError(
        [
            {
                "type": "value_error",
                "loc": ("body", "table_catalogue", exc.index, "id"),
                "msg": str(exc),
                "input": exc.table_id,
            }
        ]
    )


@router.patch(
    "/tournaments/{tournament_id}",
    response_model=TournamentRead,
    responses={409: {"model": AddressNotGeocodable}},
)
async def update_tournament(
    tournament_id: uuid.UUID,
    payload: TournamentUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    geocoder: Geocoder = Depends(get_geocoder),
) -> TournamentRead:
    """Edit a tournament you own. Absent fields are left alone; a supplied field
    replaces the current value. Owner-only.

    **`table_catalogue` is an id-keyed diff, sent in full and in order.** Each entry
    either carries the `id` of a table this tournament already has — keeping that table,
    with the `label`, `court` and position this payload gives it — or omits the `id` to
    add a new table, whose id the server mints. **A table no entry names is removed.**
    Send back the catalogue you read, edited: the ids came from the read, and naming an
    id this tournament does not have is a `422` on that entry.

    **Removing a table that matches are placed at is a `409` naming the table**, and
    nothing is written. To go through with it, repeat the request with
    `unplace_fixtures_on_removed_tables: true`: the table is removed and those matches
    are unplaced — table, predicted start and call all cleared — which is a thing worth
    saying on purpose rather than a silent side effect of editing the venue. Removing a
    table that only a *pool* reserves needs no confirmation and produces no refusal; the
    pool simply reserves one fewer.

    **`address` has three cases and the value alone cannot tell them apart.** Omit it to
    leave the venue and its coordinates untouched; send a real address to move the venue
    (re-geocoded only when its text actually changed, a `409` when it cannot be
    resolved); send `null` — or an object whose six components are all blank — to remove
    the venue entirely.

    `league_id` may only be changed while the tournament is a `draft`; once it is
    published the ladder is settled (`409`). `status` is not editable here — the
    lifecycle moves only across `POST /v1/tournaments/{id}/transitions`.
    """
    # Thin adapter over the transport-neutral ``edit_tournament`` verb: it owns the
    # load-lock, the owner gate, the league state-rule, the STRICT league lookup, the
    # before-lock geocode of a changed address, the partial apply and the
    # table-catalogue → re-solve trigger, and signals each refusal with a domain
    # exception. This handler maps each back to the exact status + body it produced
    # before, plus the geocode-failure 409:
    #
    #   TournamentNotFoundError    -> 404 "Tournament not found."
    #   NotTournamentOwnerError    -> 403 "You can only modify tournaments you created."
    #   LeagueNotEditableError     -> 409 "This tournament is {status}; its league …"
    #   LeagueNotFoundError        -> 404 "League not found."
    #   AddressNotGeocodableError  -> 409 coded ``address_not_geocodable`` refusal
    #   TableInUseError            -> 409 "…has 2 matches placed at it…" (ADR 20260801)
    #   TableNotInCatalogueError   -> 422 on ``body.table_catalogue[i].id``
    try:
        tournament = await edit_tournament(
            db,
            tournament_id=tournament_id,
            actor=current_user,
            updates=payload,
            geocoder=geocoder,
        )
    except TableInUseError as exc:
        # The catalogue's named refusal: removing a table matches are placed at, with no
        # opt-in. Bare prose, like the pool-set freeze and the league state rule on this
        # same route — it carries the exact domain-authored sentence, rebuilt verbatim
        # with ``str``. Nothing was written (the verb raises before the diff touches a
        # row and long before the commit), so the same request with the opt-in is safe
        # to send straight back.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TableNotInCatalogueError as exc:
        # A catalogue entry cited an id this tournament does not have: a field refusal,
        # shaped like every other 422 on this route (see ``_table_not_in_catalogue``).
        raise _table_not_in_catalogue(exc) from exc
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # Shared arms: the 404 (absent), the 403 (not the owner), and the 409
        # (league not editable) all map identically across the owner-only writes.
        raise _map_tournament_write_error(exc) from exc
    except LeagueNotFoundError as exc:
        # Verb-specific: only the edit verb resolves a league, so the strict 404
        # for a ``league_id`` that names none is this adapter's alone.
        raise HTTPException(status_code=404, detail="League not found.") from exc
    except AddressNotGeocodableError as exc:
        # A changed venue address resolved to zero candidates: the same coded 409 the
        # create path answers. The verb geocodes before the lock and before any
        # ``setattr``/commit, so the edit wrote nothing.
        raise _address_not_geocodable() from exc
    # The owner is the current user, so the username and can_edit are known.
    return serialize(
        tournament,
        created_by_username=current_user.username,
        current_user_id=current_user.id,
    )


@router.delete(
    "/tournaments/{tournament_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_tournament(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    # Thin adapter over the transport-neutral ``delete_tournament`` verb: it owns
    # the load-lock, the owner gate and the delete, and signals each refusal with a
    # domain exception. This handler maps each back to the exact status + body it
    # produced before, so the wire contract (a bodiless 204) is unchanged:
    #
    #   TournamentNotFoundError  -> 404 "Tournament not found."
    #   NotTournamentOwnerError  -> 403 "You can only modify tournaments you created."
    try:
        await delete_tournament_core(
            db, tournament_id=tournament_id, actor=current_user
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # The shared arms: the 404 (absent) and the 403 (not the owner) map
        # identically across the owner-only writes.
        raise _map_tournament_write_error(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- lifecycle routes ----------------------------------------------------
#
# The go-live precondition (``_enforce_ready_to_go_live``), the forward-only edge
# table (``LEGAL_TRANSITIONS``), and the go-live side effects now live on the
# transport-neutral ``transition_tournament`` verb (``app.tournament_lifecycle``), so
# the HTTP route below and the MCP ``transition_tournament`` tool judge the same edges
# and run the same materialization + solve. The verb's three lifecycle 409s
# (``TournamentAlreadyInStatusError`` / ``IllegalTournamentTransitionError`` /
# ``TournamentNotReadyToGoLiveError``) each carry the exact sentence this route used to
# compose inline, so the adapter rebuilds the body verbatim with ``str(exc)``.


@router.post(
    "/tournaments/{tournament_id}/transitions",
    response_model=TournamentRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_tournament_transition(
    tournament_id: uuid.UUID,
    payload: TournamentTransitionCreate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentRead:
    """Move a tournament along its lifecycle, and answer with the moved tournament.

    The lifecycle runs forward only, and exactly three transitions exist:
    `draft` → `published` (publish), `published` → `live` (go live), and
    `live` → `archived` (archive). Anything else is a `409`, including walking
    backwards, skipping a stage, moving out of the terminal `archived`, and
    re-asserting the status the tournament already holds — a request to publish
    an already-published tournament is a stale client, not a no-op.

    **Going live has a precondition** (ADR-0786): the tournament must have at least
    one event, and every event must have a **draw** whose fixtures seat exactly its
    current entrants. Three things are refused with a `409` that names the events at
    fault — a tournament with **no events** (there is nothing to start), an event with
    **no draw**, and an event whose draw is **stale**, cut before somebody entered or
    withdrew. Cut (or re-cut) the draws it names, then go live. Registration is open
    right up to that moment, which is exactly why a draw can go stale under it.

    **Publishing** an empty tournament is unaffected and stays legal: announcing a
    tournament early is fine, starting an empty one is not.

    Owner-only, like every other tournament mutation.
    """
    # Thin adapter over the transport-neutral ``transition_tournament`` verb: it owns
    # the ``FOR UPDATE`` load-lock (so two racing identical requests can't both find a
    # legal edge and both answer 201), the owner gate, the forward-only edge table, the
    # go-live precondition, and the go-live side effects (materialize + queue the
    # ``go_live`` solve), and signals each refusal with a domain exception. This handler
    # maps each back to the exact status + body it produced before, so the wire contract
    # is unchanged:
    #
    #   TournamentNotFoundError            -> 404 "Tournament not found."
    #   NotTournamentOwnerError            -> 403 "You can only modify tournaments …"
    #   TournamentAlreadyInStatusError     -> 409 "This tournament is already {status}."
    #   IllegalTournamentTransitionError   -> 409 "This tournament is {status}; it …"
    #   TournamentNotReadyToGoLiveError    -> 409 the go-live sentence naming the events
    try:
        tournament = await transition_tournament(
            db, tournament_id=tournament_id, actor=current_user, to=payload.to
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # The shared arms: the 404 (absent) and the 403 (not the owner), judged in that
        # order by the locked owner-loader — so a stranger never learns a tournament's
        # status.
        raise _map_tournament_write_error(exc) from exc
    except (
        TournamentAlreadyInStatusError,
        IllegalTournamentTransitionError,
        TournamentNotReadyToGoLiveError,
    ) as exc:
        # The three lifecycle 409s each carry their exact, domain-authored sentence
        # (``str(exc)``): the self-transition's single-ended wording, the illegal
        # edge's two-ended wording, and the go-live precondition's event-naming body.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    # The owner is the current user (the verb's owner gate just said so), so the
    # creator's username and can_edit are both known without another query.
    return serialize(
        tournament,
        created_by_username=current_user.username,
        current_user_id=current_user.id,
    )


# ----- event routes --------------------------------------------------------


@router.post(
    "/tournaments/{tournament_id}/events",
    response_model=TournamentEventRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_event(
    tournament_id: uuid.UUID,
    payload: TournamentEventCreate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentEventRead:
    # Thin adapter over the transport-neutral ``create_event`` verb: it owns the
    # ``FOR UPDATE`` owner-load (404 tournament → 403 not-owner) and the write, and
    # signals each refusal with a domain exception. This handler maps each back to the
    # exact status + body it produced before (via ``_map_tournament_write_error``), so
    # the wire contract is unchanged:
    #
    #   TournamentNotFoundError  -> 404 "Tournament not found."
    #   NotTournamentOwnerError  -> 403 "You can only modify tournaments you created."
    try:
        event, league_id = await create_event_core(
            db, tournament_id=tournament_id, actor=current_user, payload=payload
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        raise _map_tournament_write_error(exc) from exc
    # The verb returns the tournament's ``league_id`` — the ladder the caller's
    # ``entry_state`` is judged against — already loaded under the owner lock, so the
    # shared shaping helper needs no re-query for it. A just-created event has no
    # entrants, draw or results (all empty without a query, ADR-0786), so the helper's
    # only read is the caller's one ladder rating.
    return await shape_created_event_read(
        db, event=event, league_id=league_id, viewer_id=current_user.id
    )


def _pool_not_in_event(exc: PoolNotInEventError) -> RequestValidationError:
    """The 422 for a ``pools`` entry citing an id this event does not have
    (ADR 20260801) — as a **validation error on that entry's field**, not a hand-rolled
    body.

    The exact sibling of :func:`_table_not_in_catalogue`, one resource over, and the
    same argument: the body's ``id`` did not validate, the only reason the schema could
    not judge it is that the answer lives in the database, and a client should not need
    a second parser to tell "your id is malformed" (a schema 422) from "your id names
    nothing" (this one). Raising the exception the schema raises puts it through the
    app's own handler, so the body is byte-shape-identical to every other 422 this route
    can produce and no new response schema reaches the generated clients.

    The ``loc`` carries the entry's **index** — ``["body", "pools", i, "id"]`` — because
    the pools are a list and a client renders a validation error under the input that
    caused it.
    """
    return RequestValidationError(
        [
            {
                "type": "value_error",
                "loc": ("body", "pools", exc.index, "id"),
                "msg": str(exc),
                "input": exc.pool_id,
            }
        ]
    )


@router.patch(
    "/tournaments/{tournament_id}/events/{event_id}",
    response_model=TournamentEventRead,
)
async def update_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    payload: TournamentEventUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentEventRead:
    """Edit an event. Absent fields are left alone; `predicates` replaces wholesale when
    sent.

    **`pools` is an id-keyed diff, sent in full and in order.** Each entry either
    carries the `id` of a pool this event already has — keeping that pool, with the
    `name`, `slot`, `table_ids` and position this payload gives it — or omits the `id`
    to add a new pool, whose id the server mints. **A pool no entry names is removed.**
    Send back the pools you read, edited: the ids came from the read, and naming an id
    this event does not have is a `422` on that entry. Citing the same pool twice is a
    `422` too — a pool id identifies one pool, and the fixtures of a draw name their
    pool by it.

    **Once the event's draw is cut, two things freeze** (ADR-0786) — the facts its
    fixtures were derived from:

    * **its set of pools, in order.** A `pools` payload must cite exactly the pools the
      event already has, in the order they already stand, or it is refused with a
      `409`: a removed pool would leave the fixtures drawn into it pointing at nothing,
      an added one would arrive with no fixtures (the draw was dealt across the pools
      that existed at the cut), and a reorder would relabel which pool counts as
      "first" for a knockout bracket's qualifier seats mid-draw. Editing each pool's
      `name`, `slot` and `table_ids` in place is still allowed.
    * **its `draw_type`.** The draw type chose the strategy that dealt those fixtures,
      so changing it under a standing draw is a `409` too: the event would claim a shape
      its draw does not have. Re-sending the draw type the event already has is not a
      change, and is not refused.

    Nothing else freezes. The event's name, fee, rules and `max_players`, and each
    pool's `table_ids`, `slot` and `name`, all stay editable with a draw standing —
    venues change under a running tournament, and recording that must never cost a
    director the draw. To change the pools themselves or the draw type, remove the draw
    (`DELETE …/draw`), edit, and cut again. With no draw cut, `pools` and `draw_type`
    are ordinary fields.

    Owner-only.
    """
    # Thin adapter over the transport-neutral ``update_event`` verb: it owns the
    # ``FOR UPDATE`` owner-load (404 tournament → 403 not-owner), the event load (404
    # event), the two draw freezes, the partial apply, the timezone reanchor and the
    # scheduling-facts → re-solve trigger, and signals each refusal with a domain
    # exception. This handler maps each back to the exact status + body it produced
    # before, so the wire contract is unchanged:
    #
    #   TournamentNotFoundError  -> 404 "Tournament not found."
    #   NotTournamentOwnerError  -> 403 "You can only modify tournaments you created."
    #   EventNotFoundError       -> 404 "Event not found."
    #   PoolSetFrozenError       -> 409 (its carried, domain-authored sentence)
    #   DrawTypeFrozenError      -> 409 (its carried, domain-authored sentence)
    try:
        event, league_id = await update_event_core(
            db,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=current_user,
            updates=payload,
        )
    except (PoolSetFrozenError, DrawTypeFrozenError) as exc:
        # Both freezes carry the exact 409 sentence the handler used to compose inline —
        # rebuilt verbatim with ``str(exc)``.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PoolNotInEventError as exc:
        # A pools entry cited an id this event does not have: a field refusal, shaped
        # like every other 422 on this route (see ``_pool_not_in_event``).
        raise _pool_not_in_event(exc) from exc
    except _TOURNAMENT_WRITE_ERRORS as exc:
        raise _map_tournament_write_error(exc) from exc
    # The verb returns the tournament's ``league_id`` — the ladder the caller's
    # refreshed ``entry_state`` is judged on (ADR-0783) — already loaded under the owner
    # lock, so the shared shaping helper needs no re-query for it. A PATCH is not a
    # re-cut (ADR-0786): the edited event keeps its entrants, draw and results, which
    # the helper reloads and reprojects (answering ``[]`` would tell the director their
    # draw was thrown away).
    return await shape_event_read(
        db, event=event, league_id=league_id, viewer_id=current_user.id
    )


@router.delete(
    "/tournaments/{tournament_id}/events/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    # Thin adapter over the transport-neutral ``delete_event`` verb: it owns the
    # ``FOR UPDATE`` owner-load (404 tournament → 403 not-owner), the event load (404
    # event) and the delete, and signals each refusal with a domain exception. This
    # handler maps each back to the exact status + body it produced before (via
    # ``_map_tournament_write_error``), so the wire contract (a bodiless 204) is
    # unchanged:
    #
    #   TournamentNotFoundError  -> 404 "Tournament not found."
    #   NotTournamentOwnerError  -> 403 "You can only modify tournaments you created."
    #   EventNotFoundError       -> 404 "Event not found."
    try:
        await delete_event_core(
            db, tournament_id=tournament_id, event_id=event_id, actor=current_user
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        raise _map_tournament_write_error(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- entry routes --------------------------------------------------------


# Both entry verbs now own their own registration-window enforcement (the enter verb's
# ``_enforce_entry_registration_open`` raises the coded ``EntryRefusedError``; the
# withdraw verb's ``_enforce_withdrawal_registration_open`` raises the bare-prose
# ``WithdrawalRegistrationClosedError`` this route maps to its historical 409). Both
# call the ONE shared ``tournament_registration.registration_open`` decision
# (module-qualified so a test can stub the single point for both legs), so the two can
# never disagree about *whether* registration is open — while ADR-0968 keeps the
# machine-readable ``code`` on the entry endpoint alone.


# The enter-verb refusals that do NOT collapse into the shared owner-write mapper
# (``_map_tournament_write_error`` handles the tournament/event 404s and the
# ownership 403 the director path reuses). Each is the enter route's alone, so its
# transport copy lives here in the adapter: the self-path permission 403, the named-
# player 404, the singles-only 400, and the four coded entry refusals (ADR-0968).
_ENTRY_WRITE_ERRORS = (
    NotAllowedToEnterError,
    PlayerNotFoundError,
    NonSinglesEntryError,
    EntryRefusedError,
)


def _map_entry_write_error(
    exc: NotAllowedToEnterError
    | PlayerNotFoundError
    | NonSinglesEntryError
    | EntryRefusedError,
) -> HTTPException:
    """Adapt an enter-verb-specific domain exception to the exact HTTP response the
    handler produced inline: ``NotAllowedToEnterError`` → 403 ``"Forbidden."`` (the
    self-registration permission gate), ``PlayerNotFoundError`` → 404 ``"Player not
    found."``, ``NonSinglesEntryError`` → 400 with its carried sentence, and
    ``EntryRefusedError`` → the coded 409 rebuilt verbatim by ``entry_refused`` (the
    machine-readable ``{"detail": {"code": ..., "message": ...}}`` body, ADR-0968)."""
    if isinstance(exc, NotAllowedToEnterError):
        return HTTPException(status_code=403, detail="Forbidden.")
    if isinstance(exc, PlayerNotFoundError):
        return HTTPException(status_code=404, detail="Player not found.")
    if isinstance(exc, NonSinglesEntryError):
        return HTTPException(status_code=400, detail=str(exc))
    # ``EntryRefusedError`` carries its ``EntryRefusal`` code and fallback message —
    # handed straight to the same factory the route used inline, so the 409 body is
    # byte-for-byte what it was.
    return entry_refused(exc.refusal, str(exc))


@router.post(
    "/tournaments/{tournament_id}/events/{event_id}/entries",
    response_model=TournamentEntrantRead,
    status_code=status.HTTP_201_CREATED,
)
async def enter_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    payload: TournamentEntryCreate | None = None,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentEntrantRead:
    """Enter a player in a singles event — yourself, or (as the tournament's owner)
    somebody else.

    **The body is optional, and its presence chooses the actor** (ADR-0784):

    * **no body** → you are entering *yourself*. Requires the `tournament.enter`
      permission. This is the request every player already sends, and it is unchanged.
    * **`user_id`** → you are the **director** entering that player. Requires that you
      **own** the tournament; anyone else naming a `user_id` that is not their own is a
      `403`. An id that names no (live) player is a `404`.

    Naming *your own* `user_id` is self-registration, not a director entry: same
    permission, and the entry records no adder.

    Registration is open only while the tournament is **`published`** — its status
    *is* its registration window (ADR-0017). Entering an event of a `draft`
    tournament (not announced yet), a `live` one (the field is fixed; the draw is
    cut from it), or an `archived` one (it is over) is a `409` — not a `403`: you
    are permitted, the tournament is simply in the wrong state. **That holds for the
    director too**: there is no override, so a director can neither add a walk-in nor
    remove a no-show once the tournament is live.

    An event's **eligibility rules** are decided against the entrant's rating on the
    tournament's league, and they must satisfy **every** one of them: failing a rule
    (the 1650-rated player entering the "Under 1500" event) is a `409`. A player who
    holds **no rating** on that league — nobody has a rating until they finish a rated
    match — **passes every rule**, so a brand-new player is not shut out of the
    beginners' event that exists for them.

    Entering an event the player is already in is a `409`; withdrawing first frees them
    to enter it again. Entering an event that already holds its `max_players`
    entrants is a `409` too — someone withdrawing frees the slot. Doubles and teams
    events are a `400`: an entry is one row per player, with nowhere to record a
    partner or a team.

    **A director's entry is judged by exactly these rules.** The same evaluator, the
    same capacity lock, the same four refusal codes: a director adding a player to a
    full event, or one over the event's rating cap, is refused precisely as the player
    would be.
    """
    # The whole dual-actor orchestration — the fork, the self-path permission gate, the
    # locked load, the ownership gate, the ordered refusals and the INSERT — lives in
    # the
    # transport-neutral ``enter_event`` verb (``app.tournament_entries``), shared with
    # the
    # MCP ``enter_event`` tool. This adapter parses the actor out of the optional body
    # (``user_id`` present → a director entry; absent → self-registration, ADR-0784) and
    # maps each domain refusal to the exact status/body it produced inline.
    try:
        return await enter_event_core(
            db,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=current_user,
            user_id=payload.user_id if payload is not None else None,
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # The tournament/event 404s and the director-path ownership 403 map identically
        # to every other owner-only tournament write.
        raise _map_tournament_write_error(exc) from exc
    except _ENTRY_WRITE_ERRORS as exc:
        # The enter route's own: self-path permission 403, named-player 404, singles
        # 400,
        # and the four coded entry-refusal 409s (ADR-0968).
        raise _map_entry_write_error(exc) from exc


@router.delete(
    "/tournaments/{tournament_id}/events/{event_id}/entries/{entry_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def withdraw_from_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    entry_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Withdraw an entry from an event — your own, or (as the tournament's owner) any
    entry in it.

    The entry is **soft-deleted**: its status flips to `withdrawn` and the row
    survives, so the event keeps its withdrawal history — and, because the
    uniqueness guard is a *partial* index over active entries only, the player is
    free to enter the same event again afterwards.

    **Who may withdraw an entry** (ADR-0784) mirrors who may create one: the player
    themselves (with the `tournament.enter` permission), or the tournament's **owner**,
    for any entry in it. Anybody else is a `403`.

    Withdrawal, like entry, is open only while the tournament is **`published`** —
    its status *is* its registration window (ADR-0017). Withdrawing an *active*
    entry from a `live` tournament would pull a player out from under a draw cut
    from the field they were part of, so it is a `409`, as it is for a `draft`
    tournament (registration has not opened) and an `archived` one (it is over).
    A `409`, not a `403`: you are permitted, the tournament is simply in the wrong
    state. **The owner obeys that window too** — withdrawal stays symmetric with entry,
    so a director can no more remove a no-show from a live tournament than add a
    walk-in to one.

    **Withdrawing an entry that is already withdrawn is a `204` in every status**,
    `live` and `archived` included — a no-op, not an error: this is `DELETE`, and
    asking for a state the resource is already in is a success. The status gate is
    on the state *change*, not on the call; an entry that is already withdrawn has
    nothing left to lock.
    """
    # The whole soft-delete orchestration — the locked load, the
    # tournament/event/entry 404s, the owner-or-self fork (ADR-0784), the window gate on
    # the state change and the seated re-solve trigger — lives in the transport-neutral
    # ``withdraw_from_event`` verb (``app.tournament_entries``), shared with the MCP
    # ``withdraw_from_event`` tool. This adapter maps each domain refusal to the exact
    # status/body it produced inline and answers the same bodiless 204.
    try:
        await withdraw_from_event_core(
            db,
            tournament_id=tournament_id,
            event_id=event_id,
            entry_id=entry_id,
            actor=current_user,
        )
    except (TournamentNotFoundError, EventNotFoundError) as exc:
        # The tournament/event 404s map identically to every other tournament write.
        raise _map_tournament_write_error(exc) from exc
    except EntryNotFoundError as exc:
        # The withdraw route's own 404: the entry does not resolve under this event.
        raise HTTPException(status_code=404, detail="Entry not found.") from exc
    except NotAllowedToEnterError as exc:
        # The self path lacking ``tournament.enter`` — the same 403 ``"Forbidden."`` the
        # enter route's self gate produces (they share the one domain exception).
        raise HTTPException(status_code=403, detail="Forbidden.") from exc
    except NotAllowedToWithdrawError as exc:
        # Neither the entry's owner nor the tournament's owner.
        raise HTTPException(
            status_code=403,
            detail="You can only withdraw your own entry.",
        ) from exc
    except WithdrawalRegistrationClosedError as exc:
        # Withdrawing an active entry outside the registration window — the bare-prose
        # 409 (ADR-0968 keeps the coded refusals to the entry endpoint), rebuilt
        # verbatim from the domain-authored sentence.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- the draw (ADR-0786) --------------------------------------------------
#
# One sub-resource, two verbs: POST cuts (or re-cuts) an event's draw, DELETE un-cuts
# it. The draw is *read* on the tournament-detail BFF, with the event that owns it —
# one endpoint per page (root CLAUDE.md) — so there is deliberately no ``GET …/draw``
# here to make a bracket a second round-trip.
#
# Both verbs are owner-only and take the tournament's row lock, and both are refused for
# exactly one reason: **evidence of play**. Not the tournament's status — status-gating
# was considered and rejected (ADR-0786), because it forbids the legitimate day-of move
# (a no-show is withdrawn before the first ball, and the director re-cuts) while
# protecting nothing the play guard does not already protect.


def _draw_refusal(error: DrawError) -> HTTPException:
    """The 422 for a draw the domain will not produce — in words a director can read.

    A ``DrawError`` is not a bug: it is the domain saying that what was asked for is not
    a competition (``DegenerateDraw``) or is not a shape a fixture can seat
    (``NonSinglesDraw``). So it is a 422 — the request is well-formed and
    authorized, but its *content* (this event's pools, this event's field, this event's
    draw type) cannot be turned into a draw — rather than the 500 an uncaught exception
    would be, and rather than a 409, which would invite a retry that will fail
    identically until the director changes the event.

    The ``match`` over the error that composes the director-facing sentence now lives
    in :func:`app.draws.draw_error_detail` — shared with the ``published → live`` dry
    run in ``app.tournament_lifecycle``, which hits the same errors when it plans a
    cut ahead of time to see whether it would succeed, so the two call sites' copy
    cannot drift apart. See that function's docstring for what each error composes to.
    """
    return HTTPException(status_code=422, detail=draw_error_detail(error))


# The play-evidence gate, the owner-scoped locking load, and the ``cut_draw`` /
# ``uncut_draw`` calls now live on the transport-neutral draw verbs
# (``app.tournament_draw_service``): they raise ``DrawUnderWayError`` /
# ``EventNotFoundError`` / ``NotTournamentOwnerError`` / ``TournamentNotFoundError``,
# and let the ``DrawError`` family propagate unchanged, for the two adapters below to
# map back to the exact codes + bodies this router used to raise inline. They are not
# router helpers any more precisely so the cut/uncut logic has one home the MCP tool
# will share too.


@router.post(
    "/tournaments/{tournament_id}/events/{event_id}/draw",
    response_model=list[TournamentFixtureRead],
    status_code=status.HTTP_201_CREATED,
)
async def cut_event_draw(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[TournamentFixtureRead]:
    """Cut this event's draw — generate its **fixtures** from its entrants — and answer
    with them.

    Cutting is an explicit, reviewable act, and it is **not** tied to the tournament's
    status: a draw may be cut and re-cut freely while a director inspects the pools and
    the seeding. Nothing else creates fixtures, and going live requires every event to
    have one (ADR-0786).

    **Re-cutting replaces the draw wholesale.** The previous fixtures are deleted and a
    fresh set is planned from the event's *current* active entrants — the old ones are
    not patched, and their ids do not survive. That is the point: a draw is a plan made
    against a field, and once the field has changed (somebody entered, somebody
    withdrew) the whole plan is re-made, pool sizes and seeding included.

    Entrants are ordered by **seed** ascending where one is set, then by **registration
    order**. Nothing is random, so the same field always cuts the same draw.

    Refused with a `409` once the draw shows any **evidence of play** — any fixture with
    a recorded winner, or any fixture that has become a real match. A re-cut would throw
    those away, and a draw must never silently eat a score.

    Refused with a `422` when this event cannot produce a draw at all: it has
    **no pools** configured for a pooled draw type, its field is too small for the
    pools it has — a pool with fewer than two players has nobody to play — or a
    bracket has fewer than two entrants. The message names what to change.

    There is no longer a "this draw type has no generator" refusal here: every
    draw type a director can pick is one that has a strategy, because the pickable
    set *is* the seeded `draw_types` rows, and those are the types that run
    (ADR 20260726). Every `422` this route can raise is now about the event's
    **field or pools**, not its type.

    Owner-only. Fixtures come back in pool → round → position order, exactly as the
    tournament-detail page carries them.
    """
    # Thin adapter over the transport-neutral ``cut_event_draw`` verb: it owns the
    # row lock, the owner gate, the event-under-tournament load, the play-evidence
    # gate, the ``cut_draw`` core, the re-solve trigger and the read-back, and signals
    # each refusal with a domain exception (letting the ``DrawError`` family through
    # unchanged). This handler maps each back to the exact status + body it produced
    # before, so the wire contract is unchanged:
    #
    #   TournamentNotFoundError  -> 404 "Tournament not found."
    #   EventNotFoundError       -> 404 "Event not found."
    #   NotTournamentOwnerError  -> 403 "You can only modify tournaments you created."
    #   DrawUnderWayError        -> 409 "This event's draw is already under way — …"
    #   DrawError (the family)   -> 422, the sentence ``_draw_refusal`` composes
    try:
        return await _cut_event_draw(
            db, tournament_id=tournament_id, event_id=event_id, actor=current_user
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # Shared arms: the two 404s (absent tournament / event), the 403 (not the
        # owner), and the draw-under-way 409 all map identically across the writes.
        raise _map_tournament_write_error(exc) from exc
    except DrawError as error:
        # The domain refusing to produce a draw is not a bug — it is an answer (the verb
        # already rolled back). ``from None`` so no traceback shape reaches the client;
        # the sentence is composed in ``_draw_refusal``.
        raise _draw_refusal(error) from None


@router.delete(
    "/tournaments/{tournament_id}/events/{event_id}/draw",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def uncut_event_draw(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Un-cut this event's draw: delete its fixtures, leaving the event with no draw.

    The way back from a draw the director does not want. The event, its entrants and the
    rest of the tournament are untouched — only the fixtures go — and the director is
    free to change the pools and cut again.

    Refused with a `409` on the same **evidence of play** that refuses a re-cut: a
    fixture with a recorded winner, or one that has become a real match. Undoing a draw
    that has been played would delete the fixtures those results belong to.

    An event with **no draw is already in the state this asks for**, so removing a draw
    that was never cut is a `204`, not a `404`: this is a DELETE, and it is idempotent.

    Owner-only.
    """
    # Thin adapter over the transport-neutral ``uncut_event_draw`` verb: it owns the
    # row lock, the owner gate, the event-under-tournament load, the play-evidence
    # gate, the ``uncut_draw`` core and the ``had_draw``-gated re-solve trigger, and
    # signals each refusal with a domain exception. This handler maps each back to the
    # exact status + body it produced before, so the wire contract is unchanged (the
    # un-cut never produces a ``DrawError`` — it only deletes):
    #
    #   TournamentNotFoundError  -> 404 "Tournament not found."
    #   EventNotFoundError       -> 404 "Event not found."
    #   NotTournamentOwnerError  -> 403 "You can only modify tournaments you created."
    #   DrawUnderWayError        -> 409 "This event's draw is already under way — …"
    try:
        await _uncut_event_draw(
            db, tournament_id=tournament_id, event_id=event_id, actor=current_user
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # Shared arms only — the un-cut never produces a ``DrawError`` (it only
        # deletes), so every refusal it can raise maps through the shared adapter.
        raise _map_tournament_write_error(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- fixture placement (ADR-0790) -----------------------------------------
#
# A placement is two nullable columns on a fixture — ``table_id`` (a foreign key into
# ``tournament_tables``) and ``scheduled_start`` (a predicted wall-clock time, anchored
# to an instant). A human PATCHes them here; the schedule solver writes the same two
# fields. The placement RIDES the tournament-detail BFF on read (2a put the fields
# on ``TournamentFixtureRead``), so there is deliberately no ``GET …/placement``.
#
# The write is **soft** where ADR-0790 made it soft: the table belongs to the fixture's
# pool, the time falls inside the pool's window, nothing is double-booked — all three
# are flags derived on read, NOT invariants, so this route stores an out-of-window time
# and an off-pool table without complaint. What it does NOT store is a ``table_id`` that
# names no table: "the placement names a real table" became an invariant when the
# catalogue became rows (ADR 20260801), so that is a 422 naming the field. Plus the
# freeze below.
#
# But a manual placement is a **pin** (ADR "the schedule is solved; the call is
# pinned"): the director's hand is a human commitment every later solve schedules
# around, and while the tournament is live, placing a fixture IS calling it. The whole
# orchestration — the load-lock, the fixture load, the freeze, the pin/notify
# transition (``app.match_calls.apply_manual_placement``), the re-solve enqueue and the
# read-back — now lives on the transport-neutral ``place_fixture`` verb
# (``app.tournament_placement``), so the HTTP route below and the MCP ``place_fixture``
# tool run the same transition. The verb raises :class:`FixtureNotFoundError` (404),
# :class:`FixturePlacementFrozenError` (409, carrying the freeze sentence) and
# :class:`PlacementTableNotFoundError` (422, carrying the id that named no table), which
# the adapter maps to the responses this route produces.


def _placement_table_not_found(
    exc: PlacementTableNotFoundError,
) -> RequestValidationError:
    """The 422 for a placement whose ``table_id`` names no table in the tournament's
    catalogue (ADR 20260801) — as a **validation error on the field**, not a hand-rolled
    body.

    A ``RequestValidationError`` rather than an ``HTTPException``, because that is
    precisely what this is: the body's ``table_id`` did not validate. The only reason
    the schema could not judge it is that the answer lives in the database, and a client
    should not have to tell "your table_id is malformed" (a schema 422) apart from "your
    table_id names nothing" (this one) by parsing two different envelopes. Raising the
    same exception the schema raises puts it through the app's own handler
    (``app.main.validation_error_handler``), so the body is byte-shape-identical to
    every other 422 the route can produce — ``{"detail": [{"loc": ["body",
    "table_id"], …}]}``, already the documented ``HTTPValidationError`` of this
    operation — and no new response schema reaches the generated clients.

    Contrast ``_no_drawn_events_refusal`` and the geocoding refusal, which are about the
    *state of the tournament* rather than a field of the body and so carry a coded
    ``detail`` object of their own. This one names a field, so it is shaped like a field
    refusal.
    """
    return RequestValidationError(
        [
            {
                "type": "value_error",
                "loc": ("body", "table_id"),
                "msg": str(exc),
                "input": exc.table_id,
            }
        ]
    )


@router.patch(
    "/tournaments/{tournament_id}/fixtures/{fixture_id}/placement",
    response_model=TournamentFixtureRead,
)
async def place_fixture(
    tournament_id: uuid.UUID,
    fixture_id: uuid.UUID,
    payload: TournamentFixturePlacementUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentFixtureRead:
    """Set (or clear) a fixture's **placement** — its table and its predicted start
    (ADR-0790) — and answer with the updated fixture.

    The body is the placement in full: `table_id` (the id of one of the tournament's
    `table_catalogue` tables) and `scheduled_start` (a **naive** wall-clock time, in the
    venue's local frame — an offset-aware value is a `422`). `null` on either clears
    that half; `(null, null)` unassigns the fixture.

    **A manual placement is a pin.** The director's hand is a human commitment the
    schedule solver plans around, not a suggestion it may undo: a full placement (both
    halves set, both entrants known) sets `pinned_at`, and every later solve treats the
    fixture as a fixed interval. While the tournament is **live**, placing a fixture
    *is* calling it — a first placement notifies both entrants, and re-placing a
    fixture whose players were already told sends them a "your match moved" correction
    carrying the new table and time; `call_notified_count` counts exactly those
    tellings, which is the price to state before a re-drag. Pre-live placements are
    silent pins: free rearranging while planning, nobody paged. A fixture with a TBD
    side stores the placement but does **not** pin (a promise to nobody is not a
    promise) — the solver may still move it.

    **Clearing unpins.** Anything short of a full placement clears `pinned_at`; if the
    players had been called, both get a cancellation ("the schedule changed"). Pre-live
    or never-notified clears are silent. The count never resets — it is a history of
    tellings, and a cancellation is one.

    Every successful write also queues a re-solve (`settings_changed`): the director
    just changed the solver's inputs, so the board re-plans around the new pin set.

    **The table must exist.** A `table_id` that names no table in this tournament's
    `table_catalogue` is a `422` naming the field — the one thing about a placement that
    is an invariant rather than a flag. A placement whose table does not exist is not a
    state you chose; it is a dangling reference nothing can render.

    **The placement is otherwise soft.** `scheduled_start` is a *prediction* until
    pinned, and the placement's other constraints — the table belongs to the fixture's
    pool, the time falls inside the pool's window, nothing is double-booked — are flags
    derived on read, **not** invariants. So an out-of-window time, or a table outside
    the fixture's pool, is **stored, not rejected**; the queued re-solve is what judges
    the consequences.

    **The one hard rule about the fixture:** a fixture whose linked match is `completed`
    or `voided` is history, so its placement can no longer be changed — a `409`. A
    fixture with no
    match yet, or a `pending`/`in_progress` one, is freely (re)placeable (a round-robin
    match is born `pending` at go-live and only becomes `in_progress` when called, so
    neither is the freeze trigger).

    Owner-only, like every other tournament mutation: an absent tournament, or a fixture
    that is not part of it, is a `404`; a non-owner is a `403`.
    """
    # Thin adapter over the transport-neutral ``place_fixture`` verb: it owns the
    # load-lock, the owner gate, the fixture load, the freeze, the pin/notify transition
    # (``apply_manual_placement``), the ``settings_changed`` re-solve trigger, the
    # commit, the post-commit fan-out and the read-back, and signals each refusal with a
    # domain exception. This handler maps each back to the exact status + body it
    # produced before, so the wire contract is unchanged:
    #
    #   TournamentNotFoundError      -> 404 "Tournament not found."
    #   NotTournamentOwnerError      -> 403 "You can only modify tournaments …"
    #   FixtureNotFoundError         -> 404 "Fixture not found."
    #   FixturePlacementFrozenError  -> 409 "This fixture's match is already {status}…"
    #   PlacementTableNotFoundError  -> 422 on ``body.table_id`` (ADR 20260801)
    try:
        return await place_fixture_core(
            db,
            tournament_id=tournament_id,
            fixture_id=fixture_id,
            actor=current_user,
            placement=payload,
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # Shared arms: the 404 (tournament absent) and the 403 (not the owner) map
        # identically across the owner-only writes.
        raise _map_tournament_write_error(exc) from exc
    except FixtureNotFoundError as exc:
        # Verb-specific: a fixture that names no row under this tournament is a 404,
        # the same not-found ``_get_fixture_or_404`` raised inline (a mismatched
        # tournament/fixture pair included).
        raise HTTPException(status_code=404, detail="Fixture not found.") from exc
    except FixturePlacementFrozenError as exc:
        # Verb-specific: a played-out (``completed``/``voided``) fixture keeps its
        # placement — the exact 409 sentence the handler used to compose inline,
        # rebuilt verbatim with ``str``.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PlacementTableNotFoundError as exc:
        # Verb-specific: the placement named no table of this tournament (ADR 20260801).
        raise _placement_table_not_found(exc) from exc


# ----- the schedule solver (ADR "the schedule is solved; the call is pinned") -----
#
# One verb: POST queues a run of the placement solver — the owner's Run-scheduler
# button. The solve's *outcome* is read on the tournament-detail BFF
# (``latest_schedule_solve``, plus each fixture's placement and pin facts), one
# endpoint per page (root CLAUDE.md), so there is deliberately no ``GET`` here.

#: The machine-readable code for "nothing to schedule" — the client switches on it
#: and owns its copy; the message below is the fallback prose (the
#: ``tournament_entry_refusals`` / ``sessions.py`` shape).
NO_DRAWN_EVENTS_CODE = "no_drawn_events"


def _no_drawn_events_refusal() -> HTTPException:
    """The 422 for a schedule solve on a tournament with no cut draw anywhere.

    A 422 rather than a 409, for the same reason ``_draw_refusal`` is: the request is
    well-formed and authorized, but its content — this tournament, as it stands — has
    nothing the solver can place, and retrying unchanged fails identically until the
    director cuts a draw. The detail is the ``{"code": ..., "message": ...}`` shape
    (``tournament_entry_refusals``): the code is the contract, the message is the
    fallback.

    One sentence for every arity — a tournament with no events and one with ten
    undrawn events are refused for the same reason (nothing is drawn), and copy that
    counted events would have to pluralize correctly in both (#1048, #1059) for a
    distinction the director cannot act on differently anyway: either way the fix is
    to cut a draw.
    """
    return HTTPException(
        status_code=422,
        detail={
            "code": NO_DRAWN_EVENTS_CODE,
            "message": (
                "There is nothing to schedule yet: no event of this tournament has "
                "a draw. The scheduler places a draw's fixtures onto tables, so cut "
                "at least one event's draw, then run it."
            ),
        },
    )


@router.post(
    "/tournaments/{tournament_id}/schedule/solves",
    response_model=ScheduleSolveRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def request_schedule_solve(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ScheduleSolveRead:
    """Queue a run of the schedule solver for this tournament — the Run-scheduler
    button — and answer with the ledger row that will carry its outcome.

    **One solve in flight per tournament**, so this is a request, not a command:
    if a run is already `queued`, this click is absorbed by it and the existing row
    comes back (same id — the pending run will see whatever state motivated the
    click); if one is `running`, its re-run flag is set and the running row comes
    back (a fresh run follows at its finish). Only when neither exists is a new run
    queued. The `202` is honest either way — the work is accepted, not done. Poll
    the tournament detail's `latest_schedule_solve` for the outcome.

    Allowed in **any** tournament status, from the moment any event has a cut draw
    — exactly as cutting a draw itself is not status-gated. Pre-live solves are the
    point: an infeasible verdict before going live is how a director learns the day
    does not fit while there is still time to change it.

    Refused with a `422` — `{"code": "no_drawn_events", "message": ...}` — when no
    event of this tournament has a draw: the solver places a draw's fixtures, so
    with nothing cut there is nothing to schedule. A `503` means the scheduling
    queue itself was unreachable; nothing was queued, and the same request is safe
    to retry.

    Owner-only, like every other tournament mutation: an absent tournament is a
    `404`, a non-owner a `403`.
    """
    # Thin adapter over the transport-neutral ``request_schedule_solve`` verb: it
    # owns the row lock, the owner gate, the no-drawn-events gate, the coalesced
    # ``request_solve`` enqueue and the commit + read-back, and signals each refusal
    # with a domain exception. This handler maps each back to the exact status +
    # body it produced before, so the wire contract is unchanged (404 → 403 → 422,
    # ADR-0017's ordering; the 503 is the queue-down case):
    #
    #   TournamentNotFoundError        -> 404 "Tournament not found."
    #   NotTournamentOwnerError        -> 403 "You can only modify tournaments you …"
    #   NoDrawnEventsError             -> 422 {"code": "no_drawn_events", "message": …}
    #   ScheduleQueueUnavailableError  -> 503 "The scheduling queue is unavailable, …"
    try:
        row = await _request_schedule_solve(
            db, tournament_id=tournament_id, actor=current_user
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # Shared arms: the 404 (absent) and the 403 (not the owner). The verb never
        # raises the event/draw-under-way members of the tuple, so they cannot fire
        # here — but catching the whole tuple keeps the one shared mapper.
        raise _map_tournament_write_error(exc) from exc
    except NoDrawnEventsError as exc:
        # The exact 422 body this route composed inline — kept in the adapter, like
        # every other tournament refusal's HTTP copy.
        raise _no_drawn_events_refusal() from exc
    except ScheduleQueueUnavailableError as exc:
        # The enqueue failed (Redis down) and the verb took its row back out —
        # nothing was queued, so the honest answer is "not available", not a ledger
        # row that names a run that does not exist. Same request is safe to retry.
        raise HTTPException(
            status_code=503,
            detail=(
                "The scheduling queue is unavailable, so the solve was not queued. "
                "Try again in a moment."
            ),
        ) from exc
    return ScheduleSolveRead.model_validate(row)


async def _preview_rate_limit_key(request: Request) -> str:
    """Key the tight schedule-preview limiter by the caller's hashed session cookie
    so the budget is per **session**, independent of other directors. The raw cookie
    is a bearer credential, so it is sha256-hashed before it becomes a Redis key
    (matching the email limiters). A cookie-less request falls back to client IP — it
    will 401 downstream anyway, but the limiter still counts the attempt."""
    cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie:
        return f"session:{hashlib.sha256(cookie.encode('utf-8')).hexdigest()}"
    client = request.client
    return f"ip:{client.host if client else 'unknown'}"


async def _preview_ip_rate_limit_key(request: Request) -> str:
    """Per-IP key for the looser ceiling that catches a caller cycling fresh
    `/v1/session` cookies to bypass the per-session limit (each `GET /v1/session`
    mints a new one for free), so the per-session budget can't simply be multiplied
    by rotating sessions from one host."""
    client = request.client
    return f"schedule-preview-ip:{client.host if client else 'unknown'}"


# A preview runs the full CP-SAT engine, so it is the expensive click on this
# router. Two-tier, matching the email limiters' precedent (a per-session limit is
# not per-*owner* — a director can mint unlimited guest sessions — so a per-IP
# ceiling caps the aggregate a single host can drive):
#   - tight per-session cap (six a minute), comfortably above a director tweaking a
#     knob and re-previewing but well below anything that would saturate the single
#     preview worker slot;
#   - looser per-IP ceiling so rotating sessions from one host can't multiply that
#     budget.
# The poll (GET) and cancel (DELETE) are cheap and unlimited.
preview_request_rate_limit = RedisRateLimiter(
    rates=[Rate(6, Duration.MINUTE)],
    bucket_key="schedule-preview",
    identifier=_preview_rate_limit_key,
)
preview_request_ip_rate_limit = RedisRateLimiter(
    rates=[Rate(20, Duration.MINUTE)],
    bucket_key="schedule-preview-ip",
    identifier=_preview_ip_rate_limit_key,
)


@router.post(
    "/tournaments/{tournament_id}/schedule/preview",
    response_model=PreviewEnqueued,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[
        Depends(preview_request_ip_rate_limit),
        Depends(preview_request_rate_limit),
    ],
)
async def request_schedule_preview(
    tournament_id: uuid.UUID,
    body: PreviewRequest | None = None,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> PreviewEnqueued:
    """Enqueue an ephemeral **schedule preview** for a pre-live tournament and
    answer with a token plus the immediately-known structure.

    A preview asks *"given my tables, windows, formats and games-per-match, would
    the schedule even fit — and roughly how long is the day?"* **before anyone has
    registered**. It runs the same CP-SAT engine a live tournament uses over a
    **synthetic field**, but persists nothing: the whole answer lives only in the
    job's Redis result with a short TTL. Poll `GET …/schedule/preview/{token}` for
    it (the `202` is honest — the solve is accepted, not done).

    The body is optional per-event field-size overrides (`{"overrides": {"<event
    id>": N}}`) to explore a "what if N show up" scenario; omit it and each event
    fills to its own cap (or the uncapped default).

    Owner-only, and only while the tournament is **pre-live** — a `draft` or a
    `published` (registration open, nothing drawn) tournament. An absent tournament
    is a `404`, a non-owner a `403`, and a `live`/`archived` tournament a `409`
    (there is a real field and a real solve to look at, or it is over). Rate
    limited per session with a per-IP ceiling: too many previews in quick
    succession is a `429`.
    """
    # Thin adapter over the transport-neutral ``request_schedule_preview`` verb: it
    # owns the owner gate (404 → 403), the pre-live gate, the synchronous snapshot
    # build and the ephemeral enqueue, signalling each refusal with a domain
    # exception this handler maps back to its exact status:
    #
    #   TournamentNotFoundError        -> 404 "Tournament not found."
    #   NotTournamentOwnerError        -> 403 "You can only modify tournaments you …"
    #   TournamentNotPreLiveError      -> 409, the status-carrying domain sentence
    #   DrawError (the family)         -> 422, the sentence ``_draw_refusal`` composes
    #   ScheduleQueueUnavailableError  -> 503 "The scheduling queue is unavailable, …"
    overrides = body.overrides if body is not None else {}
    try:
        return await _request_schedule_preview(
            db,
            tournament_id=tournament_id,
            actor=current_user,
            count_overrides=overrides or None,
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # Shared arms: the 404 (absent) and the 403 (not the owner). The verb never
        # raises the event/draw-under-way members of the tuple, so they cannot fire
        # here — but catching the whole tuple keeps the one shared mapper.
        raise _map_tournament_write_error(exc) from exc
    except TournamentNotPreLiveError as exc:
        # A ``live``/``archived`` tournament: a preview is a pre-registration
        # question, refused with the status-carrying sentence the domain authored.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except DrawError as error:
        # A draw the synthetic field cannot be planned (a degenerate one), or a
        # tournament whose every event is a draw type the preview cannot lay out —
        # the same 422 the cut route produces, in words a director can read. A single
        # unpreviewable event beside a previewable one is not this: it is skipped, and
        # the honest-notes strip on the finished preview names it.
        raise _draw_refusal(error) from error
    except ScheduleQueueUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "The scheduling queue is unavailable, so the preview was not "
                "queued. Try again in a moment."
            ),
        ) from exc


@router.get(
    "/tournaments/{tournament_id}/schedule/preview/{token}",
    response_model=PreviewJobState,
)
async def read_schedule_preview(
    tournament_id: uuid.UUID,
    token: str,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> PreviewJobState:
    """Poll an ephemeral **schedule preview** by its token and answer with the
    job's state — `queued`, `running`, `done` (carrying the `PreviewResult`), or
    `failed` (carrying an error string, including a result that has already expired
    out of Redis).

    Owner-gated the same way the enqueue is: the tournament is re-loaded and the
    caller must own it (an absent tournament is a `404`, a non-owner a `403`, a
    `live`/`archived` tournament a `409`) before the ephemeral job — which is not
    itself scoped to a tournament in Redis — is read, and the token is then bound to
    this tournament: a real job enqueued for a *different* tournament is a `404`, so
    an owner can't pair their own tournament id with another director's token. A
    missing/expired token is *not* a `404`: it is a `done`-or-`failed` job state, so
    the client renders "run it again" rather than a transport error.
    """
    # Re-apply the owner + pre-live gate before reading the (tournament-blind)
    # Redis job, so a token cannot be polled by anyone but the tournament's owner —
    # then bind the token to this tournament (``preview_job_state`` raises the
    # not-found error, → 404, if the job was enqueued for a different one), so an
    # owner can't pair their own tournament id with another director's token.
    try:
        await ensure_preview_access(db, tournament_id, current_user)
        return preview_job_state(token, tournament_id)
    except _TOURNAMENT_WRITE_ERRORS as exc:
        raise _map_tournament_write_error(exc) from exc
    except TournamentNotPreLiveError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete(
    "/tournaments/{tournament_id}/schedule/preview/{token}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_schedule_preview(
    tournament_id: uuid.UUID,
    token: str,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Best-effort cancel an ephemeral **schedule preview** by its token — the
    director navigated away, so stop the in-flight solve from holding a worker
    slot. Answers `204` whether the job was queued, running, already finished, or
    never existed: a cancel is advisory and idempotent, its only invariant "this
    ephemeral job is no longer consuming a worker", which an absent/finished job
    already satisfies. A cancelled preview's result is dropped, so it cannot be
    polled back as a stale success.

    Owner-gated exactly as the poll is (`404`/`403`/`409`) before the
    tournament-blind Redis job is touched, so a token cannot be cancelled by
    anyone but the tournament's owner.
    """
    try:
        await ensure_preview_access(db, tournament_id, current_user)
        # Bind the token to this tournament (``cancel_preview`` raises the not-found
        # error, → 404, on a job enqueued for a different one) before the advisory
        # cancel, so a token can't be cancelled by anyone but the tournament's owner.
        cancel_preview(token, tournament_id)
    except _TOURNAMENT_WRITE_ERRORS as exc:
        raise _map_tournament_write_error(exc) from exc
    except TournamentNotPreLiveError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
