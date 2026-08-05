"""An event's **results** — how it turned out — as a *pure* per-draw-type strategy
family (ADR-0788).

``app.draws`` is the strategy family that *runs* a draw (``plan_initial`` +
``advance``); this is the separate family that reads a draw's decided matches back
into a **result**. They are kept apart because results are *shaped* differently per
draw type — a round-robin's result is its **standings** table, a single-elim's is a
placement and a **champion** — so a single shared method on ``DrawStrategy`` would
force every draw type to implement a table it does not have (ADR-0788, "results are a
separate strategy family"). ``results_for(draw_type)`` mirrors ``strategy_for``'s
exhaustive, catch-all-free ``match``, so a new
:class:`~app.models.tournament.DrawType` is a type error here until somebody says how
it reads out.

Like ``app.draws`` this module is **pure**: it holds no session, issues no query, and
imports no SQLAlchemy construct. Its whole input is small frozen value objects
(:class:`~app.pool_finishing_order.MatchOutcome`, grouped into :class:`PoolInput` for a
round-robin or :class:`BracketFixture` for a single-elim bracket) that the persistence
layer projects from the fixtures' **currently-completed** matches — so nothing here is a
snapshot, and a corrected or voided match re-derives the results the instant it leaves
``completed``, with no bookkeeping to keep in step (ADR-0788, "everything derives from
the matches").

The round-robin **tiebreak chain itself** lives in ``app.pool_finishing_order``, not
here: the draw layer needs the same order to pick a pool's qualifiers, and this module
already imports ``app.draws``, so a shared third module is the only place both can
reach (ADR 20260727). ``MatchOutcome`` is re-exported from here for the callers that
already know it by this name.

Four arms are implemented: :class:`RoundRobinResults`, whose shape is a **standings**
table per pool; :class:`SingleElimResults` (ADR-0785), whose shape is the bracket's
**finishes** — each entrant's finishing position by the round it was eliminated in;
:class:`RrThenKoResults` (ADR 20260727), a two-**stage** event whose shape is **both**,
one block per stage; and :class:`SwissResults` (ADR "swiss pre-cuts every round and
pairs each one on advance"), whose shape is a single **pool-less** table over the whole
field. The shapes cross the wire as a discriminated union tagged by ``kind`` (ADR-0785);
here they are simply different value objects returned by different ``tabulate`` methods.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.draws import EntryId, PoolId
from app.models.tournament import DrawType
from app.pool_finishing_order import MatchOutcome, entry_id_order, finishing_order

__all__ = [
    "BracketFinishes",
    "BracketFixture",
    "EventResults",
    "FieldInput",
    "FinishRow",
    # Re-exported: the value object the tabulation consumes lives in
    # ``app.pool_finishing_order`` so the draw layer can reach it too, but every
    # existing caller imports it from here.
    "MatchOutcome",
    "PoolInput",
    "PoolStandings",
    "RoundRobinResults",
    "RrThenKoResults",
    "SingleElimResults",
    "StandingRow",
    "StandingsThenFinishes",
    "SwissResults",
    "SwissStandings",
    "results_for",
]


@dataclass(frozen=True, slots=True)
class PoolInput:
    """One pool's whole input to the standings: every entry seated in it, how many
    fixtures it has, and the outcomes of the ones already decided.

    ``entrants`` is the full seated field — not just the entries that have played — so a
    player who has not played yet still appears in the table with a row of zeros
    (partial, live standings). ``fixture_count`` is the number of the pool's pairings
    that can still yield a result — every pairing except any whose match was **voided**
    (which never will) — against which ``len(outcomes)`` decides whether the pool is
    **complete**. Counting voided pairings would leave a pool that hit one (e.g. a
    self-play match voided by an account merge) unable to ever reach ``complete``.
    """

    pool_id: PoolId
    entrants: tuple[EntryId, ...]
    fixture_count: int
    outcomes: tuple[MatchOutcome, ...]


@dataclass(frozen=True, slots=True)
class FieldInput:
    """A **pool-less** field's whole input to its standings: every entry in the event,
    how many fixtures it has, and the outcomes of the ones already decided.

    :class:`PoolInput` without the ``pool_id``, because swiss has no pool to name (ADR
    "swiss pre-cuts every round and pairs each one on advance") — the whole field stands
    in one table. The three fields mean exactly what they mean there, and are read the
    same way: ``entrants`` is the full seated field so an entrant yet to play still has
    a row of zeros, and ``fixture_count`` counts the pairings that can still yield a
    result, which for swiss includes the later rounds that are cut but not yet paired.

    ``byes`` is the fourth field and the one :class:`PoolInput` will never have: one
    entry id **per bye taken**, derived by :func:`app.draws.swiss_byes` from the rows
    the caller is already holding. It is a *result* the table has to score — a win worth
    zero games (ADR "swiss standings add Buchholz") — and it cannot come from
    ``outcomes``, because a bye has no opponent to name. Empty for an even field, and
    empty for a round-robin pool, whose byed entrant is seated in every other round and
    is not credited with anything for the one they sat out.

    It is deliberately not a shared base class with :class:`PoolInput`. One is keyed by
    a pool and one is not, and one scores byes, and a base would buy a name for three
    fields at the cost of a hierarchy in a module that is otherwise flat value objects.
    """

    entrants: tuple[EntryId, ...]
    fixture_count: int
    outcomes: tuple[MatchOutcome, ...]
    #: Only ids that are in ``entrants`` — the tallies are keyed by entrant, so a
    #: stranger here is a ``KeyError``. Empty when nobody has sat out.
    byes: tuple[EntryId, ...] = ()


@dataclass(frozen=True, slots=True)
class StandingRow:
    """One entry's line in a pool's standings table, at its settled rank.

    ``rank`` is 1-based and every row's is distinct (the ordering is a total one — see
    :class:`RoundRobinResults`), so position 1 is the pool leader.
    """

    entry_id: EntryId
    rank: int
    played: int
    wins: int
    losses: int
    games_won: int
    games_lost: int

    @property
    def game_difference(self) -> int:
        """Games won minus games lost — the third link in the tiebreak chain."""
        return self.games_won - self.games_lost


@dataclass(frozen=True, slots=True)
class PoolStandings:
    """One pool's standings: its rows in finishing order, and whether every fixture in
    it has been decided."""

    pool_id: PoolId
    rows: tuple[StandingRow, ...]
    complete: bool


@dataclass(frozen=True, slots=True)
class EventResults:
    """A round-robin event's results: a standings table per pool, whether the whole
    event is decided, and its champion when there is one.

    ``champion`` is the leader of a **complete, single-pool** event — a pure
    round-robin's winner. A multi-pool round-robin has no single champion without a
    knockout stage to join its pool winners, so ``champion`` is ``None`` there even when
    the event is complete. ``None`` also while any fixture is still to be played.

    That carve-out is unchanged by the arrival of the ``rr-then-ko`` draw type (ADR
    20260727): a pools-then-knockout event *does* have a knockout stage to join its pool
    winners, and it reads out as :class:`StandingsThenFinishes` — a **different shape**,
    crowned from its bracket. This one still describes a draw with pools and nothing
    after them, and for such a draw the claim is as true as it ever was.
    """

    pools: tuple[PoolStandings, ...]
    complete: bool
    champion: EntryId | None


@dataclass(frozen=True, slots=True)
class BracketFixture:
    """One single-elimination fixture as the **finishes** need to see it: its round and,
    when its match is decided, that outcome.

    An *undecided* fixture still appears (``outcome is None``) — its ``round`` is what
    fixes the bracket's **depth**, the final round from which every finishing position
    is measured, before anybody has reached it. Byes are not represented at all: a bye
    is the *absence* of a fixture (ADR-0786), and it needs no representation here — a
    byed entrant still loses (or wins) in some real later-round fixture, which places
    them. ``round`` is 1-based; the largest round across the bracket is its final.
    """

    round: int
    outcome: MatchOutcome | None


@dataclass(frozen=True, slots=True)
class FinishRow:
    """One entrant's **finish**: its finishing position and the round it was eliminated
    in (``None`` for the champion, who was never eliminated).

    ``position`` is 1-based and is **shared by same-round losers** — the two semifinal
    losers both carry ``3`` — so it is deliberately *not* distinct per row: single-elim
    genuinely does not rank same-round losers against each other, and inventing a
    tiebreak (seed, game-difference) would fabricate an order the format never produced
    (ADR-0785).
    """

    entry_id: EntryId
    position: int
    eliminated_in_round: int | None


@dataclass(frozen=True, slots=True)
class BracketFinishes:
    """A single-elimination event's results: its entrants' :class:`FinishRow`\\ s ranked
    by position, whether the whole bracket is decided, and its champion when there is
    one.

    Only *placed* entrants appear in ``finishes`` — every loser of a decided fixture,
    plus the champion once the final is decided. An entrant still alive in a
    partially-played bracket has no finish yet and is simply absent (a partial result,
    live like the standings). ``champion`` is the final's winner — finish position ``1``
    — and ``None`` until the final is decided.
    """

    finishes: tuple[FinishRow, ...]
    complete: bool
    champion: EntryId | None


@dataclass(frozen=True, slots=True)
class StandingsThenFinishes:
    """A round-robin-then-knockout event's results: **one block per stage** — the pool
    stage's standings *and* the knockout stage's finishes — read out together (ADR
    20260727, "results are a third arm of the wire union").

    Both blocks are exactly what the one-stage shapes carry: ``pools`` is
    :class:`EventResults`' standings, ``finishes`` is :class:`BracketFinishes`' ranked
    rows, each still live and partial — pool rows appear before a pool has finished, and
    only *placed* knockout entrants have a finish. Neither is a new reading of a stage;
    see :class:`RrThenKoResults`.

    ``champion`` is the **knockout final's winner, never a pool leader** (CONTEXT.md,
    "Champion"): the pool stage only seeds the bracket, so topping a pool wins nothing.
    It is ``None`` until that final is decided — which, since the final cannot be
    decided before the pools that seat it, is also the only way it can be non-``None``.

    ``complete`` is **both stages decided**, and the two are asserted separately rather
    than one inferred from the other. See :meth:`RrThenKoResults.tabulate`.
    """

    pools: tuple[PoolStandings, ...]
    finishes: tuple[FinishRow, ...]
    complete: bool
    champion: EntryId | None


@dataclass(frozen=True, slots=True)
class SwissStandings:
    """A swiss event's results: **one** standings table over the whole field, whether
    every round has been decided, and its champion when it has.

    One table and not a tuple of them, because swiss is pool-less: everybody is ranked
    against everybody, which is the whole point of pairing by score. That is the only
    structural difference from :class:`EventResults`, and it is why this is its own
    shape rather than a pool-less flavour of that one — a ``pools`` list of length one
    with a made-up id would be a lie about a pool that does not exist.

    ``champion`` is the leader of a **complete** event, with no single-pool carve-out to
    make: a swiss event ranks the whole field, so its table's top row is its winner
    (CONTEXT.md, "Swiss"). ``None`` while any round is still to be decided.
    """

    rows: tuple[StandingRow, ...]
    complete: bool
    champion: EntryId | None


def results_for(
    draw_type: DrawType,
) -> RoundRobinResults | SingleElimResults | RrThenKoResults | SwissResults:
    """The results strategy for this draw type.

    **Total**, exactly as ``app.draws.strategy_for``: an exhaustive ``match`` with
    **no catch-all** over an enum that holds only what runs (ADR "a draw type is a
    seeded row, and the enum holds only what runs"), so every member reads out and
    adding one fails to type-check here until it says how. There is no
    "unsupported results type" error, because no input can reach one.

    The return type is a **union tagged by shape** (ADR-0785): round-robin's
    :class:`RoundRobinResults` reads out a **standings** table, single-elim's
    :class:`SingleElimResults` reads out the bracket's **finishes**, rr-then-ko's
    :class:`RrThenKoResults` reads out **both**, and swiss's :class:`SwissResults` reads
    out a single **pool-less** table over the whole field. A caller narrows the union
    (an exhaustive ``match`` over the concrete strategies) to call the right
    ``tabulate`` —
    so a further strategy is a type error at every call site until handled.

    The narrowing is not uniform, and cannot be: :meth:`RrThenKoResults.tabulate` takes
    **two** stage inputs where its siblings take one, because a two-stage event has two
    stages to project (the pooled fixtures and the ``pool_id IS NULL`` ones). That is
    what the ``match`` at the call site is for — each arm builds the input its own shape
    needs, rather than a single call signature pretending every draw type has one stage.
    """
    match draw_type:
        case DrawType.round_robin:
            return RoundRobinResults()
        case DrawType.single_elim:
            return SingleElimResults()
        case DrawType.rr_then_ko:
            return RrThenKoResults()
        case DrawType.swiss:
            return SwissResults()


@dataclass(frozen=True, slots=True)
class RoundRobinResults:
    """A round-robin event's results: a standings table per pool.

    Each pool is ordered by :func:`~app.pool_finishing_order.finishing_order` — the
    extensible tiebreak chain of ADR-0788 (wins, then head-to-head when exactly two are
    tied, then game difference, then games won, then the entry id as a deterministic
    final fallback). That chain lives in its own module because the draw layer reads the
    same order to pick a pool's qualifiers; this strategy is the *standings* reading of
    it, and the two cannot drift because there is only one of them (ADR 20260727).
    """

    def tabulate(self, pools: Sequence[PoolInput]) -> EventResults:
        standings = tuple(_pool_standings(pool) for pool in pools)
        # Complete = every pool's every fixture decided. ``all(())`` is vacuously true,
        # so an event with no pools at all is deliberately *not* called complete.
        complete = bool(standings) and all(pool.complete for pool in standings)
        champion: EntryId | None = None
        if complete and len(standings) == 1 and standings[0].rows:
            champion = standings[0].rows[0].entry_id
        return EventResults(pools=standings, complete=complete, champion=champion)


@dataclass(frozen=True, slots=True)
class SingleElimResults:
    """A single-elimination event's results: the bracket's **finishes** (ADR-0785).

    Each entrant's finishing position is derived **live** from the completed fixtures by
    the round it was eliminated in — a fixture's loser is placed by that round, the
    final's winner is the champion (position 1). Positions come out
    ``1, 2, 3, 3, 5, 5, 5, 5, …``: the final's loser is runner-up (2), the two semifinal
    losers **tie 3rd**, the four quarterfinal losers **tie 5th**, and so on — a loser
    eliminated ``k`` rounds before the final places ``2ᵏ + 1``, shared by all ``2ᵏ``
    losers of that round. Nothing is snapshotted, so a correction or void that
    un-completes a fixture drops its loser's finish (and can re-crown) on the next
    read — the same live-derivation property :class:`RoundRobinResults` has.
    """

    def tabulate(self, fixtures: Sequence[BracketFixture]) -> BracketFinishes:
        if not fixtures:
            # No fixtures = uncut/empty bracket: no depth to measure from, no finishes.
            return BracketFinishes(finishes=(), complete=False, champion=None)
        final_round = max(fixture.round for fixture in fixtures)
        decided = 0
        champion: EntryId | None = None
        rows: list[FinishRow] = []
        for fixture in fixtures:
            outcome = fixture.outcome
            if outcome is None:
                continue
            decided += 1
            # The loser is placed by the round they lost in; same-round losers share it.
            rows.append(
                FinishRow(
                    entry_id=outcome.loser_entry_id,
                    position=2 ** (final_round - fixture.round) + 1,
                    eliminated_in_round=fixture.round,
                )
            )
            if fixture.round == final_round:
                # The final's winner is the champion — read from the result, position 1,
                # never eliminated. There is exactly one final fixture, so this is set
                # at most once.
                champion = outcome.winner_entry_id
        if champion is not None:
            rows.append(
                FinishRow(entry_id=champion, position=1, eliminated_in_round=None)
            )
        # Ranked by position; the entry id is the final *list*-order tiebreak so tied
        # rows come out deterministically — without conferring an order on the tie
        # itself (the shared ``position`` is what the reader sees).
        rows.sort(key=lambda row: (row.position, entry_id_order(row.entry_id)))
        # Complete once every fixture is decided — which is exactly when the final is,
        # so ``champion`` is non-None precisely then. A voided (never-completed) fixture
        # holds the bracket incomplete, honestly: its winner was never seated forward,
        # so the bracket genuinely has not resolved.
        return BracketFinishes(
            finishes=tuple(rows),
            complete=decided == len(fixtures),
            champion=champion,
        )


@dataclass(frozen=True, slots=True)
class RrThenKoResults:
    """A round-robin-then-knockout event's results: **both stages, read out together**
    (ADR 20260727).

    It computes neither stage itself. The pool stage *is*
    :meth:`RoundRobinResults.tabulate` and the knockout stage *is*
    :meth:`SingleElimResults.tabulate` — the same two readings a pure round-robin and a
    pure single-elim get — so "an rr-then-ko event's pools stand exactly as a
    round-robin's do, and its bracket places exactly as a single-elim's do" is true
    structurally rather than by three implementations agreeing. This strategy's whole
    job is to run both and say what the *event* (as opposed to either stage) makes of
    them: who is champion, and whether it is over. It is the results-side mirror of
    :class:`~app.draws.RrThenKoStrategy`, which composes the same two draw strategies.

    Live and partial like every other shape, in either stage independently: pools
    part-played read as a live table with an empty bracket behind them, and pools
    decided with the bracket mid-flight read as a settled table plus the finishes of
    whoever has been knocked out so far.
    """

    def tabulate(
        self, pools: Sequence[PoolInput], bracket: Sequence[BracketFixture]
    ) -> StandingsThenFinishes:
        pool_stage = RoundRobinResults().tabulate(pools)
        knockout_stage = SingleElimResults().tabulate(bracket)
        return StandingsThenFinishes(
            pools=pool_stage.pools,
            finishes=knockout_stage.finishes,
            # Both stages, asserted separately. The conjunction's left half is not
            # redundant even though it is implied: nothing is seated into the bracket
            # until a pool finishes, so a decided final entails decided pools. Deriving
            # ``complete`` from the bracket alone would make this shape's headline claim
            # depend on an invariant enforced two modules away (``RrThenKoStrategy``'s
            # seating) rather than on the standings it is handed — and it would read as
            # complete for any caller that projects the two stages inconsistently.
            complete=pool_stage.complete and knockout_stage.complete,
            # The champion is the **bracket's**. ``pool_stage.champion`` is deliberately
            # dropped, and it is not always ``None``: a legal one-pool rr-then-ko (a
            # league, then a playoff) makes ``RoundRobinResults`` crown its complete
            # pool's leader, who is merely the top *seed* of the knockout here. Taking
            # it would crown somebody the playoff went on to eliminate.
            champion=knockout_stage.champion,
        )


@dataclass(frozen=True, slots=True)
class SwissResults:
    """A swiss event's results: one standings table over the whole field (ADR "swiss
    pre-cuts every round and pairs each one on advance").

    Ordered by :func:`~app.pool_finishing_order.finishing_order` — the *same* chain a
    round-robin pool is ordered by — through the same :func:`_standing_rows` a pool's
    table is built with. That is deliberate and temporary: swiss gets its own ordering
    function, with Buchholz above game difference and the head-to-head step guarded on
    the pair having met, in its own slice (ADR "swiss standings add Buchholz, and
    head-to-head is guarded on having met"). Until then this reads out the chain that
    exists rather than a swiss-shaped approximation of the one that does not.

    **A bye scores as a win worth zero games** (ADR "swiss standings add Buchholz, and
    head-to-head is guarded on having met"), which is the one thing this table counts
    that a pool's does not. The win, because sitting out is a scheduling artifact the
    player did not cause. Zero games, because a nominal 3-0 would hand them a game
    difference nobody earned and lift them over somebody who beat a real opponent. The
    byes themselves are derived from the fixtures by :func:`app.draws.swiss_byes` and
    arrive on :attr:`FieldInput.byes` — the same derivation the draw layer pairs by, so
    the rank a director reads and the rank the next round is paired down are one number.

    Live and partial like every other shape: an entrant appears from the moment they are
    seated, and a correction re-orders the table the instant it lands.
    """

    def tabulate(self, field: FieldInput) -> SwissStandings:
        rows = _standing_rows(field.entrants, field.outcomes, field.byes)
        # Every round decided — which, since the later rounds are cut up front with
        # their sides unknown, includes the ones nobody has been paired into yet. An
        # event with no fixtures that can still yield a result is deliberately NOT
        # complete: ``0 == 0`` would call an uncut (or wholly voided) swiss finished.
        complete = (
            field.fixture_count > 0 and len(field.outcomes) == field.fixture_count
        )
        champion = rows[0].entry_id if complete and rows else None
        return SwissStandings(rows=rows, complete=complete, champion=champion)


def _pool_standings(pool: PoolInput) -> PoolStandings:
    return PoolStandings(
        pool_id=pool.pool_id,
        rows=_standing_rows(pool.entrants, pool.outcomes),
        complete=len(pool.outcomes) == pool.fixture_count,
    )


def _standing_rows(
    entrants: Sequence[EntryId],
    outcomes: Sequence[MatchOutcome],
    byes: Sequence[EntryId] = (),
) -> tuple[StandingRow, ...]:
    """These entrants' rows, at their settled ranks — the one place a table is built,
    for the two shapes that carry one (a pool's, and a swiss field's).

    Shared so that "a standings row means the same thing whichever event it is read
    off" is true structurally: the ordering is
    :func:`~app.pool_finishing_order.finishing_order` and the counts come off the
    tallies it returns, in one function rather than two that agree today.

    ``byes`` defaults to none, which is a **fact about a pool** rather than a
    convenience: a round-robin bye is a round sat out inside a schedule that seats its
    holder in every other one, so there is nothing to score. Only swiss passes any."""
    return tuple(
        StandingRow(
            entry_id=tally.entry_id,
            rank=rank,
            played=tally.played,
            wins=tally.wins,
            losses=tally.losses,
            games_won=tally.games_won,
            games_lost=tally.games_lost,
        )
        for rank, tally in enumerate(finishing_order(entrants, outcomes, byes), start=1)
    )
