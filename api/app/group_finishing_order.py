"""How a **field finished** — the one definition of the tiebreak chains that order a
round-robin group's entrants and a swiss event's, shared by the draw layer and the
results layer.

Two layers need this answer and they must never disagree about it. ``app.results``
reads it out as a group's **standings** table, the thing a director is looking at on
screen; ``app.draws`` needs the same order to decide which entrants *qualify* out of a
group into a knockout stage. If each computed its own, "the qualifiers" and "the top of
the table" could differ at precisely the moment somebody is looking hardest — a
three-way tie for the last qualifying spot. One function, imported by both, makes them
the same order **structurally**, not by two implementations happening to agree (ADR
20260727, "the group finishing order moves to a shared pure module").

It lives in its own module rather than in either caller because ``app.results`` already
imports ``app.draws``: putting the order in ``app.results`` would make the draw layer's
use of it an import cycle. For the same reason this module imports **nothing** from
``app.draws`` at runtime — :class:`~app.draws.EntryId` is a ``NewType`` over
``uuid.UUID``, needed only as a *type*, so it is imported under ``TYPE_CHECKING`` and
the draw layer can import this module freely.

Like ``app.draws`` and ``app.results``, this module is **pure**: no session, no query,
no SQLAlchemy or FastAPI construct. Its whole input is the group's seated entrants plus
the :class:`MatchOutcome`\\ s of its **currently-completed** matches, so nothing here is
a snapshot — a corrected or voided match re-derives the order the instant it leaves
``completed``.

There are **two** chains, one per format, and they live side by side on purpose: they
share every step but one, and a reader has to be able to see both at once to keep them
in step (ADR "swiss standings add Buchholz, and head-to-head is guarded on having met").

:func:`finishing_order` — a **round-robin group**:

1. **wins** — most match wins first;
2. **head-to-head**, *only when exactly two entries are tied* on wins **and one of them
   won more of their meetings than the other** — that one ranks above. It counts every
   meeting rather than one, because swiss pairs a rematch as a last resort and a pair
   who met twice and took one each did not beat each other: a split falls through, like
   a pair who never met at all. A three-or-more-way tie can cycle (A beat B beat C beat
   A), so it is **not** broken head-to-head; it falls straight through to the game
   tiebreakers rather than a recursive mini-league;
3. **game difference** — games won minus games lost;
4. **games won**;
5. the **entry id** — a total, deterministic fallback, so a group in which two entries
   are genuinely level on every count still orders the same way on every read.

:func:`swiss_finishing_order` — a **swiss field**: the same chain with **Buchholz**
between steps 2 and 3, and byes scored into step 1.

The two share their machinery rather than agreeing by coincidence: one grouping by
wins, one guarded head-to-head step, one tail of scalar comparators ending in the entry
id. The swiss chain is that tail with one value in front of it.

**The head-to-head step is guarded on the pair having a result between them**, in *both*
chains, and that is a property of the step rather than a swiss carve-out. A round-robin
group cannot reach the guard once it is played out — everyone meets everyone, once — so
it costs that format nothing, while a swiss pair tied on wins may never have been drawn
against each other and there is simply no result to read. (A part-played group reaches it
too, which is why the guard predates swiss.) Swiss adds the second way through it: a
pair who met **twice** and took one each are level between themselves, so the step has
no answer there either.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
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
    # ``tests/test_group_finishing_order.py`` pins.
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
    """A mutable per-entry accumulator — what one entry has done in its group so far.

    Built and mutated inside :func:`_tallies`, which both orders start from; callers
    only ever see the finished list. Every entrant seated in the field gets one,
    including a player who has not played yet (a row of zeros), so the order is a
    *live, partial* one.
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


@dataclass(frozen=True, slots=True)
class SwissTally:
    """One entry's swiss line: the tally every format keeps, plus the **Buchholz**
    figure only swiss ranks on.

    Composed rather than a subclass of :class:`EntryTally`, so there is exactly one
    definition of "wins" and one of "game difference" — the divergence this module
    exists to prevent — and so a group's row cannot acquire a Buchholz of ``0`` that
    really means "never computed".

    ``buchholz`` rides on the row rather than staying inside the sort, because a
    director has to be able to *see* the number that ordered the table: it is the one
    link in the swiss chain that cannot be recomputed from the counts beside it."""

    tally: EntryTally
    buchholz: int


# The tiebreak chain, after wins (which groups) and the two-way head-to-head (which
# refines a pair): each entry maps to a value where HIGHER is better, tried in order.
# A new comparator is **appended** here, not surgically inserted between the existing
# ones — the chain is data, so extending it touches nothing already in it (ADR-0788).
# Swiss ranks on the same two, in the same order, with Buchholz in front of them
# (:func:`_swiss_scalar_key`) — so the two formats share this tail rather than agreeing
# about it.
_TIEBREAKERS: tuple[Callable[[EntryTally], int], ...] = (
    lambda tally: tally.game_difference,
    lambda tally: tally.games_won,
)


def finishing_order(
    entrants: Iterable[EntryId],
    outcomes: Sequence[MatchOutcome],
) -> list[EntryTally]:
    """The group's finishing order: its ``entrants`` tallied from ``outcomes``, then
    ordered by the round-robin chain in this module's docstring.

    ``entrants`` is the full seated field — not just the entries that have played — so
    the returned list always covers the whole group. First place is index ``0``.

    ``outcomes`` may only name entries that are in ``entrants``: the tallies are keyed
    by entrant, so a stranger is a ``KeyError`` rather than a row appearing from
    nowhere.

    It takes **no byes**, and that is a fact about the format rather than an omission: a
    round-robin's byed entrant sits out one round of a schedule that seats them in every
    other, so there is no result to credit. Only swiss scores one — see
    :func:`swiss_finishing_order`.
    """
    return _order(list(_tallies(entrants, outcomes).values()), outcomes, _scalar_key)


def swiss_finishing_order(
    entrants: Iterable[EntryId],
    outcomes: Sequence[MatchOutcome],
    byes: Iterable[EntryId] = (),
) -> list[SwissTally]:
    """A swiss field's finishing order: its ``entrants`` tallied from ``outcomes`` and
    ``byes``, ordered by the swiss chain — wins, guarded head-to-head, **Buchholz**,
    game difference, games won, entry id — with each row's Buchholz figure attached.

    Its ``entrants`` and ``outcomes`` mean exactly what they mean in
    :func:`finishing_order`, and first place is index ``0`` there too. The two
    differences are the ones the format forces:

    **Buchholz sits above game difference** (ADR "swiss standings add Buchholz, and
    head-to-head is guarded on having met"). Swiss deliberately pairs you against
    players on your own score, so two entrants level on wins may have faced completely
    different halves of the field; game difference would rank them by margin against
    unequal opposition. Buchholz measures who you had to beat, which in a format that
    pairs by score is the stronger signal. A round-robin has no such thing to measure —
    everybody plays everybody, so every entrant's opposition is identical — which is why
    this link exists on one chain and not the other.

    **Byes are scored**, as a win worth zero games. They arrive as a flat sequence of
    entry ids, **one per bye taken**, so an entrant who has sat out twice appears twice,
    and they may only name entries that are in ``entrants``. They are derived rather
    than stored — a bye is the absence of a fixture row (CONTEXT.md, "Bye"), so the byed
    entrant is the one with no fixture that round — by :func:`app.draws.swiss_byes`,
    once, for both callers. Empty for an even field.

    ``byes`` **defaults to empty**, which is safe here for a reason that does not
    travel: this is one free function, so an omission is a caller declining to pass a
    value at one call site — visible in the diff, and "no byes" is the truth of an even
    field. Contrast :meth:`app.draws.DrawStrategy.advance`, where the field is a
    **required** parameter precisely because that is a ``Protocol`` with four
    implementations: there, a default would let an implementation omit the parameter
    from its own signature and still type-check.
    """
    tallies = _tallies(entrants, outcomes, byes)
    buchholz = _buchholz(tallies, outcomes)
    return [
        SwissTally(tally=tally, buchholz=buchholz[tally.entry_id])
        for tally in _order(
            list(tallies.values()), outcomes, _swiss_scalar_key(buchholz)
        )
    ]


def _tallies(
    entrants: Iterable[EntryId],
    outcomes: Sequence[MatchOutcome],
    byes: Iterable[EntryId] = (),
) -> dict[EntryId, EntryTally]:
    """Every entrant's accumulator, folded from the results they have — the one place a
    row's counts are built, so the two chains cannot disagree about what a win is."""
    tallies: dict[EntryId, EntryTally] = {
        entry_id: EntryTally(entry_id=entry_id) for entry_id in entrants
    }
    for outcome in outcomes:
        _record_outcome(
            tallies[outcome.entry_a_id], tallies[outcome.entry_b_id], outcome
        )
    for entry_id in byes:
        _record_bye(tallies[entry_id])
    return tallies


def _buchholz(
    tallies: Mapping[EntryId, EntryTally], outcomes: Sequence[MatchOutcome]
) -> dict[EntryId, int]:
    """Each entrant's **Buchholz**: the sum of their opponents' win counts.

    The wins summed are ``tallies[...].wins`` — **the same wins column the standings
    display, bye wins included** (ADR "swiss standings add Buchholz", amended).
    Stripping a bye win out would put two definitions of "wins" in one module, and would
    break the arithmetic a director does to check the figure by adding up their
    opponents' win columns. The cost is that whoever played the byed entrant is credited
    very slightly high, which is bounded at one win per opponent and lands arbitrarily
    rather than systematically.

    A **bye adds no term to its own holder's sum**: it produced no opponent, so there is
    nothing to add. That falls out of summing over ``outcomes``, which a bye is not in,
    rather than needing a case.

    A **rematch counts twice** — swiss allows one as a last resort, and iterating the
    outcomes credits that opponent's wins once per meeting. That is the standard reading
    (Buchholz is a sum over games played, not over distinct opponents), and the ADR does
    not settle it either way.

    It is computed after the tallies are complete, never incrementally: an opponent's
    later win changes an entrant's Buchholz without that entrant playing, which is
    inherent to the measure.
    """
    totals = {entry_id: 0 for entry_id in tallies}
    for outcome in outcomes:
        totals[outcome.entry_a_id] += tallies[outcome.entry_b_id].wins
        totals[outcome.entry_b_id] += tallies[outcome.entry_a_id].wins
    return totals


def _record_outcome(a: EntryTally, b: EntryTally, outcome: MatchOutcome) -> None:
    """Fold one decided fixture into both sides' tallies.

    Private, like every other step of the order: :func:`finishing_order` and
    :func:`swiss_finishing_order` are the module's verbs and the accumulator is their
    internals. Nothing outside builds a tally, so a
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
    tallies: list[EntryTally],
    outcomes: Sequence[MatchOutcome],
    scalar_key: Callable[[EntryTally], tuple[int, ...]],
) -> list[EntryTally]:
    """Group by wins (descending), then break each tie.

    ``scalar_key`` is the *only* thing that differs between the two formats' chains —
    :func:`_scalar_key` for a group, :func:`_swiss_scalar_key`'s closure for a swiss
    field — so the first two links, wins and the guarded head-to-head, are shared
    structurally rather than written twice and kept in step by hand.
    """
    by_wins: dict[int, list[EntryTally]] = defaultdict(list)
    for tally in tallies:
        by_wins[tally.wins].append(tally)
    ordered: list[EntryTally] = []
    for wins in sorted(by_wins, reverse=True):
        ordered.extend(_break_tie(by_wins[wins], outcomes, scalar_key))
    return ordered


def _break_tie(
    group: list[EntryTally],
    outcomes: Sequence[MatchOutcome],
    scalar_key: Callable[[EntryTally], tuple[int, ...]],
) -> list[EntryTally]:
    """Order a group of entries level on wins.

    A **two-way** tie is broken head-to-head when one of the pair won more of their
    meetings than the other — that one ranks above. A larger tie (which can cycle), a
    two-way tie whose pair has not met, and a two-way tie whose pair split their
    meetings evenly all fall through to ``scalar_key``.

    "When the pair have a result between them" is the guard, and it belongs to the step
    rather than to either format. A part-played round-robin group reaches it, and a swiss
    field reaches it at the end of a completed event too: swiss pairs by score and never
    claims to have drawn every pair together, so two entrants can finish level on wins
    having never played each other — or, after a last-resort rematch, having beaten each
    other once apiece. Without the guard the step would have to read a result that does
    not exist, or pick one of two that disagree.
    """
    if len(group) == 2:
        decided = _head_to_head(group[0], group[1], outcomes)
        if decided is not None:
            return decided
    return sorted(group, key=scalar_key)


def _head_to_head(
    first: EntryTally, second: EntryTally, outcomes: Sequence[MatchOutcome]
) -> list[EntryTally] | None:
    """``[winner, loser]`` if one of these two won **more of their meetings** than the
    other, else ``None``.

    ``None`` covers two cases and they are one answer: the pair have never met (nothing
    to read — the guard :func:`_break_tie` describes), and the pair met an even number
    of times and took half each. A 1-1 split is not one side beating the other, so
    there is no head-to-head result to rank on and the chain carries on to the next
    link, exactly as it does for a pair who never played.

    **Every** meeting is counted, not the first one found, and that is what keeps the
    step order-independent. Swiss pairs a rematch as a last resort once the walk runs
    out of fresh opponents (CONTEXT.md, "Rematch"), so a pair genuinely can meet twice
    — and reading only the first matching outcome made the answer depend on the order
    the caller listed them in. The two callers do not list them alike (each loads its
    own rows, sorted on its own key), so that was the one step in either chain that
    could have parted them: every other link is a sum or a count, and neither cares
    about order. This one now counts too.
    """
    pair = {first.entry_id, second.entry_id}
    wins = 0
    for outcome in outcomes:
        if {outcome.entry_a_id, outcome.entry_b_id} == pair:
            wins += 1 if outcome.winner_entry_id == first.entry_id else -1
    if wins > 0:
        return [first, second]
    if wins < 0:
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


def _swiss_scalar_key(
    buchholz: Mapping[EntryId, int],
) -> Callable[[EntryTally], tuple[int, ...]]:
    """:func:`_scalar_key` with **Buchholz in front of it** — the swiss chain's scalar
    half, built over a field's already-computed figures.

    Prepending is what puts Buchholz *above* game difference: the key is compared
    left-to-right, so a Buchholz that separates the pair settles them before the game
    counts are ever read. The rest of the tuple is the group's own key, not a copy of it,
    so the tail of the two chains is one definition.
    """

    def key(tally: EntryTally) -> tuple[int, ...]:
        return (-buchholz[tally.entry_id], *_scalar_key(tally))

    return key
