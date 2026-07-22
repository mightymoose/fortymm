import hashlib
import uuid
from typing import Literal, assert_never

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pyrate_limiter import Duration, Rate
from sqlalchemy import exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.draws import (
    DegenerateDraw,
    DrawError,
    NonSinglesDraw,
    UnsupportedDrawType,
)
from app.match_calls import apply_manual_placement, enqueue_call_fanout
from app.models import (
    EventFormat,
    Match,
    MatchStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.rate_limiting import RedisRateLimiter
from app.rbac import require_permission, user_has_permission
from app.schedule_preview_solve import (
    cancel_preview,
    ensure_preview_access,
    preview_job_state,
)
from app.schedule_preview_solve import (
    request_schedule_preview as _request_schedule_preview,
)
from app.schedule_solves import request_solve
from app.schemas.schedule_preview import (
    PreviewEnqueued,
    PreviewJobState,
    PreviewRequest,
)
from app.schemas.tournament import (
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
from app.tournament_eligibility import (
    Eligible,
    RatingIneligible,
    evaluate_rating_eligibility,
    event_is_full,
)
from app.tournament_entry_refusals import EntryRefusal, entry_refused
from app.tournament_errors import (
    DrawTypeFrozenError,
    DrawUnderWayError,
    EventNotFoundError,
    IllegalTournamentTransitionError,
    LeagueNotEditableError,
    LeagueNotFoundError,
    NoDefaultLeagueError,
    NoDrawnEventsError,
    NotTournamentOwnerError,
    PoolSetFrozenError,
    ScheduleQueueUnavailableError,
    TournamentAlreadyInStatusError,
    TournamentNotFoundError,
    TournamentNotPreLiveError,
    TournamentNotReadyToGoLiveError,
)
from app.tournament_events import create_event as create_event_core
from app.tournament_events import delete_event as delete_event_core
from app.tournament_events import update_event as update_event_core
from app.tournament_lifecycle import create_tournament as create_tournament_core
from app.tournament_lifecycle import delete_tournament as delete_tournament_core
from app.tournament_lifecycle import transition_tournament
from app.tournament_list import list_tournament_details, tournament_detail
from app.tournament_queries import (
    active_entrants_by_event,
    active_entry_count,
    entrant_rating,
    fixtures_by_event,
    game_counts_by_match,
)
from app.tournament_queries import completed_match_ids as _completed_match_ids
from app.tournament_queries import visible_to as _visible_to
from app.tournament_serialization import (
    serialize,
    serialize_event,
)
from app.tournament_solve_service import (
    request_schedule_solve as _request_schedule_solve,
)

# Reads are gated on ``tournament.view``, creation on ``tournament.create``, and
# entering an event as a player on ``tournament.enter`` (all three granted to the
# Beta-tester role in ``scripts/seed_rbac.py``). The owner-facing mutating routes
# — PATCH, DELETE, and every event mutation — carry NO permission gate: they're
# owner-only, available solely to the user who created the tournament
# (``_require_owner``). There is deliberately no
# ``tournament.edit``/``tournament.delete``/``tournament.publish`` permission;
# managing a tournament you created is a property of ownership, not a role grant.
# Player self-registration is the exception that needs its own permission: a
# player entering *themselves* is not the tournament's owner, so it cannot go
# through ``_require_owner``.
#
# The two ENTRY routes hold BOTH of those authorizations at once, because a single
# endpoint serves both actors (ADR-0784): a player entering themselves is gated on
# ``tournament.enter``, and a director entering somebody else — or withdrawing an
# entry that is not their own — is gated on ownership. Which gate applies is decided
# by the request, so neither can be a router dependency (a dependency runs before the
# handler has seen the body, and would refuse an owner for lacking a grant that has
# nothing to do with what they are doing). Both routes therefore take
# ``get_current_user`` and ask ``_require_enter_permission`` / ``_require_owner`` in
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


async def _get_owned_tournament_or_404(
    db: AsyncSession, tournament_id: uuid.UUID, current_user: User
) -> Tournament:
    """Load a tournament the caller OWNS, or refuse: 404 if absent, 403 if not theirs.

    Load first, THEN check ownership — the ordering is intentional, and preserved
    from the call sites this replaces: a permitted non-creator learns the
    tournament exists.

    The loading and the owner check are welded together on purpose. Every loader in
    this module now NAMES THE SCOPE IT LOADS UNDER — owner-scoped (this one, for the
    owner-only writes), for-update (the concurrency-sensitive writes), visibility-
    scoped (``_visible_to``, in the read routes' WHERE) — and there is deliberately
    no bare "just fetch the row" loader left. A bare one is a trap: it 404s, it
    reads correctly, and it is right there, so the next read route added to this
    module would reach for it and silently serve other people's drafts. The guard
    against that has to be structural — a leaky loader that doesn't exist cannot be
    picked by accident — not a reviewer remembering to ask.
    """
    tournament = (
        await db.execute(select(Tournament).where(Tournament.id == tournament_id))
    ).scalar_one_or_none()
    if tournament is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    _require_owner(tournament, current_user)
    return tournament


async def _get_tournament_for_update_or_404(
    db: AsyncSession, tournament_id: uuid.UUID
) -> Tournament:
    """The same 404, with the row locked for the rest of the transaction.

    Every route that *judges a tournament's status and then writes* loads it
    through here — the transition, entering an event, withdrawing an active entry,
    and the PATCH (whose league guard reads the status, ADR-0783) — because without
    the lock the judgment and the write happen in two different
    instants. Postgres runs READ COMMITTED, so an unlocked ``SELECT`` answers from
    the snapshot of that statement alone: a player's entry can pass the
    ``published`` check, the owner's go-live can commit, and the ``INSERT`` can
    then land *behind* it. Both requests succeed and the field is no longer the
    one the tournament went live with — precisely the invariant going live exists
    to establish, and the one the draw (#785) is cut from. The mirror of it lets a
    player withdraw out from under a tournament that has just gone live; it lets a
    league change pass the ``draft`` check and then land behind a publish, moving
    the ladder under a field that has already started filling; and it lets two
    concurrent identical transitions both read ``published``, both find a legal
    edge, and both answer 201 — turning the 409 ADR-0017 promises for a
    re-asserted status into a silent no-op.

    ``FOR UPDATE`` closes the window: the status read here cannot change under the
    caller until its transaction ends, and a second writer blocks and then re-reads
    the *committed* status rather than the one it saw first. All four mutating
    routes take this lock, on the TOURNAMENT row, before any other — one lock, one
    order, so they queue behind each other and no pair of them can deadlock. (The
    PATCH takes it unconditionally, though it only *judges* the status when the
    payload carries a ``league_id``: one loader per route is simpler than a
    branch, and a name-only edit that queues behind a publish is harmless.)

    The read routes deliberately take no lock: they select through ``_visible_to``
    and never come through here, because a reader has nothing to serialize against
    and no business making writers queue behind it.

    Unscoped by ownership, and legitimately so — entering and withdrawing are
    *player* actions on somebody else's tournament, so there is no owner to check.
    The owner-only writes that do NOT judge a status load through
    ``_get_owned_tournament_or_404`` instead, which welds the 403 to the load but
    takes no lock. The two routes that need *both* — the transition and the PATCH —
    take this lock and then call ``_require_owner`` themselves, because a loader
    that locked and owner-checked would be a third loader saying what these two
    lines already say.
    """
    tournament = (
        await db.execute(
            select(Tournament).where(Tournament.id == tournament_id).with_for_update()
        )
    ).scalar_one_or_none()
    if tournament is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    return tournament


async def _get_event_or_404(
    db: AsyncSession, tournament_id: uuid.UUID, event_id: uuid.UUID
) -> TournamentEvent:
    # The event must belong to the named tournament — scope the lookup by both
    # ids so a mismatched pair is a 404, not a cross-tournament edit.
    event = (
        await db.execute(
            select(TournamentEvent).where(
                TournamentEvent.id == event_id,
                TournamentEvent.tournament_id == tournament_id,
            )
        )
    ).scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    return event


async def _get_entry_or_404(
    db: AsyncSession, event_id: uuid.UUID, entry_id: uuid.UUID
) -> TournamentEntry:
    # Scoped by event id as well as entry id, the same way _get_event_or_404 is
    # scoped by tournament: an entry that exists but hangs off a *different* event
    # is not addressable through this URL, so the mismatch is a 404 rather than a
    # withdrawal from the event the caller didn't name.
    entry = (
        await db.execute(
            select(TournamentEntry).where(
                TournamentEntry.id == entry_id,
                TournamentEntry.event_id == event_id,
            )
        )
    ).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found.")
    return entry


async def _get_entrant_or_404(db: AsyncSession, user_id: uuid.UUID) -> User:
    """The player a director named in the body — the one they are entering (ADR-0784).

    Tombstoned (merged-away) users are excluded, exactly as ``/v1/players/search``
    excludes them: a ghost is a user no listing, search or auth query will ever return,
    so entering one would put a player in the draw who cannot sign in, cannot be
    notified and cannot play. The merge re-points every *existing* entry onto the
    survivor; the way to keep new ones off the tombstone is to refuse to write them.

    A 404 rather than a 422: the id is well-formed, it simply names nobody enterable.
    It is raised only *after* ``_require_owner``, so a stranger poking at the endpoint
    learns nothing about which user ids exist.
    """
    user = (
        await db.execute(
            select(User).where(
                User.id == user_id,
                User.merged_into_user_id.is_(None),
            )
        )
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    return user


def _require_owner(t: Tournament, current_user: User) -> None:
    if t.created_by_user_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You can only modify tournaments you created.",
        )


async def _require_enter_permission(db: AsyncSession, current_user: User) -> None:
    """The self-registration arm's gate: the caller must hold ``tournament.enter``.

    Byte-for-byte what ``Depends(require_permission(TOURNAMENT_ENTER))`` raised when
    it was a router dependency — the same query (``user_has_permission``), the same
    403, the same ``"Forbidden."`` — because it is the same authorization. What moved
    is only *where* it is asked: a dependency cannot see the request body, and the
    body is what says whether this caller is self-registering at all (ADR-0784). An
    owner entering somebody else must not be refused for lacking a permission about
    entering *themselves*.

    So it is asked FIRST, before the tournament is even loaded, on the self path — the
    dependency's position, kept. The director's ownership check is the mirror image
    and is deliberately asked *last*, after the 404s, because ownership is a fact about
    a tournament that has to exist before it can be owned.
    """
    if not await user_has_permission(db, current_user.id, TOURNAMENT_ENTER):
        raise HTTPException(status_code=403, detail="Forbidden.")


# The league-editable-only-while-draft rule (ADR-0783) now lives on the
# transport-neutral edit verb: ``edit_tournament`` (``app.tournament_edit``)
# raises ``LeagueNotEditableError``, which the PATCH adapter below maps to the 409
# this router used to raise inline. It is not a router helper any more precisely so
# the rule has one home the MCP tool shares too.


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


@router.get(
    "/tournaments",
    response_model=list[TournamentDetailRead],
    dependencies=[Depends(require_view)],
)
async def list_tournaments(
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[TournamentDetailRead]:
    # The list page's cards render event-derived stats (event count, total
    # entries, table count), so the list returns the full aggregate — events, their
    # entrants and their draws included — rather than a thinner summary. The FIVE-query
    # batched read (no N+1, whatever the number of tournaments or events) lives in the
    # shared ``list_tournament_details`` so the MCP ``list_my_tournaments`` tool runs
    # the exact same shape; this handler only supplies the WHERE.
    #
    # Scoped by ``_visible_to``: somebody else's draft is not the caller's to see, so it
    # never enters the result set — and, because the filter is a WHERE clause on the
    # first of the five queries, the events and entrants queries are keyed off the
    # surviving ids and cannot leak a hidden tournament's contents either. A predicate
    # costs no extra statement, so the statement-count tripwire in
    # tests/test_tournaments.py still reads the same count.
    return await list_tournament_details(
        db, where=_visible_to(current_user.id), current_user_id=current_user.id
    )


@router.post(
    "/tournaments",
    response_model=TournamentRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_create)],
)
async def create_tournament(
    payload: TournamentCreate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentRead:
    # Thin adapter over the transport-neutral ``create_tournament`` verb: it owns
    # the STRICT (FastAPI-free) league resolution and the write, and signals each
    # league refusal with a domain exception. This handler maps each back to the
    # exact status + body it produced before, so the wire contract is unchanged:
    #
    #   LeagueNotFoundError   -> 404 "League not found."
    #   NoDefaultLeagueError  -> 500 "No default league configured."
    try:
        tournament = await create_tournament_core(
            db, actor=current_user, payload=payload
        )
    except LeagueNotFoundError as exc:
        # The STRICT resolution: a ``league_id`` that names no league is a 404,
        # never a silent fall back to the default (ADR-0783).
        raise HTTPException(status_code=404, detail="League not found.") from exc
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
    # The six-statement batched composition — events, their entrants, their draws,
    # the completed matches' games (standings), the caller's one ladder rating, and
    # the newest solve — lives in the shared ``tournament_detail`` reader, which the
    # MCP ``get_tournament`` tool composes too, so the two surfaces cannot drift. The
    # statement-count pin (tests/test_tournaments.py) is measured against this route,
    # which is the reader plus this one visibility-scoped load.
    return await tournament_detail(
        db,
        tournament,
        created_by_username=username,
        current_user_id=current_user.id,
    )


@router.patch("/tournaments/{tournament_id}", response_model=TournamentRead)
async def update_tournament(
    tournament_id: uuid.UUID,
    payload: TournamentUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentRead:
    # Thin adapter over the transport-neutral ``edit_tournament`` verb: it owns the
    # load-lock, the owner gate, the league state-rule, the STRICT league lookup,
    # the partial apply and the table-catalogue → re-solve trigger, and signals
    # each refusal with a domain exception. This handler maps each back to the
    # exact status + body it produced before, so the wire contract is unchanged:
    #
    #   TournamentNotFoundError  -> 404 "Tournament not found."
    #   NotTournamentOwnerError  -> 403 "You can only modify tournaments you created."
    #   LeagueNotEditableError   -> 409 "This tournament is {status}; its league …"
    #   LeagueNotFoundError      -> 404 "League not found."
    try:
        tournament = await edit_tournament(
            db, tournament_id=tournament_id, actor=current_user, updates=payload
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        # Shared arms: the 404 (absent), the 403 (not the owner), and the 409
        # (league not editable) all map identically across the owner-only writes.
        raise _map_tournament_write_error(exc) from exc
    except LeagueNotFoundError as exc:
        # Verb-specific: only the edit verb resolves a league, so the strict 404
        # for a ``league_id`` that names none is this adapter's alone.
        raise HTTPException(status_code=404, detail="League not found.") from exc
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
        event = await create_event_core(
            db, tournament_id=tournament_id, actor=current_user, payload=payload
        )
    except _TOURNAMENT_WRITE_ERRORS as exc:
        raise _map_tournament_write_error(exc) from exc
    # The event's league is the tournament's — the number the caller's ``entry_state``
    # is judged against. The verb's owner gate just confirmed the tournament exists and
    # is the caller's, so this scalar read cannot miss.
    league_id = (
        await db.execute(
            select(Tournament.league_id).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    # A just-created event has no entries, so its entrants are empty and its
    # derived ``entered`` count is 0 — no query needed to learn that. Its draw is
    # empty for the same reason and with the same certainty: fixtures are only ever
    # written by the cut (ADR-0786), which is an explicit act on an event that already
    # exists, so an event one statement old cannot have any. ``[]``, not a query.
    #
    # Its ``entry_state`` is still the CALLER's, computed exactly as it is on the
    # read paths (the director who just created the event is a player too, and the
    # rules they wrote judge them like anyone else). One rating query, on the
    # tournament's league: answering with a state the endpoint had guessed rather
    # than computed is how the read and the guard come apart.
    rating = await entrant_rating(db, league_id, current_user.id)
    # No fixtures on a one-statement-old event, so no results either —
    # ``_event_results`` answers ``None`` for an uncut draw whatever the game counts, so
    # an empty map is all this needs.
    return serialize_event(
        event, entrants=[], fixtures=[], rating=rating, game_counts={}
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
    """Edit an event. Absent fields are left alone; `predicates` and `pools` replace
    wholesale when sent. No two pools may share an `id`, in any state (`422`) — a pool
    id identifies one pool, and the fixtures of a draw name their pool by it.

    **Once the event's draw is cut, two things freeze** (ADR-0786) — the facts its
    fixtures were derived from:

    * **its set of pools.** A `pools` payload must carry exactly the pool `id`s the
      event already has, or it is refused with a `409`: a removed (or re-`id`'d) pool
      would leave the fixtures drawn into it pointing at nothing, and an added one would
      arrive with no fixtures, since the draw was dealt across the pools that existed at
      the cut.
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
        event = await update_event_core(
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
    except _TOURNAMENT_WRITE_ERRORS as exc:
        raise _map_tournament_write_error(exc) from exc
    # The event's league is the tournament's — the ladder the caller's refreshed
    # ``entry_state`` is judged on (ADR-0783). The verb's owner gate just confirmed the
    # tournament exists and is the caller's, so this scalar read cannot miss.
    league_id = (
        await db.execute(
            select(Tournament.league_id).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    # An edited event keeps whatever entrants it already had — reload them rather
    # than answering with an empty list (and a ``entered`` of 0) that would be a
    # lie for any event people have entered. Its DRAW survives the edit too (a PATCH
    # is not a re-cut, ADR-0786), so its fixtures are reloaded for the same reason:
    # answering ``[]`` here would tell the director their draw had just been thrown
    # away, and the page would render it that way.
    entrants = (await active_entrants_by_event(db, [event.id]))[event.id]
    event_fixtures = await fixtures_by_event(db, [event.id])
    fixtures = event_fixtures[event.id]
    # Its RESULTS survive the edit too (a PATCH is not a re-cut), so they are
    # reprojected from the same completed-match games as the read paths — one game load,
    # so an edit to a played event still answers its live standings, not drops them.
    game_counts = await game_counts_by_match(db, _completed_match_ids(event_fixtures))
    # And its ``entry_state`` is recomputed from the event as it now stands: an owner
    # who has just tightened a rule or lowered ``max_players`` is answered with what
    # the event says NOW, not with what it said before their edit.
    rating = await entrant_rating(db, league_id, current_user.id)
    return serialize_event(
        event,
        entrants=entrants,
        fixtures=fixtures,
        rating=rating,
        game_counts=game_counts,
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


# A tournament's status IS its registration window (ADR-0017): ``published`` is
# open, and the other three are shut for three different reasons — a draft is not
# announced yet, a live tournament's field is fixed (the draw is cut from it), and
# an archived one is over.
#
# The closed statuses are named as a Literal rather than the whole enum so the set
# stays exhaustive under change: mypy narrows ``tournament.status`` past the
# ``is not published`` guard, so a fourth closed status added to the enum tomorrow
# is a type error at the call site until it is handled — and ``assert_never`` makes
# a missing branch in here one too. That is the "if you must map an enum, do it in
# one place with an exhaustive match" rule; a dict keyed by status would answer a
# new member with a KeyError at runtime instead.
ClosedRegistrationStatus = Literal[
    TournamentStatus.draft,
    TournamentStatus.live,
    TournamentStatus.archived,
]


def _registration_closed_detail(status: ClosedRegistrationStatus) -> str:
    """Why registration is refused, in words a player can read.

    The status is not merely echoed back: "not yet" and "too late" are different
    things to be told, and a client that only knew "you cannot enter" could not
    say which.

    Both entering and withdrawing an active entry are refused for the *same*
    reason — the registration window is shut — so both say it with this one
    function rather than drifting into two half-maintained copies of the same
    three sentences. Each sentence leads with the fact about the *tournament*
    ("has not been published yet", "is already under way", "has ended"), which is
    what a player on either side of the window needs to be told.
    """
    match status:
        case TournamentStatus.draft:
            return (
                "This tournament has not been published yet, "
                "so its events are not open for entry."
            )
        case TournamentStatus.live:
            return "This tournament is already under way, so its entries are locked."
        case TournamentStatus.archived:
            return "This tournament has ended, so its events can no longer be entered."
        case _:
            assert_never(status)


def _registration_refusal_detail(status: TournamentStatus) -> str:
    """The words for a refusal, for *any* status a refusal can arrive in.

    This is the total function ``_registration_closed_detail`` deliberately is not.
    The narrow one only speaks about the statuses that are closed *because of the
    status* — and mypy's narrowing past the ``published`` test below is what keeps
    its ``Literal`` exhaustive, so a fourth closed status added to the enum is a
    type error until somebody writes the sentence a player should read. Losing that
    would be the real cost of making the copy helper total.

    So the totality is bought here instead, and only here: ``published`` falls
    through to a generic sentence. That branch is unreachable today — ``published``
    *is* the open status — but it stops being unreachable the moment
    ``_registration_open`` grows a second condition (an entry deadline, a capacity
    cap, #784), and a ``published``-but-closed tournament reaches the refusal path
    for a reason that has nothing to do with its status. The generic sentence is
    the honest one to say then: the status is not why the window is shut, so naming
    it would mislead. When such a rule lands, its author gives it its own sentence
    — but a guard must never depend on that having happened yet. Refusing vaguely
    is a bug report; permitting the write would be a corrupted field.
    """
    if status is not TournamentStatus.published:
        return _registration_closed_detail(status)
    return "Registration for this tournament is closed."


def _registration_open(t: Tournament) -> bool:
    """Whether a tournament's registration window is open right now (ignoring who
    is asking, and what they want to do with it).

    This is the whole rule, and it is one line: a tournament's status IS its
    registration window (ADR-0017), so the window is open in ``published`` and shut
    in the other three.

    Single source of truth shared by every guard that has to know — entering,
    withdrawing an active entry, and whatever comes next (a director entering a
    player for someone else, #784; a ``can_enter`` flag on the BFF read) — so a
    third caller cannot quietly grow a fourth opinion about when registration is
    open. The routes ask ``_enforce_registration_open``; the *decision* lives here,
    exactly once.
    """
    return t.status is TournamentStatus.published


def _enforce_registration_open(t: Tournament) -> None:
    """Raise the 409 unless the registration window is open.

    ``_registration_open`` owns the *decision*; this only turns a refusal into a
    status code and words, so no caller of this can disagree with a caller of the
    predicate about whether entry is open.

    409, not 403 (ADR-0017): the caller is permitted and the entry is their own — it
    is the tournament that is in the wrong state. "Not you" would be a lie; the truth
    is "not now".

    Exactly two branches, and only one of them returns: open, or raise. The refusal
    does **not** re-derive "is it closed?" from the status — a guard that decides to
    refuse and then asks a second question before refusing can fall through both and
    permit the write it was asked to stop, and a guard must never fail in the
    permissive direction. Finding the words for the refusal is a separate job, and
    ``_registration_refusal_detail`` is total, so there is no status it can be handed
    that leaves it with nothing to say.

    This is the **withdraw** route's enforcer, and its refusal is still bare prose.
    The enter route has its own — ``_enforce_entry_registration_open`` — which says
    the same thing with a machine-readable ``code``. The split is deliberate:
    ADR-0968 scopes the coded refusals to the *entry* endpoint (the one whose client
    was telling refusals apart by byte-comparing English), and leaves #968 open
    against everything else here, withdraw included. Do not re-merge the two to tidy
    them up — that silently changes the withdraw route's response body. Convert
    withdraw *on purpose*, with its client, or not at all. What the two share is the
    part that must not fork: the ``_registration_open`` decision and the
    ``_registration_refusal_detail`` sentences.
    """
    if _registration_open(t):
        return
    raise HTTPException(
        status_code=409,
        detail=_registration_refusal_detail(t.status),
    )


def _enforce_entry_registration_open(t: Tournament) -> None:
    """The enter route's half of the same guard: refuse unless the window is open,
    with the ``registration_closed`` code the client switches on (ADR-0968).

    Same decision (``_registration_open``) and the same words
    (``_registration_refusal_detail``) as the withdraw route's enforcer — only the
    envelope differs, because only the entry endpoint's refusals are coded so far.
    So the two routes cannot come to disagree about *whether* registration is open,
    which is the property worth protecting; that they describe the refusal
    differently is a client-contract fact, not a second opinion.

    One code for all three closed statuses. The status is *why*, and the client does
    not branch on which one — it branches on "the window is shut", and the
    per-status sentence rides along as the message, which is the only place the
    difference is worth anything: a fallback for a client that does not know the
    code, and prose for a human. (A ``published`` tournament closed for some *other*
    reason lands here too, with the generic sentence — the code is honest about that
    where the sentence could not be.)
    """
    if _registration_open(t):
        return
    raise entry_refused(
        EntryRefusal.registration_closed,
        _registration_refusal_detail(t.status),
    )


async def _enforce_event_has_room(db: AsyncSession, event: TournamentEvent) -> None:
    """Raise the ``event_full`` 409 once the event holds ``max_players`` entrants.

    **This function is only correct when it is called with the tournament's row lock
    already held** (ADR-0783, §4). Capacity is a count on ``tournament_entries``
    compared against a column on ``tournament_events`` — which is not something a
    database constraint can express, so unlike the duplicate-entry guard (a *partial
    unique index*, enforced by Postgres itself, which is why that one can safely be a
    caught ``IntegrityError`` after the fact) there is nothing underneath us. The lock
    is the entire mechanism. Counted outside it, two entrants racing for the final
    slot each read ``max_players - 1``, each pass this gate, and each insert: an
    overfull event, from two requests that were both answered 201.

    Inside the lock the count-then-insert is serialised, because every entry to every
    event of a tournament takes that same lock, on that same row, first — so the
    loser blocks, and its count re-reads the row the winner *committed*.

    Active entries only (ADR-0016): a withdrawn entry is not an entrant and its slot
    is genuinely free again.

    *What* full means — ``>=``, not ``==``, so an event whose ``max_players`` was
    lowered under an already-larger field is full; and an event with **no cap at all**
    is never full — is ``event_is_full``, shared with the detail read's
    ``entry_state``: the page that reports an event as full and the guard that refuses
    entry to it must not be able to disagree about the word. What this function owns is
    the *count* (fresh, under the lock) and the refusal.

    An **uncapped** event (``max_players IS NULL``, ADR-0935) leaves by the first line,
    before the count: there is no limit for a count to be compared against, so the
    ``COUNT(*)`` would be a query whose answer could not change the outcome, and the
    ``event_full`` refusal below is unreachable for such an event — as it must be. The
    early return is the same rule ``event_is_full`` states for the read path, taken
    early enough to skip the query; it is not a second opinion about what full means,
    and the assertion that the two agree is a test, not a comment
    (``test_an_uncapped_event_never_refuses_with_event_full``).
    """
    max_players = event.max_players
    if max_players is None:
        return
    entered = await active_entry_count(db, event.id)
    if not event_is_full(entered=entered, max_players=max_players):
        return
    raise entry_refused(
        EntryRefusal.event_full,
        f"This event is full — it has reached its limit of {max_players} players.",
    )


async def _enforce_rating_eligible(
    db: AsyncSession,
    tournament: Tournament,
    event: TournamentEvent,
    user: User,
) -> float | None:
    """Raise the ``rating_ineligible`` 409 unless the player satisfies the event's
    rating rules (ADR-0783) — and hand back the rating it judged them on, ``None`` if
    they hold none.

    Returning it is not a convenience: the entry this route goes on to create is
    answered as a ``TournamentEntrantRead``, which carries the entrant's rating on this
    tournament's ladder. Re-reading it after the INSERT would be a second query for a
    number already in hand, and — worse — a number that could differ from the one the
    guard actually decided against, so the created entrant could come back rated
    differently from the rating that admitted it.

    The *decision* is not made here — it is made in ``app.tournament_eligibility``,
    which the detail read (6a) calls too, so the guard that refuses an entry and the
    page that explains why the Enter control is missing cannot come to two different
    answers. This is only the translation: rating in, 409 out.

    The rating is read on the **tournament's** league — the ladder the tournament
    named when it was created — so "rated against what?" has one answer that is
    recorded rather than assumed.

    **A player with no rating there passes every rule and is not refused** (ADR-0783
    §3, and the evaluator's own docstring). That is the beginners'-event case, and it
    is why the entrants list marks unrated entrants for the director rather than this
    guard refusing them.

    ``match``, not ``if isinstance(...)``: a third eligibility outcome added tomorrow
    (a capacity-shaped one, a "your entry is pending" one) is a type error here until
    it is answered, rather than silently falling through and *admitting* the player —
    a guard must never fail in the permissive direction.
    """
    rating = await entrant_rating(db, tournament.league_id, user.id)
    decision = evaluate_rating_eligibility(rating=rating, predicates=event.predicates)
    match decision:
        case Eligible():
            return rating
        case RatingIneligible():
            raise entry_refused(EntryRefusal.rating_ineligible, decision.message)
        case _:
            assert_never(decision)


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
    # ----- the fork (ADR-0784) ----------------------------------------------
    #
    # One line, decided from the body alone, before anything is loaded: WHO is being
    # entered. Everything downstream reads ``entrant`` and does not care how it got
    # there — the eligibility evaluator, the capacity lock and the four refusal codes
    # are the same rules for a director as for a player, which is the whole reason this
    # is one endpoint and not two (a twin route would make the next refusal a thing to
    # add twice).
    #
    # Naming your OWN ``user_id`` is self-registration. It has to be: "the player
    # entered themselves" is spelled ``added_by_user_id = NULL``, and letting an owner
    # write ``added_by == user_id`` would create a second, contradictory encoding of
    # the same fact — one the entrants list would render as "added by the director" on
    # an entry whose director is the player. (``merge_user``'s CASE already collapses
    # that shape when a merge would otherwise produce it; the route must not mint it in
    # the first place. Deliberately no ``CHECK`` constraint enforces this: the INSERT
    # below catches ``IntegrityError`` and reads it as ``already_entered``, so a
    # constraint violation here would surface as a false "already entered" refusal.)
    entrant_id = current_user.id if payload is None else payload.user_id
    self_registration = entrant_id == current_user.id
    if self_registration:
        # Asked here, at the top, exactly where the router dependency used to run:
        # a player who does not hold ``tournament.enter`` is refused before the
        # handler learns anything about the tournament. The director's arm is gated
        # by ownership instead, and its check comes *after* the 404s below — you
        # cannot own a tournament that does not exist.
        await _require_enter_permission(db, current_user)

    # Load first, then decide — the same 404-before-anything-else ordering the
    # owner-only routes use.
    #
    # The tournament is loaded *locked*, and locked first: it is the row whose
    # status decides this request, and it must not change between the check below
    # and the INSERT — otherwise an entry passes the ``published`` gate and then
    # commits behind the owner's go-live, into a field that was supposed to be
    # sealed. Whichever of the two gets the lock first, the other sees its
    # committed outcome.
    tournament = await _get_tournament_for_update_or_404(db, tournament_id)
    event = await _get_event_or_404(db, tournament_id, event_id)

    if self_registration:
        # The caller is the entrant, and nobody added them — that is what NULL means.
        entrant, added_by_user_id = current_user, None
    else:
        # The director's arm. Ownership is the gate (403 for anyone else naming
        # somebody else's id), and it is judged after the 404s above so that a
        # stranger's refusal never leaks whether the tournament or event exists.
        _require_owner(tournament, current_user)
        entrant, added_by_user_id = (
            await _get_entrant_or_404(db, entrant_id),
            current_user.id,
        )

    if event.format is not EventFormat.singles:
        # Not a policy — a modelling limit (ADR-0016). One row per user cannot
        # express a doubles pairing or a team, so rather than record half a pair
        # we refuse. ``is not singles`` rather than ``== doubles`` so a new format
        # is rejected by default instead of silently falling through.
        raise HTTPException(
            status_code=400,
            detail=(
                "Only singles events can be entered directly, "
                f"not {event.format.value}."
            ),
        )

    # Ordering: the format 400 first, then the status 409 — the permanent refusal
    # before the transient one. It is a judgment call, not a forced move (asking
    # "is registration open at all?" before "is this event's shape enterable?" is
    # defensible too), so here is the reason. A 409 means "not now", and invites
    # the caller back once the tournament is published — but a doubles event will
    # never be enterable through this route, in any status, so a caller sent away
    # to retry would only be refused again, this time with the 400 they should
    # have been given in the first place. Answer with the fact that will not
    # change. It also keeps one clean rule for the whole handler: every "this
    # request cannot work" check precedes every "the state conflicts" check, so
    # both 409s (this one, and the already-entered one at commit) sit last.
    #
    # Refusing HERE, before the INSERT (rather than inserting and rolling back), is
    # what makes "no row is written" a property of the code and not of a transaction
    # that happened to abort.
    _enforce_entry_registration_open(tournament)

    # Eligibility BEFORE capacity, for the same reason the doubles 400 precedes the
    # status 409: answer with the fact that will not change first. "The event is full"
    # invites the player back when somebody withdraws — but a player whose rating fails
    # the event's rules would only be refused again on that retry, this time with the
    # refusal they should have been given now. A rating does move, so it is still a 409
    # and not a 403; it just does not move because somebody else withdrew.
    #
    # It reads the player's rating (a plain SELECT, no lock of its own), and it must
    # stay ABOVE the capacity count: nothing may come between that count and the
    # INSERT (see below). The rating it judged against comes back out, because the
    # entrant this route answers with carries it — the number that admitted you and the
    # number reported beside your name are the same number, read once.
    #
    # ``entrant``, not ``current_user``: the rules judge the person being ENTERED. A
    # director adding a 1650 player to the "Under 1500" event is refused with the same
    # ``rating_ineligible`` code that player would have got, and judging the DIRECTOR's
    # rating here would silently make ownership an eligibility bypass — a ``force`` flag
    # nobody voted for, arriving through a typo.
    rating = await _enforce_rating_eligible(db, tournament, event, entrant)

    # Capacity, counted UNDER THE LOCK taken above (ADR-0783, §4) — the count and the
    # INSERT below are one serialised unit, which is the only reason two entrants
    # racing for the final slot cannot both be admitted. Nothing between this line
    # and the commit may take a lock of its own, and nothing may move this count
    # above ``_get_tournament_for_update_or_404``.
    #
    # After the status 409, before the INSERT: whether the event has room is a
    # question about *this* event, and it is only worth asking once registration is
    # known to be open at all — a full event of a draft tournament is refused for the
    # window, which is the fact that governs every event of that tournament.
    await _enforce_event_has_room(db, event)

    # ``added_by_user_id`` is the fork's one lasting trace: NULL on the self path (the
    # player entered themselves), the director's id on the other (ADR-0784). It is a
    # fact about the past that cannot be reconstructed later, so it is stored now.
    entry = TournamentEntry(
        event_id=event.id,
        user_id=entrant.id,
        added_by_user_id=added_by_user_id,
    )
    db.add(entry)
    try:
        await db.commit()
    except IntegrityError:
        # The partial unique index on (event_id, user_id) WHERE status='entered'
        # is what rejected this, and letting the database decide is the point: a
        # pre-flight SELECT would leave a window in which two concurrent requests
        # both see "not entered" and both insert. ``from None`` drops the DBAPI
        # error, so nothing about the schema reaches the response body. Because
        # the index is partial, a player whose only prior entry is *withdrawn*
        # does not land here — they enter again, cleanly.
        #
        # It is the index, and only the index, that can raise here — which is why
        # ``added_by_user_id`` deliberately carries no CHECK constraint (see the fork
        # above): a second constraint on this INSERT would be reported to the client as
        # a false "you have already entered this event".
        await db.rollback()
        raise entry_refused(
            EntryRefusal.already_entered,
            "You have already entered this event.",
        ) from None

    return TournamentEntrantRead(
        id=entry.id,
        # The ENTRANT — who is the caller on the self path and somebody else on the
        # director's. The 201 describes the row that was written, not the person who
        # wrote it, so a director's POST answers with the player they just entered.
        user_id=entrant.id,
        username=entrant.username,
        seed=entry.seed,
        # The rating the eligibility guard above already read on this tournament's
        # ladder — not a fresh one. The entrant that comes back from the POST is the
        # same shape, judged by the same number, as the one the detail read lists.
        rating=rating,
    )


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
    # Load-then-authorize, as everywhere else here: the tournament, the event
    # under it, and the entry under that event must all exist before ownership is
    # considered — so a wrong (tournament, event, entry) triple is a 404, and 403
    # means "this entry is real, but it isn't yours to take back".
    #
    # The tournament comes back locked, and first — the same lock, in the same
    # order, as the enter, transition and PATCH routes take (which is what keeps the
    # four of them free of any deadlock cycle). Without it, a withdrawal could pass the
    # ``published`` gate and commit *after* the tournament went live, pulling a
    # player out of the very field the draw is cut from.
    tournament = await _get_tournament_for_update_or_404(db, tournament_id)
    event = await _get_event_or_404(db, tournament_id, event_id)
    entry = await _get_entry_or_404(db, event.id, entry_id)

    # The same fork the enter route makes, read off the ENTRY rather than off a body:
    # this is the caller's own entry, or it is somebody's the owner is removing
    # (ADR-0784). Two authorizations, disjoint, and neither is a router dependency —
    # which entry it is cannot be known until the row is loaded.
    if entry.user_id == current_user.id:
        # Withdrawing your own entry is the mirror of self-registering, and it is gated
        # the same way: ``tournament.enter``. (The owner's arm below deliberately does
        # NOT require it — managing the field of a tournament you created is a property
        # of ownership, not a role grant.)
        await _require_enter_permission(db, current_user)
    elif tournament.created_by_user_id != current_user.id:
        # Not yours, and not your tournament. The message stays true for everyone who
        # can ever read it: the only caller refused here is a non-owner reaching for an
        # entry that is not theirs, and for them their own entry really is all they may
        # withdraw.
        #
        # Ordering: this 403 precedes the status 409 below, so withdrawing someone
        # else's entry from a *live* tournament is "not yours", not "not now".
        # "Not yours" is the fact that will not change: come back when the
        # tournament is published and the entry is still not theirs to withdraw,
        # whereas a 409 would invite exactly that pointless retry. Same rule the
        # 404s above follow, and the same rule the enter route follows with its
        # doubles 400 — every permanent refusal is answered before any transient
        # one.
        raise HTTPException(
            status_code=403,
            detail="You can only withdraw your own entry.",
        )

    # The gate is on the state CHANGE, not on the call (ADR-0017). Going live locks
    # the field the draw is cut from, so flipping an ``entered`` entry to
    # ``withdrawn`` outside the registration window is refused — the same window, and
    # the same 409, the enter route asks about, which is why both ask the one
    # enforcer rather than each restating what "open" means.
    #
    # But an entry that is *already* withdrawn has nothing left to lock, so it is
    # deliberately not gated: this ``entered`` guard is what preserves the idempotent
    # 204 that ADR-0016 designed, in ``live`` and ``archived`` too. Drop it and this
    # route starts answering 409 to a request that would change nothing — a conflict
    # with no conflict in it.
    if entry.status is TournamentEntryStatus.entered:
        _enforce_registration_open(tournament)
        # Scheduling-input trigger (ADR "the schedule is solved; the call is
        # pinned"), inside the ``entered`` arm on purpose: only a withdrawal
        # that actually changes state owes a solve — the idempotent re-DELETE
        # below writes nothing and triggers nothing. And only when this
        # entrant is **seated in a cut draw**: entries reach the solver only
        # through fixtures, so an entrant with no fixture is invisible to it
        # (they entered after the cut, or nothing is cut) and their leaving
        # changes no solver input until a re-cut — which triggers on its own.
        # One EXISTS decides it, and a seated entrant implies a drawn event by
        # construction, so no separate ``tournament_has_drawn_event`` gate is
        # needed. Same transaction, under the tournament row lock this handler
        # already holds (the order ``request_solve`` requires); a ``None``
        # return (Redis down) deliberately costs the solve, never the
        # withdrawal.
        seated = (
            await db.execute(
                select(
                    exists(
                        select(TournamentFixture.id).where(
                            or_(
                                TournamentFixture.entry_a_id == entry.id,
                                TournamentFixture.entry_b_id == entry.id,
                            )
                        )
                    )
                )
            )
        ).scalar_one()
        if seated:
            await request_solve(
                db, tournament_id, ScheduleSolveTrigger.settings_changed
            )

    # Idempotent by construction: withdrawing is an assignment, not a decrement,
    # so applying it to an already-withdrawn entry writes the value it already
    # holds. SQLAlchemy emits no UPDATE for an unchanged attribute, and the
    # response is the same 204 either way. Nor can this UPDATE violate the partial
    # unique index — it only ever *removes* a row from the index's predicate — so,
    # unlike the enter route, there is no IntegrityError here to catch and no
    # database error that could reach the response body.
    entry.status = TournamentEntryStatus.withdrawn
    await db.commit()
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
    a competition (``DegenerateDraw``) or is not a format we can cut yet
    (``UnsupportedDrawType``). So it is a 422 — the request is well-formed and
    authorized, but its *content* (this event's pools, this event's field, this event's
    draw type) cannot be turned into a draw — rather than the 500 an uncaught exception
    would be, and rather than a 409, which would invite a retry that will fail
    identically until the director changes the event.

    A ``match`` over the error, not ``str(error)`` over whatever arrives:

    * ``UnsupportedDrawType`` carries the ``draw_type`` **structurally**, so the
      sentence is composed here from the fact rather than parsed out of a message. Its
      own ``str()`` ("… is not implemented yet") is written for the developer who has
      to go implement it; the director needs to be told which of *their* events cannot
      be cut, and that the rest of the tournament is unaffected.
    * ``DegenerateDraw`` is the one error whose message is **domain-authored copy**, and
      it is passed through on purpose: only the strategy knows *which* degeneracy it hit
      — no pools at all, or a snake that would leave some pool with one player and
      nobody to play — and the numbers in that sentence ("5 entrants across 3 pool(s)")
      are the numbers the director has to change. Recomposing it here would be a second
      copy of a rule this route does not own, and the copy that drifts is the one a
      director reads.
    * The fallback arm is a **generic** sentence, never the exception's own. A
      ``DrawError`` subclass added tomorrow gets a vague refusal rather than leaking a
      message nobody wrote for a human — refusing vaguely is a bug report; leaking
      internals is a defect that reaches the UI. (Its author gives it its own arm, the
      same way ``_registration_refusal_detail`` buys its totality.)
    """
    match error:
        case UnsupportedDrawType():
            detail = (
                f"A {error.draw_type.value} draw cannot be cut yet. "
                "Change the event's draw type to one that can, or wait for support."
            )
        case NonSinglesDraw():
            # Composed from the structural ``event_format``, like
            # ``UnsupportedDrawType`` above: a doubles/teams event can never be cut in
            # any state (an entry is
            # one row per player, with nowhere to record a partner or a team, ADR-0788),
            # so a director is told which event is un-drawable and why — a permanent
            # fact, not a retryable one.
            detail = (
                f"A {error.event_format.value} event cannot be given a draw — only "
                "singles events can. A fixture seats one entrant on each side, and "
                "there is nowhere to record a doubles pairing or a team."
            )
        case DegenerateDraw():
            detail = str(error)
        case _:
            detail = "This event's draw cannot be cut as the event stands."
    return HTTPException(status_code=422, detail=detail)


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

    Refused with a `422` when this event cannot produce a draw at all: its draw type has
    no generator yet (only round-robin does today), it has **no pools** configured for a
    pooled draw type, or its field is too small for the pools it has — a pool with fewer
    than two players has nobody to play. The message names what to change.

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
# A placement is two nullable columns on a fixture — ``table_id`` (a string ref into
# the tournament's ``table_catalogue``) and ``scheduled_start`` (a naive, predicted
# wall-clock time). A human PATCHes them here; the schedule solver writes the same two
# fields. The placement RIDES the tournament-detail BFF on read (2a put the fields
# on ``TournamentFixtureRead``), so there is deliberately no ``GET …/placement``.
#
# The write is **soft**: the placement's constraints (table-in-pool, time-in-window, no
# double-booking) are flags derived on read, NOT invariants (ADR-0790), so this route
# stores an out-of-window time and an unknown ``table_id`` without complaint. Its one
# hard rule is the freeze below.
#
# But a manual placement is a **pin** (ADR "the schedule is solved; the call is
# pinned"): the director's hand is a human commitment every later solve schedules
# around, and while the tournament is live, placing a fixture IS calling it. The whole
# pin/notify transition lives in ``app.match_calls.apply_manual_placement``; this route
# supplies the locks, the freeze, and the re-solve enqueue.


async def _get_fixture_or_404(
    db: AsyncSession, tournament_id: uuid.UUID, fixture_id: uuid.UUID
) -> tuple[TournamentFixture, MatchStatus | None, str]:
    """The fixture named in the URL, scoped to the tournament, its linked match's
    live status (``None`` when the fixture has not materialized), and the venue
    ``timezone`` of its event (the IANA zone that anchors a placement's wall-clock
    ``scheduled_start`` to a real instant — ADR "tournament times are timezone-aware
    instants").

    Scoped by BOTH ids — fixture → event → tournament — so a fixture that exists but
    hangs off a *different* tournament is a 404, not a cross-tournament placement,
    exactly the way ``_get_event_or_404`` scopes an event by its tournament and
    ``_get_entry_or_404`` an entry by its event. A well-formed id that names no
    addressable fixture is a 404.

    The match status rides on the same statement (a LEFT join on ``match_id``, one row
    per fixture) because it is the single fact the freeze rule judges (ADR-0790): a
    fixture whose match is ``completed``/``voided`` is history and can no longer be
    moved. Reading it here, at the load, keeps the judgment on the same read as the row
    it judges.
    """
    row = (
        await db.execute(
            select(TournamentFixture, Match.status, TournamentEvent.timezone)
            .join(TournamentEvent, TournamentEvent.id == TournamentFixture.event_id)
            .outerjoin(Match, Match.id == TournamentFixture.match_id)
            .where(
                TournamentFixture.id == fixture_id,
                TournamentEvent.tournament_id == tournament_id,
            )
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Fixture not found.")
    fixture, match_status, event_timezone = row
    return fixture, match_status, event_timezone


def _enforce_fixture_placeable(match_status: MatchStatus | None) -> None:
    """Raise the 409 unless this fixture may still be (re)placed — the ONE hard rule of
    an otherwise-soft endpoint (ADR-0790).

    A fixture whose linked match is ``completed`` or ``voided`` is **history**: its
    placement records where and when the match actually happened, so the move is
    refused. A fixture with no match yet (``None``) or a ``pending``/``in_progress`` one
    is freely (re)placeable — a round-robin match is born ``pending`` at go-live and
    only becomes ``in_progress`` when called, so neither status is the freeze trigger;
    the plan for a scheduled-or-live-but-unplayed match is exactly the thing a scheduler
    moves. Only ``completed``/``voided`` freezes.

    409, not 403 (this module's refusal-code doctrine, ADR-0017): the caller is the
    owner and the request is well-formed — it is the *fixture* that is past the point
    where a placement means anything. "Not you" would be a lie; the truth is "not any
    more".

    A ``match`` with ``assert_never``, not an ``in {completed, voided}`` test: a new
    ``MatchStatus`` is a type error here until somebody decides whether a fixture in it
    may be moved, rather than falling through to placeable — a freeze must never fail in
    the permissive direction.
    """
    match match_status:
        case MatchStatus.completed | MatchStatus.voided:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This fixture's match is already {match_status.value}, so its "
                    "placement can no longer be changed."
                ),
            )
        case MatchStatus.pending | MatchStatus.in_progress | None:
            return
        case _:
            assert_never(match_status)


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

    The body is the placement in full: `table_id` (a string ref into the tournament's
    `table_catalogue`) and `scheduled_start` (a **naive** wall-clock time, in the
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

    **The placement is otherwise soft.** `scheduled_start` is a *prediction* until
    pinned, and the placement's constraints — the table belongs to the fixture's pool,
    the time falls inside the pool's window, nothing is double-booked — are flags
    derived on read, **not** invariants. So an out-of-window time, or a `table_id` that
    names no table in the catalogue, is **stored, not rejected**; the queued re-solve
    is what judges the consequences.

    **The one hard rule:** a fixture whose linked match is `completed` or `voided` is
    history, so its placement can no longer be changed — a `409`. A fixture with no
    match yet, or a `pending`/`in_progress` one, is freely (re)placeable (a round-robin
    match is born `pending` at go-live and only becomes `in_progress` when called, so
    neither is the freeze trigger).

    Owner-only, like every other tournament mutation: an absent tournament, or a fixture
    that is not part of it, is a `404`; a non-owner is a `403`.
    """
    # 404 → 403 → 409, the ordering ADR-0017 fixed for this whole module. The locked
    # loader welds the 404 (tournament absent) to the row lock; ``_require_owner`` then
    # adds the 403 (not the caller's), before the fixture — let alone its placement
    # state — is looked at, so a stranger probing ids learns nothing.
    #
    # It takes the row lock, like the other fixture-writers, because this route WRITES
    # ``TournamentFixture`` rows, and ``cut_draw``/``uncut_draw`` delete-and-replace an
    # event's fixtures wholesale under this same tournament lock (``uncut_draw`` also
    # runs cross-actor from ``account_merge``'s un-cut of a collided entrant's events).
    # Without the lock, that DELETE can commit between this route's fixture SELECT and
    # its flush, so the UPDATE matches zero rows and SQLAlchemy raises a
    # ``StaleDataError`` — an unhandled 500. Holding the lock first serializes the whole
    # read-judge-write against a concurrent cut/uncut of the same event. It does NOT
    # save the placement from a re-cut that wins the lock: that placement is discarded,
    # the accepted ADR-0790 consequence. What the lock buys is a *clean* outcome — the
    # placement is made and then discarded by the re-cut, or the fixture is already gone
    # and this answers a 404 — never a 500. Same lock, same row, taken first, as the
    # transition, entry, and draw routes: one lock, one order, so no pair can deadlock.
    tournament = await _get_tournament_for_update_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    # The fixture, scoped to this tournament (a mismatched pair is a 404), and its
    # match's live status — the single fact the freeze judges.
    fixture, match_status, event_timezone = await _get_fixture_or_404(
        db, tournament_id, fixture_id
    )
    # The one hard rule, before anything is written: a played-out fixture keeps its
    # placement. Everything else — an odd time, a dangling table ref — saves.
    _enforce_fixture_placeable(match_status)
    # The whole pin/notify transition — columns, ``pinned_at``, in-app rows — on this
    # open transaction (the atomicity contract of ``app.match_calls``: a call and its
    # durable record commit together); the returned push/email fan-out is enqueued
    # only after the commit below. The tournament row lock held above is the lock
    # every pin writer takes first, so this write serializes with a concurrent pin
    # tick or guarded apply.
    fanout = await apply_manual_placement(
        db,
        tournament,
        fixture,
        table_id=payload.table_id,
        scheduled_start=payload.scheduled_start,
        event_timezone=event_timezone,
    )
    # Scheduling-input trigger: the director just changed the solver's inputs — a new
    # pin to plan around, or a freed slot — so the board re-plans (ADR). Same
    # transaction, under the tournament row lock (the order ``request_solve``
    # requires); no drawn-event gate, because a fixture in hand means a draw is cut by
    # definition. A ``None`` return (Redis down) deliberately costs the solve, never
    # the placement.
    await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
    # Post-commit, by design: the pin and its in-app rows are durable; push/email
    # fan-out is best-effort (``app.match_calls``'s atomicity contract).
    enqueue_call_fanout(fanout)
    # Read back through the SAME loader the detail page reads fixtures through, so the
    # placed fixture this answers with is byte-for-byte the one the page will show —
    # ``match_status`` live (not the value the freeze just judged, which was a means to
    # an end), same read model. The fixture is in the batch we just committed, so the
    # lookup always finds it.
    fixtures = (await fixtures_by_event(db, [fixture.event_id]))[fixture.event_id]
    return next(f for f in fixtures if f.id == fixture.id)


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
        # A non-round-robin (or otherwise degenerate) draw the synthetic field
        # cannot be planned — the same 422 the cut route produces, in words a
        # director can read.
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
