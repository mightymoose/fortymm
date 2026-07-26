"""An event's **results** — how it turned out — as a *pure* per-draw-type strategy
family (ADR-0788).

``app.draws`` is the strategy family that *runs* a draw (``plan_initial`` +
``advance``); this is the separate family that reads a draw's decided matches back
into a **result**. They are kept apart because results are *shaped* differently per
draw type — a round-robin's result is its **standings** table, a single-elim's is a
placement and a **champion** — so a single shared method on ``DrawStrategy`` would
force every draw type to implement a table it does not have (ADR-0788, "results are a
separate strategy family"). ``results_for(draw_type)`` mirrors ``strategy_for``'s
exhaustive ``match`` / ``UnsupportedResultsType``, so a new
:class:`~app.models.tournament.DrawType` is a type error here until somebody says how
it reads out.

Like ``app.draws`` this module is **pure**: it holds no session, issues no query, and
imports no SQLAlchemy construct. Its whole input is small frozen value objects
(:class:`MatchOutcome`, grouped into :class:`PoolInput` for a round-robin or
:class:`BracketFixture` for a single-elim bracket) that the persistence layer projects
from the fixtures' **currently-completed** matches — so nothing here is a snapshot, and
a corrected or voided match re-derives the results the instant it leaves ``completed``,
with no bookkeeping to keep in step (ADR-0788, "everything derives from the matches").

Two arms are implemented: :class:`RoundRobinResults`, whose shape is a **standings**
table per pool, and :class:`SingleElimResults` (ADR-0785), whose shape is the bracket's
**finishes** — each entrant's finishing position by the round it was eliminated in. The
two shapes cross the wire as a discriminated union tagged by ``kind`` (ADR-0785); here
they are simply two different value objects returned by two ``tabulate`` methods.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from app.draws import EntryId, PoolId
from app.models.tournament import DrawType


class UnsupportedResultsType(Exception):
    """This draw type has no results strategy yet.

    Raised by :func:`results_for`, whose ``match`` is exhaustive with no catch-all —
    so a new :class:`~app.models.tournament.DrawType` member is a *type* error until it
    is handled here, and a member handled-but-unimplemented is a catchable domain error
    rather than a 500. The exact mirror of ``app.draws.UnsupportedDrawType``.
    """

    def __init__(self, draw_type: DrawType) -> None:
        self.draw_type = draw_type
        super().__init__(f"Draw type {draw_type.value!r} has no results strategy yet.")


@dataclass(frozen=True, slots=True)
class MatchOutcome:
    """One decided fixture, as the standings need to see it: who was in it, who won,
    and the games each side took.

    Projected by the caller from a fixture whose match is **currently completed** — so
    it is a fact about live state, never a snapshot. The games are the count each entry
    *won*, which is all the game-difference and games-won tiebreakers need — and the
    winner falls out of them.
    """

    entry_a_id: EntryId
    entry_b_id: EntryId
    entry_a_games: int
    entry_b_games: int

    @property
    def winner_entry_id(self) -> EntryId:
        """Whichever entry took more games. A decided match has no tie (odd best-of),
        so the higher count is always the winner — derived here rather than stored, so
        it cannot be handed in disagreeing with the counts beside it."""
        return (
            self.entry_a_id
            if self.entry_a_games > self.entry_b_games
            else self.entry_b_id
        )

    @property
    def loser_entry_id(self) -> EntryId:
        """The other side of :attr:`winner_entry_id` — whichever entry took fewer
        games. A decided match has no tie (odd best-of), so the lower count is always
        the loser; single-elim's finishes read a fixture's loser straight off this,
        since losing is exactly what places you (ADR-0785)."""
        return (
            self.entry_b_id
            if self.entry_a_games > self.entry_b_games
            else self.entry_a_id
        )


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
    knockout stage to join its pool winners (that is ``rr_then_ko``, not this slice), so
    ``champion`` is ``None`` there even when the event is complete. ``None`` also while
    any fixture is still to be played.
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


@dataclass(slots=True)
class _Stat:
    """A mutable per-entry accumulator — private to the tabulation, never returned."""

    entry_id: EntryId
    played: int = 0
    wins: int = 0
    losses: int = 0
    games_won: int = 0
    games_lost: int = 0

    @property
    def game_difference(self) -> int:
        return self.games_won - self.games_lost


# The tiebreak chain, after wins (which groups) and the two-way head-to-head (which
# refines a pair): each entry maps to a value where HIGHER is better, tried in order.
# A new comparator is **appended** here, not surgically inserted between the existing
# ones — the chain is data, so extending it touches nothing already in it (ADR-0788).
_TIEBREAKERS: tuple[Callable[[_Stat], int], ...] = (
    lambda stat: stat.game_difference,
    lambda stat: stat.games_won,
)


def results_for(draw_type: DrawType) -> RoundRobinResults | SingleElimResults:
    """The results strategy for this draw type.

    An exhaustive ``match`` with **no catch-all**, exactly as
    ``app.draws.strategy_for``: adding a member to
    :class:`~app.models.tournament.DrawType` makes this fail to type-check until the
    member is handled, so a new format cannot read out its results silently
    unimplemented. The formats without a strategy yet raise
    :class:`UnsupportedResultsType` — a catchable domain error, not a 500.

    The return type is a **union tagged by shape** (ADR-0785): round-robin's
    :class:`RoundRobinResults` reads out a **standings** table, single-elim's
    :class:`SingleElimResults` reads out the bracket's **finishes**. A caller narrows
    the union (an exhaustive ``match`` over the two concrete strategies) to call the
    right ``tabulate`` — so a third strategy is a type error at every call site until
    handled. A further draw type lands its own strategy and widens this the way
    ``strategy_for`` already is.
    """
    match draw_type:
        case DrawType.round_robin:
            return RoundRobinResults()
        case DrawType.single_elim:
            return SingleElimResults()
        case DrawType.double_elim | DrawType.rr_then_ko | DrawType.swiss:
            raise UnsupportedResultsType(draw_type)


@dataclass(frozen=True, slots=True)
class RoundRobinResults:
    """A round-robin event's results: a standings table per pool.

    Each pool is ordered by an extensible chain of tiebreakers (ADR-0788):

    1. **wins** — most match wins first;
    2. **head-to-head**, *only when exactly two entries are tied* on wins — the one
       that beat the other ranks above it. A three-or-more-way tie can cycle (A beat B
       beat C beat A), so it is **not** broken head-to-head; it falls straight through
       to the game tiebreakers rather than a recursive mini-league;
    3. **game difference** — games won minus games lost;
    4. **games won**.

    The entry id is the final, deterministic tiebreak, so a pool in which two entries
    are genuinely level on every count still orders the same way on every read.
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
        rows.sort(key=lambda row: (row.position, _entry_id_order(row.entry_id)))
        # Complete once every fixture is decided — which is exactly when the final is,
        # so ``champion`` is non-None precisely then. A voided (never-completed) fixture
        # holds the bracket incomplete, honestly: its winner was never seated forward,
        # so the bracket genuinely has not resolved.
        return BracketFinishes(
            finishes=tuple(rows),
            complete=decided == len(fixtures),
            champion=champion,
        )


def _pool_standings(pool: PoolInput) -> PoolStandings:
    stats: dict[EntryId, _Stat] = {
        entry_id: _Stat(entry_id=entry_id) for entry_id in pool.entrants
    }
    for outcome in pool.outcomes:
        _record(stats[outcome.entry_a_id], stats[outcome.entry_b_id], outcome)
    ordered = _order(list(stats.values()), pool.outcomes)
    rows = tuple(
        StandingRow(
            entry_id=stat.entry_id,
            rank=rank,
            played=stat.played,
            wins=stat.wins,
            losses=stat.losses,
            games_won=stat.games_won,
            games_lost=stat.games_lost,
        )
        for rank, stat in enumerate(ordered, start=1)
    )
    return PoolStandings(
        pool_id=pool.pool_id,
        rows=rows,
        complete=len(pool.outcomes) == pool.fixture_count,
    )


def _record(a: _Stat, b: _Stat, outcome: MatchOutcome) -> None:
    a.played += 1
    b.played += 1
    a.games_won += outcome.entry_a_games
    a.games_lost += outcome.entry_b_games
    b.games_won += outcome.entry_b_games
    b.games_lost += outcome.entry_a_games
    if outcome.winner_entry_id == outcome.entry_a_id:
        a.wins += 1
        b.losses += 1
    else:
        b.wins += 1
        a.losses += 1


def _order(stats: list[_Stat], outcomes: Sequence[MatchOutcome]) -> list[_Stat]:
    """The pool's finishing order: group by wins (descending), then break each tie."""
    by_wins: dict[int, list[_Stat]] = defaultdict(list)
    for stat in stats:
        by_wins[stat.wins].append(stat)
    ordered: list[_Stat] = []
    for wins in sorted(by_wins, reverse=True):
        ordered.extend(_break_tie(by_wins[wins], outcomes))
    return ordered


def _break_tie(group: list[_Stat], outcomes: Sequence[MatchOutcome]) -> list[_Stat]:
    """Order a group of entries level on wins.

    A **two-way** tie is broken head-to-head when the pair has actually met — the
    winner of that match ranks above the loser. A larger tie (which can cycle) and a
    two-way tie whose pair has not met yet (mid-pool) fall through to the game
    tiebreakers.
    """
    if len(group) == 2:
        decided = _head_to_head(group[0], group[1], outcomes)
        if decided is not None:
            return decided
    return sorted(group, key=_scalar_key)


def _head_to_head(
    first: _Stat, second: _Stat, outcomes: Sequence[MatchOutcome]
) -> list[_Stat] | None:
    """``[winner, loser]`` if these two have met, else ``None`` (not yet played)."""
    pair = {first.entry_id, second.entry_id}
    for outcome in outcomes:
        if {outcome.entry_a_id, outcome.entry_b_id} == pair:
            if outcome.winner_entry_id == first.entry_id:
                return [first, second]
            return [second, first]
    return None


def _scalar_key(stat: _Stat) -> tuple[int, ...]:
    """The tiebreak-chain sort key: each comparator negated (higher is better ⇒
    earlier), then the entry id as the final deterministic tiebreak so the order is
    total."""
    return (*(-tiebreaker(stat) for tiebreaker in _TIEBREAKERS), _entry_order(stat))


def _entry_order(stat: _Stat) -> int:
    return _entry_id_order(stat.entry_id)


def _entry_id_order(entry_id: EntryId) -> int:
    """A total, deterministic order over entry ids — the final list-order tiebreak both
    shapes fall back to so equal rows never come out in a nondeterministic order."""
    return int.from_bytes(entry_id.bytes, "big")
