"""Pure tests for the shared pool finishing order (ADR 20260727).

Two properties are pinned here, because both are load-bearing for
round-robin-then-knockout and neither is observable from ``tests/test_results.py``:

**The module stays importable on its own** — no runtime reach into ``app.results``,
``app.draws``, SQLAlchemy or FastAPI. That is what lets the *draw* layer call it
without an import cycle (``app.results`` already imports ``app.draws``).

**The tiebreak chain's order is exactly wins → head-to-head → game difference →
games won → entry id.** rr-then-ko's whole correctness claim is that the qualifiers
are the top *K* of the standings table on screen, so a silently reordered chain
changes who advances. Each test below isolates **one** link: the case is built so
that link alone separates the pair, and so the *later* links — including the entry-id
fallback — would give the opposite answer if the link under test were removed.
"""

import subprocess
import sys
import uuid
from pathlib import Path

import app.pool_finishing_order
from app.draws import EntryId, PoolId
from app.pool_finishing_order import MatchOutcome, finishing_order
from app.results import PoolInput, RoundRobinResults

_API_ROOT = Path(__file__).resolve().parent.parent

# Imported in a *clean* interpreter, then asked what else came along for the ride.
# The module name is echoed first so a subprocess that silently did nothing cannot
# masquerade as a pass.
_PURITY_PROBE = """
import sys

import app.pool_finishing_order as module

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
    return [tally.entry_id for tally in finishing_order(entrants, outcomes)]


def test_the_shared_module_imports_no_layer_that_imports_it() -> None:
    """The no-cycle property, guarded.

    ``app.pool_finishing_order`` exists so that **both** ``app.results`` and
    ``app.draws`` can reach one definition of how a pool finished. ``app.results``
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
    assert imported_name == "app.pool_finishing_order"
    assert imported_file == app.pool_finishing_order.__file__
    assert leaked == "", f"pool_finishing_order pulled in {leaked} at import time"


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

    The same cyclic pool as above, all three on 1-1 with GD 0 and 4 games won, fed in
    **descending** id order. Python's sort is stable, so without the id fallback the
    result would simply be the input order — the assertion is that it is the reverse.
    """
    a, b, c = _eid(2), _eid(5), _eid(7)
    outcomes = [_outcome(a, b, 3, 1), _outcome(b, c, 3, 1), _outcome(c, a, 3, 1)]

    fed_in = [c, b, a]
    assert _order(fed_in, outcomes) == list(reversed(fed_in))


def test_the_standings_table_is_this_order() -> None:
    """The standings a director reads *are* the shared finishing order.

    This is the claim rr-then-ko's qualifiers rest on: the top *K* of a pool is the
    top *K* of the table on screen, because ``RoundRobinResults`` ranks by nothing
    else. Asserting the two agree keeps the standings from acquiring a private
    tiebreak of their own.
    """
    x, y, w, z = _eid(9), _eid(2), _eid(5), _eid(1)
    entrants = [w, x, y, z]
    outcomes = [_outcome(x, w, 3, 0), _outcome(y, z, 3, 1), _outcome(w, y, 3, 2)]
    pool = PoolInput(
        pool_id=PoolId("pool-a"),
        entrants=tuple(entrants),
        fixture_count=6,
        outcomes=tuple(outcomes),
    )

    results = RoundRobinResults().tabulate([pool])

    rows = results.pools[0].rows
    assert [row.entry_id for row in rows] == _order(entrants, outcomes)
    assert [row.rank for row in rows] == [1, 2, 3, 4]
