import uuid
from collections import defaultdict
from typing import Any, Literal, assert_never

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.draws import (
    DegenerateDraw,
    DrawError,
    EntryId,
    NonSinglesDraw,
    PoolId,
    UnsupportedDrawType,
)
from app.leagues import resolve_league
from app.models import (
    DrawType,
    EventFormat,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentStatus,
    User,
)
from app.rbac import require_permission, user_has_permission
from app.results import EventResults, MatchOutcome, PoolInput, results_for
from app.schemas.tournament import (
    EventEntryFull,
    EventEntryOpen,
    EventEntryRatingIneligible,
    EventEntryState,
    EventResultsRead,
    PoolStandingsRead,
    StandingRowRead,
    TournamentCreate,
    TournamentDetailRead,
    TournamentEntrantRead,
    TournamentEntryCreate,
    TournamentEventCreate,
    TournamentEventRead,
    TournamentEventUpdate,
    TournamentFixtureRead,
    TournamentRead,
    TournamentTransitionCreate,
    TournamentUpdate,
    named_list,
)
from app.sessions import get_current_user
from app.tournament_draws import (
    DrawCurrency,
    cut_draw,
    draw_currency_by_event,
    draw_has_play,
    event_has_draw,
    event_pools,
    uncut_draw,
)
from app.tournament_eligibility import (
    Eligible,
    RatingIneligible,
    evaluate_rating_eligibility,
    event_is_full,
)
from app.tournament_entry_refusals import EntryRefusal, entry_refused
from app.tournament_materialization import materialize_live_draw
from app.tournament_queries import (
    active_entrants_by_event,
    active_entry_count,
    entrant_rating,
    entrant_ratings_by_league,
    fixtures_by_event,
    game_counts_by_match,
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
# One table, at one dispatch point, is also where the go-live precondition hangs
# (``_enforce_ready_to_go_live``, ADR-0786): a tournament may only *start* with at
# least one event, each with a draw that seats exactly its current entrants. That is
# a rule about the TARGET rather than the edge — it says nothing about who may publish
# or archive — and it lives beside this table, in the one handler that consults it,
# rather than in a route of its own that somebody would have to remember to call.
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
        "league_id": t.league_id,
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


def _entry_state(
    e: TournamentEvent,
    *,
    entered: int,
    rating: float | None,
) -> EventEntryState:
    """Whether THIS caller may enter THIS event — the read-path twin of the guards
    the entry route raises 409s from, computed from facts already in hand.

    No database access, and that is the point: the ``entered`` count is the length of
    the entrants list the read has already batched (ADR-0016 — the count is derived
    from the rows, so it cannot disagree with the list beside it), and ``rating`` is
    the caller's rating on the **tournament's** league, resolved ONCE per tournament
    (``entrant_ratings_by_league``) because every event of a tournament is judged on
    the same ladder. Reaching for either from in here would be a query per event: an
    N+1 that grows with the very field the page is describing, and the statement-count
    tripwires in ``tests/test_tournaments.py`` fail if one appears.

    **The decision is not made here.** ``evaluate_rating_eligibility`` and
    ``event_is_full`` make it — the same two functions the ``POST …/entries`` guards
    call — so the page that explains why Enter is not offered and the route that
    refuses the entry cannot come to two different answers (ADR-0783). This is only
    the translation into the wire's sum type.

    That sharing is what keeps an **uncapped** event (``max_players IS NULL``,
    ADR-0935) out of the ``event_full`` arm: ``event_is_full`` answers ``False`` for a
    null cap however many entrants there are, so this function cannot report as full an
    event the entry route would happily admit the reader to. Had the capacity question
    been re-asked here — with a ``>=`` over a nullable column — it would have been a
    ``TypeError`` on the detail page of the first uncapped event, or (worse, had it
    been written defensively as ``max_players or 0``) a permanently, silently full one.

    **The ORDER mirrors the entry route's**, and it has to: eligibility first, then
    capacity. An ineligible player looking at a full event is told about their
    *rating*, which is exactly what ``POST …/entries`` would tell them
    (``test_the_rating_refusal_outranks_the_event_full_refusal``) — and it is the more
    useful of the two facts, because it is the one that does not change when somebody
    withdraws. Flip these two lines and the page starts promising a player a slot that
    frees up, for an event that would refuse them anyway.

    What is deliberately NOT decided here: the registration window (a fact about the
    tournament — its status, ADR-0017), whether the caller is already entered (a fact
    on the entrants list), whether they hold ``tournament.enter``, and whether the
    event is doubles. All four are already on the page or in the session, and
    restating them would be carrying a field and its own derivation. ``open`` means
    "the event admits you", not "click here".

    ``match`` with ``assert_never``, not ``isinstance``: a third eligibility outcome
    added tomorrow is a type error here until somebody says what the page should show
    for it, rather than falling through to ``open`` — a read must not fail in the
    reassuring direction any more than a guard may fail in the permissive one.
    """
    decision = evaluate_rating_eligibility(rating=rating, predicates=e.predicates)
    match decision:
        case RatingIneligible():
            return EventEntryRatingIneligible(
                predicate_id=decision.predicate_id, rating=decision.rating
            )
        case Eligible():
            if event_is_full(entered=entered, max_players=e.max_players):
                return EventEntryFull()
            return EventEntryOpen()
        case _:
            assert_never(decision)


def _completed_match_ids(
    fixtures_by_event: dict[uuid.UUID, list[TournamentFixtureRead]],
) -> list[uuid.UUID]:
    """The ids of the matches of every **completed** fixture across the page.

    The one list ``game_counts_by_match`` is batched over, gathered before any event is
    serialized so the standings of every event are projected from a single game load
    (ADR-0788) rather than a query per event. Only ``completed`` fixtures contribute: an
    in-progress match's part-scored board is not a result and must not reach a standings
    table."""
    return [
        f.match_id
        for fixtures in fixtures_by_event.values()
        for f in fixtures
        if f.match_status is MatchStatus.completed and f.match_id is not None
    ]


def _event_results(
    e: TournamentEvent,
    *,
    fixtures: list[TournamentFixtureRead],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> EventResultsRead | None:
    """The event's results (ADR-0788), projected from its fixtures' completed matches,
    or ``None`` when there are none to compute.

    ``None`` in two cases, both meaning "no results here" rather than an empty table: a
    draw type with no results strategy yet (``results_for`` raises for it — only
    round-robin has one today), and an event whose draw has not been cut (no fixtures to
    stand). Everything else is a real :class:`EventResultsRead`, whose standings are
    empty of *decided* rows but full of *seated* ones while the pool is still played.

    The projection is the fixed materialization convention read backwards (#788): side 1
    is ``entry_a`` and side 2 is ``entry_b``, so the ``(side_1, side_2)`` game counts
    are the ``(entry_a, entry_b)`` game counts, and the winner is whichever took more
    games — derived from the live match, never from the fixture's written-back
    ``winner_entry_id`` (which no round-robin read reads, for correction-safety)."""
    match e.draw_type:
        case DrawType.round_robin:
            pass  # the projection below is round-robin-shaped
        case (
            DrawType.single_elim
            | DrawType.double_elim
            | DrawType.rr_then_ko
            | DrawType.swiss
        ):
            # No results projection for these yet (``results_for`` has no strategy for
            # them either). Spelled as a checked dispatch with an ``assert_never``
            # catch-all rather than a bare ``is not round_robin``, so a new ``DrawType``
            # is a type error here until its projection is written — the same guarantee
            # ``strategy_for``/``results_for`` give (ADR-0788).
            return None
        case _:
            assert_never(e.draw_type)
    if not fixtures:
        return None
    by_pool: dict[str, list[TournamentFixtureRead]] = defaultdict(list)
    for f in fixtures:
        # A round-robin fixture is always pooled; a NULL pool would be a different draw
        # type's fixture and has no pool table to stand in. Skip it rather than key a
        # pool on ``None``.
        if f.pool_id is not None:
            by_pool[f.pool_id].append(f)
    pool_inputs: list[PoolInput] = []
    for pool_id, pool_fixtures in by_pool.items():
        entrants = {
            entry_id
            for f in pool_fixtures
            for entry_id in (f.entry_a_id, f.entry_b_id)
            if entry_id is not None
        }
        outcomes: list[MatchOutcome] = []
        for f in pool_fixtures:
            if (
                f.match_status is not MatchStatus.completed
                or f.match_id is None
                or f.entry_a_id is None
                or f.entry_b_id is None
            ):
                continue
            side_1_games, side_2_games = game_counts[f.match_id]
            outcomes.append(
                MatchOutcome(
                    entry_a_id=EntryId(f.entry_a_id),
                    entry_b_id=EntryId(f.entry_b_id),
                    entry_a_games=side_1_games,
                    entry_b_games=side_2_games,
                )
            )
        pool_inputs.append(
            PoolInput(
                pool_id=PoolId(pool_id),
                entrants=tuple(EntryId(entry_id) for entry_id in entrants),
                fixture_count=len(pool_fixtures),
                outcomes=tuple(outcomes),
            )
        )
    return _serialize_results(results_for(e.draw_type).tabulate(pool_inputs))


def _serialize_results(results: EventResults) -> EventResultsRead:
    return EventResultsRead(
        pools=[
            PoolStandingsRead(
                pool_id=pool.pool_id,
                rows=[
                    StandingRowRead(
                        entry_id=row.entry_id,
                        rank=row.rank,
                        played=row.played,
                        wins=row.wins,
                        losses=row.losses,
                        games_won=row.games_won,
                        games_lost=row.games_lost,
                    )
                    for row in pool.rows
                ],
                complete=pool.complete,
            )
            for pool in results.pools
        ],
        complete=results.complete,
        champion=results.champion,
    )


def _serialize_event(
    e: TournamentEvent,
    *,
    entrants: list[TournamentEntrantRead],
    fixtures: list[TournamentFixtureRead],
    rating: float | None,
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> TournamentEventRead:
    # ``entrants`` is not on the ORM row in the shape the read model wants (it
    # needs the entrant's username, and only the *active* entries), so the fields
    # are listed explicitly rather than validated straight off the attributes —
    # which would also fire a lazy load. The event's ``entered`` count is not
    # listed at all: it is a computed field over ``entrants`` (ADR-0016), so
    # there is nothing here that could disagree with the list.
    #
    # ``entry_state`` is the caller's, and it is computed from the entrants already
    # loaded plus the caller's ``rating`` on this tournament's league — passed in,
    # never fetched here, so no serializer can turn into an N+1.
    #
    # ``fixtures`` — the event's draw (ADR-0786) — is passed in for exactly that
    # reason. ``e.fixtures`` is right there on the ORM instance and would read
    # *correctly*: a lazy load would fetch the rows and the response would be
    # identical. It would also fire one SELECT per event, on the LIST endpoint that
    # returns every event of every tournament — an N+1 that no assertion about the
    # body can see. It is loaded once, in a batch, by ``fixtures_by_event``, which
    # also owns the pool → round → position ordering, so the serializer never sorts
    # and no two call sites can order a bracket differently.
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
            "entry_state": _entry_state(e, entered=len(entrants), rating=rating),
            "fixtures": fixtures,
            # The standings, projected here from the fixtures' completed matches plus
            # the page's one batched game load — ``None`` for an uncut or
            # non-round-robin event (ADR-0788). Computed in the serializer, not fetched
            # per event, for the same reason ``fixtures`` is: no read may become an N+1.
            "results": _event_results(e, fixtures=fixtures, game_counts=game_counts),
        }
    )


def _serialize_detail(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
    events: list[TournamentEvent],
    entrants_by_event: dict[uuid.UUID, list[TournamentEntrantRead]],
    fixtures_by_event: dict[uuid.UUID, list[TournamentFixtureRead]],
    game_counts: dict[uuid.UUID, tuple[int, int]],
    rating: float | None,
) -> TournamentDetailRead:
    # The full aggregate: tournament fields plus its events (each event's JSONB
    # value-objects validate into Pydantic models here, at this single boundary).
    #
    # ONE ``rating`` for all of them — the caller's, on ``t.league_id``. A tournament
    # names the single ladder its eligibility is judged on (ADR-0783), so every event
    # under it is judged on the same number, and fetching it per event would be a
    # query per event for an answer that cannot vary.
    return TournamentDetailRead.model_validate(
        {
            **_tournament_fields(
                t,
                created_by_username=created_by_username,
                current_user_id=current_user_id,
            ),
            "events": [
                _serialize_event(
                    e,
                    entrants=entrants_by_event[e.id],
                    fixtures=fixtures_by_event[e.id],
                    rating=rating,
                    game_counts=game_counts,
                )
                for e in events
            ],
        }
    )


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


def _enforce_league_editable(t: Tournament) -> None:
    """Raise the 409 unless the tournament's league may still be moved.

    A tournament's league is the ladder its events' rating rules are judged on
    (ADR-0783), and it is settled the moment the tournament is published: from
    then on registration is open and eligibility is *live*, so moving the ladder
    underneath would silently re-judge — and could retroactively disqualify —
    players who have already entered against the old one. ``draft`` is the only
    status in which nobody can have entered yet, so it is the only one in which
    the ladder is still free to move. Same guarded-edge reasoning as the lifecycle
    itself (ADR-0017): what a tournament will accept depends on where it is.

    Presence, not difference: sending the league the tournament already has, once
    it is published, is refused too. That mirrors the transition route, where
    re-asserting the status you already hold is a *conflict* rather than an
    idempotent no-op — the only caller that sends a settled field is a stale one,
    and answering 200 would tell it the field is still editable when it is not.

    409, not 403 (as on the transitions route): the caller is the owner and the
    field is theirs to edit — it is the tournament that is past the point where
    the edit means anything. "Not you" would be a lie; the truth is "not now".
    """
    if t.status is TournamentStatus.draft:
        return
    raise HTTPException(
        status_code=409,
        detail=(
            f"This tournament is {t.status.value}; its league can only be changed "
            "while it is a draft."
        ),
    )


# The statuses in which a tournament has been ANNOUNCED to the world. Publishing
# is the act that makes a tournament public (ADR-0017), and nothing walks
# backwards out of it, so everything from ``published`` onward is announced and
# ``draft`` is not.
#
# An allow-list, deliberately, rather than "anything but draft": a status added
# to the enum tomorrow is invisible to non-owners until somebody puts it in this
# set on purpose. The inverse spelling would silently publish a future
# pre-publish status (a ``pending_review``, a ``scheduled``) the moment it was
# added, which is exactly the leak this predicate exists to close.
ANNOUNCED_STATUSES: frozenset[TournamentStatus] = frozenset(
    {
        TournamentStatus.published,
        TournamentStatus.live,
        TournamentStatus.archived,
    }
)


def _visible_to(user_id: uuid.UUID) -> ColumnElement[bool]:
    """Which tournaments ``user_id`` may see at all: the announced ones, plus
    their own — whatever status their own is in.

    A draft is not announced, so it is owner-only. The read routes push this into
    the WHERE clause rather than filtering after the fact, so a hidden draft is
    *not selected* and the detail route's existing "Tournament not found." 404
    answers for it. 404 and not 403: a 403 would confirm that a tournament with
    that id exists, which is precisely what an unannounced tournament must not
    admit. A draft the caller cannot see is indistinguishable from one that was
    never created.

    ``tournament.view`` is a separate question, and it is asked first — it is a
    route dependency, so a caller without the permission is refused (403) before
    this predicate is ever built. Permission says "may you read tournaments at
    all"; this says "which ones are there for you to read".

    One predicate, used by both the list and the detail route, because two copies
    of this rule would eventually disagree — and the way they disagree is that the
    list hides a draft the detail route still serves.
    """
    return or_(
        Tournament.status.in_(ANNOUNCED_STATUSES),
        Tournament.created_by_user_id == user_id,
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
    # entries, table count), so the list returns the full aggregate — events, their
    # entrants and their draws included — rather than a thinner summary. FIVE queries,
    # no N+1, whatever the number of tournaments or events: the tournaments+usernames
    # join, then all their events, then all those events' active entrants in one
    # batch, then all those events' fixtures in one batch (ADR-0786), then the caller's
    # rating on every distinct league those tournaments run on (which every event's
    # ``entry_state`` is judged against, ADR-0783). A per-event entry count, a
    # per-event draw, or a per-tournament rating would be the N+1 this shape exists to
    # avoid, and a statement-count tripwire in tests/test_tournaments.py fails if one
    # comes back.
    #
    # Scoped by ``_visible_to``: somebody else's draft is not the caller's to see,
    # so it never enters the result set — and, because the filter is a WHERE clause
    # on the first of the four queries, the events and entrants queries are keyed
    # off the surviving ids and cannot leak a hidden tournament's contents either.
    # A predicate costs no extra statement, so the tripwire above still reads 4.
    rows = (
        await db.execute(
            select(Tournament, User.username)
            .join(User, User.id == Tournament.created_by_user_id)
            .where(_visible_to(current_user.id))
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
    event_ids = [e.id for e in events]
    entrants_by_event = await active_entrants_by_event(db, event_ids)
    # And ONE batch for every one of those events' fixtures — its draw (ADR-0786).
    # Batched for the same reason the entrants are: the list returns every event of
    # every tournament, so reading ``event.fixtures`` in the loop would be a SELECT per
    # event. Uncut draws come back as ``[]``, so an event nobody has cut a draw for
    # costs nothing and answers with an empty list rather than a null.
    event_fixtures = await fixtures_by_event(db, event_ids)
    # And ONE batch for the games of every completed tournament match on the page — the
    # raw material each event's standings are projected from (ADR-0788). One statement,
    # not one per event, and none at all when nothing has been played yet (an uncut or
    # unplayed page collects no completed match ids), so the statement-count pin holds.
    game_counts = await game_counts_by_match(db, _completed_match_ids(event_fixtures))
    # ONE batch for the caller's ratings, keyed by league — deduplicated, because
    # every tournament on the default league shares the one number, and because the
    # ladders a page happens to list is not a reason to ask the same question twice.
    ratings = await entrant_ratings_by_league(
        db, list({tournament.league_id for tournament, _ in rows}), current_user.id
    )
    return [
        _serialize_detail(
            tournament,
            created_by_username=username,
            current_user_id=current_user.id,
            events=events_by_tournament[tournament.id],
            entrants_by_event=entrants_by_event,
            fixtures_by_event=event_fixtures,
            game_counts=game_counts,
            rating=ratings[tournament.league_id],
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
    #
    # The league is the one field the caller may leave out and still get: the
    # column is NOT NULL (a tournament must name the ladder its eligibility is
    # judged on, ADR-0783), and an omitted ``league_id`` resolves to the default
    # league — the league a surface falls back to when the caller names none.
    #
    # The STRICT resolver, the same one the PATCH uses (and matches.py before it):
    # an omitted league is the default, but an id that names NO league is a 404.
    # NOT the degrading ``resolve_league_or_default`` — a tournament's league is a
    # persisted fact that decides who may enter, not a view-preference lens on a
    # resource that exists anyway (see the note in app/leagues.py). Degrading here
    # would answer 201 to a director who mistyped an id, hand them a tournament
    # quietly running on the DEFAULT ladder, and judge their entrants on a ladder
    # nobody chose — exactly the silent lie ADR-0783 exists to remove.
    league = await resolve_league(db, payload.league_id)
    tournament = Tournament(
        name=payload.name,
        description=payload.description,
        start_date=payload.start_date,
        end_date=payload.end_date,
        address=payload.address.model_dump(),
        table_catalogue=[t.model_dump() for t in payload.table_catalogue],
        league_id=league.id,
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
    event_ids = [e.id for e in events]
    entrants_by_event = await active_entrants_by_event(db, event_ids)
    # A FOURTH query batches every one of those events' fixtures — their DRAWS
    # (ADR-0786). The draw rides on this page rather than on a ``GET …/draw`` of its
    # own: one endpoint per page (root CLAUDE.md), so the bracket cannot become a
    # second round-trip that the page has to wait for. Batched across the events for
    # the same reason the entrants are — a draw read per event is an N+1 that grows
    # with the very thing the page is describing — and it is the loader, not this
    # route, that orders them (pool → round → position) and answers ``[]`` for an
    # event whose draw has not been cut.
    event_fixtures = await fixtures_by_event(db, event_ids)
    # ONE more query batches the games of every completed tournament match on the page
    # — what each event's standings are projected from (ADR-0788). One statement for the
    # whole page, and **none at all** until something has been played (an unplayed
    # detail collects no completed match ids), so an unplayed tournament still costs
    # five and the statement-count pin holds; a played one costs the one extra.
    game_counts = await game_counts_by_match(db, _completed_match_ids(event_fixtures))
    # The FIFTH query (and last on an unplayed page): the caller's rating on the
    # tournament's league, read ONCE for the whole page. It is what every event's
    # ``entry_state`` is judged against (ADR-0783), and a tournament has exactly one
    # ladder — so a rating read inside the per-event loop would issue a query per event
    # to learn the same number, on the page whose whole job is to describe a field of
    # events.
    rating = await entrant_rating(db, tournament.league_id, current_user.id)
    return _serialize_detail(
        tournament,
        created_by_username=username,
        current_user_id=current_user.id,
        events=events,
        entrants_by_event=entrants_by_event,
        fixtures_by_event=event_fixtures,
        game_counts=game_counts,
        rating=rating,
    )


@router.patch("/tournaments/{tournament_id}", response_model=TournamentRead)
async def update_tournament(
    tournament_id: uuid.UUID,
    payload: TournamentUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentRead:
    # The locked loader plus an explicit ``_require_owner`` — the same pair
    # ``create_tournament_transition`` takes, and for the same reason — rather than
    # ``_get_owned_tournament_or_404``, which does not lock. This route now *judges
    # the status and then writes*: the league guard below reads ``status``, and an
    # unlocked read answers from its own statement's snapshot (READ COMMITTED). A
    # league change could pass the ``draft`` check, the owner's publish could
    # commit, and the UPDATE could then land behind it — moving the ladder under a
    # tournament whose registration is already open, which is the one thing the
    # guard exists to prevent. Same lock, on the same row, taken first, as the
    # transition and entry routes: one lock in one order, so no pair of them can
    # deadlock.
    #
    # Load first (404 if missing), THEN check ownership (403). The ordering is
    # intentional, and is the one the owner-scoped loader bakes in: a permitted
    # non-creator learns the tournament exists.
    tournament = await _get_tournament_for_update_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    fields = payload.model_dump(exclude_unset=True)
    # The league is settled once the tournament leaves ``draft`` (ADR-0783), so it
    # comes out of the generic loop: it is the one field with a *state* rule, and
    # it is refused (409) before anything is written. The refusal is judged before
    # the league is looked up, so a caller who cannot change it learns nothing
    # about whether the league they named exists.
    if "league_id" in fields:
        _enforce_league_editable(tournament)
        # The STRICT resolver, exactly as on create: the id is a deliberate choice
        # by the owner, not a view preference, so an id that names no league is a
        # 404 rather than a silent swap to the default (see app/leagues.py). It also
        # keeps the NOT NULL FK from turning a bad id into a 500.
        league = await resolve_league(db, fields.pop("league_id"))
        tournament.league_id = league.id
    # model_dump(exclude_unset=True) already recursively serializes the nested
    # value-objects (address/table_catalogue) to plain dicts/lists, so a single
    # setattr loop covers the JSONB columns and the scalar fields alike. Absent
    # fields stay untouched; the schema validator already rejected an explicit
    # null on the NOT NULL columns.
    for key, value in fields.items():
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
    tournament = await _get_owned_tournament_or_404(db, tournament_id, current_user)
    await db.delete(tournament)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- lifecycle routes ----------------------------------------------------


# The one thing a tournament with no events can never do. Publishing one stays legal
# — announcing a tournament before its events are written up is ordinary — but
# *starting* it is not: there is nothing to run, no draw to have, and (without this)
# nothing for the per-event checks below to fail on, so an empty tournament would sail
# through a precondition that is vacuously true of it and land in ``live`` (ADR-0786;
# the hole the #782 hand-off flagged).
_NOTHING_TO_START = (
    "This tournament has no events, so there is nothing to start. Add an event and cut "
    "its draw, then start the tournament."
)


def _go_live_refusal(*, uncut: list[str], stale: list[str]) -> HTTPException:
    """The 409 for a tournament whose draws are not ready to be played (ADR-0786).

    409, not 403, for the reason ADR-0017 fixed for this whole module: the caller is
    the owner and going live is theirs to do — it is the *tournament* that is in the
    wrong state for it. The same request succeeds the moment the draws are cut, which
    is what a conflict means and what a 403 would deny.

    **It names the events**, because a refusal a director cannot act on is barely
    better than a 500: "some event has no draw" leaves them clicking through a
    ten-event tournament looking for it. Names, not ids (``named_list``) — the ids
    are what this guard compared, but they are not what the director is looking at.

    The two failures are kept apart in the sentence, because they are two different
    jobs. An **uncut** event needs a first cut. A **stale** one has a draw the
    director may well have reviewed and approved — it is simply older than the field,
    because somebody entered or withdrew after it was cut — and needs re-cutting,
    which will move players around inside it. Collapsing the two into "cut the draws"
    would tell the director of a stale event that nothing they did was kept.
    """
    clauses = []
    if uncut:
        clauses.append(
            f"{named_list(uncut)} {'has' if len(uncut) == 1 else 'have'} no draw yet"
        )
    if stale:
        clauses.append(
            f"{named_list(stale)} "
            + (
                "has a draw that no longer matches its entrants"
                if len(stale) == 1
                else "have draws that no longer match their entrants"
            )
        )
    return HTTPException(
        status_code=409,
        detail=(
            "This tournament cannot start yet: "
            + "; and ".join(clauses)
            + ". A draw is cut from the field as it stands at the time, and "
            "registration stays open right up to the moment a tournament goes live — "
            "so cut the draw for each event named (again, if somebody entered or "
            "withdrew since it was last cut), then start the tournament."
        ),
    )


async def _enforce_ready_to_go_live(db: AsyncSession, tournament: Tournament) -> None:
    """Raise the 409 unless every event of this tournament has a draw, and every one of
    those draws still describes the field it will be played by (ADR-0786).

    **The** ``published → live`` **precondition** — the per-target rule ADR-0017 left
    room for at its single dispatch point, and the reason that room was left. Going
    live is what seals the field (registration closes with it) and, from #788, what
    turns every ready fixture into a real match. Both are irreversible in practice and
    both are computed from the draw — so the draw has to be *right* at the instant the
    tournament starts, not merely to have existed at some point before it.

    Three ways it is not, and each of the three is refused:

    * **No events at all.** ``_NOTHING_TO_START``. It has to be checked, and checked
      first, because the per-event rules below say nothing about a tournament with no
      events: "every event has a current draw" is *true* of a tournament with none.
    * **An event with no draw** (``uncut``) — nothing to play.
    * **An event whose draw is stale** — its fixtures no longer seat exactly its
      active entrants. Registration stays open all the way to go-live, so a draw cut
      on Tuesday is a plan for Tuesday's field: a player who entered on Wednesday is
      in no fixture (they would sit out the tournament they paid for), and a player
      who withdrew is still seated in one (their opponents get a match nobody plays).

    **Read under the tournament's row lock, which the transition route has already
    taken** — this function does not take a second one, and must not. That lock is the
    whole mechanism: every writer of the entrant field (the entry route, the withdraw
    route) queues on that same row first, so an entry cannot land between this check
    and the ``UPDATE`` that follows it. Postgres runs READ COMMITTED, so unlocked, the
    currency this reads would be the currency of *its own statement's snapshot* — and
    a tournament could go live, on a draw this function had just certified as current,
    into a field with one more player in it than the draw seats. The check would have
    been true when it was made and false by the time it mattered, which is the only
    kind of guard worse than none.

    A ``match`` with ``assert_never``, not an ``if``: a fourth thing that can be true
    of a draw (a fixture pointing at a pool the event no longer has, say) is a type
    error here until somebody decides whether it may go live, rather than falling
    through to ``current`` — a precondition must never fail in the permissive
    direction.
    """
    events = (
        await db.execute(
            select(TournamentEvent.id, TournamentEvent.name)
            .where(TournamentEvent.tournament_id == tournament.id)
            # The page's order, so the refusal names the events in the order the
            # director is looking at them.
            .order_by(TournamentEvent.created_at)
        )
    ).all()
    if not events:
        raise HTTPException(status_code=409, detail=_NOTHING_TO_START)
    # ONE batched read for the whole tournament (two statements, whatever the number
    # of events): this runs with the row lock held, and a per-event query would hold
    # it for a time that grows with the tournament.
    currency = await draw_currency_by_event(db, [event_id for event_id, _ in events])
    uncut: list[str] = []
    stale: list[str] = []
    for event_id, name in events:
        state = currency[event_id]
        match state:
            case DrawCurrency.current:
                continue
            case DrawCurrency.uncut:
                uncut.append(name)
            case DrawCurrency.stale:
                stale.append(name)
            case _:
                assert_never(state)
    if not uncut and not stale:
        return
    raise _go_live_refusal(uncut=uncut, stale=stale)


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
    # Load first (404), then ownership (403), and only then judge the edge (409)
    # — the ordering the owner-only routes above already keep. It is the ordering
    # that makes each code mean one thing: a stranger poking at someone else's
    # tournament gets the same 403 whichever edge they ask for, so the response
    # never leaks what status a tournament they cannot touch is in.
    #
    # Locked, because the status this handler reads is the status it is about to
    # overwrite: two identical requests racing here would otherwise both read the
    # same ``from``, both find the edge legal, and both answer 201 — and "the
    # status you already hold is a conflict, not a no-op" would hold only when
    # nobody was in a hurry. The loser now blocks, re-reads the status the winner
    # committed, and gets the 409 it is owed. Same lock the entry routes take, so
    # an entry cannot slip in behind a go-live either.
    tournament = await _get_tournament_for_update_or_404(db, tournament_id)
    _require_owner(tournament, current_user)

    if (tournament.status, payload.to) not in LEGAL_TRANSITIONS:
        # The pair, not the target: the same ``to`` that is legal from one status
        # is a conflict from another. Both details name the tournament rather than
        # the schema, because a player reads them in a toast.
        #
        # The self-transition gets its own sentence. It is the common refusal in
        # practice — a stale tab clicking "Start tournament" on a tournament that
        # is already live is exactly the ``live → live`` the edge table refuses —
        # and the two-ended phrasing degenerates into tautology there ("this
        # tournament is live; it cannot be moved to live"), which tells the player
        # nothing. What they actually need is the fact that somebody already did
        # it. Every other illegal edge keeps the two-ended shape: a caller asking
        # for a genuinely illegal jump needs both ends named, since the target
        # alone doesn't say why it was refused.
        detail = (
            f"This tournament is already {tournament.status.value}."
            if tournament.status == payload.to
            else (
                f"This tournament is {tournament.status.value}; "
                f"it cannot be moved to {payload.to.value}."
            )
        )
        raise HTTPException(status_code=409, detail=detail)

    # THE per-target precondition, at the one dispatch point ADR-0017 reserved for it —
    # the edge table above says *where* you may go, and this says whether the tournament
    # is in a fit state to get there. Only ``live`` has one (ADR-0786): a tournament may
    # be published with no events and no draws (announcing early is fine), and archiving
    # asks nothing of the draws it is putting away.
    #
    # Inside the row lock this handler already holds, and it must stay inside it: the
    # currency it checks is a fact about the entrant field, and every writer of that
    # field queues on this same row — so an entry cannot land between the check and the
    # ``UPDATE`` below. A second lock is neither taken nor needed.
    if payload.to is TournamentStatus.live:
        await _enforce_ready_to_go_live(db, tournament)

    tournament.status = payload.to
    # Materialization (#788), as the transition's final act: once the status is
    # ``live``, the first ``advance()`` turns every ready fixture into a real
    # ``in_progress`` match — for round-robin, the whole pool — in the SAME transaction
    # as the status write, so a tournament is never seen ``live`` without the matches
    # its go-live created. Run only on the ``published → live`` edge (nothing else
    # materializes), and only after the precondition above, which is what guarantees a
    # complete, current draw to work from. It is idempotent on ``fixture.match_id``, so
    # it can never double-create.
    if payload.to is TournamentStatus.live:
        await materialize_live_draw(db, tournament)
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
    tournament = await _get_owned_tournament_or_404(db, tournament_id, current_user)
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
    rating = await entrant_rating(db, tournament.league_id, current_user.id)
    # No fixtures on a one-statement-old event, so no results either —
    # ``_event_results`` answers ``None`` for an uncut draw whatever the game counts, so
    # an empty map is all this needs.
    return _serialize_event(
        event, entrants=[], fixtures=[], rating=rating, game_counts={}
    )


def _pool_set_refusal(removed: list[str], added: list[str]) -> HTTPException:
    """The 409 for a pools payload that would change *which pools* a cut event has.

    409, not 403 (ADR-0017's refusal-code doctrine): the caller is the owner and the
    request is well-formed — it is the *resource* that is in the wrong state for it. The
    same payload becomes legal the moment the draw is removed, which is precisely what a
    conflict means and what a 403 would deny.

    Both halves are named, because a re-**id**'d pool is exactly one removal plus one
    addition and the director has to be told which of their pools went missing:

    * a **removed** pool leaves its fixtures pointing at a pool that no longer exists —
      the dangling ref no foreign key is there to catch (ADR-0786);
    * an **added** pool arrives with **no fixtures**, because the draw was dealt across
      the pools the event had at the cut, and nothing re-deals it.

    The sentence ends with the way out (remove the draw, change the pools, cut again)
    and with what is still allowed, because a refusal that only says "no" leaves a
    director who has to move a broken table with nowhere to go — and the answer is that
    they don't need us: tables, times and names were never frozen.
    """
    clauses = []
    if removed:
        clauses.append(
            f"{named_list(removed)} already has fixtures drawn into it, "
            "which this change would leave pointing at a pool that no longer exists"
        )
    if added:
        clauses.append(
            f"{named_list(added)} would arrive with no fixtures in it, "
            "because the draw was cut across the pools this event had at the time"
        )
    return HTTPException(
        status_code=409,
        detail=(
            "This event's draw is already cut, so its set of pools is frozen: "
            + "; and ".join(clauses)
            + ". A pool's tables, its time and its name can all still be changed. "
            "To add, remove or re-identify a pool, remove the draw first, then cut it "
            "again."
        ),
    )


async def _enforce_pool_set_frozen(
    db: AsyncSession, event: TournamentEvent, payload: TournamentEventUpdate
) -> None:
    """Raise the 409 once a ``pools`` payload would change *which pools* an event with a
    cut draw has (ADR-0786).

    A fixture names its pool by a **string ref** into this same event's ``pools`` JSONB,
    and there is no pools table for it to foreign-key. So the database cannot refuse the
    edit that orphans it, and the integrity of that reference is procedural — it is this
    function, and nothing else. Remove a pool (or change its ``id``, which is a removal
    with an addition standing where it was) and every fixture drawn into it refers to
    nothing; add one and it arrives with no fixtures, because the draw was dealt across
    the pools that existed at the cut.

    What is frozen is the **id set**, and only the id set. A pool's ``table_ids``, its
    ``slot`` and its ``name`` stay editable with a draw standing, on purpose — this is
    the case the freeze exists to *permit*, not to prevent. Venues move under a running
    tournament (a table breaks and is pulled, one frees up early, a pool slips an hour),
    and a director who cannot record that has to un-cut a draw that is *correct* —
    losing the placements — to move a table. A rename is likewise allowed: identity
    lives in the ``id``, so "Pool A" becoming "Morning Pool" is a display change and
    every fixture still resolves.

    Asked **before** anything is written (and, like every judge-then-write guard in this
    module, under the tournament's row lock), so a refusal leaves both the pools and the
    fixtures exactly as they were. Not merely rolled back — never written: a guard that
    fired after the ``setattr`` loop would be relying on the transaction to undo it, and
    the day somebody makes an intermediate ``commit`` for convenience the refusal starts
    persisting the very thing it refuses.

    With **no draw cut** this is a no-op and ``pools`` replaces wholesale, as it always
    has. There are no fixtures to orphan, and the pools of an un-drawn event are just
    configuration; ``DELETE …/draw`` un-freezes the set by construction for the same
    reason.
    """
    # An absent ``pools`` key is the only way this is ``None`` — an explicit ``null`` is
    # a 422 at the schema (the column is NOT NULL) — so "not sent" is the whole meaning
    # of it, and an event whose pools are not being replaced has nothing to enforce.
    if payload.pools is None:
        return
    # The freeze turns on the draw EXISTING, not on it having been played: an unplayed
    # draw is the ordinary state of a tournament that has not started, and it is just as
    # orphanable as a played one.
    if not await event_has_draw(db, event.id):
        return
    # Parsed ONCE, and kept: the id set decides *whether* to refuse, and the pools
    # themselves say *which* — a refusal names them (``named_list``), and re-parsing the
    # JSONB to recover the names would be the same validation run twice per pool.
    current = event_pools(event)
    existing = {PoolId(pool.id) for pool in current}
    incoming = {PoolId(pool.id) for pool in payload.pools}
    if existing == incoming:
        return
    # Named by their names, from whichever side of the change still knows them: a pool
    # being removed is only described by the row we hold, and one being added only by
    # the payload.
    removed = [pool.name for pool in current if PoolId(pool.id) not in incoming]
    added = [pool.name for pool in payload.pools if pool.id not in existing]
    raise _pool_set_refusal(removed, added)


def _draw_type_refusal(current: DrawType) -> HTTPException:
    """The 409 for a ``draw_type`` change on an event whose draw is already cut.

    Same doctrine as the pool-set freeze, one field over (ADR-0017): 409, not 403 — the
    caller is the owner and the payload is well-formed; it is the *resource* that is in
    the wrong state, and the same request becomes legal the moment the draw is removed.

    And it says how, because the alternative is a director who is **stuck**. The draw
    type is what chose the strategy that dealt these fixtures, so an event that is
    ``single-elim`` while holding pooled round-robin fixtures cannot even be re-cut back
    into agreement with itself: today ``single-elim`` has no strategy, so the re-cut is
    a 422, and the only way out is to patch the draw type *back* to a value the director
    never asked for — which they have to guess. The refusal names the way out instead.
    """
    return HTTPException(
        status_code=409,
        detail=(
            f"This event's draw is already cut, so its draw type is frozen: its "
            f"fixtures were dealt as a “{current.value}” draw, and changing the type "
            "would leave the event claiming a shape its draw does not have. To change "
            "the draw type, remove the draw first, then cut it again."
        ),
    )


async def _enforce_draw_type_frozen(
    db: AsyncSession, event: TournamentEvent, payload: TournamentEventUpdate
) -> None:
    """Raise the 409 once a ``draw_type`` payload would change the draw type of an event
    that **has a draw** (ADR-0786).

    A draw type is not a label on an event — it is the strategy that dealt the event's
    fixtures, and the fixtures are the shape that strategy prescribes. Patch it under a
    standing draw and the two facts contradict each other: a ``single-elim`` event
    holding pooled round-robin fixtures (measured — the PATCH answered **200**), whose
    bracket no client can render and whose draw no strategy would ever have produced.

    The **go-live currency check cannot catch it**, which is why this guard has to
    exist rather than being someone else's problem: currency compares the *entrant set*
    the fixtures seat against the event's active entrants (``draw_currency_by_event``),
    and re-labelling the draw type moves neither. The corrupted event reads as
    ``current`` and starts.

    Sibling of ``_enforce_pool_set_frozen``, and the same shape of rule: what a cut draw
    freezes is *the facts its fixtures were derived from* — the pools they were dealt
    across, and the strategy that dealt them. Everything else about the event (its name,
    its fee, its rules, a pool's tables and window) stays editable, because a director
    must never have to destroy a correct draw to record an ordinary change.

    **Presence is not enough — the change is what is refused.** A ``draw_type`` equal to
    the one the event already has changes nothing, so it is not a conflict, and a guard
    that fired on the mere presence of the key would refuse a page that PATCHes the
    whole event form back (draw type included) to move a pool's tables — the very edit
    the freeze exists to permit. (This is where it differs from
    ``_enforce_league_editable``, which *does* refuse the field it already holds: there,
    the field is settled by a
    lifecycle status no request of the caller's can move, so the only client that sends
    it is a stale one. Here, the way out — remove the draw — is on the caller's own
    keyboard.)

    Asked **before** anything is written, like every judge-then-write guard in this
    module, and under the tournament's row lock: a refusal leaves the draw type and the
    fixtures exactly as they were, never written and then rolled back.
    """
    if payload.draw_type is None or payload.draw_type is event.draw_type:
        return
    # Only now the query — and only for a payload that really moves the draw type. It is
    # the same ``event_has_draw`` the pool freeze asks, and a payload that changes both
    # asks it twice: two COUNTs on an indexed column, both under a lock we already hold,
    # in exchange for two guards that each read as one rule.
    if not await event_has_draw(db, event.id):
        return
    raise _draw_type_refusal(event.draw_type)


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
    # The row lock first, then the owner check — the same pair, in the same order, that
    # the transition route and the tournament PATCH take, and that the draw verbs take
    # (which is what keeps them all free of a deadlock cycle). This route is a
    # judge-then-write path now: ``_enforce_pool_set_frozen`` reads whether a draw
    # exists and then writes the pools that draw's fixtures refer to. Postgres runs READ
    # COMMITTED, so unlocked, a cut committing between those two would be a cut across
    # pools this request is in the middle of replacing — a draw born orphaned, refused
    # by nothing.
    #
    # The tournament is kept, not discarded: its ``league_id`` is the ladder the event's
    # refreshed ``entry_state`` is judged on (ADR-0783), and it is already loaded, so
    # re-fetching it would be a second query for a row we are holding.
    tournament = await _get_tournament_for_update_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    event = await _get_event_or_404(db, tournament_id, event_id)
    # 404 → 403 → 409, the ordering ADR-0017 fixed: the state of this event's draw is
    # never the reason a stranger's request is refused. And it is asked before the loop
    # below, so a refusal writes nothing at all.
    await _enforce_pool_set_frozen(db, event, payload)
    # The draw's other frozen fact, judged in the same window and for the same reason:
    # the strategy that dealt the fixtures is not a label to be re-typed under them.
    await _enforce_draw_type_frozen(db, event, payload)
    # As in update_tournament: model_dump(exclude_unset=True) serializes the
    # nested value-objects (slot/match_settings/predicates/pools) to plain
    # dicts/lists, so one setattr loop covers the JSONB columns and scalars.
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(event, key, value)
    await db.commit()
    await db.refresh(event)
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
    rating = await entrant_rating(db, tournament.league_id, current_user.id)
    return _serialize_event(
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
    # As in update_event: the owner-scoped load is the guard (404 then 403); the
    # row this route deletes is the event.
    await _get_owned_tournament_or_404(db, tournament_id, current_user)
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


async def _enforce_draw_unplayed(db: AsyncSession, event: TournamentEvent) -> None:
    """Raise the 409 once an event's draw shows **evidence of play** — the single gate
    on both cutting and un-cutting a draw (ADR-0786).

    It is what makes a re-cut safe. A cut replaces the draw wholesale, so a draw with a
    decided fixture (a recorded winner) or a materialized one (a linked match, which may
    already carry games on its scratchpad) cannot be re-cut without throwing away
    results that players actually produced. The draw must never silently eat a score, so
    the refusal is on the *evidence*, not on the tournament's status: a director may cut
    and re-cut as often as they like right up until the first fixture becomes real.

    Read under the tournament's row lock, like every other judge-then-write guard in
    this module (``_enforce_event_has_room``): the evidence this reads is the evidence
    the write below is authorized by, and an unlocked read would sit in a different
    instant from it.

    409, not 403: the caller is the owner and the draw is theirs — it is the draw that
    is past the point where a re-cut means anything. "Not you" would be a lie; the truth
    is "not now, not any more".

    One sentence for both verbs, because it is one fact. A re-cut and an un-cut are
    refused for the same reason (the fixtures that would be destroyed are the ones that
    have been played), and two sentences saying so would be two things to keep true.
    """
    if not await draw_has_play(db, event.id):
        return
    raise HTTPException(
        status_code=409,
        detail=(
            "This event's draw is already under way — at least one fixture has a match "
            "or a recorded winner — so it can no longer be cut or removed."
        ),
    )


async def _get_owned_event_for_draw_or_404(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    current_user: User,
) -> TournamentEvent:
    """The event whose draw is about to be written, loaded under the tournament's row
    lock and the owner check — the refusal ordering both draw verbs share.

    **404 → 403 → 409**, the ordering ADR-0017 fixed and every route in this module
    keeps: a tournament that does not exist (or an event that is not under it) is a 404
    before ownership is considered, so a stranger probing ids learns nothing; a
    non-owner is a 403 before the draw's *state* is looked at, so the refusal never
    leaks whether an event has been played. The 409 (``_enforce_draw_unplayed``) is the
    caller's own, and comes last.

    The tournament is loaded through the **locking** loader — the same lock, on the same
    row, taken first, that the entry, withdrawal, transition and PATCH routes take
    (which is what keeps them free of a deadlock cycle) — and ``_require_owner`` is then
    asked here, exactly as ``update_tournament`` and the transition route do.

    The lock is not decoration. A cut reads the event's active field and writes fixtures
    *derived from it*; Postgres runs READ COMMITTED, so an unlocked read answers from
    its own statement's snapshot, and an entry (or a withdrawal) committing between the
    read and the INSERT would leave a persisted draw that never matched any real field
    of players — a pool of the wrong size, an entrant seated nowhere, or one seated in a
    draw they had left. Every writer of the entrant field already queues on this row, so
    taking it here is what puts the cut in the same queue: the loser blocks and re-reads
    the field the winner *committed*.
    """
    tournament = await _get_tournament_for_update_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    return await _get_event_or_404(db, tournament_id, event_id)


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
    # 404 → 403 first (and the tournament's row lock with them), so the draw's own
    # state is never the reason a stranger's request is refused.
    event = await _get_owned_event_for_draw_or_404(
        db, tournament_id, event_id, current_user
    )
    # Then the one gate on the write: has this draw been played? Asked before anything
    # is planned or deleted, so a refused re-cut leaves the standing draw exactly as it
    # was — the guard's whole promise.
    await _enforce_draw_unplayed(db, event)
    try:
        # Plans, deletes and re-inserts inside THIS transaction — the lock above is
        # still held, so the field it reads cannot move under it, and the DELETE and
        # the INSERTs land together or not at all. A DrawError is raised before the
        # DELETE, so a 422 destroys nothing either.
        await cut_draw(db, event)
    except DrawError as error:
        # The domain refusing to produce a draw is not a bug — it is an answer, and it
        # is the caller's to act on. ``from None`` so no traceback shape reaches the
        # client; the sentence is composed in ``_draw_refusal``.
        await db.rollback()
        raise _draw_refusal(error) from None
    await db.commit()
    # Read the draw back through the SAME loader the detail page reads it through, so
    # the fixtures this mutation answers with are byte-for-byte the ones the page will
    # show — same shape, same pool → round → position order. Composing the response
    # from the objects just added would be a second serialization of the same rows,
    # ordered by whatever the planner happened to emit.
    return (await fixtures_by_event(db, [event.id]))[event.id]


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
    # The same 404 → 403 → 409 ordering, and the same row lock, as the cut: this verb
    # deletes what that verb writes, and the guard that protects the fixtures cannot
    # depend on which route is asking.
    event = await _get_owned_event_for_draw_or_404(
        db, tournament_id, event_id, current_user
    )
    await _enforce_draw_unplayed(db, event)
    await uncut_draw(db, [event.id])
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
