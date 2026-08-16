"""Pure tests for the shared finishing orders (ADR 20260727) — the round-robin group
chain and the swiss one.

Three properties are pinned here, because they are load-bearing for
round-robin-then-knockout and for swiss, and none is observable from
``tests/test_results.py``:

**The module stays importable on its own** — no runtime reach into ``app.results``,
``app.draws``, SQLAlchemy or FastAPI. That is what lets the *draw* layer call it
without an import cycle (``app.results`` already imports ``app.draws``).

**The group chain's order is exactly wins → head-to-head → game difference →
games won → entry id.** rr-then-ko's whole correctness claim is that the qualifiers
are the top *K* of the standings table on screen, so a silently reordered chain
changes who advances.

**The swiss chain's is that chain with Buchholz between head-to-head and game
difference** (ADR "swiss standings add Buchholz, and head-to-head is guarded on having
met"), and the head-to-head link is **guarded on the pair having a result between
them** — swiss pairs by score, so two entrants can finish level on wins having never
played each other, and its last-resort rematch lets a pair meet twice and take one each.
Counting **every** meeting rather than the first one found is also what keeps that link
order-independent, and so what keeps the draw layer's answer and the results layer's the
same one.

Each test below isolates **one** link: the case is built so that link alone separates
the pair, and so the *later* links — including the entry-id fallback — would give the
opposite answer if the link under test were removed.
"""

import subprocess
import sys
import uuid
from pathlib import Path

import app.group_finishing_order
from app.draws import (
    EntryId,
    FixtureGames,
    FixtureId,
    FixtureState,
    MatchId,
    GroupId,
    _swiss_standings_order,
)
from app.group_finishing_order import (
    EntryTally,
    MatchOutcome,
    finishing_order,
    swiss_finishing_order,
)
from app.results import FieldInput, GroupInput, RoundRobinResults, SwissResults

_API_ROOT = Path(__file__).resolve().parent.parent

# Imported in a *clean* interpreter, then asked what else came along for the ride.
# The module name is echoed first so a subprocess that silently did nothing cannot
# masquerade as a pass.
_PURITY_PROBE = """
import sys

import app.group_finishing_order as module

forbidden = ("app.draws", "app.results", "sqlalchemy", "fastapi")
print(module.__name__)
print(module.__file__)
print(",".join(sorted(name for name in forbidden if name in sys.modules)))
"""


def _eid(n: int) -> EntryId:
    """A stable entry id — ``uuid.UUID(int=n)`` — so the final id tiebreak is a fact
    of the test, not of ``uuid4``'s luck. Bigger ``n`` sorts later."""
    return EntryId(uuid.UUID(int=n))


def _outcome(
    first: EntryId, second: EntryId, first_games: int, second_games: int
) -> MatchOutcome:
    """One decided fixture: ``first`` took ``first_games`` games, ``second`` took
    ``second_games``; the winner is whoever took more."""
    return MatchOutcome(
        entry_a_id=first,
        entry_b_id=second,
        entry_a_games=first_games,
        entry_b_games=second_games,
    )


def _order(entrants: list[EntryId], outcomes: list[MatchOutcome]) -> list[EntryId]:
    """The **round-robin** chain's order: wins → head-to-head → game difference →
    games won → entry id."""
    return [tally.entry_id for tally in finishing_order(entrants, outcomes)]


def _swiss_order(
    entrants: list[EntryId],
    outcomes: list[MatchOutcome],
    byes: list[EntryId] | None = None,
) -> list[EntryId]:
    """The **swiss** chain's order — the one above with Buchholz between head-to-head
    and game difference, and byes scored as wins worth zero games."""
    return [
        standing.tally.entry_id
        for standing in swiss_finishing_order(entrants, outcomes, byes or ())
    ]


def _tally(
    entrants: list[EntryId],
    outcomes: list[MatchOutcome],
    byes: list[EntryId],
    of: EntryId,
) -> EntryTally:
    return next(
        standing.tally
        for standing in swiss_finishing_order(entrants, outcomes, byes)
        if standing.tally.entry_id == of
    )


def _buchholz(
    entrants: list[EntryId],
    outcomes: list[MatchOutcome],
    byes: list[EntryId],
    of: EntryId,
) -> int:
    return next(
        standing.buchholz
        for standing in swiss_finishing_order(entrants, outcomes, byes)
        if standing.tally.entry_id == of
    )


#: The four entrants of the rematch cases below. ``_A`` carries the smallest id, so the
#: entry-id fallback always says ``_A`` first — which is what makes an answer of ``_B``
#: first evidence of the link under test rather than of the fallback.
_A, _B, _C, _D = _eid(1), _eid(2), _eid(3), _eid(4)


def _split_rematch() -> tuple[list[EntryId], list[MatchOutcome]]:
    """A four-entrant swiss in which A and B met **twice and took one each**, with the
    outcomes in the order the results layer reads them (round, then position).

    Read the arithmetic in
    :func:`test_a_split_rematch_leaves_the_head_to_head_undecided`, which is the test
    the field is shaped for; the other two read the same field from the draw layer and
    from the results layer.
    """
    return (
        [_A, _B, _C, _D],
        [
            _outcome(_A, _B, 3, 1),
            _outcome(_C, _D, 3, 0),
            _outcome(_A, _D, 3, 0),
            _outcome(_B, _C, 3, 0),
            _outcome(_B, _A, 3, 1),
        ],
    )


def _fixture(
    round_number: int,
    position: int,
    first: EntryId,
    second: EntryId,
    first_games: int,
    second_games: int,
) -> FixtureState:
    """One decided, ungrouped fixture as the **draw** layer holds it — the row shape
    :func:`app.draws._swiss_standings_order` projects its outcomes from."""
    slot = round_number * 16 + position
    return FixtureState(
        fixture_id=FixtureId(uuid.UUID(int=0xF000 + slot)),
        group_id=None,
        round=round_number,
        position=position,
        entry_a_id=first,
        entry_b_id=second,
        winner_entry_id=first if first_games > second_games else second,
        match_id=MatchId(uuid.UUID(int=0xE000 + slot)),
        games=FixtureGames(entry_a_games=first_games, entry_b_games=second_games),
    )


def test_the_shared_module_imports_no_layer_that_imports_it() -> None:
    """The no-cycle property, guarded.

    ``app.group_finishing_order`` exists so that **both** ``app.results`` and
    ``app.draws`` can reach one definition of how a group finished. ``app.results``
    already imports ``app.draws``, so the moment this module imports either of them
    at runtime the draw layer's use of it becomes an import cycle — and the
    ``TYPE_CHECKING`` guard on ``EntryId`` is the only thing preventing that today.
    SQLAlchemy and FastAPI are checked too: this module must stay pure enough to run
    in a REPL or a script with no app wiring.

    **The subprocess is load-bearing.** Asserting inside the test process is
    worthless — pytest has already imported ``app.results``, SQLAlchemy and FastAPI
    via ``conftest`` before this line runs, so ``sys.modules`` would show them no
    matter what this module does. Only a fresh interpreter can answer the question.
    """
    probe = subprocess.run(
        [sys.executable, "-c", _PURITY_PROBE],
        capture_output=True,
        text=True,
        cwd=_API_ROOT,
    )
    assert probe.returncode == 0, probe.stderr
    imported_name, imported_file, leaked = probe.stdout.splitlines()
    # Provenance: the subprocess imported *this* worktree's module, not some other
    # copy on the path — otherwise a green result is about the wrong artifact.
    assert imported_name == "app.group_finishing_order"
    assert imported_file == app.group_finishing_order.__file__
    assert leaked == "", f"group_finishing_order pulled in {leaked} at import time"


def test_game_difference_outranks_games_won() -> None:
    """Game difference is the **third** link and games won the fourth, in that order.

    X and Y are level on wins (1 each) in a three-way group, so head-to-head is not
    consulted. X has the better game difference (+3 vs +1) and Y the better games-won
    (5 vs 3), so the two comparators disagree and only their *order* decides. The ids
    disagree as well — ascending id would be Z, Y, W, X — so the deterministic
    fallback cannot be producing this answer by luck.

        X beat W 3-0   → X: 1-0, GW 3, GL 0, GD +3
        Y beat Z 3-1   ┐
        W beat Y 3-2   ┴ Y: 1-1, GW 5, GL 4, GD +1;  W: 1-1, GW 3, GL 5, GD -2
                         Z: 0-1, GW 1, GL 3, GD -2
    """
    x, y, w, z = _eid(9), _eid(2), _eid(5), _eid(1)
    outcomes = [_outcome(x, w, 3, 0), _outcome(y, z, 3, 1), _outcome(w, y, 3, 2)]

    # Game difference first: X (+3), Y (+1), W (-2). Were games won tried first it
    # would be Y (5), X (3), W (3).
    assert _order([w, x, y, z], outcomes) == [x, y, w, z]


def test_head_to_head_outranks_the_game_tiebreakers_for_a_tied_pair() -> None:
    """Head-to-head is the **second** link, ahead of both game tiebreakers.

    P and Q are the only entries on 1 win, so the group is exactly two and they have
    met. Q is ahead of P on game difference (+2 vs +1), on games won (5 vs 3) *and*
    on entry id (3 vs 8) — every later link says Q. P is above Q solely because P
    beat Q, so dropping the head-to-head flips the pair.

        P beat Q 3-2   → P: 1-0, GW 3, GL 2, GD +1
        Q beat R 3-0   → Q: 1-1, GW 5, GL 3, GD +2;  R: 0-1, GW 0, GL 3
    """
    p, q, r = _eid(8), _eid(3), _eid(1)
    outcomes = [_outcome(p, q, 3, 2), _outcome(q, r, 3, 0)]

    assert _order([p, q, r], outcomes) == [p, q, r]


def test_a_three_way_tie_is_not_broken_head_to_head() -> None:
    """The head-to-head link applies to a pair and **only** a pair.

    A beat B, B beat C, C beat A — a cycle, so there is no head-to-head answer to
    have. All three are identical on wins, game difference and games won, so the
    order falls all the way through to the entry id.
    """
    a, b, c = _eid(2), _eid(5), _eid(7)
    outcomes = [_outcome(a, b, 3, 1), _outcome(b, c, 3, 1), _outcome(c, a, 3, 1)]

    assert _order([c, b, a], outcomes) == [a, b, c]


def test_the_entry_id_is_the_final_deterministic_tiebreak() -> None:
    """Entries level on every count still order the same way on every read.

    The same cyclic group as above, all three on 1-1 with GD 0 and 4 games won, fed in
    **descending** id order. Python's sort is stable, so without the id fallback the
    result would simply be the input order — the assertion is that it is the reverse.
    """
    a, b, c = _eid(2), _eid(5), _eid(7)
    outcomes = [_outcome(a, b, 3, 1), _outcome(b, c, 3, 1), _outcome(c, a, 3, 1)]

    fed_in = [c, b, a]
    assert _order(fed_in, outcomes) == list(reversed(fed_in))


def test_a_bye_counts_as_a_win() -> None:
    """A bye is a **win** in the first link of the swiss chain (ADR "swiss standings add
    Buchholz"), because a player must not be punished for a scheduling artifact they
    did not cause.

    Built so the win alone moves B, and moves them *past somebody*. Counting the bye
    puts B in C's wins group, where B ranks above; not counting it drops B into the
    group below C entirely — second place to third, overtaken by the player they are
    level with.

    **B and C have identical Buchholz (2 each)**, deliberately: the link above game
    difference must not be the one separating them, or this would pin Buchholz rather
    than the bye. Their entry ids disagree with the answer too (B's is the largest of
    the four), so the deterministic fallback is not producing it either.

        A beat B 3-2, A beat C 3-0  → A: 2-0
        C beat D 3-2                → C: 1-1, GW 3, GL 5, GD -2;  Buchholz A(2)+D(0)=2
                                      D: 0-1, GW 2, GL 3, GD -1
        B sat out                   → B: 1-1 (the bye is the win), GW 2, GL 3, GD -1;
                                      Buchholz A(2) = 2
    """
    a, b, c, d = _eid(1), _eid(4), _eid(2), _eid(3)
    outcomes = [_outcome(a, b, 3, 2), _outcome(a, c, 3, 0), _outcome(c, d, 3, 2)]

    assert _swiss_order([a, b, c, d], outcomes, byes=[b]) == [a, b, c, d]
    # And the same field with the bye unscored, which is what the assertion above is
    # worth: B falls behind the entrant they outrank on every count but the win.
    assert _swiss_order([a, b, c, d], outcomes) == [a, c, b, d]


def test_a_bye_is_worth_zero_games_not_a_nominal_win() -> None:
    """**The half of the rule that a passing test can easily miss.** A bye adds a win
    and *no games*, so it stays neutral on game difference and games won — the links
    below it.

    Awarding a nominal 3-0 instead would be invisible in the wins column and decisive
    here: A and B are level on wins, have never met (B was byed, so head-to-head has
    nothing to read), and A's real 3-1 win gives them a difference of +2. A phantom
    3-0 would give B +3 and put the player who sat out above the player who went and
    won a match.

        A beat C 3-1  → A: 1-0, GW 3, GL 1, GD +2
                        C: 0-1, GW 1, GL 3, GD -2
        B sat out     → B: 1-0 by bye, GW 0, GL 0, GD 0  (a nominal 3-0 would be +3)
    """
    a, b, c = _eid(1), _eid(2), _eid(3)
    outcomes = [_outcome(a, c, 3, 1)]

    # A and B are level on Buchholz too — A's only opponent (C) has no wins, and B has
    # no opponent at all — so game difference is what separates them, which is exactly
    # the link a phantom 3-0 would corrupt.
    assert _swiss_order([a, b, c], outcomes, byes=[b]) == [a, b, c]

    tally = _tally([a, b, c], outcomes, [b], of=b)
    assert (tally.wins, tally.games_won, tally.games_lost) == (1, 0, 0)
    assert tally.game_difference == 0, "the bye moves neither game counter"


def test_a_bye_leaves_the_row_reading_played_once_and_won_once() -> None:
    """``played`` moves with the win, so the row still satisfies the arithmetic every
    other row on the table does: played equals wins plus losses. A row reading "played
    0, won 1" is what a director would report as a bug in the standings."""
    a, b = _eid(1), _eid(2)

    tally = _tally([a, b], [], [b], of=b)

    assert (tally.played, tally.wins, tally.losses) == (1, 1, 0)


def test_two_byes_count_twice() -> None:
    """Byes arrive one id per bye taken, so an entrant who has sat out twice is
    credited twice — the multiset is the whole meaning of that argument."""
    a, b = _eid(1), _eid(2)

    tally = _tally([a, b], [], [b, b], of=b)

    assert (tally.played, tally.wins) == (2, 2)


def test_a_bye_does_not_reach_the_head_to_head_link() -> None:
    """A bye has no opponent, so it cannot be read as a result *against* anybody. B
    and C are tied on wins — C's from a real match, B's from a bye — and the pair have
    never met, so the head-to-head link falls through, past a Buchholz they are level on
    (C's only opponent D has no wins, B has no opponent), to the game tiebreakers, where
    C's +1 outranks B's 0. A bye that leaked into head-to-head could only invent a
    result nobody played."""
    b, c, d = _eid(1), _eid(2), _eid(3)
    outcomes = [_outcome(c, d, 3, 2)]

    assert _swiss_order([b, c, d], outcomes, byes=[b]) == [c, b, d]


def test_buchholz_outranks_game_difference() -> None:
    """**Buchholz is the third link of the swiss chain and game difference the fourth.**

    X and Y are level on one win each and have never met. X beat the field's strongest
    player, Y beat its weakest, so Buchholz says X (2 against 0). Every link *below* it
    says Y: game difference (+3 against +1), and the entry id (Y's is the smaller). So
    only the position of Buchholz in the chain can put X above Y.

        S beat T 3-0, S beat W 3-0  → S: 2-1
        X beat S 3-2                → X: 1-0, GD +1;  Buchholz S(2) = 2
        Y beat W 3-0                → Y: 1-0, GD +3;  Buchholz W(0) = 0
                                      W: 0-2,  T: 0-1

    The same field through the **round-robin** chain, which has no Buchholz link, comes
    out the other way — which is the whole reason swiss has a chain of its own.
    """
    s, x, y, t, w = _eid(5), _eid(9), _eid(1), _eid(3), _eid(2)
    entrants = [s, x, y, t, w]
    outcomes = [
        _outcome(s, t, 3, 0),
        _outcome(s, w, 3, 0),
        _outcome(x, s, 3, 2),
        _outcome(y, w, 3, 0),
    ]

    assert _swiss_order(entrants, outcomes) == [s, x, y, w, t]
    # Margin, not strength of schedule: Y's +3 beats X's +1, and W (GD -6) drops below
    # T (GD -3) for the same reason.
    assert _order(entrants, outcomes) == [s, y, x, t, w]


def test_head_to_head_outranks_buchholz() -> None:
    """**Head-to-head is the second link and Buchholz the third**, so a pair who have
    met are settled by the match rather than by the field around them.

    P and Q are the only two on one win and they played each other. Q is ahead of P on
    Buchholz (3 against 1), on game difference (+2 against +1), on games won (5 against
    3) and on entry id — every link but one says Q. P is above Q only because P beat Q.

        P beat Q 3-2                → P: 1-0, GW 3, GD +1;  Buchholz Q(1) = 1
        Q beat S 3-0                → Q: 1-1, GW 5, GD +2;  Buchholz P(1)+S(2) = 3
        S beat T 3-0, S beat U 3-0  → S: 2-1;  T and U: 0-1
    """
    s, p, q, t, u = _eid(5), _eid(9), _eid(1), _eid(6), _eid(7)
    entrants = [s, p, q, t, u]
    outcomes = [
        _outcome(p, q, 3, 2),
        _outcome(q, s, 3, 0),
        _outcome(s, t, 3, 0),
        _outcome(s, u, 3, 0),
    ]

    assert _swiss_order(entrants, outcomes) == [s, p, q, t, u]


def test_a_tied_pair_who_never_met_fall_through_the_head_to_head_link() -> None:
    """**The guard.** A swiss pair can finish level on wins having never been drawn
    against each other — the format pairs by score and makes no claim to have played
    every pair — so the head-to-head link has to be able to say "there is no result
    here" and fall through.

    X and Y are the only two on one win, and their opponents were different players.
    Fed in as ``[x, y, …]``, so a head-to-head step that answered *anything* for a pair
    that never met would leave them in that order; the chain's real answer is Y first,
    on the Buchholz its fall-through reaches (2 against 0). Both later links — game
    difference (+3 against +2) and the entry id (X's is smaller) — say X, so nothing
    below Buchholz can be producing this either.

        S beat T 3-0, S beat U 3-0  → S: 2-1
        X beat W 3-0                → X: 1-0, GD +3;  Buchholz W(0) = 0
        Y beat S 3-1                → Y: 1-0, GD +2;  Buchholz S(2) = 2

    The step is shared machinery, so the group chain is guarded by the same lines — a
    part-played round-robin reaches it, and a finished one cannot.
    """
    s, x, y, t, u, w = _eid(5), _eid(1), _eid(9), _eid(6), _eid(7), _eid(8)
    entrants = [x, y, s, t, u, w]
    outcomes = [
        _outcome(s, t, 3, 0),
        _outcome(s, u, 3, 0),
        _outcome(x, w, 3, 0),
        _outcome(y, s, 3, 1),
    ]

    assert _swiss_order(entrants, outcomes)[:3] == [s, y, x]


def test_a_split_rematch_leaves_the_head_to_head_undecided() -> None:
    """**A pair who met twice and took one each did not beat each other**, so the link
    has nothing to say and the chain carries on to Buchholz.

    Swiss pairs a rematch as a last resort when the walk runs out of fresh opponents,
    so a pair *can* meet twice — and reading only one of the two meetings makes the
    answer depend on which meeting the caller happened to list first. Here A won the
    first meeting and B the second, and they are the only two on two wins.

        A beat B 3-1, B beat A 3-1   → A: 2-1, GW 7, GL 4, GD +3
                                       B: 2-1, GW 7, GL 4, GD +3
        A beat D 3-0                 → Buchholz A = B(2) + B(2) + D(0) = 4
        B beat C 3-0                 → Buchholz B = A(2) + A(2) + C(1) = 5
        C beat D 3-0                 → C: 1-1,  D: 0-2

    Buchholz says B, and it is the only link that separates them: they are level on
    game difference (+3) and games won (7), and the entry-id fallback says A. So an
    implementation that answered the head-to-head from *either* meeting gets a
    different order — and one that answered it from the **first** meeting in the list
    gets a different order depending on the order it was handed.
    """
    entrants, outcomes = _split_rematch()

    assert _swiss_order(entrants, outcomes) == [_B, _A, _C, _D]
    assert _swiss_order(entrants, list(reversed(outcomes))) == [_B, _A, _C, _D], (
        "the order must not depend on which meeting the caller listed first"
    )


def test_a_decisive_rematch_ranks_the_side_that_won_both_above() -> None:
    """The other half: a pair who met twice and one of them won **both** *did* beat the
    other, so head-to-head still settles them.

    A won both meetings 3-2. Every link below head-to-head says B — game difference
    (+4 against +2), with Buchholz level at four apiece — so the pair only comes out
    A-first because the two meetings are counted and A took both.

        A beat B 3-2 twice  → A: 2-0, GW 6, GL 4, GD +2;  Buchholz B(2) + B(2) = 4
        B beat C 3-0        → B: 2-2, GW 10, GL 6, GD +4; Buchholz A(2) + A(2)
        B beat D 3-0                                              + C(0) + D(0) = 4
                            → C: 0-1,  D: 0-1
    """
    entrants = [_A, _B, _C, _D]
    outcomes = [
        _outcome(_A, _B, 3, 2),
        _outcome(_B, _C, 3, 0),
        _outcome(_A, _B, 3, 2),
        _outcome(_B, _D, 3, 0),
    ]

    assert _swiss_order(entrants, outcomes) == [_A, _B, _C, _D]
    assert _swiss_order(entrants, list(reversed(outcomes))) == [_A, _B, _C, _D]


def test_a_split_rematch_orders_the_draw_layer_and_the_results_layer_alike() -> None:
    """**The two layers rank one table**, over the case that used to be able to part
    them.

    The results layer reads its fixtures ordered (round, then position); the draw layer
    reads the same rows to decide which order the next round is paired down. A
    head-to-head answered from the first meeting in the list made that a question about
    which row came back first, so the director's table and the pairing could disagree —
    and the draw layer's answer could differ between two advances of the same event.

    Both layers are asked here, and the draw layer is asked a second time with its rows
    **reversed** — the shape an unordered ``SELECT`` is free to hand it.
    """
    entrants, outcomes = _split_rematch()
    fixtures = [
        _fixture(1, 1, _A, _B, 3, 1),
        _fixture(1, 2, _C, _D, 3, 0),
        _fixture(2, 1, _A, _D, 3, 0),
        _fixture(2, 2, _B, _C, 3, 0),
        _fixture(3, 1, _B, _A, 3, 1),
    ]

    table = SwissResults().tabulate(
        FieldInput(entrants=tuple(entrants), fixture_count=5, outcomes=tuple(outcomes))
    )

    assert [row.entry_id for row in table.rows] == [_B, _A, _C, _D]
    assert _swiss_standings_order(entrants, fixtures, ()) == [_B, _A, _C, _D]
    assert _swiss_standings_order(entrants, list(reversed(fixtures)), ()) == [
        _B,
        _A,
        _C,
        _D,
    ], "an unordered fixture load must not move the pairing order"


def test_buchholz_counts_an_opponents_bye_win() -> None:
    """**The amendment.** Buchholz sums the wins the standings *display*, and a bye is
    one of them (ADR "swiss standings add Buchholz…", amended 2026-08-05).

    Y has one real win and one bye, so Y's row reads two wins. X played Y and nobody
    else with a win, so X's Buchholz is that same two. An implementation that stripped
    bye wins out of the sum — the alternative the ADR rejects — would answer one, and a
    director adding up their opponents' win columns would get an answer the table
    disagrees with.

        Y beat X 3-0  → Y: 1-0 on the day
        X beat Z 3-0  → X: 1-1
        Y sat out     → Y: 2-0, the second win from the bye
    """
    x, y, z = _eid(1), _eid(2), _eid(3)
    outcomes = [_outcome(y, x, 3, 0), _outcome(x, z, 3, 0)]

    assert _buchholz([x, y, z], outcomes, [y], of=x) == 2


def test_a_bye_adds_no_term_to_its_holders_buchholz() -> None:
    """The other half of the rule: a bye produced **no opponent**, so it contributes
    nothing to the byed entrant's own sum.

    Y's only opponent is X, who has one win, so Y's Buchholz is exactly one — the bye
    adds no term of its own. It is the same fixture as the test above, read from the
    other side.
    """
    x, y, z = _eid(1), _eid(2), _eid(3)
    outcomes = [_outcome(y, x, 3, 0), _outcome(x, z, 3, 0)]

    assert _buchholz([x, y, z], outcomes, [y], of=y) == 1


def test_the_standings_table_is_this_order() -> None:
    """The standings a director reads *are* the shared finishing order.

    This is the claim rr-then-ko's qualifiers rest on: the top *K* of a group is the
    top *K* of the table on screen, because ``RoundRobinResults`` ranks by nothing
    else. Asserting the two agree keeps the standings from acquiring a private
    tiebreak of their own.
    """
    x, y, w, z = _eid(9), _eid(2), _eid(5), _eid(1)
    entrants = [w, x, y, z]
    outcomes = [_outcome(x, w, 3, 0), _outcome(y, z, 3, 1), _outcome(w, y, 3, 2)]
    group = GroupInput(
        group_id=GroupId(uuid.uuid4()),
        entrants=tuple(entrants),
        fixture_count=6,
        outcomes=tuple(outcomes),
    )

    results = RoundRobinResults().tabulate([group])

    rows = results.groups[0].rows
    assert [row.entry_id for row in rows] == _order(entrants, outcomes)
    assert [row.rank for row in rows] == [1, 2, 3, 4]
