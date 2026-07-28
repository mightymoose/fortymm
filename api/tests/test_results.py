"""Pure tests for the results strategies (ADR-0788 round-robin, ADR-0785 single-elim,
ADR 20260727 round-robin-then-knockout).

No database: ``app.results`` is pure, so every rule about how a pool stands or a bracket
finishes is exercised against literal :class:`~app.results.MatchOutcome` /
:class:`~app.results.PoolInput` / :class:`~app.results.BracketFixture` value objects —
the same shape the BFF projects from completed matches. The ordering/placement is
hand-computed in each test's docstring so a green assertion means the *table* (or the
*finishes*) is right, not merely that some deterministic order came out.
"""

import uuid

from app.draws import EntryId, PoolId
from app.models.tournament import DrawType
from app.results import (
    BracketFixture,
    MatchOutcome,
    PoolInput,
    RoundRobinResults,
    RrThenKoResults,
    SingleElimResults,
    results_for,
)


def _eid(n: int) -> EntryId:
    """A stable entry id — ``uuid.UUID(int=n)`` — so the final id tiebreak is a fact of
    the test, not of ``uuid4``'s luck."""
    return EntryId(uuid.UUID(int=n))


A, B, C, D, E, F = (_eid(n) for n in range(1, 7))


def _outcome(
    first: EntryId, second: EntryId, first_games: int, second_games: int
) -> MatchOutcome:
    """One decided fixture: ``first`` took ``first_games``, ``second`` took
    ``second_games``; the winner is whoever took more (the boards below are all
    decisive)."""
    return MatchOutcome(
        entry_a_id=first,
        entry_b_id=second,
        entry_a_games=first_games,
        entry_b_games=second_games,
    )


def _single_pool(
    entrants: tuple[EntryId, ...],
    fixture_count: int,
    outcomes: list[MatchOutcome],
) -> PoolInput:
    return PoolInput(
        pool_id=PoolId("p-a"),
        entrants=entrants,
        fixture_count=fixture_count,
        outcomes=tuple(outcomes),
    )


def _order(pool: PoolInput) -> list[EntryId]:
    (standings,) = RoundRobinResults().tabulate([pool]).pools
    return [row.entry_id for row in standings.rows]


def test_results_for_returns_the_round_robin_strategy() -> None:
    assert isinstance(results_for(DrawType.round_robin), RoundRobinResults)


def test_results_for_returns_the_single_elim_strategy() -> None:
    assert isinstance(results_for(DrawType.single_elim), SingleElimResults)


def test_results_for_returns_the_rr_then_ko_strategy() -> None:
    """The third arm (ADR 20260727) — a two-stage event reads out as both blocks."""
    assert isinstance(results_for(DrawType.rr_then_ko), RrThenKoResults)


def test_every_draw_type_reads_out_and_none_refuses() -> None:
    """``results_for`` is **total** — the enum holds only draw types that run (ADR "a
    draw type is a seeded row, and the enum holds only what runs"), so every member has
    a results strategy and there is no ``UnsupportedResultsType`` left to raise.

    This replaces the old parametrized refusal test, whose subjects (``double_elim`` /
    ``rr_then_ko`` / ``swiss``) are no longer enum members. It reds if a member is added
    without a results strategy, which is the claim that refusal was really protecting.
    """
    for draw_type in DrawType:
        assert results_for(draw_type) is not None


def test_orders_by_wins_descending() -> None:
    """Three players, all matches played, distinct win counts: A wins both, B wins one,
    C wins none. Order is purely by wins — A, B, C — no tiebreak needed."""
    pool = _single_pool(
        (A, B, C),
        fixture_count=3,
        outcomes=[
            _outcome(A, B, 2, 0),
            _outcome(A, C, 2, 0),
            _outcome(B, C, 2, 0),
        ],
    )
    assert _order(pool) == [A, B, C]
    (standings,) = RoundRobinResults().tabulate([pool]).pools
    assert [(r.wins, r.losses, r.rank) for r in standings.rows] == [
        (2, 0, 1),
        (1, 1, 2),
        (0, 2, 3),
    ]


def test_two_way_tie_on_wins_is_broken_head_to_head_over_game_difference() -> None:
    """A and B both finish on 2 wins; C and D on 1 each. The head-to-head rule ranks a
    two-way tie by who beat whom, **ahead of** game difference — and here it has to
    override it:

    * A beat B, beat C, lost to D  → 2 wins, games 5–3 (diff **+2**)
    * B lost to A, beat C, beat D  → 2 wins, games 5–2 (diff **+3**)

    On game difference alone B (+3) would outrank A (+2); but A won their head-to-head,
    so A is first and B second. C and D are a second two-way tie on 1 win, and C beat D,
    so C is third and D fourth. Final table: A, B, C, D."""
    outcomes = [
        _outcome(A, B, 2, 1),  # A beat B
        _outcome(A, C, 2, 0),  # A beat C
        _outcome(D, A, 2, 1),  # D beat A
        _outcome(B, C, 2, 0),  # B beat C
        _outcome(B, D, 2, 0),  # B beat D
        _outcome(C, D, 2, 1),  # C beat D
    ]
    pool = _single_pool((A, B, C, D), fixture_count=6, outcomes=outcomes)
    (standings,) = RoundRobinResults().tabulate([pool]).pools
    assert [(r.entry_id, r.wins, r.game_difference) for r in standings.rows] == [
        (A, 2, 2),
        (B, 2, 3),
        (C, 1, -3),
        (D, 1, -2),
    ]


def test_three_way_tie_is_not_broken_head_to_head_and_falls_to_game_difference() -> (
    None
):
    """The cyclic case head-to-head must refuse: A beat B, B beat C, C beat A — each on
    one win, a rock-paper-scissors that has no head-to-head winner. So the three-way tie
    falls straight through to game difference rather than a cycle:

    * A: beat B 2–0, lost to C 0–2 → diff **0**
    * B: lost to A 0–2, beat C 2–1 → diff **-1**
    * C: lost to B 1–2, beat A 2–0 → diff **+1**

    Order by game difference: C, A, B."""
    outcomes = [
        _outcome(A, B, 2, 0),
        _outcome(B, C, 2, 1),
        _outcome(C, A, 2, 0),
    ]
    pool = _single_pool((A, B, C), fixture_count=3, outcomes=outcomes)
    assert _order(pool) == [C, A, B]


def test_game_difference_ties_break_on_games_won() -> None:
    """Mid-pool, A and B each have one win and have **not** met — a two-way tie on wins
    whose head-to-head is unplayed, so it falls to game difference, then to games won. A
    won 3–1, B won 2–0: both +2 game difference, but A took **3** games to B's **2**, so
    games won puts A first. (C and D, both winless and not yet met, tie behind them.)"""
    outcomes = [
        _outcome(A, C, 3, 1),
        _outcome(B, D, 2, 0),
    ]
    pool = _single_pool((A, B, C, D), fixture_count=6, outcomes=outcomes)
    (standings,) = RoundRobinResults().tabulate([pool]).pools
    assert [(r.entry_id, r.game_difference, r.games_won) for r in standings.rows] == [
        (A, 2, 3),
        (B, 2, 2),
        (C, -2, 1),
        (D, -2, 0),
    ]


def test_partial_standings_seat_unplayed_entrants_and_are_incomplete() -> None:
    """Mid-pool: only A–B has been played (A won 2–0); C has not played at all. Every
    seated entrant still has a row — C appears with zeros — the pool is **not**
    complete, and there is no champion yet.

    B and C are level on zero wins and have not met, so their two-way tie cannot be
    broken head-to-head; it falls to game difference, where C (0) sits above B (-2).
    Order: A, C, B."""
    pool = _single_pool(
        (A, B, C),
        fixture_count=3,
        outcomes=[_outcome(A, B, 2, 0)],
    )
    results = RoundRobinResults().tabulate([pool])
    (standings,) = results.pools
    assert [r.entry_id for r in standings.rows] == [A, C, B]
    assert [(r.entry_id, r.played) for r in standings.rows] == [
        (A, 1),
        (C, 0),
        (B, 1),
    ]
    assert standings.complete is False
    assert results.complete is False
    assert results.champion is None


def test_a_complete_single_pool_event_has_a_champion() -> None:
    """Every fixture decided in a single pool → the event is complete and its leader is
    champion. A wins both, so A is champion."""
    pool = _single_pool(
        (A, B, C),
        fixture_count=3,
        outcomes=[
            _outcome(A, B, 2, 0),
            _outcome(A, C, 2, 0),
            _outcome(B, C, 2, 0),
        ],
    )
    results = RoundRobinResults().tabulate([pool])
    assert results.complete is True
    assert results.champion == A


def test_a_complete_multi_pool_event_crowns_no_single_champion() -> None:
    """Two pools, both fully played: the event is complete, but a multi-pool round-robin
    has no single champion (that needs a knockout stage to join the pool winners), so
    ``champion`` is ``None`` while each pool still has its own leader."""
    pool_a = PoolInput(
        pool_id=PoolId("p-a"),
        entrants=(A, B),
        fixture_count=1,
        outcomes=(_outcome(A, B, 2, 0),),
    )
    pool_b = PoolInput(
        pool_id=PoolId("p-b"),
        entrants=(C, D),
        fixture_count=1,
        outcomes=(_outcome(C, D, 2, 0),),
    )
    results = RoundRobinResults().tabulate([pool_a, pool_b])
    assert results.complete is True
    assert results.champion is None
    assert [pool.rows[0].entry_id for pool in results.pools] == [A, C]


def test_a_corrected_result_re_orders_the_standings() -> None:
    """Nothing is snapshotted, so a correction is just a re-tabulation over the new
    outcomes (ADR-0788). A beats B → A leads; correct the match to B beating A and
    re-tabulate → B leads. The table follows the live result with no bookkeeping."""
    entrants = (A, B)
    before = _single_pool(entrants, fixture_count=1, outcomes=[_outcome(A, B, 2, 0)])
    assert RoundRobinResults().tabulate([before]).champion == A

    after = _single_pool(entrants, fixture_count=1, outcomes=[_outcome(A, B, 0, 2)])
    assert RoundRobinResults().tabulate([after]).champion == B


# ----- single-elimination finishes (ADR-0785) --------------------------------


def _bracket_match(
    round_number: int, winner: EntryId, loser: EntryId
) -> BracketFixture:
    """A decided bracket fixture: ``winner`` took 2 games, ``loser`` 0 (a decisive
    board), in the given round. Only the round and who-lost matter to the finishes; the
    games merely decide the winner off the same :class:`MatchOutcome` the pools use."""
    return BracketFixture(
        round=round_number,
        outcome=MatchOutcome(
            entry_a_id=winner,
            entry_b_id=loser,
            entry_a_games=2,
            entry_b_games=0,
        ),
    )


def _bracket_tbd(round_number: int) -> BracketFixture:
    """An as-yet-undecided fixture — no match completed. It still fixes the bracket's
    depth (its round) so the finishes measure positions from the real final round even
    before that fixture is played."""
    return BracketFixture(round=round_number, outcome=None)


def test_an_eight_entrant_bracket_places_every_round() -> None:
    """A full 8-seed bracket, top seed winning throughout (3 rounds — QF, SF, final):

    * QF (round 1): 1 beats 8, 4 beats 5, 3 beats 6, 2 beats 7 → losers 8,5,6,7 out;
    * SF (round 2): 1 beats 4, 2 beats 3 → losers 4,3 out;
    * final (round 3): 1 beats 2 → 2 is runner-up, 1 is champion.

    Finishes place by the round eliminated in, same-round losers **tied**: champion 1,
    runner-up 2, the two semifinal losers tied **3**, the four quarterfinal losers tied
    **5** — no 4th and no 6th/7th/8th, because the format never ranked them."""
    s = [_eid(n) for n in range(1, 9)]  # s[0]..s[7] are seeds 1..8
    s1, s2, s3, s4, s5, s6, s7, s8 = s
    fixtures = [
        _bracket_match(1, s1, s8),
        _bracket_match(1, s4, s5),
        _bracket_match(1, s3, s6),
        _bracket_match(1, s2, s7),
        _bracket_match(2, s1, s4),
        _bracket_match(2, s2, s3),
        _bracket_match(3, s1, s2),
    ]
    results = SingleElimResults().tabulate(fixtures)

    assert results.complete is True
    assert results.champion == s1
    positions = {row.entry_id: row.position for row in results.finishes}
    assert positions == {
        s1: 1,
        s2: 2,
        s3: 3,
        s4: 3,
        s5: 5,
        s6: 5,
        s7: 5,
        s8: 5,
    }
    # The champion was never eliminated; every loser carries the round they lost in.
    rounds = {row.entry_id: row.eliminated_in_round for row in results.finishes}
    assert rounds == {
        s1: None,
        s2: 3,
        s3: 2,
        s4: 2,
        s5: 1,
        s6: 1,
        s7: 1,
        s8: 1,
    }
    # Ranked by position ascending — ties adjacent, never interleaved.
    assert [row.position for row in results.finishes] == [1, 2, 3, 3, 5, 5, 5, 5]


def test_a_partial_eight_entrant_bracket_places_only_the_eliminated() -> None:
    """Mid-bracket: all four quarterfinals decided and one semifinal, the other
    semifinal and the final still to play. The final fixture already exists (TBD), so it
    still fixes the depth at 3 rounds — the QF losers place **5th**, the one decided SF
    loser **3rd**.

    Nobody still alive (the two finalists-to-be and the undecided semifinalist) has a
    finish yet, and there is no champion until the final is played."""
    s = [_eid(n) for n in range(1, 9)]
    s1, s2, s3, s4, s5, s6, s7, s8 = s
    fixtures = [
        _bracket_match(1, s1, s8),
        _bracket_match(1, s4, s5),
        _bracket_match(1, s3, s6),
        _bracket_match(1, s2, s7),
        _bracket_match(2, s1, s4),  # one semifinal decided
        _bracket_tbd(2),  # the other semifinal — still to play
        _bracket_tbd(3),  # the final — still to play
    ]
    results = SingleElimResults().tabulate(fixtures)

    assert results.complete is False
    assert results.champion is None
    positions = {row.entry_id: row.position for row in results.finishes}
    assert positions == {
        s4: 3,  # the decided semifinal's loser
        s5: 5,
        s6: 5,
        s7: 5,
        s8: 5,
    }, "only eliminated entrants have a finish; the still-alive ones are absent"


def test_a_two_entrant_bracket_is_champion_and_runner_up() -> None:
    """The smallest bracket — one final (round 1 is the final): the winner is champion
    (1), the loser runner-up (2). No semifinal or quarterfinal positions exist."""
    final = _bracket_match(1, A, B)
    results = SingleElimResults().tabulate([final])

    assert results.complete is True
    assert results.champion == A
    assert {row.entry_id: row.position for row in results.finishes} == {A: 1, B: 2}
    assert {row.entry_id: row.eliminated_in_round for row in results.finishes} == {
        A: None,
        B: 1,
    }


def test_an_unplayed_bracket_has_no_finishes_and_no_champion() -> None:
    """A cut-but-unplayed 4-seed bracket (two semifinals and a final, all TBD): the
    depth is known but nobody has been eliminated, so there are no finishes and no
    champion — the bracket's live, partial state before its first result."""
    fixtures = [_bracket_tbd(1), _bracket_tbd(1), _bracket_tbd(2)]
    results = SingleElimResults().tabulate(fixtures)

    assert results.finishes == ()
    assert results.complete is False
    assert results.champion is None


def test_a_corrected_final_re_crowns_the_champion() -> None:
    """Nothing is snapshotted (ADR-0785), so a correction is just a re-tabulation. A
    beats B in the final → A champion, B runner-up; correct the final to B beating A and
    re-tabulate → B champion, A runner-up. The finishes follow the live result."""
    before = SingleElimResults().tabulate([_bracket_match(1, A, B)])
    assert before.champion == A
    assert {row.entry_id: row.position for row in before.finishes} == {A: 1, B: 2}

    after = SingleElimResults().tabulate([_bracket_match(1, B, A)])
    assert after.champion == B
    assert {row.entry_id: row.position for row in after.finishes} == {B: 1, A: 2}


# ----- round-robin then knockout: both stages at once (ADR 20260727) ----------
#
# The two-stage event every test below reads (except the single-pool one) is the same
# one, at different moments:
#
#   pool P (A, B, C) and pool Q (D, E, F), K = 2 qualifiers each → a 4-slot bracket.
#   Both pools are won on a clean sweep: A beats B and C, B beats C  → A, B, C;
#                                        D beats E and F, E beats F  → D, E, F.
#   So the qualifiers are A and B out of P, D and E out of Q.
#   Semifinals (round 1): A beats E, B beats D.   Final (round 2): **B beats A**.
#
# B is deliberately pool P's *runner-up*: the champion of this event is neither pool's
# leader, which is the whole point — a champion read off the standings would name A
# (or nobody, since a multi-pool round-robin crowns none), never B.

_POOL_P = PoolInput(
    pool_id=PoolId("p-p"),
    entrants=(A, B, C),
    fixture_count=3,
    outcomes=(
        MatchOutcome(entry_a_id=A, entry_b_id=B, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=A, entry_b_id=C, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=B, entry_b_id=C, entry_a_games=2, entry_b_games=0),
    ),
)
_POOL_Q = PoolInput(
    pool_id=PoolId("p-q"),
    entrants=(D, E, F),
    fixture_count=3,
    outcomes=(
        MatchOutcome(entry_a_id=D, entry_b_id=E, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=D, entry_b_id=F, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=E, entry_b_id=F, entry_a_games=2, entry_b_games=0),
    ),
)


def _part_played(pool: PoolInput) -> PoolInput:
    """The same pool with only its first fixture decided — a live, mid-pool table."""
    return PoolInput(
        pool_id=pool.pool_id,
        entrants=pool.entrants,
        fixture_count=pool.fixture_count,
        outcomes=pool.outcomes[:1],
    )


#: The bracket as cut: two semifinals and a final, every side TBD, nobody qualified yet.
_UNPLAYED_BRACKET = [_bracket_tbd(1), _bracket_tbd(1), _bracket_tbd(2)]
#: Both semifinals decided (A beat E, B beat D), the final still to play.
_SEMIS_ONLY = [_bracket_match(1, A, E), _bracket_match(1, B, D), _bracket_tbd(2)]
#: The whole knockout stage: B beats A in the final.
_FULL_BRACKET = [*_SEMIS_ONLY[:2], _bracket_match(2, B, A)]


def test_rr_then_ko_reads_out_both_stages_in_one_tabulation() -> None:
    """The headline claim: **one** tabulation returns the pool stage's standings *and*
    the knockout stage's finishes.

    Both pools stand exactly as a round-robin's do (A, B, C and D, E, F), and the
    bracket places exactly as a single-elim's do — champion B (1), runner-up A (2), the
    two semifinal losers D and E tied 3rd. C and F never qualified, so they hold a
    standings row and **no finish**: a knockout finish is a fact about the bracket, not
    about the event's field."""
    results = RrThenKoResults().tabulate([_POOL_P, _POOL_Q], _FULL_BRACKET)

    assert [pool.pool_id for pool in results.pools] == [PoolId("p-p"), PoolId("p-q")]
    assert [[row.entry_id for row in pool.rows] for pool in results.pools] == [
        [A, B, C],
        [D, E, F],
    ]
    assert {row.entry_id: row.position for row in results.finishes} == {
        B: 1,
        A: 2,
        D: 3,
        E: 3,
    }


def test_rr_then_ko_champion_is_the_bracket_winner_not_the_pool_leader() -> None:
    """The champion comes from the **bracket**, never from a pool (CONTEXT.md,
    "Champion").

    Every pool is won by somebody else: P by A, Q by D. B — P's *runner-up* — wins the
    knockout, so B is the event's champion. A champion read off the standings would
    name A or D (or ``None``, which is what a multi-pool round-robin crowns); only
    reading the final's winner names B."""
    results = RrThenKoResults().tabulate([_POOL_P, _POOL_Q], _FULL_BRACKET)

    assert results.champion == B
    pool_leaders = [pool.rows[0].entry_id for pool in results.pools]
    assert pool_leaders == [A, D]
    assert results.champion not in pool_leaders


def test_rr_then_ko_with_pools_part_played_stands_live_with_no_finishes() -> None:
    """Pools mid-play, nobody qualified: the standings are live and partial, the bracket
    is cut but empty.

    Only A–B has been played in each pool, so every seated entrant still has a row (C
    and F on zeros) and neither pool is complete. No knockout fixture is decided, so
    there are no finishes, no champion, and the event is not complete."""
    results = RrThenKoResults().tabulate(
        [_part_played(_POOL_P), _part_played(_POOL_Q)], _UNPLAYED_BRACKET
    )

    assert [len(pool.rows) for pool in results.pools] == [3, 3]
    assert [pool.complete for pool in results.pools] == [False, False]
    assert results.finishes == ()
    assert results.champion is None
    assert results.complete is False


def test_rr_then_ko_with_the_bracket_part_played_has_finishes_but_no_champion() -> None:
    """Pools decided, knockout mid-flight: standings complete, finishes partial, still
    no champion.

    Both semifinals are in (A beat E, B beat D) but the final is not, so D and E are
    placed — tied 3rd, measured from the final round the TBD final fixes — while A and B
    are still alive and have no finish at all. The champion is the final's winner, so it
    is ``None`` until that final is decided, and the event is not complete."""
    results = RrThenKoResults().tabulate([_POOL_P, _POOL_Q], _SEMIS_ONLY)

    assert [pool.complete for pool in results.pools] == [True, True]
    assert {row.entry_id: row.position for row in results.finishes} == {D: 3, E: 3}
    assert results.champion is None
    assert results.complete is False


def test_rr_then_ko_is_complete_only_when_both_stages_are() -> None:
    """``complete`` is **both stages decided**, asserted separately.

    Three states of the same event: pools decided and the bracket mid-flight → not
    complete; the bracket decided while a pool is not → **not complete either**, even
    though the champion is already known, because the pool stage this shape was handed
    has not finished; both decided → complete. (The middle state is unreachable
    through ``RrThenKoStrategy``, which seats nobody out of an unfinished pool — which
    is exactly why ``complete`` must not lean on that invariant to hold.)"""
    pools_only = RrThenKoResults().tabulate([_POOL_P, _POOL_Q], _SEMIS_ONLY)
    assert pools_only.complete is False

    bracket_only = RrThenKoResults().tabulate(
        [_part_played(_POOL_P), _POOL_Q], _FULL_BRACKET
    )
    assert bracket_only.champion == B, "the knockout stage did finish"
    assert bracket_only.complete is False, "but a pool has not, so the event has not"

    both = RrThenKoResults().tabulate([_POOL_P, _POOL_Q], _FULL_BRACKET)
    assert both.complete is True


def test_rr_then_ko_with_a_single_pool_is_a_league_then_a_playoff() -> None:
    """One pool is legal (ADR 20260727) — a league, then a playoff — and it reads out
    like any other two-stage event.

    A four-player pool, all six fixtures played on clean sweeps → A, B, C, D. The top
    two qualify and meet in a one-fixture bracket, where **B beats A**. So the league
    leader is A and the champion is B: the pool stage seeds the playoff, it does not win
    it. (This is the case a pool-derived champion gets *wrong* rather than empty — a
    complete single-pool round-robin does crown its leader, and that leader is A.)"""
    pool = _single_pool(
        (A, B, C, D),
        fixture_count=6,
        outcomes=[
            _outcome(A, B, 2, 0),
            _outcome(A, C, 2, 0),
            _outcome(A, D, 2, 0),
            _outcome(B, C, 2, 0),
            _outcome(B, D, 2, 0),
            _outcome(C, D, 2, 0),
        ],
    )
    results = RrThenKoResults().tabulate([pool], [_bracket_match(1, B, A)])

    (standings,) = results.pools
    assert [row.entry_id for row in standings.rows] == [A, B, C, D]
    assert RoundRobinResults().tabulate([pool]).champion == A, (
        "the pool stage on its own would crown its leader"
    )
    assert results.champion == B, "but the event's champion is the playoff's winner"
    assert {row.entry_id: row.position for row in results.finishes} == {B: 1, A: 2}
    assert results.complete is True
