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
from typing import Any, assert_never

from app.draws import EntryId, PoolId
from app.models import (
    DrawType,
    MatchStatus,
    ScheduleSolve,
    Tournament,
    TournamentEvent,
)
from app.results import EventResults, MatchOutcome, PoolInput, results_for
from app.schemas.tournament import (
    EventEntryFull,
    EventEntryOpen,
    EventEntryRatingIneligible,
    EventEntryState,
    EventResultsRead,
    PoolStandingsRead,
    ScheduleSolveRead,
    StandingRowRead,
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

# Public shared surface: the serializers both the HTTP router (``tournaments.py``)
# and the MCP adapter import. ``_serialize_event`` is public too because the
# per-event routes (cut/uncut draw, place fixtures) serialize a single event
# directly. Everything else (``_tournament_fields``, ``_entry_state``,
# ``_event_results``, ``_serialize_results``) is a module-internal helper and
# stays private.
__all__ = [
    "serialize",
    "serialize_detail",
    "serialize_event",
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
            "draw_type": e.draw_type,
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
            # The standings, projected here from the fixtures' completed matches plus
            # the page's one batched game load — ``None`` for an uncut or
            # non-round-robin event (ADR-0788). Computed in the serializer, not fetched
            # per event, for the same reason ``fixtures`` is: no read may become an N+1.
            #
            # ``game_counts is None`` is the tournaments *list*'s signal to skip the
            # projection entirely: its cards render no standings (only event and table
            # counts), so the list neither runs the game-count query nor tabulates a
            # results object nobody reads — standings are a detail-BFF concern. A
            # detail surface passes a real map (``{}`` when nothing is played).
            "results": (
                None
                if game_counts is None
                else _event_results(e, fixtures=fixtures, game_counts=game_counts)
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
