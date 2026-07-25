"""Draw planning — the *pure* domain behind cutting and advancing a draw (ADR-0786).

A **draw** is the complete set of **fixtures** an event's draw type prescribes for
its entrants; a **fixture** is one planned pairing (a round and a position, plus a
**pool** when the draw is pooled), whose sides may still be unknown. This module
knows how to *plan* those fixtures. It does not persist them: it holds no session,
issues no query, imports no FastAPI and no SQLAlchemy construct. Its inputs and
outputs are small frozen value objects, so a strategy is testable with a literal
list and re-runnable anywhere (a REPL, a script, a test) without a database.

Each :class:`~app.models.tournament.DrawType` is a strategy behind
:class:`DrawStrategy`, with two pure operations:

``plan_initial(config, ordered_entrants)``
    Cuts the draw — the fixtures as they stand the moment they are first written.

``advance(fixtures)``
    Reads the persisted fixtures *as they currently stand* and returns the
    side-fills that the decided fixtures now imply, plus the fixtures that have
    become **ready** (both sides known, no match yet). It is re-run after *every*
    result and at go-live rather than fired by carefully-chosen events, which only
    works because it is **idempotent**: apply its plan, feed the resulting state
    back in, and the second plan is empty (:attr:`AdvancePlan.is_empty`).

Two things the schema deliberately does not store, and this module therefore owns:

- **Topology.** There is no ``next_slot_id``. Single-elim's successor is arithmetic
  on ``(round, position)``, round-robin has no successor at all, and swiss cannot
  know its next round until the current one finishes. ``advance()`` recomputes what
  it needs from the rows.
- **Byes.** A bye is the *absence of a fixture row*, never a row with a ``NULL``
  side. ``NULL`` means exactly one thing — "TBD, ``advance()`` will fill it" — so an
  odd round-robin pool simply has fewer fixtures in some rounds.
"""

from __future__ import annotations

import enum
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import NewType, Protocol

from app.models.tournament import DrawType, EventFormat

# Distinct id types, so the checker rejects handing a fixture id to something that
# wants an entry id. They are plain ``uuid.UUID`` at runtime.
EntryId = NewType("EntryId", uuid.UUID)
FixtureId = NewType("FixtureId", uuid.UUID)
MatchId = NewType("MatchId", uuid.UUID)
#: A pool is a JSONB value-object on the event, not a row — its id is a *string ref*
#: into ``TournamentEvent.pools``, which is why this is a ``str`` and not a UUID FK.
PoolId = NewType("PoolId", str)


class DrawError(Exception):
    """Base class for every refusal this module can raise.

    One base so the HTTP layer has a single thing to catch and turn into a 422: the
    draw endpoint's callers are asking for something the domain will not produce, not
    tripping over a bug. Strategies never signal a refusal by returning ``None`` or an
    empty plan — an un-cuttable draw is an *error*, and a silent empty draw would look
    exactly like a legitimately empty one.
    """


class UnsupportedDrawType(DrawError):
    """This draw type has no strategy yet.

    Raised by :func:`strategy_for`, whose ``match`` is exhaustive with no catch-all —
    so a new :class:`DrawType` member is a *type* error until it is handled here, and
    a member that is handled-but-unimplemented is a catchable domain error rather than
    a 500.
    """

    def __init__(self, draw_type: DrawType) -> None:
        self.draw_type = draw_type
        super().__init__(f"Draw type {draw_type.value!r} is not implemented yet.")


class DegenerateDraw(DrawError):
    """The requested cut would produce a draw that isn't a competition.

    A pool holding a single entrant has nobody to play (and a pool holding none is a
    ghost), so we refuse the cut rather than silently emit a pool of one. The director
    fixes the input — fewer pools, or more entrants — and re-cuts.
    """


class NonSinglesDraw(DrawError):
    """The event is not **singles**, so it cannot be given a draw (ADR-0788).

    Every draw this module cuts is over :class:`Entrant`\\ s that are **one entry per
    person** — a fixture seats one entry on each side, and a materialized match seats
    that entry's single user (side 1 ← ``entry_a``, side 2 ← ``entry_b``). A doubles or
    teams event has no way to say *which two people* form one side: ``TournamentEntry``
    is a single ``user_id``, there is no partner or roster model. So a round-robin over
    such an event would be meaningless, and it is refused at the **cut** — the earliest,
    clearest point — rather than left to fail obscurely at go-live.

    Carries the offending :class:`~app.models.tournament.EventFormat` **structurally**,
    so the HTTP layer composes the director-facing sentence from the fact rather than
    parsing it out of a message (the same shape as :class:`UnsupportedDrawType`).
    """

    def __init__(self, event_format: EventFormat) -> None:
        self.event_format = event_format
        super().__init__(
            f"A {event_format.value} event cannot be given a draw — draws are "
            "singles-only."
        )


class Side(enum.Enum):
    """Which of a fixture's two sides — ``entry_a_id`` or ``entry_b_id``."""

    a = "a"
    b = "b"


@dataclass(frozen=True, slots=True)
class Entrant:
    """An active entry, as the ordering rule needs to see it.

    Deliberately not the ``TournamentEntry`` row: this module must be constructible
    from literals. The caller (the persistence layer) is responsible for passing only
    **active** entries — withdrawal is a soft-delete, and a withdrawn entry has no
    place in a draw.
    """

    entry_id: EntryId
    #: ``None`` = unseeded. Nothing sets a seed today (a director-only seeding endpoint
    #: is its own slice), so in practice every entrant is unseeded and the draw is
    #: ordered by registration order — which is what club-night reality does anyway.
    seed: int | None
    #: Registration order. Aware, like every datetime that crosses this boundary.
    created_at: datetime


@dataclass(frozen=True, slots=True)
class OrderedEntrant:
    """An entrant in its settled draw order — the output of :func:`order_entrants` and
    the only entrant shape a strategy sees.

    A distinct type from :class:`Entrant` on purpose: a strategy cannot be handed an
    unordered pile and quietly cut a draw from it, because the ordering *is* the
    seeding. ``position`` is 1-based, so entrant 1 is the top seed.
    """

    entry_id: EntryId
    position: int


@dataclass(frozen=True, slots=True)
class DrawConfig:
    """What a cut needs to know about the event itself — which is its **pools**, and
    nothing else.

    Deliberately **not** the draw type. The draw type is what chose the strategy
    (:func:`strategy_for`, which runs *before* this config is ever built), so a strategy
    reading it back off its own config would be a second source of truth for a decision
    already made — and a second source that can *disagree*: with a ``draw_type`` field
    here, ``RoundRobinStrategy().plan_initial(DrawConfig(draw_type=DrawType.swiss, …))``
    was a sentence you could write, and the field it named was read by nobody. (It was
    genuinely dead: mutation-testing set it to ``None`` and killed no test, and no test
    *could* have killed it.) The danger is not the dead field, it is the live one it
    invites — the next strategy (rr-then-ko, swiss) branching on ``config.draw_type``
    in the belief that it is authoritative, on an event whose real draw type is the one
    that picked the strategy. Its absence is what makes that unsayable.

    ``pool_ids`` are the ids of the event's configured pools, **in the event's own pool
    order** — that order is what the snake seeds against, so it must not be re-sorted.
    Empty for an un-pooled draw type (single-elim), where every fixture's ``pool_id``
    is ``NULL``. The pool *id set* freezes while a draw exists, which is what lets a
    fixture's string ref stay valid without a foreign key. No id among them is ever the
    empty string — ``Pool.id`` is a ``ValueObjectId`` (``min_length=1``) at the write
    boundary, which is what keeps ``ready_fixtures``' "pooled?" test (``pool_id is
    None``) and its sort key (``pool_id or ""``) answering the same question the same
    way.
    """

    pool_ids: tuple[PoolId, ...] = ()


@dataclass(frozen=True, slots=True)
class PlannedFixture:
    """One fixture a cut wants written — the pre-persistence twin of a
    ``TournamentFixture`` row, minus the ids the database mints.

    A side is ``None`` only when it is genuinely **TBD** (single-elim's later rounds).
    It is *never* ``None`` to mean "bye": a bye is the absence of this object.
    """

    #: ``None`` = the draw is un-pooled (or this is the KO stage of an rr-then-ko).
    pool_id: PoolId | None
    #: 1-based.
    round: int
    #: 1-based within its (pool, round).
    position: int
    entry_a_id: EntryId | None = None
    entry_b_id: EntryId | None = None


@dataclass(frozen=True, slots=True)
class FixtureState:
    """A persisted fixture as it currently stands — the whole input to
    :meth:`DrawStrategy.advance`.

    ``advance`` is a pure function of this state, which is what makes re-running it
    after every result safe: there is no accumulated bookkeeping to get out of step,
    and no event it can miss.
    """

    fixture_id: FixtureId
    pool_id: PoolId | None
    round: int
    position: int
    entry_a_id: EntryId | None
    entry_b_id: EntryId | None
    #: Set when the fixture's match completed — the fixture is then **decided**.
    winner_entry_id: EntryId | None = None
    #: Set once the fixture **materialized** into a real match. ``None`` before that.
    match_id: MatchId | None = None

    @property
    def is_pending(self) -> bool:
        """Some side is still unknown."""
        return self.entry_a_id is None or self.entry_b_id is None


@dataclass(frozen=True, slots=True)
class SideFill:
    """Fill one side of one fixture with the entry that has become known for it.

    One side per object, and the entry is non-optional: there is no way to express
    "fill this side with nothing", so an ``advance()`` cannot blank a side it has
    already filled.
    """

    fixture_id: FixtureId
    side: Side
    entry_id: EntryId


@dataclass(frozen=True, slots=True)
class AdvancePlan:
    """Everything the current fixture state implies: sides that became known, and the
    fixtures that are now **ready** to materialize into matches.

    ``ready_fixture_ids`` names fixtures with **both sides known that do not yet have a
    match** — including the ones this same plan's ``side_fills`` are about to complete.
    The "no match yet" half is what makes the plan idempotent: apply it, and the next
    run over the resulting state sees materialized fixtures and returns an empty plan
    (:attr:`is_empty`), rather than proposing the same matches forever.

    Materialization itself is gated on the tournament being ``live`` — a *plan* is not
    permission to create matches, and nothing consumes this list yet.
    """

    side_fills: tuple[SideFill, ...] = ()
    ready_fixture_ids: tuple[FixtureId, ...] = ()

    @property
    def is_empty(self) -> bool:
        """Nothing to do — the state is already fully advanced."""
        return not self.side_fills and not self.ready_fixture_ids


class DrawStrategy(Protocol):
    """How one draw type cuts and advances its draw.

    Pure: no I/O, no session, no clock.
    """

    def plan_initial(
        self, config: DrawConfig, ordered_entrants: Sequence[OrderedEntrant]
    ) -> list[PlannedFixture]:
        """Cut the draw: the fixtures this draw type prescribes for these entrants.

        Deterministic — the same entrants in the same order always yield the same
        fixtures, so a re-cut is reproducible and reviewable. Raises
        :class:`DegenerateDraw` rather than emitting a draw that isn't a competition.
        """
        ...

    def advance(self, fixtures: Sequence[FixtureState]) -> AdvancePlan:
        """What the current state of these fixtures implies. Idempotent: run against a
        state its own last plan was applied to, it returns an empty plan."""
        ...


def order_entrants(entrants: Iterable[Entrant]) -> list[OrderedEntrant]:
    """The draw order: **seed ascending where set, then registration order** for the
    unseeded rest.

    There is deliberately **no rating fallback and no randomness**. Ratings are
    league-scoped (``UserLeagueRating``) while tournaments are standalone, so "the
    player's rating" is not a thing this domain can read; and a random tie-break would
    make a re-cut produce a different draw from the same field, which is exactly what
    the explicit-cut model exists to prevent. The entry id is the final tie-break, so
    two entries registered in the same instant still order the same way every time.

    The caller passes **active** entries only (withdrawal is a soft-delete).
    """
    ordered = sorted(
        entrants,
        key=lambda e: (
            # Seeded before unseeded: `False < True`.
            e.seed is None,
            # Only meaningful for the seeded; the unseeded all share this 0 and fall
            # through to registration order.
            e.seed if e.seed is not None else 0,
            e.created_at,
            str(e.entry_id),
        ),
    )
    return [
        OrderedEntrant(entry_id=e.entry_id, position=i)
        for i, e in enumerate(ordered, 1)
    ]


@dataclass(frozen=True, slots=True)
class RoundRobinStrategy:
    """All-play-all within each pool: every pair in a pool meets exactly once, and
    nobody plays twice in the same round.

    The cut is two steps. First the ordered entrants are **snaked** across the event's
    pools — pool A takes seeds 1, 2P, 2P+1, …; pool B takes 2, 2P−1, … — which spreads
    the strength evenly and leaves pool sizes differing by at most one. Then each pool's
    fixtures are laid out by the **circle method**: fix one entrant, rotate the rest,
    and every rotation is one round of simultaneous pairings. An odd pool rotates
    against a phantom, and the pairing against it is simply **not emitted** — that is
    what a bye is here (a row with a ``NULL`` side would mean "TBD", which is a lie
    about a fixture that will never be played).

    Both sides of every fixture are known at cut time, so this draw has nothing to
    advance *into*: :meth:`advance` fills no sides, and only reports readiness.
    """

    def plan_initial(
        self, config: DrawConfig, ordered_entrants: Sequence[OrderedEntrant]
    ) -> list[PlannedFixture]:
        pools = _snake(ordered_entrants, config.pool_ids)
        return [
            fixture
            for pool_id, members in pools
            for fixture in _circle_method(pool_id, members)
        ]

    def advance(self, fixtures: Sequence[FixtureState]) -> AdvancePlan:
        """Round-robin fixtures are fully determined at the cut, so there is never a
        side to fill: every pairing was known the moment the draw existed. All this can
        report is which fixtures are ready to become matches — which, on a freshly cut
        draw, is all of them, and on an already-materialized one is none of them."""
        return AdvancePlan(side_fills=(), ready_fixture_ids=ready_fixtures(fixtures))


def ready_fixtures(fixtures: Sequence[FixtureState]) -> tuple[FixtureId, ...]:
    """The fixtures that should now become matches: **both sides known**, no match yet,
    not already decided.

    Shared by every strategy, because "ready" is a property of the fixture, not of the
    draw type. Excluding the already-materialized is what makes an ``advance()`` plan
    idempotent; excluding the decided keeps a fixture whose match was later unlinked
    (``match_id`` is ``ON DELETE SET NULL``) from rising from the dead and being played
    twice. Ordered by ``(pool, round, position)`` so the plan itself is deterministic.

    The sort key asks two questions of ``pool_id`` — "is it pooled?" (``pool_id is
    None``, which sorts the un-pooled last) and "which pool?" (``pool_id or ""``) — and
    the two agree only because an id is never ``""``. It was: ``Pool.id`` was a bare
    ``str``, and a fixture drawn into an empty-id pool answered *pooled* to the first
    question while colliding with the un-pooled group's ``""`` in the second. The floor
    that closes it is at the write boundary (``ValueObjectId``, ``min_length=1``), not
    here — an ``if not pool_id`` in this sort would be a runtime check standing in for a
    state that should not exist. Which is why the ``""`` fallback is now *unobservable*:
    it is reached only by the ``None`` group, which the first key element has already
    partitioned off, so its value cannot change an order. (Mutation testing agrees —
    replacing it with any other string survives, and after this it is *supposed* to.)
    """
    ready = [
        f
        for f in fixtures
        if not f.is_pending and f.match_id is None and f.winner_entry_id is None
    ]
    ready.sort(key=lambda f: (f.pool_id is None, f.pool_id or "", f.round, f.position))
    return tuple(f.fixture_id for f in ready)


def strategy_for(draw_type: DrawType) -> DrawStrategy:
    """The strategy that cuts and advances this draw type.

    An exhaustive ``match`` with **no catch-all**: adding a member to
    :class:`DrawType` makes this function fail to type-check until the member is
    handled, so a new format cannot reach production silently unimplemented. The
    formats that have no strategy yet raise :class:`UnsupportedDrawType` — a catchable
    domain error the draw endpoint turns into a 422, not a 500 and not a ``None`` for
    the caller to trip over.
    """
    match draw_type:
        case DrawType.round_robin:
            return RoundRobinStrategy()
        case (
            DrawType.single_elim
            | DrawType.double_elim
            | DrawType.rr_then_ko
            | DrawType.swiss
        ):
            raise UnsupportedDrawType(draw_type)


def _snake(
    ordered_entrants: Sequence[OrderedEntrant], pool_ids: Sequence[PoolId]
) -> list[tuple[PoolId, tuple[EntryId, ...]]]:
    """Deal the ordered entrants across the pools in **snake** order — 1, 2, …, P, then
    back P, P−1, …, 1 — so the top seeds are spread one per pool and the second tier
    lands behind them in reverse. Pool sizes differ by at most one by construction: the
    deal only ever fills a row before starting the next.

    Refuses a pool of fewer than two: a lone entrant has nobody to play, and emitting
    the pool anyway would hide a director's mistake behind a plausible-looking draw.
    """
    pool_count = len(pool_ids)
    if pool_count == 0:
        raise DegenerateDraw("A round-robin draw needs at least one pool.")

    members: list[list[EntryId]] = [[] for _ in pool_ids]
    for index, entrant in enumerate(ordered_entrants):
        row, offset = divmod(index, pool_count)
        # Odd rows deal backwards — that is the snake.
        column = offset if row % 2 == 0 else pool_count - 1 - offset
        members[column].append(entrant.entry_id)

    # Asked of the dealt pools themselves, not of arithmetic on N and P: the refusal
    # should hold whatever the distribution does.
    if any(len(pool_members) < 2 for pool_members in members):
        entrant_count = len(ordered_entrants)
        entrant_noun = "entrant" if entrant_count == 1 else "entrants"
        pool_noun = "pool" if pool_count == 1 else "pools"
        raise DegenerateDraw(
            f"{entrant_count} {entrant_noun} across {pool_count} {pool_noun} would "
            "leave a pool with fewer than 2 entrants, who would have nobody to play."
        )

    return [
        (pool_id, tuple(pool_members))
        for pool_id, pool_members in zip(pool_ids, members, strict=True)
    ]


def _circle_method(pool_id: PoolId, members: Sequence[EntryId]) -> list[PlannedFixture]:
    """Every pair in this pool exactly once, laid out in rounds in which nobody plays
    twice — the circle method: pin the first entrant, rotate the others one seat per
    round, and pair across the circle.

    An odd pool gets a **phantom** seat so the circle still has an even circumference;
    whoever is drawn against the phantom that round sits out, and their pairing is not
    emitted. That is the whole of "byes are absence" — no ``is_bye`` flag, no ``NULL``
    side, just a round with one fewer fixture. ``position`` therefore stays contiguous
    (1..k) within each round.
    """
    circle: list[EntryId | None] = list(members)
    if len(circle) % 2 == 1:
        circle.append(None)  # the phantom
    seats = len(circle)

    fixtures: list[PlannedFixture] = []
    for round_number in range(1, seats):
        position = 0
        for seat in range(seats // 2):
            home, away = circle[seat], circle[seats - 1 - seat]
            if home is None or away is None:
                continue  # a bye is the absence of a fixture row
            position += 1
            fixtures.append(
                PlannedFixture(
                    pool_id=pool_id,
                    round=round_number,
                    position=position,
                    entry_a_id=home,
                    entry_b_id=away,
                )
            )
        # Rotate every seat but the first, one step clockwise.
        circle = [circle[0], circle[-1], *circle[1:-1]]

    return fixtures
