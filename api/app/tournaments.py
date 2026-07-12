import uuid
from typing import Any, Literal, assert_never

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import (
    EventFormat,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentStatus,
    User,
)
from app.rbac import require_permission
from app.schemas.tournament import (
    TournamentCreate,
    TournamentDetailRead,
    TournamentEntrantRead,
    TournamentEventCreate,
    TournamentEventRead,
    TournamentEventUpdate,
    TournamentRead,
    TournamentTransitionCreate,
    TournamentUpdate,
)
from app.sessions import get_current_user
from app.tournament_queries import active_entrants_by_event

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
TOURNAMENT_VIEW = "tournament.view"
TOURNAMENT_CREATE = "tournament.create"
TOURNAMENT_ENTER = "tournament.enter"

require_view = require_permission(TOURNAMENT_VIEW)
require_create = require_permission(TOURNAMENT_CREATE)
# Returns the signed-in user, so the enter route gets its gate and its caller
# from one dependency — and cannot enter anyone other than that caller.
require_enter = require_permission(TOURNAMENT_ENTER)

# The tournament lifecycle, in full (ADR-0017):
#
#     draft ──publish──▶ published ──go live──▶ live ──archive──▶ archived
#
# Legality is a property of the EDGE, not of the target — "may I be published?"
# has no answer without knowing where you are now — so the rule is a set of
# ordered (from, to) pairs, and this set is the whole rule. Every pair absent
# from it is a 409: backwards (published → draft), skipping a stage (draft →
# live), out of the terminal ``archived``, and re-asserting the status a
# tournament already holds (published → published is a *conflict*, not an
# idempotent no-op: the only caller that sends it is a stale one, and answering
# 200 would tell it that it did something when somebody else did).
#
# One table, at one dispatch point, is also where slice B (#785) hangs the
# go-live precondition ("requires a generated draw") — a per-target rule that
# would otherwise have to be remembered in a route of its own.
LEGAL_TRANSITIONS: frozenset[tuple[TournamentStatus, TournamentStatus]] = frozenset(
    {
        (TournamentStatus.draft, TournamentStatus.published),
        (TournamentStatus.published, TournamentStatus.live),
        (TournamentStatus.live, TournamentStatus.archived),
    }
)

router = APIRouter(prefix="/v1")


# ----- helpers -------------------------------------------------------------


def _tournament_fields(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
) -> dict[str, Any]:
    # The request-scoped fields (``created_by_username``/``can_edit``) aren't on
    # the ORM row. The JSONB columns (``address``/``table_catalogue``) are read
    # straight off the attributes; Pydantic validates them into
    # Address/TournamentTable when the returned dict is fed to model_validate,
    # so the raw dicts never leave the serialize boundary.
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "status": t.status,
        "start_date": t.start_date,
        "end_date": t.end_date,
        "address": t.address,
        "table_catalogue": t.table_catalogue,
        "created_by_user_id": t.created_by_user_id,
        "created_by_username": created_by_username,
        "can_edit": t.created_by_user_id == current_user_id,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


def _serialize(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
) -> TournamentRead:
    return TournamentRead.model_validate(
        _tournament_fields(
            t, created_by_username=created_by_username, current_user_id=current_user_id
        )
    )


def _serialize_event(
    e: TournamentEvent,
    *,
    entrants: list[TournamentEntrantRead],
) -> TournamentEventRead:
    # ``entrants`` is not on the ORM row in the shape the read model wants (it
    # needs the entrant's username, and only the *active* entries), so the fields
    # are listed explicitly rather than validated straight off the attributes —
    # which would also fire a lazy load. The event's ``entered`` count is not
    # listed at all: it is a computed field over ``entrants`` (ADR-0016), so
    # there is nothing here that could disagree with the list.
    return TournamentEventRead.model_validate(
        {
            "id": e.id,
            "tournament_id": e.tournament_id,
            "name": e.name,
            "format": e.format,
            "draw_type": e.draw_type,
            "max_players": e.max_players,
            "entry_fee": e.entry_fee,
            "slot": e.slot,
            "match_settings": e.match_settings,
            "predicates": e.predicates,
            "pools": e.pools,
            "created_at": e.created_at,
            "updated_at": e.updated_at,
            "entrants": entrants,
        }
    )


def _serialize_detail(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
    events: list[TournamentEvent],
    entrants_by_event: dict[uuid.UUID, list[TournamentEntrantRead]],
) -> TournamentDetailRead:
    # The full aggregate: tournament fields plus its events (each event's JSONB
    # value-objects validate into Pydantic models here, at this single boundary).
    return TournamentDetailRead.model_validate(
        {
            **_tournament_fields(
                t,
                created_by_username=created_by_username,
                current_user_id=current_user_id,
            ),
            "events": [
                _serialize_event(e, entrants=entrants_by_event[e.id]) for e in events
            ],
        }
    )


async def _get_tournament_or_404(
    db: AsyncSession, tournament_id: uuid.UUID
) -> Tournament:
    tournament = (
        await db.execute(select(Tournament).where(Tournament.id == tournament_id))
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


def _require_owner(t: Tournament, current_user: User) -> None:
    if t.created_by_user_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You can only modify tournaments you created.",
        )


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
    # entries, table count), so the list returns the full aggregate — events and
    # their entrants included — rather than a thinner summary. THREE queries, no
    # N+1, whatever the number of tournaments or events: the tournaments+usernames
    # join, then all their events, then all those events' active entrants in one
    # batch. A per-event entry count would be the N+1 this shape exists to avoid,
    # and a statement-count tripwire in tests/test_tournaments.py fails if one
    # comes back.
    rows = (
        await db.execute(
            select(Tournament, User.username)
            .join(User, User.id == Tournament.created_by_user_id)
            .order_by(Tournament.created_at.desc())
        )
    ).all()
    tournament_ids = [tournament.id for tournament, _ in rows]
    events_by_tournament: dict[uuid.UUID, list[TournamentEvent]] = {
        tid: [] for tid in tournament_ids
    }
    events: list[TournamentEvent] = []
    if tournament_ids:
        events = list(
            (
                await db.execute(
                    select(TournamentEvent)
                    .where(TournamentEvent.tournament_id.in_(tournament_ids))
                    .order_by(TournamentEvent.created_at)
                )
            )
            .scalars()
            .all()
        )
        for event in events:
            events_by_tournament[event.tournament_id].append(event)
    entrants_by_event = await active_entrants_by_event(db, [e.id for e in events])
    return [
        _serialize_detail(
            tournament,
            created_by_username=username,
            current_user_id=current_user.id,
            events=events_by_tournament[tournament.id],
            entrants_by_event=entrants_by_event,
        )
        for tournament, username in rows
    ]


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
    # Persist the value-objects as plain JSONB; the dicts produced by
    # ``model_dump`` don't propagate beyond this write boundary.
    #
    # No ``status``: it isn't on the create schema (ADR-0017), so it isn't set
    # here either. A tournament is born ``draft`` from the column's server
    # default — one source for the starting status, rather than a schema default
    # that a request could override — and the ``refresh`` below reads it back.
    tournament = Tournament(
        name=payload.name,
        description=payload.description,
        start_date=payload.start_date,
        end_date=payload.end_date,
        address=payload.address.model_dump(),
        table_catalogue=[t.model_dump() for t in payload.table_catalogue],
        created_by_user_id=current_user.id,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return _serialize(
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
    row = (
        await db.execute(
            select(Tournament, User.username)
            .join(User, User.id == Tournament.created_by_user_id)
            .where(Tournament.id == tournament_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    tournament, username = row
    # A second query loads this tournament's events in creation order, and a
    # third batches every one of those events' active entrants — the same
    # one-statement-per-collection shape the list endpoint uses.
    events = list(
        (
            await db.execute(
                select(TournamentEvent)
                .where(TournamentEvent.tournament_id == tournament_id)
                .order_by(TournamentEvent.created_at)
            )
        )
        .scalars()
        .all()
    )
    entrants_by_event = await active_entrants_by_event(db, [e.id for e in events])
    return _serialize_detail(
        tournament,
        created_by_username=username,
        current_user_id=current_user.id,
        events=events,
        entrants_by_event=entrants_by_event,
    )


@router.patch("/tournaments/{tournament_id}", response_model=TournamentRead)
async def update_tournament(
    tournament_id: uuid.UUID,
    payload: TournamentUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentRead:
    # Load first (404 if missing), THEN check ownership (403). The ordering is
    # intentional: a permitted non-creator learns the tournament exists.
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    # model_dump(exclude_unset=True) already recursively serializes the nested
    # value-objects (address/table_catalogue) to plain dicts/lists, so a single
    # setattr loop covers the JSONB columns and the scalar fields alike. Absent
    # fields stay untouched; the schema validator already rejected an explicit
    # null on the NOT NULL columns.
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(tournament, key, value)
    await db.commit()
    await db.refresh(tournament)
    # The owner is the current user, so the username and can_edit are known.
    return _serialize(
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
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    await db.delete(tournament)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- lifecycle routes ----------------------------------------------------


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

    Owner-only, like every other tournament mutation.
    """
    # Load first (404), then ownership (403), and only then judge the edge (409)
    # — the ordering the owner-only routes above already keep. It is the ordering
    # that makes each code mean one thing: a stranger poking at someone else's
    # tournament gets the same 403 whichever edge they ask for, so the response
    # never leaks what status a tournament they cannot touch is in.
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)

    if (tournament.status, payload.to) not in LEGAL_TRANSITIONS:
        # The pair, not the target: the same ``to`` that is legal from one status
        # is a conflict from another. The detail names both ends of the edge the
        # caller asked for, because that is what a stale tab needs to be told —
        # and it says nothing a user shouldn't read.
        raise HTTPException(
            status_code=409,
            detail=(
                f"This tournament is {tournament.status.value}; "
                f"it cannot be moved to {payload.to.value}."
            ),
        )

    tournament.status = payload.to
    await db.commit()
    await db.refresh(tournament)
    # The owner is the current user (``_require_owner`` just said so), so the
    # creator's username and can_edit are both known without another query.
    return _serialize(
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
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name=payload.name,
        format=payload.format,
        draw_type=payload.draw_type,
        max_players=payload.max_players,
        entry_fee=payload.entry_fee,
        slot=payload.slot.model_dump(),
        match_settings=payload.match_settings.model_dump(),
        predicates=[p.model_dump() for p in payload.predicates],
        pools=[p.model_dump() for p in payload.pools],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    # A just-created event has no entries, so its entrants are empty and its
    # derived ``entered`` count is 0 — no query needed to learn that.
    return _serialize_event(event, entrants=[])


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
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    event = await _get_event_or_404(db, tournament_id, event_id)
    # As in update_tournament: model_dump(exclude_unset=True) serializes the
    # nested value-objects (slot/match_settings/predicates/pools) to plain
    # dicts/lists, so one setattr loop covers the JSONB columns and scalars.
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(event, key, value)
    await db.commit()
    await db.refresh(event)
    # An edited event keeps whatever entrants it already had — reload them rather
    # than answering with an empty list (and a ``entered`` of 0) that would be a
    # lie for any event people have entered.
    entrants = (await active_entrants_by_event(db, [event.id]))[event.id]
    return _serialize_event(event, entrants=entrants)


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
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    event = await _get_event_or_404(db, tournament_id, event_id)
    await db.delete(event)
    await db.commit()
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
    """Raise the 409 when the registration window is shut.

    ``_registration_open`` owns the *decision*; this only turns a refusal into a
    status code and words (``_registration_closed_detail``), so no caller of this
    can disagree with a caller of the predicate about whether entry is open.

    409, not 403 (ADR-0017): the caller is permitted and the entry is their own — it
    is the tournament that is in the wrong state. "Not you" would be a lie; the truth
    is "not now".

    The status is re-tested below rather than taken on trust from the predicate,
    because a ``bool`` cannot narrow ``t.status`` for the type checker — and that
    narrowing is load-bearing: it is what keeps ``_registration_closed_detail``'s
    ``Literal`` exhaustive, so a fourth closed status added to the enum is a type
    error right here until somebody writes the sentence a player should read.
    """
    if _registration_open(t):
        return
    if t.status is not TournamentStatus.published:
        raise HTTPException(
            status_code=409,
            detail=_registration_closed_detail(t.status),
        )


@router.post(
    "/tournaments/{tournament_id}/events/{event_id}/entries",
    response_model=TournamentEntrantRead,
    status_code=status.HTTP_201_CREATED,
)
async def enter_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(require_enter),
) -> TournamentEntrantRead:
    """Register the signed-in player in a singles event.

    Self-registration only: the entry created is always the caller's own, which
    is why the request carries no body — there is no field in which to name
    someone else. Entering a player who is not you is a director's job, and a
    different endpoint.

    Registration is open only while the tournament is **`published`** — its status
    *is* its registration window (ADR-0017). Entering an event of a `draft`
    tournament (not announced yet), a `live` one (the field is fixed; the draw is
    cut from it), or an `archived` one (it is over) is a `409` — not a `403`: you
    are permitted, the tournament is simply in the wrong state.

    Entering an event you are already in is a `409`; withdrawing first frees you
    to enter it again. Doubles and teams events are a `400`: an entry is one row
    per player, with nowhere to record a partner or a team.
    """
    # Load first, then decide — the same 404-before-anything-else ordering the
    # owner-only routes use. This route has no ownership check to run afterwards:
    # a player entering themselves is by definition not the tournament's owner,
    # so the authorization is the ``tournament.enter`` gate above plus the fact
    # that ``current_user`` is the only user this handler can enter.
    tournament = await _get_tournament_or_404(db, tournament_id)
    event = await _get_event_or_404(db, tournament_id, event_id)
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
    _enforce_registration_open(tournament)

    entry = TournamentEntry(event_id=event.id, user_id=current_user.id)
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
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="You have already entered this event."
        ) from None

    return TournamentEntrantRead(
        id=entry.id,
        user_id=current_user.id,
        username=current_user.username,
        seed=entry.seed,
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
    current_user: User = Depends(require_enter),
) -> Response:
    """Withdraw the signed-in player's own entry from an event.

    The entry is **soft-deleted**: its status flips to `withdrawn` and the row
    survives, so the event keeps its withdrawal history — and, because the
    uniqueness guard is a *partial* index over active entries only, the player is
    free to enter the same event again afterwards.

    You may only withdraw your own entry; someone else's is a `403`.

    Withdrawal, like entry, is open only while the tournament is **`published`** —
    its status *is* its registration window (ADR-0017). Withdrawing an *active*
    entry from a `live` tournament would pull a player out from under a draw cut
    from the field they were part of, so it is a `409`, as it is for a `draft`
    tournament (registration has not opened) and an `archived` one (it is over).
    A `409`, not a `403`: you are permitted, the tournament is simply in the wrong
    state.

    **Withdrawing an entry that is already withdrawn is a `204` in every status**,
    `live` and `archived` included — a no-op, not an error: this is `DELETE`, and
    asking for a state the resource is already in is a success. The status gate is
    on the state *change*, not on the call; an entry that is already withdrawn has
    nothing left to lock.
    """
    # Load-then-authorize, as everywhere else here: the tournament, the event
    # under it, and the entry under that event must all exist before ownership is
    # considered — so a wrong (tournament, event, entry) triple is a 404, and 403
    # means "this entry is real, but it isn't yours".
    tournament = await _get_tournament_or_404(db, tournament_id)
    event = await _get_event_or_404(db, tournament_id, event_id)
    entry = await _get_entry_or_404(db, event.id, entry_id)
    if entry.user_id != current_user.id:
        # The ``tournament.enter`` gate says "may self-register at all"; it cannot
        # say *whose* entry this is. Withdrawing another player from an event is a
        # director's job (#784), on a different endpoint with its own permission.
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
