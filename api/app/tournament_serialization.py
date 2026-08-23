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
from collections.abc import Mapping, Sequence
from typing import Any, assert_never, cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import (
    EntryId,
    GroupId,
    SeatedPairing,
    seats_both_sides_at_cut,
    swiss_byes,
    swiss_pairable_rows,
)
from app.models import (
    DrawType,
    MatchStatus,
    ScheduleSolve,
    Tournament,
    TournamentEvent,
)
from app.models.draw_type import StageDrawType
from app.results import (
    BracketFinishes,
    BracketFixture,
    EventResults,
    FieldInput,
    FinishRow,
    GroupInput,
    GroupStandings,
    MatchOutcome,
    RoundRobinResults,
    RrThenKoResults,
    SingleElimResults,
    StandingRow,
    StandingRowColumns,
    StandingsThenFinishes,
    SwissResults,
    SwissStandingRow,
    SwissStandings,
    results_for,
)
from app.schemas.tournament import (
    DrawTypeRead,
    EventEntryFull,
    EventEntryOpen,
    EventEntryRatingIneligible,
    EventEntryState,
    EventResultsRead,
    EventStageRead,
    FinishesResultsRead,
    FinishRowRead,
    GroupStandingsRead,
    ScheduleSolveRead,
    StandingRowRead,
    StandingsResultsRead,
    StandingsThenFinishesResultsRead,
    SwissStandingRowRead,
    SwissStandingsResultsRead,
    TournamentDetailRead,
    TournamentEntrantRead,
    TournamentEventRead,
    TournamentFixtureRead,
    TournamentRead,
)
from app.tournament_draw_settings import draw_settings_of
from app.tournament_draws import event_groups, event_reservations
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
    # the ORM row. The ``address`` JSONB is read straight off the attribute and
    # Pydantic validates it into an ``Address`` when the returned dict is fed to
    # model_validate, so the raw dict never leaves the serialize boundary.
    #
    # ``table_catalogue`` is no longer a column: the wire field is unchanged, but the
    # value now comes off the ``tables`` relationship (ADR 20260801), already in the
    # director's order and eagerly loaded (``lazy="selectin"``), so this stays a plain
    # attribute read and the serializer still fires no query. ``TournamentTable`` is
    # ``from_attributes``, so the ORM rows validate into the read model at the same one
    # boundary the JSONB used to.
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "status": t.status,
        "start_date": t.start_date,
        "end_date": t.end_date,
        "address": t.address,
        "table_catalogue": t.tables,
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
    entrants: Sequence[TournamentEntrantRead],
    fixtures: list[TournamentFixtureRead],
    game_counts: dict[uuid.UUID, tuple[int, int]],
    stage_draw_types: Mapping[uuid.UUID, StageDrawType],
) -> EventResultsRead | None:
    """The event's results, projected from its fixtures' completed matches, or ``None``
    when there are none to compute — a **discriminated union tagged by shape**
    (ADR-0785): ``kind: "standings"`` for a round-robin (ADR-0788), ``kind: "finishes"``
    for a single-elimination bracket, ``kind: "standings_then_finishes"`` for a
    round-robin-then-knockout event, which carries one block per stage (ADR 20260727),
    and ``kind: "swiss_standings"`` for a swiss event's one group-less table.

    ``entrants`` is the event's **active** field, and only the group-less swiss shape
    reads it: a group's membership is defined by its own fixtures, but a swiss entrant
    with a **bye** has no fixture that round at all (a bye is the absence of a row,
    ADR-0786), so a field derived from fixtures alone would drop them from the table
    they belong at the top of. The grouped shapes are deliberately left fixture-derived,
    unchanged.

    ``stage_draw_types`` maps this event's own stage ids to each stage's OWN draw type
    (ADR 20260815) — the map ``RrThenKoResults``' arm reads to tell the group stage's
    fixtures from the knockout stage's, in place of the ``group_id IS NULL`` proxy this
    used to read. **Required, with no default**: the two callers that do not serve a
    ``stages`` array on the wire (the single-event create/update reads) still load it
    for this computation — see ``app.tournament_serialization.shape_event_read`` — so a
    default here would be the one call site that quietly forgets to, and it would be the
    one an rr-then-ko event's edit page silently mis-projects.

    It is **not** true that ``round_robin`` never reads the map: every arm here that
    calls ``_group_inputs`` (``round_robin`` and ``rr_then_ko``'s group half alike)
    reads it, because that is where a fixture's own group-stage-ness is decided now (ADR
    20260815). It is a no-op for ``round_robin`` only in the sense that every one of a
    round-robin event's fixtures shares the one stage the map already has to name —
    ``single_elim`` is the arm that truly never reads it at all (``_bracket_fixtures``
    takes no ``stage_draw_types`` argument), and ``swiss`` never has a knockout half to
    split out either. The map is required precisely because it is read for every grouped
    shape: an unknown ``stage_id`` is a loud failure (a fixture and the map it is
    projected against were built off two different stage sets), never a fixture quietly
    dropped from the table.

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
                strategy.tabulate(
                    _group_inputs(fixtures, game_counts, stage_draw_types)
                )
            )
        case SingleElimResults():
            return _serialize_finishes(
                strategy.tabulate(_bracket_fixtures(fixtures, game_counts))
            )
        case RrThenKoResults():
            # The one arm whose ``tabulate`` takes TWO stage inputs, because a two-stage
            # event has two stages to project. Each fixture's OWN stage (``stage_id``,
            # ADR 20260815) — read here through ``stage_draw_types`` rather than through
            # ``group_id IS NULL`` — is the discriminator, and it is applied to the
            # bracket half only: ``_group_inputs`` already selects the group-stage
            # fixtures itself, so the group half needs no filter here and asking twice
            # would let the two disagree.
            return _serialize_standings_then_finishes(
                strategy.tabulate(
                    _group_inputs(fixtures, game_counts, stage_draw_types),
                    _bracket_fixtures(
                        [
                            f
                            for f in fixtures
                            if _stage_draw_type_of(stage_draw_types, f.stage_id)
                            is DrawType.single_elim
                        ],
                        game_counts,
                    ),
                )
            )
        case SwissResults():
            # One table over the whole field: swiss is group-less, so there is no
            # grouping to do and every fixture in the event feeds the same input.
            return _serialize_swiss_standings(
                strategy.tabulate(_field_input(entrants, fixtures, game_counts))
            )
        case _:
            assert_never(strategy)


def _stage_draw_type_of(
    stage_draw_types: Mapping[uuid.UUID, StageDrawType], stage_id: uuid.UUID
) -> StageDrawType:
    """The fixture's own stage's draw type — a loud failure, never a silent
    ``.get(...)``, when ``stage_id`` is missing from the map.

    A fixture's ``stage_id`` always names one of its own event's stages (the
    composite FK, ADR 20260815), so a miss here means the caller built
    ``stage_draw_types`` off a different, stale set of stages than the fixtures it
    is projecting against it — a bug in how the two were assembled, worth
    surfacing loudly at the seam that found it, not a fixture quietly vanishing
    from a director's results table with no error anywhere."""
    try:
        return stage_draw_types[stage_id]
    except KeyError:
        raise RuntimeError(
            f"fixture's stage {stage_id} is missing from stage_draw_types — the map "
            "and the fixtures it is projecting were built from two different stage "
            "sets (ADR 20260815)"
        ) from None


def _group_inputs(
    fixtures: list[TournamentFixtureRead],
    game_counts: dict[uuid.UUID, tuple[int, int]],
    stage_draw_types: Mapping[uuid.UUID, StageDrawType],
) -> list[GroupInput]:
    by_group: dict[uuid.UUID, list[TournamentFixtureRead]] = defaultdict(list)
    for f in fixtures:
        # The group stage's fixtures — this fixture's OWN stage seats both sides at
        # the cut (ADR 20260815), read through ``stage_draw_types`` rather than
        # inferred from ``group_id`` plus the event's overall draw type. Asked through
        # :func:`~app.draws.seats_both_sides_at_cut`, the one predicate every
        # group-stage-ness decision goes through since #1483, rather than compared
        # against ``round_robin`` inline: that comparison silently answers "not a group
        # stage" for a draw type nobody has considered yet, where the shared predicate
        # is an exhaustive ``match`` that refuses to type-check until somebody does.
        # ``group_id`` is never ``None`` now (#1484) — every stage holds a group, so
        # this dict key is always real, not just this stage's group-ness.
        if not seats_both_sides_at_cut(
            _stage_draw_type_of(stage_draw_types, f.stage_id)
        ):
            continue
        by_group[f.group_id].append(f)
    group_inputs: list[GroupInput] = []
    for group_id, group_fixtures in by_group.items():
        entrants = {
            entry_id
            for f in group_fixtures
            for entry_id in (f.entry_a_id, f.entry_b_id)
            if entry_id is not None
        }
        outcomes: list[MatchOutcome] = []
        for f in group_fixtures:
            outcome = _fixture_outcome(f, game_counts)
            if outcome is not None:
                outcomes.append(outcome)
        group_inputs.append(
            GroupInput(
                group_id=GroupId(group_id),
                entrants=tuple(EntryId(entry_id) for entry_id in entrants),
                # Count only the pairings that can still produce a result. A **voided**
                # fixture never will — its match is terminal and ``ready_fixtures`` will
                # not re-materialize it — so it is excluded, not counted-but-missing.
                # Without this, a played-event account-merge collision (which voids the
                # guest-vs-survivor self-play match) would hold the group one outcome
                # short of ``fixture_count`` forever: permanently un-``complete``, no
                # champion — the opposite of ADR-0788's live-standings guarantee.
                fixture_count=sum(
                    1
                    for f in group_fixtures
                    if f.match_status is not MatchStatus.voided
                ),
                outcomes=tuple(outcomes),
            )
        )
    return group_inputs


def _field_input(
    entrants: Sequence[TournamentEntrantRead],
    fixtures: list[TournamentFixtureRead],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> FieldInput:
    """The whole field as one standings input — the swiss projection of
    :func:`_group_inputs`, with nothing to group by.

    The field is the event's **active entrants**, not the entries its fixtures seat.
    That difference is the whole reason this takes an argument :func:`_group_inputs`
    does not: a swiss entrant with a **bye** has no fixture that round (a bye is the
    absence of a row, ADR-0786), and every later round is cut with both sides unknown,
    so a seven-player draw derived from fixtures alone would stand a six-player table.

    The entries seated in fixtures are **unioned in** rather than assumed to be a
    subset, for the **rows** only. A player who withdraws after the draw is cut leaves
    the active list while their played fixtures stay, and
    :func:`~app.group_finishing_order.swiss_finishing_order` indexes its tallies by
    entrant — so dropping them would be a ``KeyError`` on the first outcome that names
    them, on the detail page of any event that had a withdrawal. Somebody who played
    real matches belongs in the table.

    The **byes** are derived here rather than stored, because there is nothing to
    store: a bye is the absence of a fixture row, so it is read off the rounds that
    *are* paired (:func:`~app.draws.swiss_byes`). They are scored as a win worth zero
    games one layer down, in the standings themselves.

    **Over the active entrants, not that union** — the one field the draw layer pairs
    from. Handed the union, this layer asked who was missing from each round and got
    the departed entrant back every time, because nobody seats them again: a
    withdrawn-but-seated player collected a phantom bye win per remaining round, up to
    ``R − 1`` of them, on a table that otherwise looked right. The two layers now derive
    byes from one field, which is the whole of what they share: the tallies are still
    the union's, so a departed entrant's results count here and are dropped by
    :func:`~app.draws._swiss_standings_order` (a stranger in its tallies would turn a
    two-way tie into a three-way one). For a field that never shrank the two sets are
    the same set and the two tables are the same table.

    ``fixture_count`` is **what can still be paired**, not the row count. Every round
    is cut with ``⌊n/2⌋`` rows from the field at the cut, and a round nobody has been
    paired into yet is very much still countable — but a field that shrank leaves rows
    nothing will ever seat, and counting those holds the event one outcome short of
    complete forever. :func:`~app.draws.swiss_pairable_rows` is that count, per round,
    over the same active field; a **voided** pairing comes off it exactly as it does
    for a group, for the same reason."""
    active = tuple(EntryId(entrant.id) for entrant in entrants)
    field = set(active) | {
        EntryId(entry_id)
        for f in fixtures
        for entry_id in (f.entry_a_id, f.entry_b_id)
        if entry_id is not None
    }
    outcomes = [
        outcome
        for outcome in (_fixture_outcome(f, game_counts) for f in fixtures)
        if outcome is not None
    ]
    return FieldInput(
        entrants=tuple(field),
        fixture_count=_swiss_fixture_count(fixtures, len(active)),
        outcomes=tuple(outcomes),
        byes=swiss_byes(active, _seated_pairings(fixtures)),
    )


def _swiss_fixture_count(fixtures: list[TournamentFixtureRead], field_size: int) -> int:
    """How many of a swiss draw's rows can still yield a result — the denominator
    ``complete`` is measured against.

    Per round, because that is the grain the cut wrote and the grain a field change
    moves: :func:`~app.draws.swiss_pairable_rows` says how many of a round's rows can
    ever carry a pairing, and the ones already seated into a **voided** match are taken
    back off, since that match is terminal and will never produce the outcome the count
    is promising."""
    by_round: dict[int, list[TournamentFixtureRead]] = defaultdict(list)
    for f in fixtures:
        by_round[f.round].append(f)
    total = 0
    for round_fixtures in by_round.values():
        seated = [
            f
            for f in round_fixtures
            if f.entry_a_id is not None and f.entry_b_id is not None
        ]
        total += swiss_pairable_rows(
            len(round_fixtures), len(seated), field_size
        ) - sum(1 for f in seated if f.match_status is MatchStatus.voided)
    return total


def _seated_pairings(
    fixtures: list[TournamentFixtureRead],
) -> list[SeatedPairing]:
    """The read rows that seat **both** sides, in the shape
    :func:`~app.draws.swiss_byes` reads them.

    A **voided** pairing is deliberately still a pairing here. It happened — those two
    were drawn against each other and neither sat out — so counting its round as one
    nobody was paired into would invent a bye for every other entrant in it. Voiding
    takes away the *result*, which ``outcomes`` above already reflects, not the fact of
    the pairing. It counts as ``decided`` for the same reason it is left out of
    ``fixture_count``: it will never produce a result, so it must not hold its round —
    and the bye scored against that round — open forever.

    ``decided`` is the match's **terminal status** — completed, or voided — read live
    off the row, which is the same live fact :func:`_fixture_outcome` gates the
    standings on. So a result under correction un-decides its round here exactly as it
    un-scores its match there.

    It asks the status directly rather than building the outcome and testing it for
    ``None``, which is what this did and what cost a discarded ``MatchOutcome`` per
    completed fixture on every detail render. The other two things that projection
    checks are already true of every row that reaches here: the comprehension filters
    both entries, and ``match_status`` is read off an outer join onto the fixture's own
    ``match_id`` (:func:`~app.tournament_queries.fixtures_by_event`), so a status of
    any kind means there is a match behind it.

    The draw layer spells the same question over its own row shape
    (:attr:`app.draws.FixtureState.is_decided`, a live score or a void). The row shapes
    genuinely differ, so the two are not one predicate — that the two agree, including
    on a status neither of them names, is pinned by a test in ``tests/test_swiss.py``.
    """
    return [
        SeatedPairing(
            round=f.round,
            entry_a_id=EntryId(f.entry_a_id),
            entry_b_id=EntryId(f.entry_b_id),
            decided=f.match_status is MatchStatus.voided
            or f.match_status is MatchStatus.completed,
        )
        for f in fixtures
        if f.entry_a_id is not None and f.entry_b_id is not None
    ]


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


def _group_standings_read(groups: Sequence[GroupStandings]) -> list[GroupStandingsRead]:
    """The per-group standings block, shared by the two shapes that carry one — the
    round-robin arm and the group stage of the rr-then-ko arm — so a table means the
    same
    thing whichever event it is read off."""
    return [
        GroupStandingsRead(
            group_id=group.group_id,
            rows=_standing_rows_read(group.rows),
            complete=group.complete,
        )
        for group in groups
    ]


def _standing_rows_read(rows: Sequence[StandingRow]) -> list[StandingRowRead]:
    """A group's standings rows, shared by the two shapes that carry one — the
    round-robin arm and the group stage of the rr-then-ko arm."""
    return [StandingRowRead(**_standing_read_columns(row)) for row in rows]


def _standing_read_columns(row: StandingRow) -> StandingRowColumns:
    """One domain row's columns, ready to unpack into its wire model — the one place a
    standings row crosses onto the wire, for both tables that carry one.

    The set of columns is named once, in :class:`~app.results.StandingRowColumns`, and
    both wire models take it: :class:`StandingRowRead` alone, and
    :class:`SwissStandingRowRead` with ``buchholz`` beside it, exactly as their domain
    rows relate. So adding a column to a standings row is a type error at each
    constructor until it is added here, rather than a column that quietly reaches one
    table and not the other."""
    return StandingRowColumns(
        entry_id=row.entry_id,
        rank=row.rank,
        played=row.played,
        wins=row.wins,
        losses=row.losses,
        games_won=row.games_won,
        games_lost=row.games_lost,
    )


def _swiss_standing_rows_read(
    rows: Sequence[SwissStandingRow],
) -> list[SwissStandingRowRead]:
    """A swiss table's rows: the same columns a group's row carries plus ``buchholz``,
    the figure that ordered them (ADR "swiss standings add Buchholz, and head-to-head is
    guarded on having met").

    The shared columns come from :func:`_standing_read_columns`, the same call a group
    row's do, rather than being spelled out a second time here: the shapes match on both
    sides of the wire — :class:`SwissStandingRowRead` extends
    :class:`~app.schemas.tournament.StandingRowRead` exactly as
    :class:`~app.results.SwissStandingRow` extends :class:`~app.results.StandingRow` —
    so the only thing this adds is the one column swiss has."""
    return [
        SwissStandingRowRead(**_standing_read_columns(row), buchholz=row.buchholz)
        for row in rows
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
        groups=_group_standings_read(results.groups),
        complete=results.complete,
        champion=results.champion,
    )


def _serialize_finishes(results: BracketFinishes) -> FinishesResultsRead:
    return FinishesResultsRead(
        finishes=_finish_rows_read(results.finishes),
        complete=results.complete,
        champion=results.champion,
    )


def _serialize_swiss_standings(results: SwissStandings) -> SwissStandingsResultsRead:
    """The swiss table — a group's columns plus the Buchholz figure each row was ordered
    by."""
    return SwissStandingsResultsRead(
        rows=_swiss_standing_rows_read(results.rows),
        complete=results.complete,
        champion=results.champion,
    )


def _serialize_standings_then_finishes(
    results: StandingsThenFinishes,
) -> StandingsThenFinishesResultsRead:
    """Both stages, each serialized by the same helper its one-stage sibling uses — so
    "an rr-then-ko event's groups cross the wire exactly as a round-robin's do, and its
    bracket exactly as a single-elim's" is true structurally and not by three
    serializers happening to agree (ADR 20260727)."""
    return StandingsThenFinishesResultsRead(
        groups=_group_standings_read(results.groups),
        finishes=_finish_rows_read(results.finishes),
        complete=results.complete,
        champion=results.champion,
    )


def _stage_draw_types(
    stages: Sequence[EventStageRead],
) -> dict[uuid.UUID, StageDrawType]:
    """Stage id → that stage's own draw type — the map :func:`event_results` reads
    to tell a two-stage event's group-stage fixtures from its knockout-stage ones
    (ADR 20260815), built off whatever ``stages`` a caller has in hand rather than
    fetched again here.

    ``EventStageRead.draw_type`` is typed ``DrawType`` on the wire (unchanged: it is a
    served field, and narrowing it would change the OpenAPI schema), but its only
    source is ``TournamentEventStage.draw_type`` — already
    :data:`~app.models.draw_type.StageDrawType`-narrowed at the model boundary, whose
    setter refuses ``rr_then_ko`` outright — so the cast below is safe, not a
    suppression: this value can never actually be that member.
    """
    return {stage.id: cast(StageDrawType, stage.draw_type) for stage in stages}


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
    # also owns the group → round → position ordering, so the serializer never sorts
    # and no two call sites can order a bracket differently.
    #
    # The draw configuration is parsed ONCE, here, off the settings row that rides along
    # with the event (``lazy="joined"``): both wire fields below come off this one arm,
    # so the type and the count cannot be read from two different places and disagree.
    draw_settings = draw_settings_of(e.draw_settings)
    # The eager (``lazy="selectin"``) stages collection, validated once: served on
    # the wire below AND the source of the stage → draw-type map ``event_results``
    # splits a two-stage event's fixtures with (ADR 20260815) — one origin, so the
    # served stages and the results' stage-split cannot disagree.
    stage_reads = [EventStageRead.model_validate(s) for s in e.stages]
    stage_draw_types = _stage_draw_types(stage_reads)
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
            "draw_type": draw_settings.draw_type,
            # The other half of the same fact, off the same parsed arm: **K**, which
            # only the ``rr-then-ko`` arm carries as a field. ``None`` for the two draw
            # types that have no knockout stage to qualify for — a property on those
            # arms, so this reads the same question of every arm without an
            # ``isinstance`` ladder, and the answer comes from the union rather than
            # from this line assuming it. **Flat beside ``draw_type`` on the wire**,
            # exactly as before: the settings object is a storage shape, not a wire one
            # (ADR "a draw type's settings are one NOT NULL JSON object").
            "qualifiers_per_group": draw_settings.qualifiers_per_group,
            # And **R**, the swiss round count, off the same parsed arm and by the same
            # rule: a property on the arms that have no round count, so this line asks
            # every arm one question rather than deciding which draw types have one.
            "rounds": draw_settings.rounds,
            "max_players": e.max_players,
            "entry_fee": e.entry_fee,
            # The event's venue timezone anchors its wall-clock ``Slot`` windows to
            # real instants (ADR "tournament times are timezone-aware instants"); it
            # rides on the read so the client knows the frame the Slot is stated in.
            "timezone": e.timezone,
            "slot": e.slot,
            "match_settings": e.match_settings,
            "predicates": e.predicates,
            # Projected from the event's GROUP rows and the reservations they map to
            # (ADR 20260801), not handed over as a JSONB column — ``group_read`` is the
            # join that keeps this wire field exactly what it was. Both sides ride on
            # the event's own eager ``selectin`` loads, so this costs the page no
            # statement of its own — the same arrangement the venue catalogue has.
            # Both arrays through the ``app.tournament_draws`` seam, not inlined here.
            # They read ``event.groups`` themselves — the same eager collection this
            # loop already holds, so going through the seam costs nothing — and being
            # the one spelling is what matters: when #1370 lets two groups share a
            # reservation, ``event_reservations`` has to dedupe, and a second copy
            # living in the BFF's own payload would go on emitting the duplicate.
            "groups": event_groups(e),
            "reservations": event_reservations(e),
            # Read straight off the relationship, exactly as ``groups`` above is:
            # ``TournamentEvent.stages`` is ``lazy="selectin"`` now, so every event this
            # serializer reaches already carries its stages, however it was loaded — no
            # separate batch, no sentinel for "not on this page" (ADR 20260815).
            # ``model_validate`` directly rather than a helper: unlike ``group_read``,
            # nothing composes a stage row from more than itself. The same eager
            # collection feeds ``_stage_draw_types`` for the results projection below,
            # so the served stages and the stage-split of the results cannot disagree.
            "stages": stage_reads,
            # The optimistic-concurrency token (#1499) the next PATCH of this event has
            # to state back. This is the app's only ``TournamentEventRead`` build, so
            # one key here puts the version on the list, the detail, create, update and
            # both MCP tools at once — which is what makes "the editor sends the version
            # it read" true of every surface that can read an event.
            "lock_version": e.lock_version,
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
                else event_results(
                    e,
                    entrants=entrants,
                    fixtures=fixtures,
                    game_counts=game_counts,
                    stage_draw_types=stage_draw_types,
                )
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
    still the CALLER's, computed exactly as on the read paths.

    Its stages ride along for free: ``create_event`` mints them in the same
    transaction and the caller's ``db.refresh(event)`` repopulates the eager
    (``lazy="selectin"``) collection before this is ever called, so
    ``serialize_event`` reads real rows off ``event.stages`` with no query of its own
    here."""
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
    # Its stages ride along for free, same as ``shape_created_event_read`` above:
    # ``update_event``'s own ``db.refresh(event)`` repopulates the ``lazy="selectin"``
    # collection, so ``serialize_event`` reads real rows off ``event.stages`` — and
    # ``event_results``' stage-split reads the same rows, so an edited two-stage
    # event's group/knockout split is always the live one (ADR 20260815).
    return serialize_event(
        event,
        entrants=entrants,
        fixtures=fixtures,
        rating=rating,
        game_counts=game_counts,
    )
