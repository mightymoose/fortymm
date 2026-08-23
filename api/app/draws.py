"""Draw planning — the *pure* domain behind cutting and advancing a draw (ADR-0786).

A **draw** is the complete set of **fixtures** an event's draw type prescribes for
its entrants; a **fixture** is one planned pairing (a round and a position, plus a
**group** when the draw is grouped), whose sides may still be unknown. This module
knows how to *plan* those fixtures. It does not persist them: it holds no session,
issues no query, imports no FastAPI and no SQLAlchemy construct. Its inputs and
outputs are small frozen value objects, so a strategy is testable with a literal
list and re-runnable anywhere (a REPL, a script, a test) without a database.

Each :class:`~app.models.tournament.DrawType` is a strategy behind
:class:`DrawStrategy`, with two pure operations:

``plan_initial(config, ordered_entrants)``
    Cuts the draw — the fixtures as they stand the moment they are first written.

``advance(fixtures, ordered_entrants)``
    Reads the persisted fixtures *as they currently stand* and returns the
    side-fills that the decided fixtures now imply, plus the fixtures that have
    become **ready** (both sides known, no match yet). It is re-run after *every*
    result and at go-live rather than fired by carefully-chosen events, which only
    works because it is **idempotent**: apply its plan, feed the resulting state
    back in, and the second plan is empty (:attr:`AdvancePlan.is_empty`).

    It takes the **field** as well as the fixtures because the fixtures are not always
    a complete description of it. A swiss bye is the absence of a fixture row, so a
    byed entrant sits in no row at all, and pairing the next round from the seated set
    alone would drop them from the event permanently. Three of the four strategies
    ignore the argument — their fixtures do seat their whole field — and say so.

Two things the schema deliberately does not store, and this module therefore owns:

- **Topology.** There is no ``next_slot_id``. Single-elim's successor is arithmetic
  on ``(round, position)``, round-robin has no successor at all, and a swiss draw
  could not know its next round until the current one finished. ``advance()``
  recomputes what it needs from the rows.
- **Byes.** A bye is the *absence of a fixture row*, never a row with a ``NULL``
  side. ``NULL`` means exactly one thing — "TBD, ``advance()`` will fill it" — so an
  odd round-robin group simply has fewer fixtures in some rounds.
"""

from __future__ import annotations

import enum
import uuid
from collections import Counter, defaultdict
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import NewType, Protocol

from app.group_finishing_order import (
    EntryTally,
    MatchOutcome,
    finishing_order,
    swiss_finishing_order,
)
from app.models.tournament import DrawType, EventFormat
from app.schemas.tournament import (
    DrawSettingsWriteArm,
    RoundRobinDrawSettingsWrite,
    RrThenKoDrawSettingsWrite,
    SingleElimDrawSettingsWrite,
    SwissDrawSettingsWrite,
)

# Distinct id types, so the checker rejects handing a fixture id to something that
# wants an entry id. They are plain ``uuid.UUID`` at runtime.
EntryId = NewType("EntryId", uuid.UUID)
FixtureId = NewType("FixtureId", uuid.UUID)
MatchId = NewType("MatchId", uuid.UUID)
#: A group is a row (``tournament_event_stage_groups``, ADR 20260801) with a
#: server-minted uuid primary key, and a fixture's ``group_id`` is a real composite
#: foreign key onto it — so this is a ``uuid.UUID``, exactly like the ids above. It was
#: a ``str``, a dangling ref into ``TournamentEvent.groups`` JSONB, for as long as
#: there was no groups table to point at and no server to mint one.
GroupId = NewType("GroupId", uuid.UUID)


def group_letter(position: int) -> str:
    """``Group A``, ``Group B``, … and past ``Group Z`` the spreadsheet's ``AA`` — a
    bijective base-26 label, so a hundred-group field names its groups instead of
    printing punctuation.

    Ported from ``web-client/src/components/tournaments/data/draw-structure.ts``'s
    ``groupLetter`` (ADR 20260808, "draw-structure derivation runs on both sides and
    shares its vectors"). The carry is ``n // 26 - 1``, not the naive ``n // 26``: the
    naive form agrees with this one for positions 0 to 25 and disagrees at 26 and every
    position after, because a bijective base-26 digit has no zero — position 26 is
    ``AA``, not ``BA``. ``position`` is 0-based.
    """
    letters = ""
    n = position
    while n >= 0:
        letters = chr(65 + (n % 26)) + letters
        n = n // 26 - 1
    return letters


def group_label(position: int) -> str:
    """``Group A``, ``Group B``, … — the director-facing label a group renders as
    everywhere the app used to print a stored reservation name (ADR 20260808).

    A thin wrapper over :func:`group_letter` so every caller that needs the full label
    (the group-set freeze's 409, the dashboard's ``group_label``, a match call's
    context) shares one spelling of "Group " + the letter, rather than composing the
    prefix at each call site."""
    return f"Group {group_letter(position)}"


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
    :mod:`app.schedule_preview` raises this for ``single_elim`` and ``swiss``, both
    fully supported draw types, because the **preview** does not cover them.

    It is no longer the scheduler that cannot place them: a live solve places a fixture
    belonging to no group over its event's own window, on the tournament's tables (ADR
    "a group restricts scheduling, it does not enable it"). The reason the preview
    refuses is the preview's own, and :mod:`app.schedule_preview` states it in full.

    Carries the offending :class:`DrawType` **structurally**, so the HTTP/MCP layers
    compose their own sentence from the fact rather than parsing a message.
    """

    def __init__(self, draw_type: DrawType) -> None:
        self.draw_type = draw_type
        super().__init__(f"Draw type {draw_type.value!r} is not supported here yet.")


class DegenerateDraw(DrawError):
    """The requested cut would produce a draw that isn't a competition.

    A group holding a single entrant has nobody to play (and a group holding none is a
    ghost), so we refuse the cut rather than silently emit a group of one. The director
    fixes the input — fewer groups, or more entrants — and re-cuts.
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


def draw_error_detail(error: DrawError) -> str:
    """The director-facing sentence for a ``DrawError`` — the one mapper every caller
    that turns a refused cut into words for a director goes through, so the copy for
    "why can't this be cut" is written once.

    A ``match`` over the error, not ``str(error)`` over whatever arrives:

    * ``NonSinglesDraw`` carries its ``event_format`` **structurally**, so the sentence
      is composed here from the fact rather than parsed out of a message written for a
      developer.
    * ``DegenerateDraw`` is the one error whose message is **domain-authored copy**,
      and it is passed through verbatim: only the strategy knows *which* degeneracy it
      hit, and the numbers in that sentence are the numbers the director has to change.
    * ``UnsupportedDrawType`` carries its ``draw_type`` **structurally**, for the same
      reason ``NonSinglesDraw`` does.
    * The fallback arm is a **generic** sentence, never the exception's own — a
      ``DrawError`` subclass added tomorrow gets a vague refusal rather than leaking a
      message nobody wrote for a human.

    Shared by the cut/schedule-preview HTTP mapper (``app.tournaments._draw_refusal``)
    and the ``published → live`` dry run (``app.tournament_lifecycle``), so the two
    call sites' copy cannot drift apart — see each caller for what it does with the
    string.
    """
    match error:
        case NonSinglesDraw():
            detail = (
                f"A {error.event_format.value} event cannot be given a draw — only "
                "singles events can. A fixture seats one entrant on each side, and "
                "there is nowhere to record a doubles pairing or a team."
            )
        case DegenerateDraw():
            detail = str(error)
        case UnsupportedDrawType():
            detail = (
                f"A {error.draw_type.value} draw cannot be previewed, and this "
                "tournament has no other event to preview. A draw of that kind is "
                "decided round by round as it is played, so before anyone has "
                "entered there is nothing to lay out. The scheduler does place it "
                "once the tournament is live."
            )
        case _:
            detail = "This event's draw cannot be cut as the event stands."
    return detail


class MissingFixtureGames(RuntimeError):
    """A draw was advanced with decided group fixtures but **no game counts anywhere** —
    the caller never loaded them.

    Deliberately **not** a :class:`DrawError`. A ``DrawError`` is a director-facing
    refusal the HTTP layer turns into a 422 ("the draw you asked for isn't a
    competition"); this is a *wiring* bug in the projection seam, and the only useful
    response to it is a loud 500 in the logs. Nothing a director can type causes it and
    there is no input they could correct.

    It exists because the alternative failure is silent and wrong. A
    groups-then-knockout draw picks its qualifiers with
    :func:`~app.group_finishing_order.finishing_order`, whose chain runs wins →
    head-to-head → game difference → games won; handed
    :attr:`FixtureState.games` of ``None`` it would still *produce an order* — one
    computed on wins alone, which silently disagrees with the standings table on screen
    at exactly the moment a director is looking hardest (a multi-way tie for the last
    qualifying spot). Every test in the suite would stay green, because nothing else
    reads the field. So the strategy refuses to order a group it cannot see the games
    of.

    The condition is scoped to "**no** fixture in this input carries games", which is
    precisely "the caller did not load them" and nothing else. A *single* fixture
    without games while its neighbours have them is an ordinary live state — a result
    under correction leaves the match un-``completed`` while the fixture's written-back
    ``winner_entry_id`` stays put — and that one is handled honestly by the strategy
    (its group is simply not finished yet), not raised at.
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


class MissingStageAssignment(RuntimeError):
    """A fixture reached :meth:`RrThenKoStrategy.advance` with
    :attr:`FixtureState.stage` either **unresolved** (``None``) or naming a stage
    whose draw type is **neither** round-robin nor single-elim — either way, this
    draw's group fixtures and its knockout fixtures cannot be told apart for it.

    Two distinct wiring bugs share this one exception, because both leave the same
    hole: a fixture that :func:`_stage_split` cannot place in either half.

    * **Unresolved** — the caller projected the fixture without the event's stage order
      at all (``stage=None``), i.e. skipped
      :func:`~app.tournament_draws.fixture_state`'s ``stages`` plumbing.
    * **Resolved, but the wrong shape** — the caller resolved a real
      :class:`FixtureStage`, but its ``draw_type`` is neither of the two this
      composite's own template mints (a swiss-typed or, in principle, an
      rr-then-ko-typed stage attached to what claims to be an rr-then-ko event) — a
      template/event mismatch that only a re-mint gone wrong could produce.

    :class:`MissingFixtureGames`' and :class:`MissingBracketSlot`'s sibling, and
    deliberately not a :class:`DrawError` for the same reason: nothing a director can
    type reaches it. Every real fixture's ``stage_id`` is ``NOT NULL`` (ADR 20260815
    decision 5) and every event's stages are minted in the same transaction as the
    event itself (decision 3), so a caller that resolved its fixtures through the
    ordinary seam (:func:`~app.tournament_draws.fixture_state`) always has this. Its
    absence means a caller skipped that plumbing — a wiring bug, and the only useful
    response is a loud 500, not a 422 nobody could act on.

    It exists because the alternative failure is silent and wrong in the exact shape
    :class:`MissingFixtureGames` warns about: a fixture :func:`_stage_split` cannot
    place matches **neither** the group half nor the knockout half, so it drops out of
    both of :meth:`RrThenKoStrategy.advance`'s stages — no qualifiers are ever seated,
    no bracket fixture is ever ready, and nothing raises. The whole suite would stay
    green, because nothing else reads the field.
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
    """*Which* qualifier a knockout seed belongs to — a group and a finishing place
    within it, never an entry.

    The whole point of this shape is what it **cannot** name. A groups-then-knockout
    bracket is cut before a single group game is played, so the seed → qualifier map
    has to be expressible without knowing who won anything; keeping it as
    ``(group_index, place)`` is what makes it computable at cut time and what lets one
    group's qualifiers take their predetermined slots the moment *that* group is
    decided, with the other groups still playing.

    ``group_index`` is 0-based into :attr:`DrawConfig.group_ids` — the event's own group
    order, the same order the snake dealt against. ``place`` is 1-based within that
    group, so ``place=1`` is the group winner.
    """

    group_index: int
    place: int


@dataclass(frozen=True, slots=True)
class DrawConfig:
    """What a cut needs to know about the event itself — which is its **groups**, and
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

    ``group_ids`` are the ids of the event's configured groups, **in the event's own
    group order** — ascending ``Group.position``, which is what the caller
    (:func:`app.tournament_draws.draw_config`) sorts them by, and which this tuple then
    carries *as* its sequence. That order is what the snake seeds against, so nothing
    downstream may re-sort it: a ``sorted(config.group_ids)`` anywhere below here would
    seed the draw against the ids' own order, which under a random uuid is nobody's.

    Never empty on the production path since #1483: every event's stage 0 holds at
    least one group, whatever its reservation count (the floor in
    ``app.tournament_reservations.group_count_for``), and a single-stage draw type
    deals every fixture into the one it names (:func:`_sole_group`). It is still
    *representable* empty, for a strategy test cutting against a bare
    ``DrawConfig()``. The group *id set* freezes while a draw exists
    (``app.tournament_events`` refuses a payload that moves it), and underneath that a
    composite foreign key holds the reference itself.
    """

    group_ids: tuple[GroupId, ...] = ()


@dataclass(frozen=True, slots=True)
class FixtureStage:
    """Which of an event's stages a fixture belongs to, and what draw type that stage
    itself runs — the pair :class:`RrThenKoStrategy` needs to tell its two stages
    apart, carried as one fact on :attr:`FixtureState.stage`.

    A value object, not two parallel optional fields on ``FixtureState``
    (a ``stage_position: int | None`` and a hypothetical ``stage_draw_type: DrawType |
    None`` beside it) — two independent optionals can disagree (a position resolved
    with no draw type, or the reverse), which is the tri-state-by-another-name shape
    api/CLAUDE.md's "make illegal states unrepresentable" rules out by name. Here,
    either the whole fact is known (:class:`FixtureStage` built with both fields) or
    none of it is (:attr:`FixtureState.stage` is ``None``); there is no representable
    in-between, and :func:`_stage_split` reads exactly one attribute
    (:attr:`draw_type`) to decide a fixture's half rather than reconciling two.

    ``position`` is 0-based, mirroring :attr:`FixtureState.group_position`, and is the
    event's own stage order (``TournamentEventStage.position``, ADR 20260815 decision
    5) — carried for callers that want to sort or display by it, though
    :class:`RrThenKoStrategy` itself no longer reads it (:attr:`draw_type` is what it
    asks). ``draw_type`` is the stage's OWN draw type, one of the components
    :func:`~app.tournament_event_stages.stage_template` mints for the composite that
    owns it — never :attr:`~app.models.tournament.DrawType.rr_then_ko` itself, which is
    refused as a stage's own type at the write boundary (decision 4).
    """

    position: int
    draw_type: DrawType


@dataclass(frozen=True, slots=True)
class PlannedFixture:
    """One fixture a cut wants written — the pre-persistence twin of a
    ``TournamentFixture`` row, minus the ids the database mints.

    A side is ``None`` only when it is genuinely **TBD** (single-elim's later rounds).
    It is *never* ``None`` to mean "bye": a bye is the absence of this object.
    """

    #: Which of its event's stages this fixture is dealt into, and that stage's own
    #: draw type — the same :class:`FixtureStage` projection :attr:`FixtureState.stage`
    #: carries on the read side (ADR 20260815 decision 5), stated here on the write
    #: side by the strategy that dealt the fixture.
    #:
    #: **Required, and not derived downstream.** The write seam
    #: (:func:`app.tournament_draws.cut_draw`) used to infer a fixture's stage from
    #: whether it named a group — stage 0 for a grouped fixture, the event's un-grouped
    #: stage otherwise. That inference was only ever correct while "has a group" and
    #: "belongs to the group stage" were the same set, and it is the strategy, not the
    #: seam, that actually knows: a bracket dealt into its stage's group is grouped AND
    #: on a knockout stage. The reader that needs the draw type
    #: (:func:`app.schedule_preview._previewed_fixtures`, through
    #: :func:`seats_both_sides_at_cut`) and the one that needs the position (the write
    #: seam) read the one fact rather than two derivations of it.
    stage: FixtureStage
    #: The group this fixture is dealt into — the event's stage-0 group for every
    #: single-stage draw type (round-robin's dealt groups, and, since #1483, the sole
    #: group a single-elim or swiss stage holds), and ``None`` for the knockout stage
    #: of a groups-then-knockout draw, whose groups #1484 materialises.
    group_id: GroupId | None
    #: 1-based.
    round: int
    #: 1-based within its (group, round).
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
    group_id: GroupId | None
    round: int
    position: int
    entry_a_id: EntryId | None
    entry_b_id: EntryId | None
    #: Where this fixture's **group** sits in its event's group order — 0-based, the
    #: ``Group.position`` the write boundary stamped (ADR 20260801, "Groups carry an
    #: explicit ``position``"). NOT to be confused with :attr:`position` above, which is
    #: this fixture's slot within its own round; the two are different axes of the same
    #: draw and the sort key below reads both.
    #:
    #: ``None`` means "no group order to sort on", which is true of an **un-grouped**
    #: fixture (``group_id is None``) and of a caller that did not resolve the event's
    #: groups at all — a strategy test built straight from :class:`FixtureState`
    #: literals, or :func:`~app.tournament_draws.fixture_state` called with no
    #: ``group_positions`` map. A group stored before the field existed still resolves
    #: to a real int here — :func:`~app.tournament_draws.group_order`'s stable sort
    #: leaves it at its array index. It is deliberately not defaulted to ``0``: a real
    #: position of ``0`` is the *first* group, and "unknown" collapsing onto "first"
    #: would silently promote every unresolved fixture to the head of the draw.
    #: Unknown sorts after every known group instead, where the id tie-break decides it
    #: — which is exactly the order :func:`ready_fixtures` had before positions
    #: existed.
    group_position: int | None = None
    #: Which of this fixture's event's stages it belongs to, and that stage's OWN draw
    #: type (:class:`FixtureStage`) — the discriminator :class:`RrThenKoStrategy` reads
    #: to split one event's fixtures between its two stages, rather than re-deriving the
    #: split from ``group_id is None``. That derivation happens to be correct for
    #: rr-then-ko today (only its second stage is un-grouped), but it is an accident of
    #: this one draw type's shape rather than a fact the strategy is entitled to lean on
    #: — a swiss round is *also* ``group_id IS NULL`` (ADR 20260815's own Context: this
    #: ambiguity already shipped a bug on the read side), and nothing in this module
    #: stops a future composite from pairing two un-grouped stages.
    #:
    #: ``None`` is "no stage was resolved" — a caller (a test built straight from
    #: literals) that never passed the event's stages through to
    #: :func:`~app.tournament_draws.fixture_state`, or one of the three draw types
    #: whose strategy never reads it at all. Only :class:`RrThenKoStrategy` asks, and
    #: it asks loudly rather than silently seating nothing: see
    #: :class:`MissingStageAssignment`.
    stage: FixtureStage | None = None
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
    #: computing a group's finishing order from these agrees with the table on screen
    #: **structurally**, down to the game-difference and games-won tiebreakers, rather
    #: than by two implementations happening to concur.
    #:
    #: Only ``rr-then-ko`` and ``swiss`` declare that they read it; round-robin
    #: and single-elim do not, and :func:`reads_fixture_games` is where that is
    #: said once so a caller knows whether it has to load the counts at all.
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
    #: It is what stops a voided pairing wedging its group: without it the group would
    #: sit one score short of "every fixture carries a score" forever — never finished,
    #: its qualifiers never seated — while the standings, which already exclude voided
    #: pairings from a group's ``fixture_count`` (:class:`app.results.GroupInput`),
    #: showed that same group ``complete``. Two layers disagreeing about whether a
    #: group is over.
    match_voided: bool = False

    @property
    def is_pending(self) -> bool:
        """Some side is still unknown."""
        return self.entry_a_id is None or self.entry_b_id is None

    @property
    def is_decided(self) -> bool:
        """This fixture has produced all the result it ever will — a live score, or a
        **void** that means there will never be one.

        The two facts, in one place, because two readers ask this same question of this
        same type within one advance: :func:`_swiss_round_is_decided` (may the next
        round be paired?) and :attr:`SeatedPairing.decided` (may this round's bye be
        scored?). Spelled twice they could gain a third condition — a forfeit status —
        one at a time, and a bye scored in the standings but not in the pairing is the
        result.

        The **live-outcome** view (:attr:`games`), not the written-back
        ``winner_entry_id``: a result under correction leaves its match un-``completed``
        while the winner id stays put, so a correction genuinely un-decides its fixture.

        Says nothing about the sides being known — an unpaired fixture is not decided in
        any useful sense, but it is not this property's question either. A caller that
        needs both asks for both (``not f.is_pending and f.is_decided``); the callers
        that already hold a seated fixture do not re-ask.
        """
        return self.match_voided or self.games is not None


@dataclass(frozen=True, slots=True)
class SeatedPairing:
    """A fixture that seats **both** sides, in the one round it belongs to — the whole
    input to :func:`swiss_byes`, and deliberately nothing more.

    Both sides are non-optional, which is the type doing the work: a bye is derived by
    asking who is *absent* from a round that was paired, so a fixture with an empty side
    (a round nobody has been paired into yet) must not be able to enter that derivation
    at all. Filtering happens where these are built, once, rather than being re-asserted
    inside every reader.

    It exists because **two layers derive byes and must not disagree** — the draw layer
    pairs the next round down the standings (:class:`SwissStrategy`), and the results
    layer reads those standings out to a director (:mod:`app.results`) — and the two
    hold entirely different row shapes (:class:`FixtureState` and a
    ``TournamentFixtureRead``). This is the small common shape both can project into, so
    the *rule* has one implementation while the projections stay each caller's own.
    """

    round: int
    entry_a_id: EntryId
    entry_b_id: EntryId
    #: Whether this pairing has produced all the result it ever will — a completed
    #: match, or a **voided** one, which never will. It is here because a bye is scored
    #: with its round (:func:`swiss_byes`), and a round is only over when every pairing
    #: in it is: a fixture still being played leaves the round open, and a voided one
    #: does not. The draw layer fills it straight from
    #: :attr:`FixtureState.is_decided` — the one place those two facts are spelled —
    #: which is the same property :func:`_swiss_round_is_decided` asks.
    #:
    #: **No default**, deliberately. Either default is a lie a caller can tell by
    #: omission, and both fail quietly: ``False`` credits nobody for a bye they took,
    #: and ``True`` credits a round still being played. Every construction site holds
    #: the fact already, so it states it.
    decided: bool


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

    def advance(
        self,
        fixtures: Sequence[FixtureState],
        ordered_entrants: Sequence[OrderedEntrant],
    ) -> AdvancePlan:
        """What the current state of these fixtures implies, for this field. Idempotent:
        run against a state its own last plan was applied to, it returns an empty plan.

        ``ordered_entrants`` is the event's **active** field in draw order — the same
        value :meth:`plan_initial` was cut from, not a set recovered from the fixtures.
        Only :class:`SwissStrategy` reads it (see the module docstring); the other three
        take it and ignore it, so that the seam has one shape rather than a special
        case. A caller may hand those three an **empty** sequence rather than paying for
        a load they discard — :func:`reads_entrants` is where each draw type says which
        it is.

        **Required, with no default**, and that is a fact about this being a
        :class:`Protocol` with four implementations rather than a rule about optional
        parameters. A default here would let one implementation quietly leave the
        parameter off its signature and still satisfy the checker, and the one that did
        would be the one that needed it. The mirror case is
        :func:`~app.group_finishing_order.swiss_finishing_order`, a single free function
        whose ``byes`` **is** defaulted: nothing implements it, so an omission there is
        a caller's choice at one call site rather than a hole in a seam.
        """
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
    group_count: int, qualifiers_per_group: int
) -> dict[int, QualifierSeat]:
    """Which qualifier takes which knockout **seed number**, so that no round-one
    fixture pairs two entrants out of the same group (ADR "rr-then-ko cuts both stages
    upfront and seeds qualifiers rematch-free").

    Returns a map ``seed → QualifierSeat`` covering every seed ``1 .. P·K``. It is a
    pure function of the group count ``P`` and the qualifiers-per-group ``K`` — it never
    sees an entry, a result or a standing, which is exactly what lets the bracket be
    cut upfront and each group's qualifiers be seated as that group finishes. Bracket
    size is *derived* here (``B`` = smallest power of two ≥ ``P·K``), never passed in,
    so it cannot contradict the qualifier count.

    Qualifiers are ordered **place-major**: every group winner outranks every runner-up,
    so place block ``k`` (0-based) owns seeds ``kP+1 .. kP+P``. Within a block the group
    order is *chosen*, not fixed, and that is the whole mechanism. Three facts make the
    guarantee provable rather than best-effort:

    - a block holds each group exactly once, so a round-one pair falling **inside** one
      block is conflict-free for free;
    - round one is a perfect matching on seeds (:func:`_seed_slots` pairs ``s`` with
      ``B+1−s``), so a seed has **at most one** partner and therefore at most one
      forbidden group;
    - assigning blocks in ascending order, one forbidden group per seed leaves Hall's
      condition exactly **one** way to fail — all ``P`` of a block's seeds forbidding
      the *same* group — and the block's own geometry closes it, so a conflict-free
      system of distinct representatives always exists. That last step is the one worth
      reading in full, and it is stated where it is relied on
      (:func:`_assign_block_groups`), because "each admits at least ``P−1`` groups" is
      not by itself the reason. The search below finds a representative system
      deterministically — groups tried in ascending index order, augmenting when stuck —
      so a re-cut reproduces the same bracket, the same promise :func:`order_entrants`
      makes.

    The two fixed orderings this replaces cannot work: place-then-group pairs ``C1``
    against ``C2`` at three groups, and reversing the runners-up fixes three groups
    while breaking two, because *which* pairs are cross-block depends on ``B − P·K``,
    which jumps around with ``P``.

    **One group is an explicit waiver, not a failure.** With ``P = 1`` every qualifier
    shares the one group, so every knockout match is necessarily a rematch — that is
    "league, then a playoff" working as intended. The assignment is then simply
    ``seed k+1 → place k+1``, and this function says so rather than raising.

    Raises :class:`ValueError` on inputs outside the format's legal space (``P ≥ 1``,
    ``K ≥ 1``, ``P·K ≥ 2``). Those are *programmer* errors here: the director-facing
    refusals are the caller's, raised as :class:`DegenerateDraw` at the cut, where the
    entrant count is in hand.
    """
    if group_count < 1:
        raise ValueError(f"group_count must be at least 1, got {group_count}.")
    if qualifiers_per_group < 1:
        raise ValueError(
            f"qualifiers_per_group must be at least 1, got {qualifiers_per_group}."
        )
    qualifier_count = group_count * qualifiers_per_group
    if qualifier_count < 2:
        raise ValueError(
            "A knockout stage needs at least 2 qualifiers, got "
            f"{qualifier_count} ({group_count} × {qualifiers_per_group})."
        )

    def seat(seed: int, group_index: int) -> QualifierSeat:
        # Place-major: the block a seed sits in *is* its finishing place.
        return QualifierSeat(
            group_index=group_index, place=(seed - 1) // group_count + 1
        )

    if group_count == 1:
        # The waiver. Every qualifier is out of the same group, so there is nothing to
        # avoid and no permutation to choose.
        return {seed: seat(seed, 0) for seed in range(1, qualifier_count + 1)}

    partners = _round_one_partners(qualifier_count)
    group_by_seed: dict[int, int] = {}
    for block in range(qualifiers_per_group):
        seeds = [block * group_count + offset + 1 for offset in range(group_count)]
        # A seed's only constraint is its round-one partner, and only once that partner
        # has a group — i.e. when it sits in an *earlier* block. A partner inside this
        # block needs no constraint (the block holds each group once, so they differ
        # anyway); a partner in a later block will see *this* seed as its constraint.
        forbidden = {
            seed: group_by_seed[partners[seed]]
            for seed in seeds
            if seed in partners and partners[seed] in group_by_seed
        }
        group_by_seed.update(_assign_block_groups(seeds, group_count, forbidden))

    return {seed: seat(seed, group) for seed, group in sorted(group_by_seed.items())}


@dataclass(frozen=True, slots=True)
class RoundRobinStrategy:
    """All-play-all within each group: every pair in a group meets exactly once, and
    nobody plays twice in the same round.

    The cut is two steps. First the ordered entrants are **snaked** across the event's
    groups — group A takes seeds 1, 2P, 2P+1, …; group B takes 2, 2P−1, … — which
    spreads the strength evenly and leaves group sizes differing by at most one. Then
    each group's fixtures are laid out by the **circle method**: fix one entrant, rotate
    the rest, and every rotation is one round of simultaneous pairings. An odd group
    rotates against a phantom, and the pairing against it is simply **not emitted** —
    that is what a bye is here (a row with a ``NULL`` side would mean "TBD", which is a
    lie about a fixture that will never be played).

    Both sides of every fixture are known at cut time, so this draw has nothing to
    advance *into*: :meth:`advance` fills no sides, and only reports readiness.
    """

    def plan_initial(
        self, config: DrawConfig, ordered_entrants: Sequence[OrderedEntrant]
    ) -> list[PlannedFixture]:
        groups = _snake(ordered_entrants, config.group_ids)
        return [
            fixture
            for group_id, members in groups
            for fixture in _circle_method(group_id, members)
        ]

    def advance(
        self,
        fixtures: Sequence[FixtureState],
        ordered_entrants: Sequence[OrderedEntrant],
    ) -> AdvancePlan:
        """Round-robin fixtures are fully determined at the cut, so there is never a
        side to fill: every pairing was known the moment the draw existed. All this can
        report is which fixtures are ready to become matches — which, on a freshly cut
        draw, is all of them, and on an already-materialized one is none of them.

        ``ordered_entrants`` is ignored: an odd group's bye is a round this group's own
        fixtures seat its holder in every *other* round of, so the seated set already is
        the field and nothing here needs to be told it a second time."""
        return AdvancePlan(side_fills=(), ready_fixture_ids=ready_fixtures(fixtures))


def _sole_group(config: DrawConfig) -> GroupId | None:
    """The **one** group a single-stage draw deals every fixture into, or ``None``
    when the config names anything other than exactly one.

    A single-elim or swiss event has one stage, and since #1483 that stage holds
    exactly one group whatever the event's reservation count: the materialisation
    floor (``app.tournament_reservations.group_count_for``) mints at least one, and
    #1482's cap keeps a non-composite event to at most one reservation, so the count
    cannot climb. The production answer is therefore always that one group's id.

    ``None`` is for the callers the production path does not have: a strategy test
    that cuts against a bare ``DrawConfig()``. Dealing those fixtures into no group
    is exactly what they did before this floor existed, so an ungrouped config
    plans the shape it always planned rather than raising at a caller that never
    asked about groups.

    The many-groups arm answers ``None`` too, and deliberately does not pick the
    first: "the group of this stage" has no answer when a stage has several, and
    guessing one would deal a whole bracket into an arbitrary group with nothing to
    say it was arbitrary. #1484, which materialises groups per stage, is what gives
    that arm a real answer.
    """
    if len(config.group_ids) != 1:
        return None
    return config.group_ids[0]


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
            # Mirrors round-robin's per-group floor: a bracket of one has no fixtures
            # and is not a competition. The message is director-facing copy (the
            # endpoint's ``_draw_refusal`` passes a ``DegenerateDraw``'s message
            # through), so it names the fix, not the internals.
            raise DegenerateDraw(
                "A single-elimination draw needs at least 2 entrants — a bracket of "
                "one has nobody to play."
            )
        seed_entry = {entrant.position: entrant.entry_id for entrant in entrants}
        return _knockout_fixtures(
            size,
            seed_entry,
            stage=FixtureStage(position=0, draw_type=DrawType.single_elim),
            group_id=_sole_group(config),
        )

    def advance(
        self,
        fixtures: Sequence[FixtureState],
        ordered_entrants: Sequence[OrderedEntrant],
    ) -> AdvancePlan:
        """Seat every decided fixture's winner into its successor slot, plus report the
        fixtures now ready to materialize.

        ``ordered_entrants`` is ignored: a bracket's byed seeds are seated onto their
        round-2 sides at cut time, so every entrant is already in a row and the
        successor arithmetic needs nothing the fixtures do not carry.

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


def _stage_split(
    fixtures: Sequence[FixtureState],
) -> tuple[list[FixtureState], list[FixtureState]]:
    """Partition an rr-then-ko draw's fixtures into ``(group stage, knockout stage)``,
    by each fixture's own :attr:`~FixtureState.stage`'s ``draw_type`` (ADR 20260815
    decision 6, refined) — never by ``group_id is None`` (see
    :attr:`FixtureState.stage`'s docstring for why), and not by the stage's bare
    ``position`` either: this composite's two stages are told apart by what they
    THEMSELVES run — round-robin vs single-elim, the exact pair
    :func:`~app.tournament_event_stages.stage_template` mints for
    ``DrawType.rr_then_ko`` — rather than by restating that template's positions as a
    second, parallel pair of literals in this module.

    **Total.** Every fixture lands in the group half, the knockout half, or is counted
    toward a single :class:`MissingStageAssignment` — never silently dropped from both,
    which is the one failure this module refuses to allow (see that class for the two
    ways a fixture can reach neither). One pass; the unplaced fixtures are only ever
    counted, never materialized into a list, since the message names no fixture
    individually — the class's own docstring already says what "unplaced" means.
    """
    grouped: list[FixtureState] = []
    knockout: list[FixtureState] = []
    unplaced = 0
    for fixture in fixtures:
        match fixture.stage.draw_type if fixture.stage is not None else None:
            case DrawType.round_robin:
                grouped.append(fixture)
            case DrawType.single_elim:
                knockout.append(fixture)
            case _:
                unplaced += 1
    if unplaced:
        fixture_noun = "fixture" if unplaced == 1 else "fixtures"
        raise MissingStageAssignment(
            f"{unplaced} {fixture_noun} reached RrThenKoStrategy.advance() with a "
            "stage that resolves to neither of this composite's own stages — see "
            "MissingStageAssignment's docstring for the two ways that happens."
        )
    return grouped, knockout


@dataclass(frozen=True, slots=True)
class RrThenKoStrategy:
    """Round-robin groups, then a knockout bracket seeded from the group finishers — the
    top :attr:`qualifiers_per_group` out of each group advance (ADR "rr-then-ko cuts
    both stages upfront and seeds qualifiers rematch-free").

    **Each stage runs the strategy its own draw type names, and this composite's only
    remaining job is the template plus the inter-stage seam** (ADR 20260815 decision
    6). The group stage *is* :class:`RoundRobinStrategy`'s own cut and its own
    readiness (:func:`ready_fixtures` is shared, not re-implemented); the knockout
    stage *is* :class:`SingleElimStrategy`'s own forward seating once it is under way.
    What is left for this class to own is cutting both in one stroke (below) and the
    one thing neither of those strategies can express on its own: seating a finished
    group's qualifiers into the bracket the moment that group decides
    (:func:`_stage_split`, :meth:`_qualifier_fills`).

    **Both stages are cut in one stroke.** ``plan_initial`` emits every group's
    round-robin *and* the full bracket, all of the latter's sides TBD. That is not a
    convenience: :class:`AdvancePlan` can express only :class:`SideFill` — there is
    deliberately no way for an ``advance()`` to *create* a fixture — so a bracket that
    did not exist at the cut could never come into being. It costs nothing, because the
    qualifier count ``P × K`` is known before anybody plays, so the bracket size (the
    smallest power of two ≥ ``P × K``) and *which seeds bye* are determined at cut time.
    Bracket size is **derived, never configured**, so it cannot contradict the qualifier
    count.

    **The group stage is round-robin's, not a copy of it**: ``plan_initial`` calls
    :class:`RoundRobinStrategy` for the group fixtures, so "the groups of an rr-then-ko
    draw are laid out exactly as a round-robin draw's" is true structurally rather than
    by two implementations agreeing. The knockout stage is likewise
    :func:`_knockout_fixtures` — the same bracket shape :class:`SingleElimStrategy`
    cuts — and its ``advance`` reuses :meth:`SingleElimStrategy.advance` verbatim for
    the forward seating once the knockout is under way.

    **Qualifiers are seated per-group, as each group finishes.** The seed → (group,
    place) map (:func:`qualifier_seed_assignment`) depends only on ``P`` and ``K`` —
    never on a result — so group A's qualifiers take their predetermined slots the
    moment *A* is decided, with B and C still playing. A knockout fixture simply is not
    ``ready`` until both its sides are seated, which :func:`ready_fixtures` already
    handles.

    **A group is finished when every one of its fixtures that can still produce a
    result has a score** — the live-outcome view (:attr:`FixtureState.games`), the
    same one the standings are projected from, not the written-back
    ``winner_entry_id`` that no read reads. So a result under correction un-finishes
    its group rather than freezing a stale qualifier list. A **voided** pairing is the
    one exception: it never will produce a result, so it is left out of the
    requirement rather than counted-but-missing, exactly as the standings leave it out
    of a group's ``fixture_count`` (:class:`app.results.GroupInput`). Counting it would
    hold the group one score short forever — never finished, its qualifiers never
    seated, the knockout never ready, and no remedy a director could reach — while the
    table on screen called that same group ``complete``. See
    :func:`_finished_group_order`.

    **A correction that changes who qualified does not re-seat the bracket**,
    knowingly (ADR): a :class:`SideFill` only ever fills an *empty* side, so a group
    match corrected after its qualifiers were seated leaves them in the bracket while
    the standings
    re-order beneath them — the same way single-elim never un-seats a winner. That
    property is also what makes ``advance`` idempotent.
    """

    #: How many entrants qualify out of **each** group. ``K ≥ 1`` is static — a Pydantic
    #: constraint at the request boundary — so a smaller value is a *programmer* error
    #: and is refused in the constructor; the refusals that depend on the entrant count
    #: (which moves) are :class:`DegenerateDraw`\\ s at the cut.
    qualifiers_per_group: int

    def __post_init__(self) -> None:
        if self.qualifiers_per_group < 1:
            raise ValueError(
                "qualifiers_per_group must be at least 1, got "
                f"{self.qualifiers_per_group}."
            )

    def plan_initial(
        self, config: DrawConfig, ordered_entrants: Sequence[OrderedEntrant]
    ) -> list[PlannedFixture]:
        # The snake is run here for the refusals below — it is a pure function of the
        # same inputs, so running it again inside round-robin's own cut deals the
        # identical groups, and the group stage stays *literally* round-robin's rather
        # than a second implementation that has to be kept in step.
        groups = _snake(ordered_entrants, config.group_ids)
        # The snake has already refused a group of fewer than two, so ``smallest`` is at
        # least 2 and the noun below never needs inflecting.
        smallest = min(len(members) for _, members in groups)
        if self.qualifiers_per_group > smallest:
            raise DegenerateDraw(
                f"Taking {self.qualifiers_per_group} qualifiers from each group is "
                f"more than the {smallest} entrants in the smallest group — take "
                "fewer qualifiers from each group, or add entrants."
            )
        if len(groups) * self.qualifiers_per_group < 2:
            # ``K ≥ 1`` is static and the snake guarantees ``P ≥ 1``, so the *only* way
            # to arrive here is one group taking one qualifier: the sentence is fully
            # determined, and interpolating the counts would only add branches no input
            # can reach.
            raise DegenerateDraw(
                "Taking 1 qualifier from a single group leaves one player in the "
                "knockout stage, who would have nobody to play — take more qualifiers "
                "from each group, or configure more groups."
            )
        qualifier_count = len(groups) * self.qualifiers_per_group
        fixtures = RoundRobinStrategy().plan_initial(config, ordered_entrants)
        # Cut in the same stroke: every side TBD (nobody has qualified), rounds from 1,
        # and **no group** — the composite passes none and takes the parameter's
        # default. Its knockout stage has no groups to name until #1484 materialises
        # them, and handing it the group stage's group (which is what
        # ``_sole_group(config)`` would answer here) would deal the bracket into the
        # round-robin half the qualifiers are picked from.
        fixtures.extend(
            _knockout_fixtures(
                qualifier_count,
                {},
                stage=FixtureStage(position=1, draw_type=DrawType.single_elim),
            )
        )
        return fixtures

    def advance(
        self,
        fixtures: Sequence[FixtureState],
        ordered_entrants: Sequence[OrderedEntrant],
    ) -> AdvancePlan:
        """Seat the qualifiers of every **finished** group into their predetermined
        bracket slots, then seat the knockout's own decided winners forward.

        Idempotent, twice over: a qualifier is seated only into a still-empty side,
        and the knockout half is :meth:`SingleElimStrategy.advance`, which already is.
        Run it against a state its own last plan was applied to and it plans nothing.

        ``ordered_entrants`` is ignored for both halves, for the two reasons the halves
        give themselves: the groups seat their whole field, and the bracket is seeded
        from *results*, never from the field directly.
        """
        grouped, knockout = _stage_split(fixtures)
        return AdvancePlan(
            side_fills=(
                *self._qualifier_fills(fixtures, grouped, knockout),
                # The knockout stage, once it is under way, advances exactly as a
                # single-elim bracket does — so it is advanced *by* single-elim, over
                # the un-grouped fixtures alone. Passing the group fixtures too would
                # let a group's ``(round, position)`` collide with the bracket's and
                # seat a group winner into a knockout slot.
                *SingleElimStrategy().advance(knockout, ordered_entrants).side_fills,
            ),
            ready_fixture_ids=ready_fixtures(fixtures),
        )

    def _qualifier_fills(
        self,
        fixtures: Sequence[FixtureState],
        grouped: Sequence[FixtureState],
        knockout: Sequence[FixtureState],
    ) -> list[SideFill]:
        """The qualifiers of every finished group, seated into their bracket slots.

        ``grouped`` and ``knockout`` are :func:`_stage_split`'s own halves of
        ``fixtures``, computed once by :meth:`advance` and handed down rather than
        re-split here — the guard :func:`_stage_split` raises has already run by the
        time this is called.
        """
        _refuse_gameless_group_results(grouped, fixtures)
        # The groups, in the DIRECTOR's own order (ADR 20260815 decision 7's rider):
        # each group's own ``group_position`` (ADR 20260801), never
        # ``sorted(group_ids)``. The two used to be conflated — a group's uuid has no
        # relationship to its position, so "group index 0" silently named a different
        # physical group from the one the director's own group listing and the snake
        # both call the first group. Which group is index 0 is still free to *choose*
        # (within a finishing place groups are not ranked against each other, and
        # relabelling them is a bijection, so the rematch-free guarantee holds under any
        # labelling) — this only pins *which* choice, so "group A" means the same group
        # everywhere. A group whose position was not resolved (a caller that skipped
        # that plumbing) sorts after every resolved one, by id —
        # :func:`_group_sort_key`, the same fallback
        # :func:`ready_fixtures` uses, so an under-wired caller degrades to the old
        # order rather than crashes and "group A" cannot drift between the two sorts.
        #
        # A dict comprehension is LAST-wins where the old hand-rolled loop was
        # first-wins; the two are equivalent only because every fixture of one group
        # carries that group's SAME ``group_position`` (it is a fact of the group, not
        # of the fixture it happens to be read off), so which of a group's many fixtures
        # "wins" the comprehension never changes the value it contributes.
        group_position_by_id: dict[GroupId, int | None] = {
            fixture.group_id: fixture.group_position
            for fixture in grouped
            if fixture.group_id is not None
        }
        group_ids = sorted(
            group_position_by_id,
            key=lambda group_id: _group_sort_key(
                group_id, group_position_by_id[group_id]
            ),
        )
        if not group_ids:
            return []
        seed_by_seat = {
            seat: seed
            for seed, seat in qualifier_seed_assignment(
                len(group_ids), self.qualifiers_per_group
            ).items()
        }
        seats = _knockout_seats(len(group_ids) * self.qualifiers_per_group)
        by_slot = {(fixture.round, fixture.position): fixture for fixture in knockout}

        fills: list[SideFill] = []
        for group_index, group_id in enumerate(group_ids):
            order = _finished_group_order(
                [fixture for fixture in grouped if fixture.group_id == group_id]
            )
            if order is None:
                continue  # still playing (or a result in flux) — nothing to seat yet
            for place, tally in enumerate(order[: self.qualifiers_per_group], start=1):
                seed = seed_by_seat[QualifierSeat(group_index=group_index, place=place)]
                round_number, position, side = seats[seed]
                slot = by_slot.get((round_number, position))
                if slot is None:
                    raise MissingBracketSlot(
                        f"Seed {seed} (place {place} in group {group_id!r}) qualifies "
                        f"into knockout slot (round {round_number}, position "
                        f"{position}), which this draw has no fixture for: the bracket "
                        f"standing here holds {len(by_slot)} fixtures and was cut for "
                        "a different number of qualifiers than the "
                        f"{len(group_ids) * self.qualifiers_per_group} "
                        f"({len(group_ids)} groups × {self.qualifiers_per_group}) this "
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


def _max_rematch_free_rounds(size: int) -> int:
    """How many rounds a field of ``size`` can play with nobody meeting twice.

    **The answer depends on the parity, and an earlier version of this rule did not.**
    An even field of ``n`` plays ``n - 1`` rounds: everybody plays every round, so the
    ceiling really is the number of distinct opponents one entrant has. An odd field
    plays ``n``, because each round byes exactly one entrant — over ``n`` rounds every
    entrant plays ``n - 1`` matches and sits out once, meeting all ``n - 1`` opponents
    with no rematch. Refusing an odd field's ``n``-th round refused a legal swiss.

    ``n - 1 + (n % 2)`` is the same statement in one expression, and is the round-robin
    circle method's round count: pair the odd field with a ghost bye and it is an even
    field of ``n + 1``, whose ``n`` rounds each sit one real entrant out.
    """
    return size - 1 + size % 2


@dataclass(frozen=True, slots=True)
class SwissStrategy:
    """Swiss: a fixed number of rounds, nobody eliminated, each round paired by the
    standings the round before it produced (ADR "swiss pre-cuts every round and pairs
    each one on advance").

    **Every round is cut up front**, all ``R`` of them: ``R × ⌊n/2⌋`` fixtures. Round 1
    carries both sides, seeded from the draw order; every later round is written with
    both sides ``None``. That is not a workaround for :class:`AdvancePlan` being unable
    to create a fixture — it is what makes swiss expressible without changing the
    contract at all. The *number* of fixtures follows from the field size at the cut and
    ``R``, an explicit setting; only the *sides* are unknown, and a ``None`` side means
    exactly "TBD, ``advance()`` will fill it" — the state single-elim's later rounds
    have always been in.

    **The field is not frozen at the cut**, and an earlier version of this docstring
    said it was. Cutting has no status gate, so a draw is cut while the tournament is
    still ``published`` and registration is still open; the field can move between the
    cut and go-live. That is what makes the draw **stale** and what
    :func:`unseated_entrant_allowance` exists to reason about. It does not weaken the
    argument above: the fixture count follows from the field the cut actually saw, and a
    field that moves under it is caught at go-live rather than silently tolerated.

    **Round 1 is top half against bottom half**: with ``m = 2⌊n/2⌋`` playing entrants,
    draw-order position ``i`` meets position ``i + m/2``, so the top seed meets the best
    of the bottom half. An odd field byes the **lowest**-ranked entrant, who simply has
    no fixture — a bye is the absence of a row (ADR-0786), never a row with a ``NULL``
    side, which here would be indistinguishable from a later round awaiting its pairing.

    **Every later round is paired by :meth:`advance`**, once the round before it is
    fully decided: the field is ordered by the current standings, walked, and each
    still-unpaired entrant given the nearest following entrant they have not already met
    (:func:`swiss_pairings`). The pairings are written into that round's
    already-existing rows in rank order, so a fixture's ``position`` *is* its pairing
    rank.

    Fixtures are dealt into the event's **one group** (#1483), which is what confines
    the rounds to the reservation their director booked — but swiss is still not a
    group *stage*: it ranks the whole field in one table, and every surface that
    renders or labels a group asks :func:`seats_both_sides_at_cut` about the stage's
    draw type rather than reading the group id. The schedule **preview** still
    refuses a swiss event exactly as it refuses a bracket, for the reason
    :mod:`app.schedule_preview` states in full.
    """

    #: How many rounds the event plays. ``R >= 1`` is static — a Pydantic constraint at
    #: the request boundary — so a smaller value is a *programmer* error and is refused
    #: in the constructor; the refusal that depends on the entrant count
    #: (``R <= n - 1 + n % 2``, see :func:`_max_rematch_free_rounds`, which moves as the
    #: field does) is a :class:`DegenerateDraw` at the cut.
    rounds: int

    def __post_init__(self) -> None:
        if self.rounds < 1:
            raise ValueError(f"rounds must be at least 1, got {self.rounds}.")

    def plan_initial(
        self, config: DrawConfig, ordered_entrants: Sequence[OrderedEntrant]
    ) -> list[PlannedFixture]:
        entrants = list(ordered_entrants)
        size = len(entrants)
        if size < 2:
            raise DegenerateDraw(
                "A Swiss draw needs at least 2 entrants — a smaller field has nobody "
                "to play."
            )
        if self.rounds > _max_rematch_free_rounds(size):
            # The ceiling is the number of rounds the field can play without a rematch,
            # and it is NOT simply the ``n - 1`` distinct opponents an entrant has: an
            # odd field byes one entrant per round, so over ``n`` rounds everybody plays
            # ``n - 1`` matches and sits out once. Refused at the CUT and not at
            # configure time, because ``n`` is not known when the setting is written —
            # the same split every entrant-count-dependent refusal in this module uses.
            maximum = _max_rematch_free_rounds(size)
            round_noun = "round" if self.rounds == 1 else "rounds"
            maximum_noun = "round" if maximum == 1 else "rounds"
            raise DegenerateDraw(
                f"{self.rounds} {round_noun} is more than the {maximum} "
                f"{maximum_noun} a field of {size} entrants can play without a "
                "rematch — play fewer rounds, or add entrants."
            )
        # The odd entrant out sits the round; ``m`` is the field that actually plays, so
        # every round holds ⌊n/2⌋ fixtures whatever the parity.
        pairs_per_round = size // 2
        # Every fixture of a swiss draw belongs to its event's sole stage, and is
        # dealt into that stage's sole group (#1483) — which is what confines the
        # rounds to the reservation the director booked. The stage's own draw type
        # is what keeps a surface from calling that group a group stage
        # (:func:`seats_both_sides_at_cut`): swiss ranks the whole field in one
        # table, and rounds past the first are unpaired until ``advance``.
        stage = FixtureStage(position=0, draw_type=DrawType.swiss)
        group_id = _sole_group(config)
        fixtures = [
            PlannedFixture(
                stage=stage,
                group_id=group_id,
                round=1,
                position=position,
                # Top half against bottom half, in draw order. ``entrants`` is
                # 1-based by ``position`` but indexed 0-based here, so the pairing is
                # index ``i`` against index ``i + pairs_per_round``.
                entry_a_id=entrants[position - 1].entry_id,
                entry_b_id=entrants[position - 1 + pairs_per_round].entry_id,
            )
            for position in range(1, pairs_per_round + 1)
        ]
        # Every later round, whole, with both sides TBD. ``position`` becomes the
        # pairing's rank in the standings when the round is paired; until then it is
        # only the row's identity within its round.
        fixtures.extend(
            PlannedFixture(
                stage=stage, group_id=group_id, round=round_number, position=position
            )
            for round_number in range(2, self.rounds + 1)
            for position in range(1, pairs_per_round + 1)
        )
        return fixtures

    def advance(
        self,
        fixtures: Sequence[FixtureState],
        ordered_entrants: Sequence[OrderedEntrant],
    ) -> AdvancePlan:
        """Pair the next round, if the round before it is decided, and report which
        fixtures are ready to become matches.

        On a freshly cut draw there is nothing to pair — round 1 is seeded and undecided
        — so this is round 1's fixtures and nothing else: the later rounds are
        ``is_pending`` (both sides unknown) and :func:`ready_fixtures` leaves those out.
        Once every round-1 fixture carries a result, the same call pairs round 2 into
        the rows the cut already wrote (:func:`_swiss_pairing_fills`).

        **The field comes from** ``ordered_entrants``, **never from the seated set.** A
        bye is the absence of a row, so the round-1 bye holder appears in no fixture at
        all; pairing from the fixtures would drop them out of the event from round 2 on.
        The same is true of a latecomer, for whom the draw is *not* stale
        (:func:`unseated_entrant_allowance`) precisely because a later round will seat
        them.

        Idempotent, and by a stronger mechanism than "do not overwrite": a round is
        pairable only while **every** one of its fixtures is still unpaired, so a fill
        this plans can only ever land on a ``NULL`` side. Run it again over the state
        its own fills were applied to and that round no longer qualifies — which is also
        what stops a *corrected* earlier result from re-pairing a round that is already
        being played. (The just-paired round is then genuinely ``ready``, so the second
        plan names it; the third, once those rows carry matches, is empty.)

        ``ready_fixture_ids`` is computed over the state as handed in, exactly as every
        other strategy computes it — the caller applies the fills and recomputes
        readiness itself (:func:`app.tournament_materialization.materialize_event`), so
        a round paired here still materializes in the same transaction.
        """
        return AdvancePlan(
            side_fills=tuple(_swiss_pairing_fills(fixtures, ordered_entrants)),
            ready_fixture_ids=ready_fixtures(fixtures),
        )


def swiss_pairings(
    order: Sequence[EntryId], met: Collection[frozenset[EntryId]]
) -> list[tuple[EntryId, EntryId]]:
    """Pair a swiss round: walk the standings ``order`` and give each still-unpaired
    entrant the **nearest following entrant they have not already met** (ADR "swiss
    pre-cuts every round and pairs each one on advance").

    Returns the pairings in **rank order** — pairing 1 contains the highest-ranked
    entrant — which is what a fixture's ``position`` is assigned from, and each pairing
    ``(higher, lower)`` in that same order.

    **A rematch is the last resort and never a refusal.** When an entrant has met
    everybody left below them, they are paired with the nearest one they *have* met: the
    ``next(...)`` below falls back to index ``0``, the nearest following entrant, full
    stop. Refusing to pair would strand a live tournament mid-event with no move a
    director could make, which is far worse than a repeated fixture. (The cut already
    refuses ``R > n − 1``, so a rematch-free swiss *exists* for every draw that was
    written; this greedy walk does not always find one, and knowingly does not try — a
    maximum matching over "has not met" would pair strangers further apart in the
    standings, which is a worse swiss than one repeat.)

    An **odd** ``order`` leaves its last entrant unpaired rather than raising: the
    caller removes the bye before calling, and this stays a total function so a miscount
    can only cost a fixture, not a 500 in the middle of an event.

    Pure, and takes only what the rule needs — an order and a set of pairs — so the rule
    is testable without a fixture, a draw or a database, which is how the last-resort
    branch is pinned directly rather than through a contrived tournament.
    """
    remaining = list(order)
    pairs: list[tuple[EntryId, EntryId]] = []
    while len(remaining) >= 2:
        first = remaining.pop(0)
        index = next(
            (
                index
                for index, other in enumerate(remaining)
                if frozenset({first, other}) not in met
            ),
            # The last resort: nobody below is fresh, so take the nearest all the same.
            0,
        )
        pairs.append((first, remaining.pop(index)))
    return pairs


def swiss_byes(
    field: Iterable[EntryId], pairings: Iterable[SeatedPairing]
) -> tuple[EntryId, ...]:
    """Every bye this draw has handed out: one entry id **per bye taken**, so an entrant
    who has sat out twice appears twice.

    A bye is the absence of a fixture row (CONTEXT.md, "Bye"), never a row with a
    ``NULL`` side and never a stored flag — so it is *derived*, here, by asking who is
    missing from a round that was paired. Nothing else can answer it: the rows are the
    only record there is, and the absence of one is the record of a bye.

    **The field comes from the event's entrants**, not from the entries the fixtures
    seat, for the reason that runs through the whole format: the byed entrant is by
    definition in no row that round, and a swiss draw cut for eight that a ninth player
    joined is seated nowhere at all. Derive the field from the rows and the very
    entrants this function exists to find would be the ones it could not see.

    A round with no seated pairing is **not** a round everybody was byed in — it is a
    round nobody has been paired into yet, which is the ordinary state of every later
    round of a freshly cut draw. Only rounds present in ``pairings`` are counted, which
    is why the input is pairings rather than a round count.

    **A bye is scored with its round**, so a round counts only once every pairing in it
    is :attr:`~SeatedPairing.decided`. The alternative — crediting it the moment the
    round is *paired* — puts a win on the table for a round nobody has played: a
    seven-player draw would be cut and immediately show its byed entrant top of the
    standings, ahead of six players who have not been given the chance to hit a ball.
    Gating on the round makes the bye land at the same moment every real result in that
    round does. It costs the pairing nothing, because a round is paired only after the
    round before it is decided.

    One definition, two layers (see :class:`SeatedPairing`): the draw layer picks the
    next bye by preferring an entrant with none of these, and the results layer scores
    each one as a win worth zero games.

    Grouped by **round, in round order** — the one ordering that is read, since a round
    is what a bye is scored with. Within a round the ids arrive in whatever order the
    caller's ``field`` iterates, and that is deliberate: every consumer takes the
    *multiset* and nothing else (``Counter(...)`` for the selection rule,
    ``for entry_id in byes`` for the scoring), so sorting the field here would be an
    ``O(n log n)`` pass per call buying a total order nobody asks for.
    """
    seated: dict[int, set[EntryId]] = defaultdict(set)
    undecided: set[int] = set()
    for pairing in pairings:
        seated[pairing.round].update({pairing.entry_a_id, pairing.entry_b_id})
        if not pairing.decided:
            undecided.add(pairing.round)
    # Materialized, because ``field`` is an ``Iterable`` and the comprehension below
    # walks it once **per decided round**: a generator would yield the first round's
    # byes and then silently nothing.
    entrants = list(field)
    return tuple(
        entry_id
        for round_number in sorted(seated)
        if round_number not in undecided
        for entry_id in entrants
        if entry_id not in seated[round_number]
    )


def swiss_pairable_rows(row_count: int, seated_count: int, field_size: int) -> int:
    """How many of one swiss round's pre-cut rows can ever carry a pairing.

    The cut writes ``⌊n/2⌋`` rows a round from the field it saw, and **the field moves
    under that number in both directions**. The rule that survives both is: a round's
    *capacity* is ``⌊(current field)/2⌋``, capped by the rows that exist and floored by
    the rows already seated.

    - ``min(row_count, …)`` is the **grown** field. A draw cut for eight that a ninth
      joined has one pairing more than there are rows for, and the lowest-ranked
      pairing is simply not written — the same outcome that entrant would have had as
      the round's bye. Without the cap a fully-written round would read as still having
      room, and would be re-paired over rows that are already being played.
    - ``max(seated_count, …)`` is the **shrunk** field, one round late. A round paired
      when the field was eight holds four real pairings; if somebody then leaves, those
      four are still four fixtures that will produce four results, whatever ``⌊7/2⌋``
      says. Only rows that were never seated are lost to a shrink.

    What is left over — ``row_count`` minus this — is **permanently unpairable**: rows
    the cut wrote for a field that no longer exists. They are not pending. Three
    readings depend on saying so once, here, rather than three times:

    - a round with this many rows filled is fully paired, so the walk moves past it
      instead of stalling on a round that is neither wholly unpaired nor decided
      (:func:`_swiss_round_to_pair`);
    - a round is decided when every row that *could* be filled is
      (:func:`_swiss_round_is_decided`), so a dead row does not hold its round — and the
      bye scored against it — open forever;
    - the event's fixture count is this, not the row count
      (:func:`app.tournament_serialization._field_input`), so a shrunk field can still
      read ``complete``.

    ``field_size`` is the **active** field in both layers, which is the same field
    :func:`swiss_byes` is derived over. A shrunk field that shrank the capacity but not
    the byes would credit a departed entrant with a bye per round.
    """
    return max(seated_count, min(row_count, field_size // 2))


def _swiss_pairing_fills(
    fixtures: Sequence[FixtureState], ordered_entrants: Sequence[OrderedEntrant]
) -> list[SideFill]:
    """The side-fills that pair the next swiss round, or nothing when no round is
    pairable yet.

    The four steps are the ADR's own sentence: find the round to pair, order the field
    by the current standings, take the bye out of an odd field, and walk the rest.
    """
    field = [entrant.entry_id for entrant in ordered_entrants]
    round_fixtures = _swiss_round_to_pair(fixtures, len(field))
    if round_fixtures is None:
        return []
    # Projected once and handed to both readers, so "who has played whom" and "who has
    # sat out" are two questions asked of one set of pairings.
    pairings = _swiss_seated_pairings(fixtures)
    # Derived once, here, and handed to both the scoring and the selection below. Two
    # calls would be two chances to disagree — and the shape of that disagreement is an
    # entrant sitting out twice while the table says they never did.
    byes = swiss_byes(field, pairings)
    order = _swiss_standings_order(field, fixtures, byes)
    bye = _swiss_bye(order, byes)
    pairs = swiss_pairings(
        [entry_id for entry_id in order if entry_id != bye], _swiss_met(pairings)
    )
    fills: list[SideFill] = []
    # ``position`` is the pairing's rank (ADR), so the round's rows are filled in
    # position order with the pairings in standings order. ``strict=False`` because the
    # two can legitimately differ in length, in **either** direction
    # (:func:`swiss_pairable_rows`). A field that grew by one after the cut has a
    # pairing more than there are rows for, and its lowest-ranked pairing simply is not
    # written — the same outcome the entrant would have had as that round's bye. (A
    # field that grew by *more* than one is a stale draw, which go-live refuses —
    # :func:`unseated_entrant_allowance` — before this is ever reached.) A field that
    # SHRANK has fewer pairings than rows, and the surplus rows stay ``NULL`` for good:
    # the round is fully paired all the same, which is what stops the walk stalling on
    # it forever.
    for (higher, lower), fixture in zip(
        pairs, sorted(round_fixtures, key=lambda f: f.position), strict=False
    ):
        fills.append(
            SideFill(fixture_id=fixture.fixture_id, side=Side.a, entry_id=higher)
        )
        fills.append(
            SideFill(fixture_id=fixture.fixture_id, side=Side.b, entry_id=lower)
        )
    return fills


def _swiss_round_to_pair(
    fixtures: Sequence[FixtureState], field_size: int
) -> list[FixtureState] | None:
    """The fixtures of the round this advance may pair — the **earliest wholly unpaired
    round, and only if every round before it is decided** — or ``None``.

    Walking from round 1 is what enforces "a round is paired once the round before it is
    fully decided": the first round that is not decided ends the walk, and it is paired
    only if it is the one that has not been paired yet.

    **Wholly unpaired**, not "has an empty side", on purpose. A half-paired round is a
    state neither the cut (which writes both sides or neither) nor this function (whose
    fills are applied in one transaction) can produce, and pairing "around" the seated
    half would need a rule for who the already-seated player's opponent is — inventing
    one risks seating an entrant in two fixtures of the same round. So a half-paired
    round stalls the walk instead, visibly, rather than being papered over.

    **A round is over when it is full, and full is not the row count.** An earlier
    version asked whether every row was seated, which is the same question only while
    the field is the one the cut saw. A field that **shrinks** afterwards — the account
    merge withdraws a guest whose entry seats played fixtures, and that is not
    window-gated — leaves ``⌊n/2⌋`` pairings for a round of more rows than that, so the
    surplus rows stay ``NULL`` for good. Read as "not yet fully seated" they made the
    round neither wholly unpaired nor decided, which returned ``None`` here on that call
    and on every call after: rounds ``r+1…R`` were never paired, and a played draw
    cannot be un-cut. One withdrawal deadlocked an eight-entrant, four-round event.
    :func:`swiss_pairable_rows` is the count that is actually full, and it holds for a
    field that grew too.

    It is still what makes the whole advance idempotent: once a round's pairable rows
    are filled it is no longer wholly unpaired, so no later run re-pairs it — which is
    the same mechanism that keeps a correction to an earlier result from re-pairing a
    round that is already being played.
    """
    by_round: dict[int, list[FixtureState]] = defaultdict(list)
    for fixture in fixtures:
        by_round[fixture.round].append(fixture)
    for round_number in sorted(by_round):
        round_fixtures = by_round[round_number]
        seated = [fixture for fixture in round_fixtures if not fixture.is_pending]
        pairable = swiss_pairable_rows(len(round_fixtures), len(seated), field_size)
        # Wholly unpaired — every row's BOTH sides empty, which is stricter than "none
        # is seated" and deliberately so: a row with one side filled is a state nothing
        # can produce, and pairing around it could seat somebody twice in one round.
        # ``pairable > 0`` excludes a field of one (or none), which has nobody to play:
        # not a round to pair, and not a round to stall on either.
        if pairable > 0 and all(
            fixture.entry_a_id is None and fixture.entry_b_id is None
            for fixture in round_fixtures
        ):
            return round_fixtures
        if not _swiss_round_is_decided(seated, pairable):
            return None
    return None


def _swiss_round_is_decided(seated: Sequence[FixtureState], pairable: int) -> bool:
    """Whether every row of one round that could **ever** carry a pairing has produced
    all the result it ever will.

    Takes the round's *seated* fixtures and how many rows it can fill
    (:func:`swiss_pairable_rows`), rather than the round's rows, because those are the
    two facts the answer is made of and the caller has already derived both.

    Per fixture that is :attr:`FixtureState.is_decided` — the shared spelling, which is
    also what :attr:`SeatedPairing.decided` carries, so "this round is over" is one
    answer whether it is being asked in order to pair the next round or in order to
    score a bye. Read that property for why it is the **live-outcome** view
    (:attr:`FixtureState.games`) and why a **voided** fixture counts as decided.

    The extra half — that the round has no row left to seat — stays here rather than on
    the property. It is a question about a *round* being playable at all, not about one
    fixture's result, and a round still owing a pairing has not been played whatever
    its other rows say. What it is **not** is "no row is still ``NULL``": a round whose
    field shrank under it keeps rows that can never be seated, and holding the round
    open for them would hold the bye scored against it open too, and the event with it.
    """
    return len(seated) >= pairable and all(fixture.is_decided for fixture in seated)


def _swiss_standings_order(
    field: Sequence[EntryId],
    fixtures: Sequence[FixtureState],
    byes: Sequence[EntryId],
) -> list[EntryId]:
    """The field ordered by the current standings — the order the next round is paired
    down.

    **Byes are scored here too**, as a win worth zero games, by the same
    :func:`swiss_finishing_order` the table on screen is built by (ADR "swiss standings
    add Buchholz"). Leaving them out would rank a byed entrant below everybody who
    played while the director's table ranked them above — the two layers disagreeing
    about the standings, which is precisely what one shared chain exists to prevent.

    ``byes`` arrives already derived (:func:`swiss_byes`, called once by
    :func:`_swiss_pairing_fills`) rather than being derived here, so that this and
    :func:`_swiss_bye` read one value instead of two derivations of it.

    :func:`~app.group_finishing_order.swiss_finishing_order` is the *shared* definition
    of that table — wins, guarded head-to-head, **Buchholz**, game difference, games
    won, entry id — and the same call the standings on screen are projected through, so
    the order a director reads and the order the pairing walks cannot disagree. It is
    the swiss chain and not the group one: pairing down a table ordered by margin rather
    than by strength of schedule would seat the next round off an order nobody is
    looking at.

    An outcome naming an entry that is not in the field is left out: a withdrawal
    between the cut and this advance would otherwise be a ``KeyError`` deep inside the
    tally. Filtering the *outcomes* rather than widening the tallied set is deliberate —
    a stranger in the tallies would turn a two-way tie into a three-way one and silently
    cost the pair its head-to-head.
    """
    in_field = set(field)
    outcomes: list[MatchOutcome] = []
    for fixture in fixtures:
        entry_a_id, entry_b_id, games = (
            fixture.entry_a_id,
            fixture.entry_b_id,
            fixture.games,
        )
        if entry_a_id is None or entry_b_id is None or games is None:
            continue
        if fixture.match_voided:
            continue
        if entry_a_id not in in_field or entry_b_id not in in_field:
            continue
        outcomes.append(
            MatchOutcome(
                entry_a_id=entry_a_id,
                entry_b_id=entry_b_id,
                entry_a_games=games.entry_a_games,
                entry_b_games=games.entry_b_games,
            )
        )
    return [
        standing.tally.entry_id
        for standing in swiss_finishing_order(field, outcomes, byes)
    ]


def _swiss_bye(order: Sequence[EntryId], byes: Sequence[EntryId]) -> EntryId | None:
    """Who sits out this round: the **lowest-ranked entrant who has not had a bye yet**,
    or ``None`` when the field is even.

    Selection and scoring read the same **value**, not two derivations of it:
    :func:`_swiss_pairing_fills` calls :func:`swiss_byes` once and hands the one tuple
    to this and to :func:`_swiss_standings_order`. So the entrant this passes over for
    having had one is exactly the entrant the standings credited with a win for it, by
    construction — where two calls would agree only as long as nobody changed what
    :func:`swiss_byes` returns for one caller's argument shape. The shape of that
    disagreement is somebody sitting out twice while the table says they never did.

    (Within *this* layer, that is. The results layer derives its own byes from its own
    row shape, because the two hold different rows — see :class:`SeatedPairing` — and
    that the two spellings of "decided" underneath them still agree is pinned by a
    test, not by a shared call.)

    The fallback for a field in which everybody has had one takes the lowest-ranked
    entrant overall — a second bye, which is worse than the rule but is a bye somebody
    has to take.

    **It runs**, and an earlier version of this docstring argued it could not: it read
    the ceiling as ``R ≤ n − 1``, so byes taken (``r − 1`` when pairing round ``r``)
    could never reach ``n``. The ceiling is ``R ≤ n − 1 + n % 2``
    (:func:`_max_rematch_free_rounds`) — an odd field legally plays ``R = n`` — and,
    more to the point, ``n`` is the field **at the cut**. A field that shrinks
    afterwards (the account merge withdraws a guest whose entry seats played fixtures)
    can hand out a bye to every remaining entrant and still owe rounds: six cut for five
    rounds, then three left, and by round 5 all three have sat out
    (``test_a_shrunk_field_runs_out_of_byeless_entrants``). The *conclusion* of the old
    argument still holds for a field that only grows, which is why the branch was never
    reached before.
    """
    if len(order) % 2 == 0:
        return None
    taken = Counter(byes)
    for entry_id in reversed(order):
        if not taken[entry_id]:
            return entry_id
    return order[-1]


def _swiss_met(pairings: Iterable[SeatedPairing]) -> set[frozenset[EntryId]]:
    """Every pair this draw has already put in a fixture together.

    Read off the *pairings*, not the results: a voided match and a result still being
    corrected are both pairings that happened, and pairing them again would be the
    rematch the walk exists to avoid.
    """
    return {frozenset({pairing.entry_a_id, pairing.entry_b_id}) for pairing in pairings}


def _swiss_seated_pairings(
    fixtures: Sequence[FixtureState],
) -> list[SeatedPairing]:
    """This draw's fixtures that seat **both** sides, as the shape the bye and rematch
    derivations read. A fixture with an empty side is a round waiting to be paired, not
    a pairing.

    ``decided`` is :attr:`FixtureState.is_decided` itself — a live score, or a void that
    means there will never be one — which is the same property
    :func:`_swiss_round_is_decided` asks, so "this round is over" is one answer here,
    whether it is being asked in order to pair the next round or in order to score a
    bye."""
    return [
        SeatedPairing(
            round=fixture.round,
            entry_a_id=fixture.entry_a_id,
            entry_b_id=fixture.entry_b_id,
            decided=fixture.is_decided,
        )
        for fixture in fixtures
        if fixture.entry_a_id is not None and fixture.entry_b_id is not None
    ]


def _finished_group_order(
    group_fixtures: Sequence[FixtureState],
) -> list[EntryTally] | None:
    """This group's finishing order, or ``None`` if the group is **not finished**.

    Finished = every fixture in it that can still produce a result carries a score. The
    order itself is :func:`~app.group_finishing_order.finishing_order` — *the*
    definition of how a group finished, the same call
    :class:`~app.results.RoundRobinResults` makes for the standings table — so the
    qualifiers are exactly the top of the table a director is reading, structurally and
    not by coincidence.

    Which is why a **voided** fixture is skipped rather than treated as a missing score:
    it can never produce one (the match is terminal, and ``ready_fixtures`` will not
    re-materialize a fixture that has a ``match_id``), and the standings already exclude
    it from the ``fixture_count`` they call a group ``complete`` against
    (:class:`app.results.GroupInput`). Requiring its score here would leave the group
    permanently un-finished and its qualifiers permanently unseated while the table on
    screen said the group was over — the two layers disagreeing about the one fact this
    function exists to share. Its **entrants** still count: they are seated in the group
    and appear in the standings, so a player whose only pairing was voided is in the
    order with a row of zeros, exactly as the table shows them.

    A group with **no** usable outcome at all — every fixture voided — is ``None``, not
    an order. The only thing left to rank on would be the entry-id fallback at the end
    of the tiebreak chain, so "the qualifiers" would be arbitrary. This is the one
    place the two layers part company on purpose: the standings call such a group
    ``complete`` (0 outcomes of 0 countable fixtures) and show a table of zeros, which
    is honest to look at, and seating qualifiers off it would not be. It takes every
    pairing in a group being voided to reach, and voiding has exactly one producer today
    (an account merge's self-play collision, ADR-0013), so it is a shape to refuse
    rather than to serve.
    """
    entrants: dict[EntryId, None] = {}
    outcomes: list[MatchOutcome] = []
    for fixture in group_fixtures:
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


def _refuse_gameless_group_results(
    grouped: Sequence[FixtureState], fixtures: Sequence[FixtureState]
) -> None:
    """Raise :class:`MissingFixtureGames` when group fixtures are decided and the whole
    input carries no game counts — see that class for why this is loud rather than
    tolerated.

    A **voided** fixture is not evidence of the wiring bug and is excluded. Voiding
    does not clear the ``winner_entry_id`` a completion wrote back, but it does take
    the match out of ``completed``, so its games go away: "decided, and no games" is
    that fixture's ordinary settled state, not a projection that forgot to load them.
    Counting it would turn a single voided pairing in a draw nobody has scored yet into
    a 500. What the guard still catches is unchanged, because it needs a decided fixture
    that *should* carry games: project a played-out group without its counts and every
    one of its scored fixtures lands in this list.
    """
    gameless = [
        fixture
        for fixture in grouped
        if fixture.winner_entry_id is not None
        and fixture.games is None
        and not fixture.match_voided
    ]
    if not gameless or any(fixture.games is not None for fixture in fixtures):
        return
    fixture_noun = "fixture" if len(gameless) == 1 else "fixtures"
    raise MissingFixtureGames(
        f"{len(gameless)} decided group {fixture_noun} reached advance() with no game "
        "counts, and no fixture in this draw carries any — the caller projected the "
        "fixtures without loading their completed matches' games. Qualifiers are the "
        "top of the same standings the tiebreak chain produces (wins, head-to-head, "
        "game difference, games won), so ordering a group without games would pick "
        "different qualifiers from the table on screen."
    )


def _group_sort_key(
    group_id: GroupId | None, group_position: int | None
) -> tuple[bool, int, str]:
    """The group-ordering fragment shared by every sort that groups fixtures by group:
    the event's own group order (``group_position``) first — with an unresolved position
    sorting after every resolved one, never colliding with a real ``0`` — then the id,
    as a comparable ``str``, the tie-break that keeps the whole key **total** when the
    positions cannot decide it. A ``uuid`` is not comparable with the ``""`` an
    un-grouped entry collapses to, so this is spelled as a ``str`` rather than left to
    ``or``.

    Shared by :func:`ready_fixtures` and :meth:`RrThenKoStrategy._qualifier_fills` so
    "group A" cannot mean two different physical groups between the two sorts that group
    fixtures by it — a hand-rolled second copy of this fragment is exactly the drift
    this module's docstrings elsewhere warn a heuristic invites.
    """
    return (
        group_position is None,
        group_position or 0,
        "" if group_id is None else str(group_id),
    )


def ready_fixtures(fixtures: Sequence[FixtureState]) -> tuple[FixtureId, ...]:
    """The fixtures that should now become matches: **both sides known**, no match yet,
    not already decided.

    Shared by every strategy, because "ready" is a property of the fixture, not of the
    draw type. Excluding the already-materialized is what makes an ``advance()`` plan
    idempotent; excluding the decided keeps a fixture whose match was later unlinked
    (``match_id`` is ``ON DELETE SET NULL``) from rising from the dead and being played
    twice. Ordered by ``(stage/group, round, position)`` so the plan itself is
    deterministic.

    **"Group" is the group's** :attr:`~FixtureState.group_position` — its place in the
    event's own group order — **not its id.** It was the id once, back when ids were
    client-minted strings (``p-1-…``, ``p-2-…``, ``p-10-…``) whose lexicographic order
    was not the director's: ``p-10-`` sorts between ``p-1-`` and ``p-2-``, so a
    ten-group draw's plan ran group 1, group 10, group 2. A minted uuid is worse still —
    its order is nobody's at all — which is exactly why the explicit ``position`` column
    had to land (ADR 20260801) before the ids could move. It is the same key the read
    path's ``fixtures_by_event`` sorts on and the same one :attr:`DrawConfig.group_ids`
    is ordered by, so the sequence a director sees, the sequence the snake dealt
    against, and the sequence matches are created in are one order rather than three
    that agree by luck.

    The sort key asks three questions, in this order:

    1. "Which of the event's own stages is it in — or, failing that, is it grouped?" —
       :attr:`~FixtureState.stage`'s ``position`` where a caller resolved it (only
       ``rr-then-ko``'s ``advance()`` ever asks for the plumbing that fills it),
       falling back to ``group_id is None`` where it did not (every other draw type, and
       an under-wired caller). Either way this sorts the knockout stage LAST, behind the
       groups that feed it. It partitions nothing at all for a single-stage draw type:
       every fixture of one shares its event's only stage, and since #1483 shares that
       stage's only group too, so both the key and its fallback answer the same value
       for all of them. That is why the deal changed nothing here — a uniform key is
       uniform whichever value it is uniform at, and the round/position questions below
       decide the order as they always did.
    2. "Where in the event's group order is its group?" — :func:`_group_sort_key`'s
    first
       two elements: ``group_position``, with an unresolved order sorting after every
       group that has one.
    3. "Which group?" — :func:`_group_sort_key`'s id tie-break, unobservable once (1)
    has
       already partitioned the un-grouped group off.

    (1)'s fallback and (3) can no longer disagree the way an early version of this rule
    could. ``Group.id`` was a bare ``str``, and a fixture drawn into an *empty-id* group
    answered "grouped" to the fallback while colliding with the un-grouped group's
    ``""`` in the tie-break — one fixture, grouped by one rule and un-grouped by the
    other. A ``min_length=1`` at the write boundary held that off; a ``uuid`` cannot
    express it at all, which is the better kind of fix.
    """
    ready = [
        f
        for f in fixtures
        if not f.is_pending and f.match_id is None and f.winner_entry_id is None
    ]
    ready.sort(
        key=lambda f: (
            f.stage.position if f.stage is not None else f.group_id is None,
            *_group_sort_key(f.group_id, f.group_position),
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
    ``qualifiers_per_group=None`` refusal is **gone**, not moved: a
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
            return RrThenKoStrategy(qualifiers_per_group=settings.qualifiers_per_group)
        case SwissDrawSettingsWrite():
            return SwissStrategy(rounds=settings.rounds)


def reads_fixture_games(draw_type: DrawType) -> bool:
    """Whether this draw type's ``advance()`` reads :attr:`FixtureState.games` — i.e.
    whether a caller projecting fixtures for it has to load the game counts first.

    A fact about the strategies, kept beside them rather than inferred at the seam.
    ``rr-then-ko`` picks its qualifiers by the standings' own tiebreak chain and so
    reads the games (refusing loudly — :class:`MissingFixtureGames` — when they were not
    loaded); round-robin and single-elim never touch the field, and for them the load is
    a SQL statement and a few hundred score rows discarded, on the completion seam,
    inside the score-accept transaction, once per result.

    ``swiss`` declares **true** for the same reason ``rr-then-ko`` does, and declares it
    now rather than when its pairing lands: it pairs each round off the standings, whose
    chain runs through Buchholz and game difference — both of which are counts of games
    — so a swiss draw advanced without them would pair the field in an order that
    disagrees with the table on screen. The cut needs no games; being handed them costs
    nothing, and being *without* them at the moment the pairing arrives would be the
    silent failure :class:`MissingFixtureGames` exists to prevent.

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
        case DrawType.swiss:
            return True


def seats_both_sides_at_cut(draw_type: DrawType) -> bool:
    """Whether a stage running ``draw_type`` knows **both sides of every one of its
    fixtures at the cut** — the one predicate every surface that used to ask
    ``group_id is not None`` asks instead.

    A round-robin stage does: the circle method pairs the whole group up front, so
    every fixture it deals names two entrants the moment it exists. A single-elim
    stage does not (round one is seeded, every later round is TBD until its feeders
    are decided), and a swiss stage does not (only round one is seeded; the rest are
    paired on ``advance``).

    **It replaced group presence, and that is the whole point.** "Has a group" and
    "seats both sides at the cut" happened to be the same set for as long as
    single-elim and swiss dealt their fixtures into no group at all — so five
    surfaces spelled the second question as the first (the preview's keep/drop split
    and its honest-note count, a match call's ``group_label``, the dashboard's group
    label, and the client's grouped/ungrouped bucketing). The moment a bracket's
    fixtures name their stage's group, every one of those readers would have started
    calling a bracket a group: a preview would place TBD-sided fixtures it cannot
    place, and a single-elim player would be told they are in "Group A". Asked here,
    once, they cannot drift apart per surface.

    An exhaustive ``match`` with **no catch-all**, exactly like
    :func:`reads_fixture_games` and :func:`strategy_for`: a fifth
    :class:`DrawType` member has to declare its answer before this type-checks.

    ``rr_then_ko`` answers ``False`` and is unreachable in practice: this is asked of
    a **stage's own** draw type, and ``rr_then_ko`` names a template rather than a
    runnable stage's type (ADR 20260815 decision 4 —
    :data:`~app.models.draw_type.StageDrawType` excludes it, and the stage model's
    setter refuses it). ``False`` is the safe answer anyway: a composite seats
    nobody's second side at the cut but its group half's, and that half is a
    round-robin stage which answers for itself.
    """
    match draw_type:
        case DrawType.round_robin:
            return True
        case DrawType.single_elim:
            return False
        case DrawType.swiss:
            return False
        case DrawType.rr_then_ko:
            return False


def reads_entrants(draw_type: DrawType) -> bool:
    """Whether this draw type's ``advance()`` reads the **field** — i.e. whether a
    caller advancing it has to load the event's entrants first.

    :func:`reads_fixture_games`' sibling, for the same seam and the same reason. The
    advance runs inside the score-accept transaction on every result, so a load nothing
    reads is a round trip per submission, and the gate is what keeps three of the four
    draw types costing exactly the fixture load they always cost.

    Only ``swiss`` declares **true**. Its bye is the absence of a fixture row, so the
    seated set is *not* the field: pairing the next round from the rows alone would drop
    the byed entrant — and a latecomer the currency check deliberately tolerates — out
    of the event for good. The other three seat every entrant they have in a row
    (a round-robin bye sits out one round of a schedule that seats it in the others, a
    byed knockout seed is seated onto its round-2 side at the cut), so for them the
    field is already in the fixtures and the load would be discarded.

    An exhaustive ``match`` with **no catch-all**, exactly like its sibling: a new
    :class:`DrawType` has to declare its own answer, and until it does this fails to
    type-check. The failure a default of ``False`` would cause is the silent one — a
    strategy handed an empty field pairs nobody and the event simply stops — which is
    why the declaration is compulsory rather than inferred.
    """
    match draw_type:
        case DrawType.round_robin:
            return False
        case DrawType.single_elim:
            return False
        case DrawType.rr_then_ko:
            return False
        case DrawType.swiss:
            return True


def unseated_entrant_allowance(draw_type: DrawType, field_size: int) -> int:
    """How many of a field's entrants this draw type's fixtures may legitimately fail
    to seat — the **bye allowance**, and the one thing "these fixtures cover this
    field" cannot be asked without.

    A draw's currency (:class:`~app.tournament_draws.DrawCurrency`) is "the fixtures
    seat exactly the active entrants", and for three of the four draw types that is
    literally true. Not because they have no byes — an odd round-robin group byes
    somebody every round — but because their byed entrants are **still seated
    somewhere**: a round-robin bye sits out one round of a schedule that seats them in
    every other, and a single-elim bye is seated directly onto its round-2 side at cut
    time (:func:`_knockout_seats`). So zero of their entrants are unseated, and an
    unseated entrant is exactly what it looks like — somebody who entered after the cut.

    **Swiss is the exception, and it is arithmetic rather than a special case.** Its cut
    emits ``⌊n/2⌋`` fixtures a round, so an odd field leaves exactly one entrant with no
    fixture at all — a bye is the absence of a row (ADR-0786), never a row with a
    ``NULL`` side. That entrant is covered by the draw; the draw simply has no row that
    says so. Hence ``field_size % 2``: one for an odd field, none for an even one.

    It is an **allowance**, i.e. an upper bound, not a required count. Once a later
    round is paired the round-1 bye is seated in it, and a draw that seats its whole
    field must stay current.

    What the allowance **cannot** do is tell a byed entrant from a single latecomer who
    leaves the field odd: a swiss draw cut for eight and joined by a ninth holds exactly
    the rows a draw cut for nine holds. The ambiguity is irreducible, not a shortcut. A
    bye is an absence, so the parity of the field the draw was cut for is recorded
    nowhere, and no arithmetic recovers it — ``⌊8/2⌋`` and ``⌊9/2⌋`` are the same number
    of fixtures.

    It is also the one shape where being wrong is survivable, and only for swiss. The
    latecomer is treated as that round's bye, which is a state the format puts somebody
    in every odd round anyway — where the same slip on a round-robin would seat a player
    in no match for the whole tournament. Everything else still reds: two latecomers,
    a latecomer that leaves the field **even** (``7 → 8``: two unseated against an
    allowance of none), and any withdrawal of a **seated** entry, which fails the subset
    half of the comparison rather than this count.

    An exhaustive ``match`` with no catch-all, exactly like :func:`reads_fixture_games`:
    a new :class:`DrawType` has to state its own answer, and until it does this fails to
    type-check. A default of ``0`` would be the ``stale`` this function exists to stop;
    a default of ``1`` would quietly stop catching the latecomer.
    """
    match draw_type:
        case DrawType.round_robin:
            return 0
        case DrawType.single_elim:
            return 0
        case DrawType.rr_then_ko:
            return 0
        case DrawType.swiss:
            return field_size % 2


def _snake(
    ordered_entrants: Sequence[OrderedEntrant], group_ids: Sequence[GroupId]
) -> list[tuple[GroupId, tuple[EntryId, ...]]]:
    """Deal the ordered entrants across the groups in **snake** order — 1, 2, …, P, then
    back P, P−1, …, 1 — so the top seeds are spread one per group and the second tier
    lands behind them in reverse. Group sizes differ by at most one by construction: the
    deal only ever fills a row before starting the next.

    Refuses a group of fewer than two: a lone entrant has nobody to play, and emitting
    the group anyway would hide a director's mistake behind a plausible-looking draw.
    """
    group_count = len(group_ids)
    if group_count == 0:
        raise DegenerateDraw("A round-robin draw needs at least one group.")

    members: list[list[EntryId]] = [[] for _ in group_ids]
    for index, entrant in enumerate(ordered_entrants):
        row, offset = divmod(index, group_count)
        # Odd rows deal backwards — that is the snake.
        column = offset if row % 2 == 0 else group_count - 1 - offset
        members[column].append(entrant.entry_id)

    # Asked of the dealt groups themselves, not of arithmetic on N and P: the refusal
    # should hold whatever the distribution does.
    if any(len(group_members) < 2 for group_members in members):
        entrant_count = len(ordered_entrants)
        entrant_noun = "entrant" if entrant_count == 1 else "entrants"
        group_noun = "group" if group_count == 1 else "groups"
        raise DegenerateDraw(
            f"{entrant_count} {entrant_noun} across {group_count} {group_noun} would "
            "leave a group with fewer than 2 entrants, who would have nobody to play."
        )

    return [
        (group_id, tuple(group_members))
        for group_id, group_members in zip(group_ids, members, strict=True)
    ]


def _circle_method(
    group_id: GroupId, members: Sequence[EntryId]
) -> list[PlannedFixture]:
    """Every pair in this group exactly once, laid out in rounds in which nobody plays
    twice — the circle method: pin the first entrant, rotate the others one seat per
    round, and pair across the circle.

    An odd group gets a **phantom** seat so the circle still has an even circumference;
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
                    # A round-robin deal is always a **group stage** at position 0 —
                    # the sole stage of a round-robin event, and the first of an
                    # rr-then-ko one (``stage_template``, ADR 20260815 decision 3).
                    # There is no third caller, and no round-robin stage anywhere else
                    # in any template, so this is stated here rather than threaded
                    # through as a parameter nobody would ever vary.
                    stage=FixtureStage(position=0, draw_type=DrawType.round_robin),
                    group_id=group_id,
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
    (:meth:`RrThenKoStrategy.advance`, seating a qualifier the moment its group
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
    field_size: int,
    entry_for_seed: Mapping[int, EntryId],
    *,
    stage: FixtureStage,
    group_id: GroupId | None = None,
) -> list[PlannedFixture]:
    """The whole bracket for ``field_size`` seeds, dealt into ``stage`` (and into
    ``group_id``, when the caller has one), with each seed's entry taken from
    ``entry_for_seed`` — **or left TBD for every seed the map does not name**.

    Two callers, one bracket. :class:`SingleElimStrategy` passes the full seed → entry
    map, because a single-elim cut knows its field. :class:`RrThenKoStrategy` passes an
    **empty** map, because its qualifiers have not played yet — and gets the identical
    shape with every side ``None``. That the shape is a pure function of ``field_size``
    is exactly why a groups-then-knockout bracket can be cut in the same stroke as the
    groups (ADR "rr-then-ko cuts both stages upfront"): the qualifier count ``P × K`` is
    known at cut time, so *which* slots exist and *which* seeds bye is settled before
    anybody has played.

    **The group rides a parameter, and it defaults to none.** The two callers do not
    agree about it: a single-elim event has one stage, that stage holds a group
    (#1483's floor), and every fixture of its bracket is dealt into it, so the
    solver confines the bracket to that group's reservation. An ``rr-then-ko``
    event's knockout stage holds no group *yet* (#1484 materialises them), and it
    must not be handed its group **stage's** group — that would deal knockout
    fixtures into the round-robin half, corrupting the standings the qualifiers are
    picked from. So the composite passes nothing and keeps ``group_id=None``, and
    a default of "no group" is the shape that cannot leak one by omission.

    ``stage`` differs between the callers for the same reason: the single-elim cut's
    bracket is its event's stage 0, the composite's is stage 1.

    A **bye is absence** (ADR-0786): a byed seed has no round-1 fixture at all, and the
    round-1 positions it would have occupied are simply skipped, leaving gaps in the
    position sequence. Every later round is emitted whole, its sides ``None`` except a
    side a bye already makes known.

    Rounds are numbered from **1** for both callers. For the knockout stage of an
    rr-then-ko draw that is a *restart*, not a continuation of the group rounds: the
    fixture uniqueness constraint is ``(stage_id, group_id, round, position)`` with
    ``NULLS NOT DISTINCT``, so the knockout stage is its own numbering namespace
    whatever its group is, and "the round after the groups" is ill-defined anyway when
    groups may differ in size.
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
            stage=stage,
            group_id=group_id,
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
            stage=stage,
            group_id=group_id,
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
    silent, because a partner map that thinks a seed byes admits the same-group pairing
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


def _assign_block_groups(
    seeds: Sequence[int], group_count: int, forbidden: dict[int, int]
) -> dict[int, int]:
    """Hand each seed in one place block a distinct group, avoiding each seed's one
    forbidden group — the bipartite matching at the heart of
    :func:`qualifier_seed_assignment`.

    Kuhn's augmenting-path algorithm, walked in ascending seed then ascending group
    order, which makes the matching it lands on a *function of the inputs* rather than
    of dict iteration luck.

    **Why the failure arm below is unreachable**, stated the way it is actually true.
    "Each seed forbids at most one group, so each admits at least ``P−1``" is the fact,
    but it is *not* the reason: a subset ``S`` of the block's seeds sees all ``P``
    groups the moment two of its members forbid different groups (or one forbids none),
    so the only subset that can fail Hall's condition is the whole block — all ``P``
    seeds forbidding the **same** group, leaving ``P−1`` groups for ``P`` seeds.
    Admitting ``P−1`` each is exactly what does not rule that out.

    What rules it out is the geometry of a block. A block is ``P`` **consecutive**
    seeds; round one pairs ``s`` with ``B+1−s`` (:func:`_seed_slots`, ``B`` the bracket
    size), an order-reversing pairing, so a block's partners are themselves ``P``
    consecutive seeds — a run spanning at most **two** blocks. Each block hands each
    group to exactly one seed, so at most two of a block's seeds can forbid one group,
    which is fewer than ``P`` for every ``P ≥ 3``. ``P = 2`` is the one size where two
    would be enough, and there the partner run is ``{B−2b−1, B−2b}`` (block ``b``),
    whose lower member is odd because ``B`` is a power of two — so both partners sit in
    the *same* block and necessarily hold different groups. Either way a block never
    forbids one group ``P`` times, Hall's condition holds, and a matching exists.
    (Measured over ``P`` 2..64 × ``K`` 1..40 the margin is wider still: no two seeds of
    a block were ever seen to forbid the same group at all.)

    A seed takes the **lowest free group** it is allowed, and only displaces an
    incumbent when every group it admits is taken — the standard greedy initialization
    for Kuhn's. Skipping it costs nothing in correctness (an augmenting path repairs any
    greedy mistake) but a great deal in legibility: without it an *unconstrained* block
    still shuffles, so a two-group bracket seats group B's winner at seed 1, which reads
    as a bug to anyone printing the draw.
    """
    seed_by_group: dict[int, int] = {}
    for seed in seeds:
        free = next(
            (
                group
                for group in range(group_count)
                if group not in seed_by_group and group != forbidden.get(seed)
            ),
            None,
        )
        if free is not None:
            seed_by_group[free] = seed
            continue
        if not _augment_group(seed, group_count, forbidden, seed_by_group, set()):
            raise RuntimeError(  # pragma: no cover - Hall's condition forbids it
                f"No conflict-free group assignment for seed {seed} across "
                f"{group_count} groups, which Hall's condition says cannot happen."
            )
    return {seed: group for group, seed in seed_by_group.items()}


def _augment_group(
    seed: int,
    group_count: int,
    forbidden: dict[int, int],
    seed_by_group: dict[int, int],
    visited: set[int],
) -> bool:
    """Try to seat ``seed`` in some group, displacing an incumbent that can move
    elsewhere. ``True`` when ``seed_by_group`` has been extended to cover it."""
    for group in range(group_count):
        if group == forbidden.get(seed) or group in visited:
            continue
        visited.add(group)
        incumbent = seed_by_group.get(group)
        if incumbent is None or _augment_group(
            incumbent, group_count, forbidden, seed_by_group, visited
        ):
            seed_by_group[group] = seed
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
