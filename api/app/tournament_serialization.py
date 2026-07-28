"""Router-free serialization of loaded ``Tournament`` rows into the
``TournamentRead`` / ``TournamentDetailRead`` (and per-event
``TournamentEventRead``) views.

This lives outside ``tournaments.py`` so that *both* the HTTP handlers and a
future MCP tool module can produce the identical view objects without one
adapter importing another router's internals (``api/CLAUDE.md`` — "don't import
another router's internals"; ADR 20260719 "tournament verbs are shared functions
behind HTTP and MCP adapters", section "Reads reuse the queries and a shared
serializer"). It imports only domain/query/schema modules — never a router — so
it stays cycle-free, mirroring ``app/match_serialization.py``.
"""

import uuid
from collections import defaultdict
from collections.abc import Sequence
from typing import Any, assert_never

from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import EntryId, PoolId
from app.models import (
    MatchStatus,
    ScheduleSolve,
    Tournament,
    TournamentEvent,
)
from app.results import (
    BracketFinishes,
    BracketFixture,
    EventResults,
    FinishRow,
    MatchOutcome,
    PoolInput,
    PoolStandings,
    RoundRobinResults,
    RrThenKoResults,
    SingleElimResults,
    StandingsThenFinishes,
    results_for,
)
from app.schemas.tournament import (
    DrawTypeRead,
    EventEntryFull,
    EventEntryOpen,
    EventEntryRatingIneligible,
    EventEntryState,
    EventResultsRead,
    FinishesResultsRead,
    FinishRowRead,
    PoolStandingsRead,
    ScheduleSolveRead,
    StandingRowRead,
    StandingsResultsRead,
    StandingsThenFinishesResultsRead,
    TournamentDetailRead,
    TournamentEntrantRead,
    TournamentEventRead,
    TournamentFixtureRead,
    TournamentRead,
)
from app.tournament_eligibility import (
    Eligible,
    RatingIneligible,
    evaluate_rating_eligibility,
    event_is_full,
)
from app.tournament_queries import (
    active_entrants_by_event,
    completed_match_ids,
    entrant_rating,
    fixtures_by_event,
    game_counts_by_match,
)

# Public shared surface: the serializers both the HTTP router (``tournaments.py``)
# and the MCP adapter import. ``_serialize_event`` is public too because the
# per-event routes (cut/uncut draw, place fixtures) serialize a single event
# directly, and ``event_results`` because the dashboard's tournament panel
# (``app.dashboard_tournaments``) stands the caller in the very same standings the
# tournament page shows — two projections of one table is the one way the panel could
# tell a player they are 2nd on one screen and 3rd on another. Everything else
# (``_tournament_fields``, ``_entry_state``, the per-shape ``_serialize_standings`` /
# ``_serialize_finishes`` and their input projections) is a module-internal helper and
# stays private.
__all__ = [
    "event_results",
    "serialize",
    "serialize_detail",
    "serialize_event",
    "shape_created_event_read",
    "shape_event_read",
]


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


def serialize(
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


def event_results(
    e: TournamentEvent,
    *,
    fixtures: list[TournamentFixtureRead],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> EventResultsRead | None:
    """The event's results, projected from its fixtures' completed matches, or ``None``
    when there are none to compute — a **discriminated union tagged by shape**
    (ADR-0785): ``kind: "standings"`` for a round-robin (ADR-0788), ``kind: "finishes"``
    for a single-elimination bracket, ``kind: "standings_then_finishes"`` for a
    round-robin-then-knockout event, which carries one block per stage (ADR 20260727).

    ``None`` in exactly one case, meaning "no results here" rather than an empty table:
    an event whose draw has not been cut (no fixtures to stand). There used to be a
    second — a draw type with no results strategy — but every ``DrawType`` has one now
    that the enum holds only what runs (ADR "a draw type is a seeded row, and the enum
    holds only what runs"), so that guard has no input left to reject. Everything else
    is a real results block, whose table is empty of *decided* rows but full of
    *seated* ones while the event is still played.

    The projection is the fixed materialization convention read backwards (#788): side 1
    is ``entry_a`` and side 2 is ``entry_b``, so the ``(side_1, side_2)`` game counts
    are the ``(entry_a, entry_b)`` game counts, and the winner is whichever took more
    games — derived from the live match, never from the fixture's written-back
    ``winner_entry_id`` (which no read reads, for correction-safety)."""
    if not fixtures:
        return None
    # ``results_for`` returns the union of the two implemented strategies; narrow it
    # with an exhaustive ``match`` so each shape builds its own input and serializes its
    # own way, and a third strategy is a type error here until it declares both.
    strategy = results_for(e.draw_settings.draw_type)
    match strategy:
        case RoundRobinResults():
            return _serialize_standings(
                strategy.tabulate(_pool_inputs(fixtures, game_counts))
            )
        case SingleElimResults():
            return _serialize_finishes(
                strategy.tabulate(_bracket_fixtures(fixtures, game_counts))
            )
        case RrThenKoResults():
            # The one arm whose ``tabulate`` takes TWO stage inputs, because a two-stage
            # event has two stages to project. ``pool_id IS NULL`` is the stage
            # discriminator (ADR-0786), and it is applied to the bracket half only:
            # ``_pool_inputs`` already drops the un-pooled fixtures itself, so the pool
            # half needs no filter and asking twice would let the two disagree.
            return _serialize_standings_then_finishes(
                strategy.tabulate(
                    _pool_inputs(fixtures, game_counts),
                    _bracket_fixtures(
                        [f for f in fixtures if f.pool_id is None], game_counts
                    ),
                )
            )
        case _:
            assert_never(strategy)


def _pool_inputs(
    fixtures: list[TournamentFixtureRead],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> list[PoolInput]:
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
            outcome = _fixture_outcome(f, game_counts)
            if outcome is not None:
                outcomes.append(outcome)
        pool_inputs.append(
            PoolInput(
                pool_id=PoolId(pool_id),
                entrants=tuple(EntryId(entry_id) for entry_id in entrants),
                # Count only the pairings that can still produce a result. A **voided**
                # fixture never will — its match is terminal and ``ready_fixtures`` will
                # not re-materialize it — so it is excluded, not counted-but-missing.
                # Without this, a played-event account-merge collision (which voids the
                # guest-vs-survivor self-play match) would hold the pool one outcome
                # short of ``fixture_count`` forever: permanently un-``complete``, no
                # champion — the opposite of ADR-0788's live-standings guarantee.
                fixture_count=sum(
                    1 for f in pool_fixtures if f.match_status is not MatchStatus.voided
                ),
                outcomes=tuple(outcomes),
            )
        )
    return pool_inputs


def _bracket_fixtures(
    fixtures: list[TournamentFixtureRead],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> list[BracketFixture]:
    """Every single-elim fixture as a :class:`BracketFixture` — its round (which fixes
    the bracket depth the finishes are measured from) and, when its match is completed,
    the outcome. An undecided or not-yet-materialized fixture carries ``outcome=None``;
    byes are already absent (no fixture emitted for them, ADR-0786), so nothing to
    skip."""
    return [
        BracketFixture(round=f.round, outcome=_fixture_outcome(f, game_counts))
        for f in fixtures
    ]


def _fixture_outcome(
    f: TournamentFixtureRead,
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> MatchOutcome | None:
    """A fixture's completed-match outcome, or ``None`` if it has no decided match yet.

    The one place both shapes read a fixture's result, so they cannot disagree on what
    "decided" means or which side is which: side 1 ← ``entry_a``, side 2 ← ``entry_b``
    (#788), so the ``(side_1, side_2)`` counts are ``(entry_a, entry_b)``'s."""
    if (
        f.match_status is not MatchStatus.completed
        or f.match_id is None
        or f.entry_a_id is None
        or f.entry_b_id is None
    ):
        return None
    side_1_games, side_2_games = game_counts[f.match_id]
    return MatchOutcome(
        entry_a_id=EntryId(f.entry_a_id),
        entry_b_id=EntryId(f.entry_b_id),
        entry_a_games=side_1_games,
        entry_b_games=side_2_games,
    )


def _pool_standings_read(pools: Sequence[PoolStandings]) -> list[PoolStandingsRead]:
    """The per-pool standings block, shared by the two shapes that carry one — the
    round-robin arm and the pool stage of the rr-then-ko arm — so a table means the same
    thing whichever event it is read off."""
    return [
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
        for pool in pools
    ]


def _finish_rows_read(finishes: Sequence[FinishRow]) -> list[FinishRowRead]:
    """The ranked finishes block, shared by the two shapes that carry one — the
    single-elim arm and the knockout stage of the rr-then-ko arm."""
    return [
        FinishRowRead(
            entry_id=row.entry_id,
            position=row.position,
            eliminated_in_round=row.eliminated_in_round,
        )
        for row in finishes
    ]


def _serialize_standings(results: EventResults) -> StandingsResultsRead:
    return StandingsResultsRead(
        pools=_pool_standings_read(results.pools),
        complete=results.complete,
        champion=results.champion,
    )


def _serialize_finishes(results: BracketFinishes) -> FinishesResultsRead:
    return FinishesResultsRead(
        finishes=_finish_rows_read(results.finishes),
        complete=results.complete,
        champion=results.champion,
    )


def _serialize_standings_then_finishes(
    results: StandingsThenFinishes,
) -> StandingsThenFinishesResultsRead:
    """Both stages, each serialized by the same helper its one-stage sibling uses — so
    "an rr-then-ko event's pools cross the wire exactly as a round-robin's do, and its
    bracket exactly as a single-elim's" is true structurally and not by three
    serializers happening to agree (ADR 20260727)."""
    return StandingsThenFinishesResultsRead(
        pools=_pool_standings_read(results.pools),
        finishes=_finish_rows_read(results.finishes),
        complete=results.complete,
        champion=results.champion,
    )


def serialize_event(
    e: TournamentEvent,
    *,
    entrants: list[TournamentEntrantRead],
    fixtures: list[TournamentFixtureRead],
    rating: float | None,
    game_counts: dict[uuid.UUID, tuple[int, int]] | None,
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
            # The wire field is unchanged — only where it is read from moved. The
            # value comes off the event's ``draw_settings`` row (ADR "an event's draw
            # configuration is a row, not a column"), which is joined onto every query
            # that loads an event (``lazy="joined"``), so the list endpoint's
            # per-event serialization still issues no query of its own.
            "draw_type": e.draw_settings.draw_type,
            "max_players": e.max_players,
            "entry_fee": e.entry_fee,
            # The event's venue timezone anchors its wall-clock ``Slot`` windows to
            # real instants (ADR "tournament times are timezone-aware instants"); it
            # rides on the read so the client knows the frame the Slot is stated in.
            "timezone": e.timezone,
            "slot": e.slot,
            "match_settings": e.match_settings,
            "predicates": e.predicates,
            "pools": e.pools,
            "created_at": e.created_at,
            "updated_at": e.updated_at,
            "entrants": entrants,
            "entry_state": _entry_state(e, entered=len(entrants), rating=rating),
            "fixtures": fixtures,
            # The results, projected here from the fixtures' completed matches plus
            # the page's one batched game load — standings for a round-robin, finishes
            # for a single-elim bracket, ``None`` for an uncut or not-yet-implemented
            # draw type (ADR-0788/0785). Computed in the serializer, not fetched per
            # event, for the same reason ``fixtures`` is: no read may become an N+1.
            #
            # ``game_counts is None`` is the tournaments *list*'s signal to skip the
            # projection entirely: its cards render no standings (only event and table
            # counts), so the list neither runs the game-count query nor tabulates a
            # results object nobody reads — standings are a detail-BFF concern. A
            # detail surface passes a real map (``{}`` when nothing is played).
            "results": (
                None
                if game_counts is None
                else event_results(e, fixtures=fixtures, game_counts=game_counts)
            ),
        }
    )


def serialize_detail(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
    events: list[TournamentEvent],
    entrants_by_event: dict[uuid.UUID, list[TournamentEntrantRead]],
    fixtures_by_event: dict[uuid.UUID, list[TournamentFixtureRead]],
    game_counts: dict[uuid.UUID, tuple[int, int]] | None,
    rating: float | None,
    latest_schedule_solve: ScheduleSolve | None,
    draw_type_catalogue: list[DrawTypeRead] | None,
    distance_miles: float | None = None,
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
            # ``None`` is two things by design, exactly as ``results`` above is: on
            # the DETAIL read it is the fact ("no solve ever requested"); on the LIST
            # it is "not projected" — the list's cards render no solve strip, so it
            # skips the ledger query the same way it skips standings.
            "latest_schedule_solve": (
                ScheduleSolveRead.model_validate(latest_schedule_solve)
                if latest_schedule_solve is not None
                else None
            ),
            # The near-me distance in miles, or ``None`` on every read that was not
            # location-filtered (the detail read, the unfiltered/owner-scoped lists).
            "distance_miles": distance_miles,
            # The selectable draw formats, already ordered by the query that read them
            # off the ``draw_types`` table — passed in rather than fetched here for the
            # same reason ``fixtures`` is, and taken from the table rather than the
            # ``DrawType`` enum because the table is what gates the choice (ADR "a draw
            # type is a seeded row, and the enum holds only what runs"). ``None`` on the
            # LIST, whose cards render no event form and so do not pay for it.
            "draw_type_catalogue": draw_type_catalogue,
            "events": [
                serialize_event(
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


async def shape_created_event_read(
    db: AsyncSession,
    *,
    event: TournamentEvent,
    league_id: uuid.UUID,
    viewer_id: uuid.UUID,
) -> TournamentEventRead:
    """Project a JUST-CREATED event into a ``TournamentEventRead`` from ``viewer_id``'s
    perspective — the shaping the create adapters (HTTP ``POST …/events`` and the MCP
    ``create_event`` tool) share, so the two surfaces cannot drift on how a new event
    reads back.

    A one-statement-old event has no entrants, no fixtures and no results, all empty
    WITHOUT a query (fixtures are only ever written by the cut, ADR-0786), so the only
    read is the caller's one ladder ``rating`` on ``league_id`` — the tournament's
    league, passed in by the verb rather than re-queried here. Its ``entry_state`` is
    still the CALLER's, computed exactly as on the read paths."""
    rating = await entrant_rating(db, league_id, viewer_id)
    return serialize_event(
        event, entrants=[], fixtures=[], rating=rating, game_counts={}
    )


async def shape_event_read(
    db: AsyncSession,
    *,
    event: TournamentEvent,
    league_id: uuid.UUID,
    viewer_id: uuid.UUID,
) -> TournamentEventRead:
    """Reload an EDITED event's entrants, draw and results and project it into a
    ``TournamentEventRead`` from ``viewer_id``'s perspective — the shaping the update
    adapters (HTTP ``PATCH …/events/{id}`` and the MCP ``update_event`` tool) share, so
    the two surfaces cannot drift on how an edited event reads back.

    A PATCH is not a re-cut (ADR-0786): the event keeps whatever entrants, draw and
    results it already had, so they are reloaded (answering ``[]`` would tell the
    director their draw was thrown away) and the standings reprojected from the same
    completed-match games as the read paths. Its ``entry_state`` is recomputed from the
    event as it now stands, judged on the caller's one ladder ``rating`` on
    ``league_id`` — the tournament's league, passed in by the verb rather than
    re-queried here."""
    entrants = (await active_entrants_by_event(db, [event.id]))[event.id]
    event_fixtures = await fixtures_by_event(db, [event.id])
    fixtures = event_fixtures[event.id]
    game_counts = await game_counts_by_match(db, completed_match_ids(event_fixtures))
    rating = await entrant_rating(db, league_id, viewer_id)
    return serialize_event(
        event,
        entrants=entrants,
        fixtures=fixtures,
        rating=rating,
        game_counts=game_counts,
    )
