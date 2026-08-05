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
  on ``(round, position)``, round-robin has no successor at all, and a swiss draw
  could not know its next round until the current one finished. ``advance()``
  recomputes what it needs from the rows.
- **Byes.** A bye is the *absence of a fixture row*, never a row with a ``NULL``
  side. ``NULL`` means exactly one thing — "TBD, ``advance()`` will fill it" — so an
  odd round-robin pool simply has fewer fixtures in some rounds.
"""

from __future__ import annotations

import enum
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import NewType, Protocol

from app.models.tournament import DrawType, EventFormat
from app.pool_finishing_order import EntryTally, MatchOutcome, finishing_order
from app.schemas.tournament import (
    DrawSettingsWriteArm,
    RoundRobinDrawSettingsWrite,
    RrThenKoDrawSettingsWrite,
    SingleElimDrawSettingsWrite,
)

# Distinct id types, so the checker rejects handing a fixture id to something that
# wants an entry id. They are plain ``uuid.UUID`` at runtime.
EntryId = NewType("EntryId", uuid.UUID)
FixtureId = NewType("FixtureId", uuid.UUID)
MatchId = NewType("MatchId", uuid.UUID)
#: A pool is a row (``tournament_event_pools``, ADR 20260801) with a server-minted uuid
#: primary key, and a fixture's ``pool_id`` is a real composite foreign key onto it — so
#: this is a ``uuid.UUID``, exactly like the ids above. It was a ``str``, a dangling ref
#: into ``TournamentEvent.pools`` JSONB, for as long as there was no pools table to
#: point at and no server to mint one.
PoolId = NewType("PoolId", uuid.UUID)


class DrawError(Exception):
    """Base class for every refusal this module can raise.

    One base so the HTTP layer has a single thing to catch and turn into a 422: the
    draw endpoint's callers are asking for something the domain will not produce, not
    tripping over a bug. Strategies never signal a refusal by returning ``None`` or an
    empty plan — an un-cuttable draw is an *error*, and a silent empty draw would look
    exactly like a legitimately empty one.
    """


class UnsupportedDrawType(DrawError):
    """This draw type cannot be planned *here*.

    Not a "no strategy yet" marker any more: every :class:`DrawType` member has a
    strategy by construction, because the enum holds only what runs (ADR "a draw type
    is a seeded row, and the enum holds only what runs"), and :func:`strategy_for` is
    total. What survives is the *caller-specific* refusal —
    :mod:`app.schedule_preview` raises this for ``single_elim``, a fully supported draw
    type, because the CP-SAT table scheduler is pool-based and a pool-less bracket has
    no windows to solve over.

    Carries the offending :class:`DrawType` **structurally**, so the HTTP/MCP layers
    compose their own sentence from the fact rather than parsing a message.
    """

    def __init__(self, draw_type: DrawType) -> None:
        self.draw_type = draw_type
        super().__init__(f"Draw type {draw_type.value!r} is not supported here yet.")


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


class MissingFixtureGames(RuntimeError):
    """A draw was advanced with decided pool fixtures but **no game counts anywhere** —
    the caller never loaded them.

    Deliberately **not** a :class:`DrawError`. A ``DrawError`` is a director-facing
    refusal the HTTP layer turns into a 422 ("the draw you asked for isn't a
    competition"); this is a *wiring* bug in the projection seam, and the only useful
    response to it is a loud 500 in the logs. Nothing a director can type causes it and
    there is no input they could correct.

    It exists because the alternative failure is silent and wrong. A pools-then-knockout
    draw picks its qualifiers with
    :func:`~app.pool_finishing_order.finishing_order`, whose chain runs wins →
    head-to-head → game difference → games won; handed
    :attr:`FixtureState.games` of ``None`` it would still *produce an order* — one
    computed on wins alone, which silently disagrees with the standings table on screen
    at exactly the moment a director is looking hardest (a multi-way tie for the last
    qualifying spot). Every test in the suite would stay green, because nothing else
    reads the field. So the strategy refuses to order a pool it cannot see the games of.

    The condition is scoped to "**no** fixture in this input carries games", which is
    precisely "the caller did not load them" and nothing else. A *single* fixture
    without games while its neighbours have them is an ordinary live state — a result
    under correction leaves the match un-``completed`` while the fixture's written-back
    ``winner_entry_id`` stays put — and that one is handled honestly by the strategy
    (its pool is simply not finished yet), not raised at.
    """


class MissingBracketSlot(RuntimeError):
    """A qualifier's predetermined knockout slot **does not exist in this draw** — the
    bracket standing here was cut for a different qualifier count than the one being
    advanced.

    :class:`MissingFixtureGames`' sibling, and deliberately not a :class:`DrawError` for
    the same reason: nothing a director can type reaches it. The qualifier count is
    frozen the moment a draw is cut (a 409 from the event editor), and the bracket is
    cut upfront from ``P × K``, so a seed with no slot means a caller advanced these
    fixtures with a strategy configured differently from the one that dealt them. That
    is a wiring bug, and the only useful response is a loud 500.

    It exists because the alternative failure is silent and wrong in exactly the way the
    freeze's own 409 refuses to allow: skipping the seed seats *some* of the qualifiers
    and leaves the rest out, producing a bracket that looks cut, looks seeded, and is
    playable — while the entrants who earned those places are simply missing from it.
    The 409 is the first line of defence, not a licence for the domain to be quiet when
    it has been breached.
    """


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
class QualifierSeat:
    """*Which* qualifier a knockout seed belongs to — a pool and a finishing place
    within it, never an entry.

    The whole point of this shape is what it **cannot** name. A pools-then-knockout
    bracket is cut before a single pool game is played, so the seed → qualifier map
    has to be expressible without knowing who won anything; keeping it as
    ``(pool_index, place)`` is what makes it computable at cut time and what lets one
    pool's qualifiers take their predetermined slots the moment *that* pool is
    decided, with the other pools still playing.

    ``pool_index`` is 0-based into :attr:`DrawConfig.pool_ids` — the event's own pool
    order, the same order the snake dealt against. ``place`` is 1-based within that
    pool, so ``place=1`` is the pool winner.
    """

    pool_index: int
    place: int


@dataclass(frozen=True, slots=True)
class DrawConfig:
    """What a cut needs to know about the event itself — which is its **pools**, and
    nothing else.

    Deliberately **not** the draw type. The draw type is what chose the strategy
    (:func:`strategy_for`, which runs *before* this config is ever built), so a strategy
    reading it back off its own config would be a second source of truth for a decision
    already made — and a second source that can *disagree*: with a ``draw_type`` field
    here, ``RoundRobinStrategy().plan_initial(DrawConfig(draw_type=DrawType.single_elim,
    …))`` was a sentence you could write, and the field it named was read by nobody. (It
    was genuinely dead: mutation-testing set it to ``None`` and killed no test, and no
    test *could* have killed it.) The danger is not the dead field, it is the live one
    it invites — the next strategy to land branching on ``config.draw_type`` in the
    belief that it is authoritative, on an event whose real draw type is the one that
    picked the strategy. Its absence is what makes that unsayable.

    ``pool_ids`` are the ids of the event's configured pools, **in the event's own pool
    order** — ascending ``Pool.position``, which is what the caller
    (:func:`app.tournament_draws.draw_config`) sorts them by, and which this tuple then
    carries *as* its sequence. That order is what the snake seeds against, so nothing
    downstream may re-sort it: a ``sorted(config.pool_ids)`` anywhere below here would
    seed the draw against the ids' own order, which under a random uuid is nobody's.

    Empty for an un-pooled draw type (single-elim), where every fixture's ``pool_id``
    is ``NULL``. The pool *id set* freezes while a draw exists
    (``app.tournament_events`` refuses a payload that moves it), and underneath that a
    composite foreign key holds the reference itself.
    """

    pool_ids: tuple[PoolId, ...] = ()


@dataclass(frozen=True, slots=True)
class PlannedFixture:
    """One fixture a cut wants written — the pre-persistence twin of a
    ``TournamentFixture`` row, minus the ids the database mints.

    A side is ``None`` only when it is genuinely **TBD** (single-elim's later rounds).
    It is *never* ``None`` to mean "bye": a bye is the absence of this object.
    """

    #: ``None`` = the draw is un-pooled — single-elim today, and the knockout stage of a
    #: pools-then-knockout draw type once #787 adds one.
    pool_id: PoolId | None
    #: 1-based.
    round: int
    #: 1-based within its (pool, round).
    position: int
    entry_a_id: EntryId | None = None
    entry_b_id: EntryId | None = None


@dataclass(frozen=True, slots=True)
class FixtureGames:
    """How many games **each side of a fixture won**, read off its completed match.

    One object carrying both counts, rather than two ``int | None`` fields on
    :class:`FixtureState`, so "we know this fixture's games" is a single fact: there is
    no way to hold a half-known score in which one side's count is present and the
    other's is missing (api/CLAUDE.md — make illegal states unrepresentable).

    ``entry_a`` ↔ side 1 and ``entry_b`` ↔ side 2, the fixed materialization convention
    (#788) every other read of a fixture's match already uses.

    A tie is representable here and is not this type's job to refuse: a match is played
    to an odd best-of, so a *completed* one cannot tie, but a count is a count and this
    object never sees the best-of that would make the claim checkable.
    """

    entry_a_games: int
    entry_b_games: int


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
    #: Where this fixture's **pool** sits in its event's pool order — 0-based, the
    #: ``Pool.position`` the write boundary stamped (ADR 20260801, "Pools carry an
    #: explicit ``position``"). NOT to be confused with :attr:`position` above, which is
    #: this fixture's slot within its own round; the two are different axes of the same
    #: draw and the sort key below reads both.
    #:
    #: ``None`` means "no pool order to sort on", which is true of an **un-pooled**
    #: fixture (``pool_id is None``) and of a caller that did not resolve the event's
    #: pools at all — a strategy test built straight from :class:`FixtureState`
    #: literals, or :func:`~app.tournament_draws.fixture_state` called with no
    #: ``pool_positions`` map. A pool stored before the field existed still resolves to
    #: a real int here — :func:`~app.tournament_draws.pool_order`'s stable sort leaves
    #: it at its array index. It is deliberately not defaulted to ``0``: a real
    #: position of ``0`` is the *first* pool, and "unknown" collapsing onto "first"
    #: would silently promote every unresolved fixture to the head of the draw.
    #: Unknown sorts after every known pool instead, where the id tie-break decides it
    #: — which is exactly the order :func:`ready_fixtures` had before positions
    #: existed.
    pool_position: int | None = None
    #: Set when the fixture's match completed — the fixture is then **decided**.
    winner_entry_id: EntryId | None = None
    #: Set once the fixture **materialized** into a real match. ``None`` before that.
    match_id: MatchId | None = None
    #: The games each side won, when this fixture's match is **currently completed** —
    #: and ``None`` when it is not (no match yet, or one that has not completed).
    #:
    #: ``None``, never ``FixtureGames(0, 0)``: a real completed match *can* read 0
    #: games for a side (a walkover, a retirement in game one), so a zero pair is a
    #: score and cannot double as "there is no score". The two must stay tellable
    #: apart, because they mean opposite things to a standings tiebreaker — one is a
    #: result to fold in, the other a fixture to leave out.
    #:
    #: Derived from the match's games rather than from ``winner_entry_id``, so a
    #: correction re-shapes it the instant it lands — the same live-outcome view the
    #: standings are projected from (ADR-0788, ADR 20260727). Which is why a strategy
    #: computing a pool's finishing order from these agrees with the table on screen
    #: **structurally**, down to the game-difference and games-won tiebreakers, rather
    #: than by two implementations happening to concur.
    #:
    #: Only ``rr-then-ko`` reads it; round-robin and single-elim ignore it, and
    #: :func:`reads_fixture_games` is where that is said once so a caller knows whether
    #: it has to load the counts at all.
    games: FixtureGames | None = None
    #: Whether this fixture's match is **voided** — terminal, and contributing nothing
    #: (ADR-0013). A voided pairing genuinely produced no result and never will: the
    #: match is closed to proposals, and ``ready_fixtures`` will not re-materialize a
    #: fixture that already has a ``match_id``.
    #:
    #: A plain ``bool``, not the ``MatchStatus`` it is read off, because this module is
    #: constructible from literals and imports nothing from the ORM. Voided-ness is the
    #: only thing about a match's status any strategy asks, so the bridge
    #: (:func:`app.tournament_draws.fixture_state`) answers that one question and the
    #: enum stays on its own side of the seam.
    #:
    #: It is what stops a voided pairing wedging its pool: without it the pool would sit
    #: one score short of "every fixture carries a score" forever — never finished, its
    #: qualifiers never seated — while the standings, which already exclude voided
    #: pairings from a pool's ``fixture_count`` (:class:`app.results.PoolInput`), showed
    #: that same pool ``complete``. Two layers disagreeing about whether a pool is over.
    match_voided: bool = False

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


def qualifier_seed_assignment(
    pool_count: int, qualifiers_per_pool: int
) -> dict[int, QualifierSeat]:
    """Which qualifier takes which knockout **seed number**, so that no round-one
    fixture pairs two entrants out of the same pool (ADR "rr-then-ko cuts both stages
    upfront and seeds qualifiers rematch-free").

    Returns a map ``seed → QualifierSeat`` covering every seed ``1 .. P·K``. It is a
    pure function of the pool count ``P`` and the qualifiers-per-pool ``K`` — it never
    sees an entry, a result or a standing, which is exactly what lets the bracket be
    cut upfront and each pool's qualifiers be seated as that pool finishes. Bracket
    size is *derived* here (``B`` = smallest power of two ≥ ``P·K``), never passed in,
    so it cannot contradict the qualifier count.

    Qualifiers are ordered **place-major**: every pool winner outranks every runner-up,
    so place block ``k`` (0-based) owns seeds ``kP+1 .. kP+P``. Within a block the pool
    order is *chosen*, not fixed, and that is the whole mechanism. Three facts make the
    guarantee provable rather than best-effort:

    - a block holds each pool exactly once, so a round-one pair falling **inside** one
      block is conflict-free for free;
    - round one is a perfect matching on seeds (:func:`_seed_slots` pairs ``s`` with
      ``B+1−s``), so a seed has **at most one** partner and therefore at most one
      forbidden pool;
    - assigning blocks in ascending order, one forbidden pool per seed leaves Hall's
      condition exactly **one** way to fail — all ``P`` of a block's seeds forbidding
      the *same* pool — and the block's own geometry closes it, so a conflict-free
      system of distinct representatives always exists. That last step is the one worth
      reading in full, and it is stated where it is relied on
      (:func:`_assign_block_pools`), because "each admits at least ``P−1`` pools" is not
      by itself the reason. The search below finds a representative system
      deterministically — pools tried in ascending index order, augmenting when stuck —
      so a re-cut reproduces the same bracket, the same promise :func:`order_entrants`
      makes.

    The two fixed orderings this replaces cannot work: place-then-pool pairs ``C1``
    against ``C2`` at three pools, and reversing the runners-up fixes three pools while
    breaking two, because *which* pairs are cross-block depends on ``B − P·K``, which
    jumps around with ``P``.

    **One pool is an explicit waiver, not a failure.** With ``P = 1`` every qualifier
    shares the one pool, so every knockout match is necessarily a rematch — that is
    "league, then a playoff" working as intended. The assignment is then simply
    ``seed k+1 → place k+1``, and this function says so rather than raising.

    Raises :class:`ValueError` on inputs outside the format's legal space (``P ≥ 1``,
    ``K ≥ 1``, ``P·K ≥ 2``). Those are *programmer* errors here: the director-facing
    refusals are the caller's, raised as :class:`DegenerateDraw` at the cut, where the
    entrant count is in hand.
    """
    if pool_count < 1:
        raise ValueError(f"pool_count must be at least 1, got {pool_count}.")
    if qualifiers_per_pool < 1:
        raise ValueError(
            f"qualifiers_per_pool must be at least 1, got {qualifiers_per_pool}."
        )
    qualifier_count = pool_count * qualifiers_per_pool
    if qualifier_count < 2:
        raise ValueError(
            "A knockout stage needs at least 2 qualifiers, got "
            f"{qualifier_count} ({pool_count} × {qualifiers_per_pool})."
        )

    def seat(seed: int, pool_index: int) -> QualifierSeat:
        # Place-major: the block a seed sits in *is* its finishing place.
        return QualifierSeat(pool_index=pool_index, place=(seed - 1) // pool_count + 1)

    if pool_count == 1:
        # The waiver. Every qualifier is out of the same pool, so there is nothing to
        # avoid and no permutation to choose.
        return {seed: seat(seed, 0) for seed in range(1, qualifier_count + 1)}

    partners = _round_one_partners(qualifier_count)
    pool_by_seed: dict[int, int] = {}
    for block in range(qualifiers_per_pool):
        seeds = [block * pool_count + offset + 1 for offset in range(pool_count)]
        # A seed's only constraint is its round-one partner, and only once that partner
        # has a pool — i.e. when it sits in an *earlier* block. A partner inside this
        # block needs no constraint (the block holds each pool once, so they differ
        # anyway); a partner in a later block will see *this* seed as its constraint.
        forbidden = {
            seed: pool_by_seed[partners[seed]]
            for seed in seeds
            if seed in partners and partners[seed] in pool_by_seed
        }
        pool_by_seed.update(_assign_block_pools(seeds, pool_count, forbidden))

    return {seed: seat(seed, pool) for seed, pool in sorted(pool_by_seed.items())}


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


@dataclass(frozen=True, slots=True)
class SingleElimStrategy:
    """Single-elimination: one bracket, lose once and you are out (ADR-0785).

    The cut pads the field to the next power of two ``B`` and lays the seeds into the
    bracket by the **standard recursive seeding** (:func:`_seed_slots`), so the top seed
    can only meet the second in the final, the 3/4 seeds in the semifinals, and so on.
    The ``B − N`` byes fall on the top ``B − N`` seeds for free — a round-1 slot paired
    against a phantom seat past ``N``.

    A **bye is absence** (ADR-0786), never a ``NULL`` side: a byed seed has *no* round-1
    fixture and is seated directly onto its round-2 side at cut time. Every later round
    is emitted up front with its sides ``None`` (TBD), except a side a bye already makes
    known — so three round-2 shapes exist at the cut: both feeders played (``NULL``),
    one bye + one feeder (one side pre-filled), and both feeders byes (a fully-known
    fixture that materializes at go-live like any other).

    This is the first strategy whose :meth:`advance` does real work. Round-robin knows
    every pairing at the cut; single-elim does not, so a decided fixture seats a winner
    **forward** into its successor slot, one result at a time. It stays idempotent — a
    side already filled is not re-filled — so re-running it after every result is safe.
    """

    def plan_initial(
        self, config: DrawConfig, ordered_entrants: Sequence[OrderedEntrant]
    ) -> list[PlannedFixture]:
        entrants = list(ordered_entrants)
        size = len(entrants)
        if size < 2:
            # Mirrors round-robin's per-pool floor: a bracket of one has no fixtures and
            # is not a competition. The message is director-facing copy (the endpoint's
            # ``_draw_refusal`` passes a ``DegenerateDraw``'s message through),
            # so it names the fix, not the internals.
            raise DegenerateDraw(
                "A single-elimination draw needs at least 2 entrants — a bracket of "
                "one has nobody to play."
            )
        seed_entry = {entrant.position: entrant.entry_id for entrant in entrants}
        return _knockout_fixtures(size, seed_entry)

    def advance(self, fixtures: Sequence[FixtureState]) -> AdvancePlan:
        """Seat every decided fixture's winner into its successor slot, plus report the
        fixtures now ready to materialize.

        Idempotent: it seats only sides that are still empty, so re-running it over a
        state its own last plan was applied to fills nothing. The final round has no
        successor — its winner is the **champion**, read through the results, never
        seated anywhere — which falls out for free: its computed successor
        ``(round, position)`` names no persisted fixture, so nothing is filled.
        """
        by_round_position = {(f.round, f.position): f for f in fixtures}
        side_fills: list[SideFill] = []
        for fixture in fixtures:
            if fixture.winner_entry_id is None:
                continue
            successor_round, successor_position, side = _successor(
                fixture.round, fixture.position
            )
            successor = by_round_position.get((successor_round, successor_position))
            if successor is None:
                continue  # the final has no successor — its winner is the champion
            already = successor.entry_a_id if side is Side.a else successor.entry_b_id
            if already is not None:
                continue  # already seated — the source of idempotence
            side_fills.append(
                SideFill(
                    fixture_id=successor.fixture_id,
                    side=side,
                    entry_id=fixture.winner_entry_id,
                )
            )
        return AdvancePlan(
            side_fills=tuple(side_fills),
            ready_fixture_ids=ready_fixtures(fixtures),
        )


@dataclass(frozen=True, slots=True)
class RrThenKoStrategy:
    """Round-robin pools, then a knockout bracket seeded from the pool finishers — the
    top :attr:`qualifiers_per_pool` out of each pool advance (ADR "rr-then-ko cuts both
    stages upfront and seeds qualifiers rematch-free").

    **Both stages are cut in one stroke.** ``plan_initial`` emits every pool's
    round-robin *and* the full bracket, all of the latter's sides TBD. That is not a
    convenience: :class:`AdvancePlan` can express only :class:`SideFill` — there is
    deliberately no way for an ``advance()`` to *create* a fixture — so a bracket that
    did not exist at the cut could never come into being. It costs nothing, because the
    qualifier count ``P × K`` is known before anybody plays, so the bracket size (the
    smallest power of two ≥ ``P × K``) and *which seeds bye* are determined at cut time.
    Bracket size is **derived, never configured**, so it cannot contradict the qualifier
    count.

    **The pool stage is round-robin's, not a copy of it**: ``plan_initial`` calls
    :class:`RoundRobinStrategy` for the pool fixtures, so "the pools of an rr-then-ko
    draw are laid out exactly as a round-robin draw's" is true structurally rather than
    by two implementations agreeing. The knockout stage is likewise
    :func:`_knockout_fixtures` — the same bracket shape :class:`SingleElimStrategy`
    cuts — and its ``advance`` reuses :meth:`SingleElimStrategy.advance` verbatim for
    the forward seating once the knockout is under way.

    **Qualifiers are seated per-pool, as each pool finishes.** The seed → (pool, place)
    map (:func:`qualifier_seed_assignment`) depends only on ``P`` and ``K`` — never on a
    result — so pool A's qualifiers take their predetermined slots the moment *A* is
    decided, with B and C still playing. A knockout fixture simply is not ``ready``
    until both its sides are seated, which :func:`ready_fixtures` already handles.

    **A pool is finished when every one of its fixtures that can still produce a
    result has a score** — the live-outcome view (:attr:`FixtureState.games`), the
    same one the standings are projected from, not the written-back
    ``winner_entry_id`` that no read reads. So a result under correction un-finishes
    its pool rather than freezing a stale qualifier list. A **voided** pairing is the
    one exception: it never will produce a result, so it is left out of the
    requirement rather than counted-but-missing, exactly as the standings leave it out
    of a pool's ``fixture_count`` (:class:`app.results.PoolInput`). Counting it would
    hold the pool one score short forever — never finished, its qualifiers never
    seated, the knockout never ready, and no remedy a director could reach — while the
    table on screen called that same pool ``complete``. See
    :func:`_finished_pool_order`.

    **A correction that changes who qualified does not re-seat the bracket**,
    knowingly (ADR): a :class:`SideFill` only ever fills an *empty* side, so a pool
    match corrected after its qualifiers were seated leaves them in the bracket while
    the standings
    re-order beneath them — the same way single-elim never un-seats a winner. That
    property is also what makes ``advance`` idempotent.
    """

    #: How many entrants qualify out of **each** pool. ``K ≥ 1`` is static — a Pydantic
    #: constraint at the request boundary — so a smaller value is a *programmer* error
    #: and is refused in the constructor; the refusals that depend on the entrant count
    #: (which moves) are :class:`DegenerateDraw`\\ s at the cut.
    qualifiers_per_pool: int

    def __post_init__(self) -> None:
        if self.qualifiers_per_pool < 1:
            raise ValueError(
                "qualifiers_per_pool must be at least 1, got "
                f"{self.qualifiers_per_pool}."
            )

    def plan_initial(
        self, config: DrawConfig, ordered_entrants: Sequence[OrderedEntrant]
    ) -> list[PlannedFixture]:
        # The snake is run here for the refusals below — it is a pure function of the
        # same inputs, so running it again inside round-robin's own cut deals the
        # identical pools, and the pool stage stays *literally* round-robin's rather
        # than a second implementation that has to be kept in step.
        pools = _snake(ordered_entrants, config.pool_ids)
        # The snake has already refused a pool of fewer than two, so ``smallest`` is at
        # least 2 and the noun below never needs inflecting.
        smallest = min(len(members) for _, members in pools)
        if self.qualifiers_per_pool > smallest:
            raise DegenerateDraw(
                f"Taking {self.qualifiers_per_pool} qualifiers from each pool is more "
                f"than the {smallest} entrants in the smallest pool — take fewer "
                "qualifiers from each pool, or add entrants."
            )
        if len(pools) * self.qualifiers_per_pool < 2:
            # ``K ≥ 1`` is static and the snake guarantees ``P ≥ 1``, so the *only* way
            # to arrive here is one pool taking one qualifier: the sentence is fully
            # determined, and interpolating the counts would only add branches no input
            # can reach.
            raise DegenerateDraw(
                "Taking 1 qualifier from a single pool leaves one player in the "
                "knockout stage, who would have nobody to play — take more qualifiers "
                "from each pool, or configure more pools."
            )
        qualifier_count = len(pools) * self.qualifiers_per_pool
        fixtures = RoundRobinStrategy().plan_initial(config, ordered_entrants)
        # Cut in the same stroke: every side TBD (nobody has qualified), ``pool_id``
        # ``None`` (the knockout stage *is* ``pool_id IS NULL``), rounds from 1.
        fixtures.extend(_knockout_fixtures(qualifier_count, {}))
        return fixtures

    def advance(self, fixtures: Sequence[FixtureState]) -> AdvancePlan:
        """Seat the qualifiers of every **finished** pool into their predetermined
        bracket slots, then seat the knockout's own decided winners forward.

        Idempotent, twice over: a qualifier is seated only into a still-empty side,
        and the knockout half is :meth:`SingleElimStrategy.advance`, which already is.
        Run it against a state its own last plan was applied to and it plans nothing.
        """
        knockout = [fixture for fixture in fixtures if fixture.pool_id is None]
        return AdvancePlan(
            side_fills=(
                *self._qualifier_fills(fixtures, knockout),
                # The knockout stage, once it is under way, advances exactly as a
                # single-elim bracket does — so it is advanced *by* single-elim, over
                # the un-pooled fixtures alone. Passing the pool fixtures too would let
                # a pool's ``(round, position)`` collide with the bracket's and seat a
                # pool winner into a knockout slot.
                *SingleElimStrategy().advance(knockout).side_fills,
            ),
            ready_fixture_ids=ready_fixtures(fixtures),
        )

    def _qualifier_fills(
        self, fixtures: Sequence[FixtureState], knockout: Sequence[FixtureState]
    ) -> list[SideFill]:
        """The qualifiers of every finished pool, seated into their bracket slots."""
        pooled = [fixture for fixture in fixtures if fixture.pool_id is not None]
        _refuse_gameless_pool_results(pooled, fixtures)
        # The event's pool order is not recoverable from the fixtures (a fixture holds a
        # pool *ref*, not an index), so the pools are indexed by their sorted ids — a
        # deterministic labelling, stable across every re-run, which is all the seed
        # assignment needs. Which pool is index 0 is genuinely arbitrary: within a
        # finishing place pools are not ranked against each other, and relabelling them
        # is a bijection, so the rematch-free guarantee holds under any labelling.
        pool_ids = sorted(
            {fixture.pool_id for fixture in pooled if fixture.pool_id is not None}
        )
        if not pool_ids:
            return []
        seed_by_seat = {
            seat: seed
            for seed, seat in qualifier_seed_assignment(
                len(pool_ids), self.qualifiers_per_pool
            ).items()
        }
        seats = _knockout_seats(len(pool_ids) * self.qualifiers_per_pool)
        by_slot = {(fixture.round, fixture.position): fixture for fixture in knockout}

        fills: list[SideFill] = []
        for pool_index, pool_id in enumerate(pool_ids):
            order = _finished_pool_order(
                [fixture for fixture in pooled if fixture.pool_id == pool_id]
            )
            if order is None:
                continue  # still playing (or a result in flux) — nothing to seat yet
            for place, tally in enumerate(order[: self.qualifiers_per_pool], start=1):
                seed = seed_by_seat[QualifierSeat(pool_index=pool_index, place=place)]
                round_number, position, side = seats[seed]
                slot = by_slot.get((round_number, position))
                if slot is None:
                    raise MissingBracketSlot(
                        f"Seed {seed} (place {place} in pool {pool_id!r}) qualifies "
                        f"into knockout slot (round {round_number}, position "
                        f"{position}), which this draw has no fixture for: the bracket "
                        f"standing here holds {len(by_slot)} fixtures and was cut for "
                        "a different number of qualifiers than the "
                        f"{len(pool_ids) * self.qualifiers_per_pool} "
                        f"({len(pool_ids)} pools × {self.qualifiers_per_pool}) this "
                        "advance is seating."
                    )
                already = slot.entry_a_id if side is Side.a else slot.entry_b_id
                if already is not None:
                    continue  # already seated — the source of idempotence
                fills.append(
                    SideFill(
                        fixture_id=slot.fixture_id, side=side, entry_id=tally.entry_id
                    )
                )
        return fills


def _finished_pool_order(
    pool_fixtures: Sequence[FixtureState],
) -> list[EntryTally] | None:
    """This pool's finishing order, or ``None`` if the pool is **not finished**.

    Finished = every fixture in it that can still produce a result carries a score. The
    order itself is :func:`~app.pool_finishing_order.finishing_order` — *the* definition
    of how a pool finished, the same call :class:`~app.results.RoundRobinResults` makes
    for the standings table — so the qualifiers are exactly the top of the table a
    director is reading, structurally and not by coincidence.

    Which is why a **voided** fixture is skipped rather than treated as a missing score:
    it can never produce one (the match is terminal, and ``ready_fixtures`` will not
    re-materialize a fixture that has a ``match_id``), and the standings already exclude
    it from the ``fixture_count`` they call a pool ``complete`` against
    (:class:`app.results.PoolInput`). Requiring its score here would leave the pool
    permanently un-finished and its qualifiers permanently unseated while the table on
    screen said the pool was over — the two layers disagreeing about the one fact this
    function exists to share. Its **entrants** still count: they are seated in the pool
    and appear in the standings, so a player whose only pairing was voided is in the
    order with a row of zeros, exactly as the table shows them.

    A pool with **no** usable outcome at all — every fixture voided — is ``None``, not
    an order. The only thing left to rank on would be the entry-id fallback at the end
    of the tiebreak chain, so "the qualifiers" would be arbitrary. This is the one
    place the two layers part company on purpose: the standings call such a pool
    ``complete`` (0 outcomes of 0 countable fixtures) and show a table of zeros, which
    is honest to look at, and seating qualifiers off it would not be. It takes every
    pairing in a pool being voided to reach, and voiding has exactly one producer today
    (an account merge's self-play collision, ADR-0013), so it is a shape to refuse
    rather than to serve.
    """
    entrants: dict[EntryId, None] = {}
    outcomes: list[MatchOutcome] = []
    for fixture in pool_fixtures:
        if fixture.entry_a_id is None or fixture.entry_b_id is None:
            return None
        entrants[fixture.entry_a_id] = None
        entrants[fixture.entry_b_id] = None
        if fixture.match_voided:
            continue
        if fixture.games is None:
            return None
        outcomes.append(
            MatchOutcome(
                entry_a_id=fixture.entry_a_id,
                entry_b_id=fixture.entry_b_id,
                entry_a_games=fixture.games.entry_a_games,
                entry_b_games=fixture.games.entry_b_games,
            )
        )
    if not outcomes:
        return None
    return finishing_order(entrants, outcomes)


def _refuse_gameless_pool_results(
    pooled: Sequence[FixtureState], fixtures: Sequence[FixtureState]
) -> None:
    """Raise :class:`MissingFixtureGames` when pool fixtures are decided and the whole
    input carries no game counts — see that class for why this is loud rather than
    tolerated.

    A **voided** fixture is not evidence of the wiring bug and is excluded. Voiding
    does not clear the ``winner_entry_id`` a completion wrote back, but it does take
    the match out of ``completed``, so its games go away: "decided, and no games" is
    that fixture's ordinary settled state, not a projection that forgot to load them.
    Counting it would turn a single voided pairing in a draw nobody has scored yet into
    a 500. What the guard still catches is unchanged, because it needs a decided fixture
    that *should* carry games: project a played-out pool without its counts and every
    one of its scored fixtures lands in this list.
    """
    gameless = [
        fixture
        for fixture in pooled
        if fixture.winner_entry_id is not None
        and fixture.games is None
        and not fixture.match_voided
    ]
    if not gameless or any(fixture.games is not None for fixture in fixtures):
        return
    fixture_noun = "fixture" if len(gameless) == 1 else "fixtures"
    raise MissingFixtureGames(
        f"{len(gameless)} decided pool {fixture_noun} reached advance() with no game "
        "counts, and no fixture in this draw carries any — the caller projected the "
        "fixtures without loading their completed matches' games. Qualifiers are the "
        "top of the same standings the tiebreak chain produces (wins, head-to-head, "
        "game difference, games won), so ordering a pool without games would pick "
        "different qualifiers from the table on screen."
    )


def ready_fixtures(fixtures: Sequence[FixtureState]) -> tuple[FixtureId, ...]:
    """The fixtures that should now become matches: **both sides known**, no match yet,
    not already decided.

    Shared by every strategy, because "ready" is a property of the fixture, not of the
    draw type. Excluding the already-materialized is what makes an ``advance()`` plan
    idempotent; excluding the decided keeps a fixture whose match was later unlinked
    (``match_id`` is ``ON DELETE SET NULL``) from rising from the dead and being played
    twice. Ordered by ``(pool, round, position)`` so the plan itself is deterministic.

    **"Pool" is the pool's** :attr:`~FixtureState.pool_position` — its place in the
    event's own pool order — **not its id.** It was the id once, back when ids were
    client-minted strings (``p-1-…``, ``p-2-…``, ``p-10-…``) whose lexicographic order
    was not the director's: ``p-10-`` sorts between ``p-1-`` and ``p-2-``, so a ten-pool
    draw's plan ran pool 1, pool 10, pool 2. A minted uuid is worse still — its order is
    nobody's at all — which is exactly why the explicit ``position`` column had to land
    (ADR 20260801) before the ids could move. It is the same key the read path's
    ``fixtures_by_event`` sorts on and the same one :attr:`DrawConfig.pool_ids` is
    ordered by, so the sequence a director sees, the sequence the snake dealt against,
    and the sequence matches are created in are one order rather than three that agree
    by luck.

    The sort key asks three questions, in this order:

    1. "Is it pooled?" — ``pool_id is None``, which sorts the un-pooled (single-elim, or
       an rr-then-ko draw's KO stage) LAST, behind the pools that feed them.
    2. "Where in the event's order is its pool?" — ``pool_position``, with a ``None``
       (an unresolved pool order; see the field) sorting after every pool that has one.
    3. "Which pool?" — the id as text, the tie-break that keeps the order **total** when
       the positions cannot decide it. A ``uuid`` is not comparable with the ``""`` the
       un-pooled group collapses to, so this is spelled as a ``str`` rather than left to
       ``or``; both halves are unobservable anyway, because the first key element has
       already partitioned the un-pooled off. The ``or 0`` beside it is unobservable for
       the same reason and by the same argument.

    (1) and (3) can no longer disagree. They could: ``Pool.id`` was a bare ``str``, and
    a fixture drawn into an *empty-id* pool answered "pooled" to the first question
    while colliding with the un-pooled group's ``""`` in the third — one fixture, pooled
    by one rule and un-pooled by the other. A ``min_length=1`` at the write boundary
    held that off; a ``uuid`` cannot express it at all, which is the better kind of fix.
    """
    ready = [
        f
        for f in fixtures
        if not f.is_pending and f.match_id is None and f.winner_entry_id is None
    ]
    ready.sort(
        key=lambda f: (
            f.pool_id is None,
            f.pool_position is None,
            f.pool_position or 0,
            "" if f.pool_id is None else str(f.pool_id),
            f.round,
            f.position,
        )
    )
    return tuple(f.fixture_id for f in ready)


def strategy_for(settings: DrawSettingsWriteArm) -> DrawStrategy:
    """The strategy that cuts and advances this draw configuration.

    **Total** — every arm returns a strategy, and there is no refusal arm left to reach.
    That is the point of holding only what runs in the enum (ADR "a draw type is a
    seeded row, and the enum holds only what runs"): a slug with no strategy is not a
    value this function can be handed, because Pydantic refuses it at the request
    boundary.

    Still an exhaustive ``match`` with **no catch-all**, and nowhere to park a new
    member lazily: adding a :class:`DrawType` and its union arm fails to type-check here
    until its strategy exists.

    It takes the **parsed settings arm**, not a draw type plus a loose ``K`` (ADR "a
    draw type's settings are one NOT NULL JSON object"). The pair was never really two
    values: ``rr-then-ko`` is the one draw type whose strategy is configured, and the
    arm is what carries the configuration each draw type actually has. So the old
    ``qualifiers_per_pool=None`` refusal is **gone**, not moved: a
    :class:`RrThenKoDrawSettingsWrite` without its count is not a value that can be
    constructed, which is a stronger guarantee than a ``ValueError`` at the point of
    dispatch. Production callers do not build the arm themselves;
    :func:`app.tournament_draws.strategy_for_event` parses it off the one row that holds
    it.
    """
    match settings:
        case RoundRobinDrawSettingsWrite():
            return RoundRobinStrategy()
        case SingleElimDrawSettingsWrite():
            return SingleElimStrategy()
        case RrThenKoDrawSettingsWrite():
            return RrThenKoStrategy(qualifiers_per_pool=settings.qualifiers_per_pool)


def reads_fixture_games(draw_type: DrawType) -> bool:
    """Whether this draw type's ``advance()`` reads :attr:`FixtureState.games` — i.e.
    whether a caller projecting fixtures for it has to load the game counts first.

    A fact about the strategies, kept beside them rather than inferred at the seam.
    ``rr-then-ko`` picks its qualifiers by the standings' own tiebreak chain and so
    reads the games (refusing loudly — :class:`MissingFixtureGames` — when they were not
    loaded); round-robin and single-elim never touch the field, and for them the load is
    a SQL statement and a few hundred score rows discarded, on the completion seam,
    inside the score-accept transaction, once per result.

    An exhaustive ``match`` with **no catch-all**, exactly like :func:`strategy_for`: a
    new :class:`DrawType` member has to *declare* whether it needs the games, and until
    it does this fails to type-check. The alternative — a default of ``False`` — is a
    new strategy silently advancing on ``games=None``, which is the one failure
    :class:`MissingFixtureGames` exists to make impossible.
    """
    match draw_type:
        case DrawType.round_robin:
            return False
        case DrawType.single_elim:
            return False
        case DrawType.rr_then_ko:
            return True


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


def _bracket_size(field_size: int) -> int:
    """The bracket a field of ``field_size`` is played in: the **smallest power of two ≥
    field_size**.

    Stated once, because the questions that turn on it — which slots exist
    (:func:`_knockout_fixtures`) and where a seed enters (:func:`_knockout_seats`) —
    must not size the bracket one way here and another way there, which is a draw that
    disagrees with itself. The ``B − field_size`` spare seats are the byes, which is why
    the padding rule and the bye rule are the same fact.

    A field of one pads to one (there is no zero-th power below it) and a field of zero
    to one as well; neither is a competition, and the refusals that say so
    (:class:`DegenerateDraw`) are the strategies', raised at the cut where the field is
    in hand.
    """
    bracket = 1
    while bracket < field_size:
        bracket <<= 1
    return bracket


def _seed_slots(bracket_size: int) -> list[int]:
    """The **standard single-elimination seeding order** for a bracket of
    ``bracket_size`` slots (a power of two): the 1-based seed positions laid out
    top-to-bottom, so pairing the adjacent slots — (1st, 2nd), (3rd, 4th), … — gives
    round 1, and the top two seeds can only meet in the final.

    Built by the classic recursion ``[1, 2] → [1, 4, 3, 2] → [1, 8, 5, 4, 3, 6, 7, 2]
    → …`` (ADR-0785): each round doubles the field, replacing every slot ``s`` with the
    pair ``(s, total − s)`` whose members sum to ``total = 2·len + 1`` — the invariant
    that keeps every seed as far as possible from its nearest rival. The pair is written
    strong-first on even indices and strong-second on odd, which threads the sequence
    into the familiar ``1, 8, 5, 4, …`` bracket order rather than a mirror of it (so the
    quarter- and half-groupings match a printed bracket, e.g. a 16-slot bracket's
    round-1 seatings are 1-16, 8-9, 5-12, 4-13, 3-14, 6-11, 7-10, 2-15).

    A pure function of seed *positions* — it never sees an entry id — so it is
    unit-tested on its own and reused wherever a bracket shape is needed.
    """
    slots = [1]
    while len(slots) < bracket_size:
        total = 2 * len(slots) + 1
        expanded: list[int] = []
        for index, seed in enumerate(slots):
            pair = (seed, total - seed) if index % 2 == 0 else (total - seed, seed)
            expanded.extend(pair)
        slots = expanded
    return slots


def _knockout_seats(field_size: int) -> dict[int, tuple[int, int, Side]]:
    """Where every seed **enters** the bracket that holds ``field_size`` of them:
    ``seed → (round, position, side)``.

    One description of a bracket's shape, for the three questions that need it: *which
    fixtures exist* (:func:`_knockout_fixtures`), *where does a given seed sit*
    (:meth:`RrThenKoStrategy.advance`, seating a qualifier the moment its pool
    finishes) and *who does a seed meet in round one* (:func:`_round_one_partners`, the
    constraint the rematch-free seeding is solved against). Keeping them one function is
    what stops a qualifier being seated into a slot the cut never emitted — and what
    stops the seeding believing in a bye the bracket does not give.

    Byes are the top ``B − field_size`` seeds, and a byed seed's entry point is its
    **round-2** side — computed with :func:`_successor` from the round-1 position it
    would have played, so a bye and a played feeder land on the two sides of the same
    successor. ``position`` is always the **full-bracket** slot index, never a
    renumbering of the surviving matches, which is what keeps that arithmetic true.
    """
    bracket = _bracket_size(field_size)
    slots = _seed_slots(bracket)
    seats: dict[int, tuple[int, int, Side]] = {}
    for pair_index in range(bracket // 2):
        position = pair_index + 1
        first, second = slots[2 * pair_index], slots[2 * pair_index + 1]
        top, bottom = min(first, second), max(first, second)
        if bottom <= field_size:
            # Two real seeds: a genuine round-1 match. Top seat = ``entry_a`` for
            # readability only — the successor side is decided by ``position``, not by
            # which seed is ``a``.
            seats[top] = (1, position, Side.a)
            seats[bottom] = (1, position, Side.b)
        else:
            # One phantom (``bottom`` > N; two phantoms cannot happen when
            # ``bracket`` is the smallest power of two ≥ N). The real ``top`` seed byes
            # straight into round 2.
            successor_round, successor_position, side = _successor(1, position)
            seats[top] = (successor_round, successor_position, side)
    return seats


def _knockout_fixtures(
    field_size: int, entry_for_seed: Mapping[int, EntryId]
) -> list[PlannedFixture]:
    """The whole un-pooled bracket for ``field_size`` seeds, with each seed's entry
    taken from ``entry_for_seed`` — **or left TBD for every seed the map does not
    name**.

    Two callers, one bracket. :class:`SingleElimStrategy` passes the full seed → entry
    map, because a single-elim cut knows its field. :class:`RrThenKoStrategy` passes an
    **empty** map, because its qualifiers have not played yet — and gets the identical
    shape with every side ``None``. That the shape is a pure function of ``field_size``
    is exactly why a pools-then-knockout bracket can be cut in the same stroke as the
    pools (ADR "rr-then-ko cuts both stages upfront"): the qualifier count ``P × K`` is
    known at cut time, so *which* slots exist and *which* seeds bye is settled before
    anybody has played.

    A **bye is absence** (ADR-0786): a byed seed has no round-1 fixture at all, and the
    round-1 positions it would have occupied are simply skipped, leaving gaps in the
    position sequence. Every later round is emitted whole, its sides ``None`` except a
    side a bye already makes known.

    Rounds are numbered from **1** for both callers. For the knockout stage of an
    rr-then-ko draw that is a *restart*, not a continuation of the pool rounds: the
    fixture uniqueness constraint is ``(event_id, pool_id, round, position)`` with
    ``NULLS NOT DISTINCT``, so ``pool_id IS NULL`` is its own numbering namespace, and
    "the round after the pools" is ill-defined anyway when pools may differ in size.
    """
    bracket = _bracket_size(field_size)
    rounds = bracket.bit_length() - 1
    seats = _knockout_seats(field_size)

    # The sides a seed is known to occupy at cut time, keyed by its slot. A seed the
    # caller cannot name yet contributes nothing, so its side stays TBD.
    seated: dict[tuple[int, int, Side], EntryId | None] = {
        seat: entry_for_seed.get(seed) for seed, seat in seats.items()
    }
    round_one_positions = sorted(
        {position for round_number, position, _ in seats.values() if round_number == 1}
    )

    fixtures = [
        PlannedFixture(
            pool_id=None,
            round=1,
            position=position,
            entry_a_id=seated.get((1, position, Side.a)),
            entry_b_id=seated.get((1, position, Side.b)),
        )
        for position in round_one_positions
    ]
    # Every later round, in one loop. Round 2 is the only one a *bye* can pre-fill —
    # :func:`_knockout_seats` seats a byed seed via ``_successor(1, …)``, which lands in
    # round 2 and nowhere further — so from round 3 on the lookup is ``None`` for every
    # slot and asking it costs nothing. Splitting the two would be two statements of one
    # rule ("a side is known only where a seat says so"), which is how they drift.
    fixtures.extend(
        PlannedFixture(
            pool_id=None,
            round=round_number,
            position=position,
            entry_a_id=seated.get((round_number, position, Side.a)),
            entry_b_id=seated.get((round_number, position, Side.b)),
        )
        for round_number in range(2, rounds + 1)
        for position in range(1, (bracket >> round_number) + 1)
    )
    return fixtures


def _round_one_partners(qualifier_count: int) -> dict[int, int]:
    """Who meets whom in round one of the bracket that holds ``qualifier_count``
    qualifiers — ``{seed: opposing seed}``, symmetric, and **only** for the pairs that
    are real matches.

    Read off :func:`_knockout_seats` — the *one* description of a bracket's shape —
    rather than re-walking :func:`_seed_slots` and re-stating the bye rule beside it.
    Two seats at the same round-1 position are two seeds in the same fixture, which is
    exactly what "meets in round one" means. A **byed** seed enters at round 2 by
    construction, so it never appears here at all, and the rematch-free guarantee
    (:func:`qualifier_seed_assignment`) is therefore built on the same bracket the cut
    emits rather than on a second opinion about it — the drift that would otherwise be
    silent, because a partner map that thinks a seed byes admits the same-pool pairing
    that seed actually plays.
    """
    by_position: dict[int, dict[Side, int]] = defaultdict(dict)
    for seed, (round_number, position, side) in _knockout_seats(
        qualifier_count
    ).items():
        if round_number == 1:
            by_position[position][side] = seed
    partners: dict[int, int] = {}
    for sides in by_position.values():
        first, second = sides.get(Side.a), sides.get(Side.b)
        # A round-1 position always carries both sides (``_knockout_seats`` seats them
        # together or byes the survivor into round 2); the guard only narrows the
        # Optionals for the type checker.
        if first is None or second is None:
            continue
        partners[first] = second
        partners[second] = first
    return partners


def _assign_block_pools(
    seeds: Sequence[int], pool_count: int, forbidden: dict[int, int]
) -> dict[int, int]:
    """Hand each seed in one place block a distinct pool, avoiding each seed's one
    forbidden pool — the bipartite matching at the heart of
    :func:`qualifier_seed_assignment`.

    Kuhn's augmenting-path algorithm, walked in ascending seed then ascending pool
    order, which makes the matching it lands on a *function of the inputs* rather than
    of dict iteration luck.

    **Why the failure arm below is unreachable**, stated the way it is actually true.
    "Each seed forbids at most one pool, so each admits at least ``P−1``" is the fact,
    but it is *not* the reason: a subset ``S`` of the block's seeds sees all ``P`` pools
    the moment two of its members forbid different pools (or one forbids none), so the
    only subset that can fail Hall's condition is the whole block — all ``P`` seeds
    forbidding the **same** pool, leaving ``P−1`` pools for ``P`` seeds. Admitting
    ``P−1`` each is exactly what does not rule that out.

    What rules it out is the geometry of a block. A block is ``P`` **consecutive**
    seeds; round one pairs ``s`` with ``B+1−s`` (:func:`_seed_slots`, ``B`` the bracket
    size), an order-reversing pairing, so a block's partners are themselves ``P``
    consecutive seeds — a run spanning at most **two** blocks. Each block hands each
    pool to exactly one seed, so at most two of a block's seeds can forbid one pool,
    which is fewer than ``P`` for every ``P ≥ 3``. ``P = 2`` is the one size where two
    would be enough, and there the partner run is ``{B−2b−1, B−2b}`` (block ``b``),
    whose lower member is odd because ``B`` is a power of two — so both partners sit in
    the *same* block and necessarily hold different pools. Either way a block never
    forbids one pool ``P`` times, Hall's condition holds, and a matching exists.
    (Measured over ``P`` 2..64 × ``K`` 1..40 the margin is wider still: no two seeds of
    a block were ever seen to forbid the same pool at all.)

    A seed takes the **lowest free pool** it is allowed, and only displaces an incumbent
    when every pool it admits is taken — the standard greedy initialization for Kuhn's.
    Skipping it costs nothing in correctness (an augmenting path repairs any greedy
    mistake) but a great deal in legibility: without it an *unconstrained* block still
    shuffles, so a two-pool bracket seats pool B's winner at seed 1, which reads as a
    bug to anyone printing the draw.
    """
    seed_by_pool: dict[int, int] = {}
    for seed in seeds:
        free = next(
            (
                pool
                for pool in range(pool_count)
                if pool not in seed_by_pool and pool != forbidden.get(seed)
            ),
            None,
        )
        if free is not None:
            seed_by_pool[free] = seed
            continue
        if not _augment_pool(seed, pool_count, forbidden, seed_by_pool, set()):
            raise RuntimeError(  # pragma: no cover - Hall's condition forbids it
                f"No conflict-free pool assignment for seed {seed} across "
                f"{pool_count} pools, which Hall's condition says cannot happen."
            )
    return {seed: pool for pool, seed in seed_by_pool.items()}


def _augment_pool(
    seed: int,
    pool_count: int,
    forbidden: dict[int, int],
    seed_by_pool: dict[int, int],
    visited: set[int],
) -> bool:
    """Try to seat ``seed`` in some pool, displacing an incumbent that can move
    elsewhere. ``True`` when ``seed_by_pool`` has been extended to cover it."""
    for pool in range(pool_count):
        if pool == forbidden.get(seed) or pool in visited:
            continue
        visited.add(pool)
        incumbent = seed_by_pool.get(pool)
        if incumbent is None or _augment_pool(
            incumbent, pool_count, forbidden, seed_by_pool, visited
        ):
            seed_by_pool[pool] = seed
            return True
    return False


def _successor(round_number: int, position: int) -> tuple[int, int, Side]:
    """Where the winner of the fixture at ``(round_number, position)`` goes: the next
    round, slot ``ceil(position / 2)``, and side ``a`` for odd ``position`` else ``b``.

    The whole of single-elimination's topology, kept as *arithmetic on the coordinates*
    rather than a stored ``next_slot_id`` (ADR-0786): the two fixtures at positions
    ``2k − 1`` and ``2k`` feed the two sides of the single fixture at position ``k`` one
    round on. Both the cut (seating a byed seed onto round 2) and
    :meth:`SingleElimStrategy.advance` (seating a winner forward) go through this one
    function, which keeps a byed seed and a played feeder landing on the two sides of
    the same successor.
    """
    return (
        round_number + 1,
        (position + 1) // 2,
        Side.a if position % 2 == 1 else Side.b,
    )
