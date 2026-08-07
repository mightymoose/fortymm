"""How a **pool finished** — the one definition of the tiebreak chain that orders a
round-robin pool's entrants, shared by the draw layer and the results layer.

Two layers need this answer and they must never disagree about it. ``app.results``
reads it out as a pool's **standings** table, the thing a director is looking at on
screen; ``app.draws`` needs the same order to decide which entrants *qualify* out of a
pool into a knockout stage. If each computed its own, "the qualifiers" and "the top of
the table" could differ at precisely the moment somebody is looking hardest — a
three-way tie for the last qualifying spot. One function, imported by both, makes them
the same order **structurally**, not by two implementations happening to agree (ADR
20260727, "the pool finishing order moves to a shared pure module").

It lives in its own module rather than in either caller because ``app.results`` already
imports ``app.draws``: putting the order in ``app.results`` would make the draw layer's
use of it an import cycle. For the same reason this module imports **nothing** from
``app.draws`` at runtime — :class:`~app.draws.EntryId` is a ``NewType`` over
``uuid.UUID``, needed only as a *type*, so it is imported under ``TYPE_CHECKING`` and
the draw layer can import this module freely.

Like ``app.draws`` and ``app.results``, this module is **pure**: no session, no query,
no SQLAlchemy or FastAPI construct. Its whole input is the pool's seated entrants plus
the :class:`MatchOutcome`\\ s of its **currently-completed** matches, so nothing here is
a snapshot — a corrected or voided match re-derives the order the instant it leaves
``completed``.

The chain, in order:

1. **wins** — most match wins first, and a **bye counts as one of them**;
2. **head-to-head**, *only when exactly two entries are tied* on wins — the one that
   beat the other ranks above it. A three-or-more-way tie can cycle (A beat B beat C
   beat A), so it is **not** broken head-to-head; it falls straight through to the game
   tiebreakers rather than a recursive mini-league;
3. **game difference** — games won minus games lost;
4. **games won**;
5. the **entry id** — a total, deterministic fallback, so a pool in which two entries
   are genuinely level on every count still orders the same way on every read.

**A bye is a win worth zero games** (ADR "swiss standings add Buchholz, and
head-to-head is guarded on having met"). The win, because a player must not be punished
for a scheduling artifact they did not cause. Zero games, because steps 3 and 4 are the
ones a nominal 3-0 would corrupt: it would hand the byed entrant a game difference
nobody earned, which can lift them above somebody who went out and beat a real
opponent. So a bye moves step 1 and is neutral on everything below it, and it is
slightly *under*-credited — the deliberate direction to err on a result nobody played.

Byes reach here as a **flat sequence of entry ids, one per bye taken**, because they are
derived rather than stored: a bye is the absence of a fixture row (CONTEXT.md, "Bye"),
so the byed entrant is the one with no fixture that round. :func:`app.draws.swiss_byes`
is where that derivation lives, once, for both callers. Round-robin passes none — its
byed entrant sits out one round of a schedule that seats them in every other, which is
not a result and is not scored as one.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Type-only: importing ``app.draws`` at runtime would be the very cycle this
    # module exists to avoid, and ``EntryId`` is a plain ``uuid.UUID`` at runtime.
    #
    # The consequence, deliberately accepted: the annotations below are **not
    # runtime-resolvable**. ``typing.get_type_hints(MatchOutcome)`` raises
    # ``NameError: name 'EntryId' is not defined``, because ``from __future__ import
    # annotations`` leaves them as strings and ``EntryId`` never exists at runtime.
    # Nothing does that today (these are plain dataclasses, and the wire schemas in
    # ``app.schemas.tournament`` are separate Pydantic models). But **do not hand
    # ``MatchOutcome`` — or anything else here — to a Pydantic model, a FastAPI
    # signature, or ``TypeAdapter``**: they all resolve hints at runtime and would
    # fail with that baffling ``NameError`` far from this line. If you need one of
    # these on a wire surface, mirror it as a Pydantic model there; the fix is *not*
    # to un-guard this import, which re-creates the cycle
    # ``tests/test_pool_finishing_order.py`` pins.
    from app.draws import EntryId


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


@dataclass(slots=True)
class EntryTally:
    """A mutable per-entry accumulator — what one entry has done in its pool so far.

    Built and mutated inside :func:`finishing_order`; callers only ever see the
    finished list. Every entrant seated in the pool gets one, including a player who
    has not played yet (a row of zeros), so the order is a *live, partial* one.
    """

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
_TIEBREAKERS: tuple[Callable[[EntryTally], int], ...] = (
    lambda tally: tally.game_difference,
    lambda tally: tally.games_won,
)


def finishing_order(
    entrants: Iterable[EntryId],
    outcomes: Sequence[MatchOutcome],
    byes: Iterable[EntryId] = (),
) -> list[EntryTally]:
    """The pool's finishing order: its ``entrants`` tallied from ``outcomes`` and
    ``byes``, then ordered by the chain in this module's docstring.

    ``entrants`` is the full seated field — not just the entries that have played — so
    the returned list always covers the whole pool. First place is index ``0``.

    ``byes`` names one entry id **per bye taken**, so an entrant who has sat out twice
    appears twice. Empty for every format but swiss, and empty for an even swiss field.
    Both it and ``outcomes`` may only name entries that are in ``entrants``: the tallies
    are keyed by entrant, so a stranger is a ``KeyError`` rather than a row appearing
    from nowhere.

    ``byes`` **defaults to empty**, which is safe here for a reason that does not
    travel: this is one free function, so an omission is a caller declining to pass a
    value at one call site — visible in the diff, and "no byes" is the truth for every
    format but swiss. Contrast :meth:`app.draws.DrawStrategy.advance`, where the field
    is a **required** parameter precisely because that is a ``Protocol`` with four
    implementations: there, a default would let an implementation omit the parameter
    from its own signature and still type-check.
    """
    tallies: dict[EntryId, EntryTally] = {
        entry_id: EntryTally(entry_id=entry_id) for entry_id in entrants
    }
    for outcome in outcomes:
        _record_outcome(
            tallies[outcome.entry_a_id], tallies[outcome.entry_b_id], outcome
        )
    for entry_id in byes:
        _record_bye(tallies[entry_id])
    return _order(list(tallies.values()), outcomes)


def _record_outcome(a: EntryTally, b: EntryTally, outcome: MatchOutcome) -> None:
    """Fold one decided fixture into both sides' tallies.

    Private, like every other step of the order: :func:`finishing_order` is the module's
    verb and the accumulator is its internals. Nothing outside builds a tally, so a
    public one would advertise a protocol no caller wants — and invite a second, partial
    tallying path beside the one definition this module exists to be.
    (:func:`entry_id_order` is the exception, and is public because the *results* layer
    genuinely shares that final tiebreak.)
    """
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


def _record_bye(tally: EntryTally) -> None:
    """Fold one bye into its holder's tally: a **win worth zero games**.

    The three lines this function does *not* have are the point. No ``games_won``,
    because awarding a nominal 3-0 would give the byed entrant a game difference nobody
    earned and float them above a player who beat a real opponent. No ``games_lost``,
    for the mirror reason. No ``losses``, obviously — this is a win.

    ``played`` does move, and it is the one judgement call the ADR leaves open: the
    entrant has a result for that round, and the invariant every other row on the table
    satisfies is ``played == wins + losses``. A row reading "played 0, won 1" would look
    to a director exactly like an arithmetic bug in the standings.
    """
    tally.played += 1
    tally.wins += 1


def entry_id_order(entry_id: EntryId) -> int:
    """A total, deterministic order over entry ids — the final list-order tiebreak both
    shapes fall back to so equal rows never come out in a nondeterministic order."""
    return int.from_bytes(entry_id.bytes, "big")


def _order(
    tallies: list[EntryTally], outcomes: Sequence[MatchOutcome]
) -> list[EntryTally]:
    """Group by wins (descending), then break each tie."""
    by_wins: dict[int, list[EntryTally]] = defaultdict(list)
    for tally in tallies:
        by_wins[tally.wins].append(tally)
    ordered: list[EntryTally] = []
    for wins in sorted(by_wins, reverse=True):
        ordered.extend(_break_tie(by_wins[wins], outcomes))
    return ordered


def _break_tie(
    group: list[EntryTally], outcomes: Sequence[MatchOutcome]
) -> list[EntryTally]:
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
    first: EntryTally, second: EntryTally, outcomes: Sequence[MatchOutcome]
) -> list[EntryTally] | None:
    """``[winner, loser]`` if these two have met, else ``None`` (not yet played)."""
    pair = {first.entry_id, second.entry_id}
    for outcome in outcomes:
        if {outcome.entry_a_id, outcome.entry_b_id} == pair:
            if outcome.winner_entry_id == first.entry_id:
                return [first, second]
            return [second, first]
    return None


def _scalar_key(tally: EntryTally) -> tuple[int, ...]:
    """The tiebreak-chain sort key: each comparator negated (higher is better ⇒
    earlier), then the entry id as the final deterministic tiebreak so the order is
    total."""
    return (
        *(-tiebreaker(tally) for tiebreaker in _TIEBREAKERS),
        entry_id_order(tally.entry_id),
    )
