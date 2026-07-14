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
(:class:`MatchOutcome`, grouped into :class:`PoolInput`) that the persistence layer
projects from the fixtures' **currently-completed** matches — so nothing here is a
snapshot, and a corrected or voided match re-orders the standings the instant it leaves
``completed``, with no bookkeeping to keep in step (ADR-0788, "everything derives from
the live matches").

This slice implements only :class:`RoundRobinResults`.
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


def results_for(draw_type: DrawType) -> RoundRobinResults:
    """The results strategy for this draw type.

    An exhaustive ``match`` with **no catch-all**, exactly as
    ``app.draws.strategy_for``: adding a member to
    :class:`~app.models.tournament.DrawType` makes this fail to type-check until the
    member is handled, so a new format cannot read out its results silently
    unimplemented. The formats without a strategy yet raise
    :class:`UnsupportedResultsType` — a catchable domain error, not a 500.

    Only round-robin has one today, so the return type is concrete; a second draw type
    lands its own strategy and widens this the way ``strategy_for`` already is.
    """
    match draw_type:
        case DrawType.round_robin:
            return RoundRobinResults()
        case (
            DrawType.single_elim
            | DrawType.double_elim
            | DrawType.rr_then_ko
            | DrawType.swiss
        ):
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
    return int.from_bytes(stat.entry_id.bytes, "big")
