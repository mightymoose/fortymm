"""Pure tests for the results strategies (ADR-0788 round-robin, ADR-0785 single-elim,
ADR 20260727 round-robin-then-knockout).

No database: ``app.results`` is pure, so every rule about how a group stands or a
bracket finishes is exercised against literal :class:`~app.results.MatchOutcome` /
:class:`~app.results.GroupInput` / :class:`~app.results.BracketFixture` value objects —
the same shape the BFF projects from completed matches. The ordering/placement is
hand-computed in each test's docstring so a green assertion means the *table* (or the
*finishes*) is right, not merely that some deterministic order came out.
"""

import uuid

from app.draws import EntryId, GroupId
from app.models.tournament import DrawType
from app.results import (
    BracketFixture,
    FieldInput,
    GroupInput,
    MatchOutcome,
    RoundRobinResults,
    RrThenKoResults,
    SingleElimResults,
    SwissResults,
    results_for,
)


def _eid(n: int) -> EntryId:
    """A stable entry id — ``uuid.UUID(int=n)`` — so the final id tiebreak is a fact of
    the test, not of ``uuid4``'s luck."""
    return EntryId(uuid.UUID(int=n))


def _gid(n: int) -> GroupId:
    """A stable group id. A group id is a ``uuid`` (ADR 20260801) — the
    ``tournament_event_stage_groups`` primary key the server mints — so these stand
    in for it, minted from a fixed integer so a failure names the same group every
    run."""
    return GroupId(uuid.UUID(int=0xB0000 + n))


#: The groups these tests deal in, by the letters their comments call them.
_GROUP_A, _GROUP_B = _gid(1), _gid(2)
_GROUP_P_ID, _GROUP_Q_ID = _gid(3), _gid(4)


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


def _single_group(
    entrants: tuple[EntryId, ...],
    fixture_count: int,
    outcomes: list[MatchOutcome],
) -> GroupInput:
    return GroupInput(
        group_id=_GROUP_A,
        entrants=entrants,
        fixture_count=fixture_count,
        outcomes=tuple(outcomes),
    )


def _order(group: GroupInput) -> list[EntryId]:
    (standings,) = RoundRobinResults().tabulate([group]).groups
    return [row.entry_id for row in standings.rows]


def test_results_for_returns_the_round_robin_strategy() -> None:
    assert isinstance(results_for(DrawType.round_robin), RoundRobinResults)


def test_results_for_returns_the_single_elim_strategy() -> None:
    assert isinstance(results_for(DrawType.single_elim), SingleElimResults)


def test_results_for_returns_the_rr_then_ko_strategy() -> None:
    """The third arm (ADR 20260727) — a two-stage event reads out as both blocks."""
    assert isinstance(results_for(DrawType.rr_then_ko), RrThenKoResults)


def test_results_for_returns_the_swiss_strategy() -> None:
    """The fourth arm (ADR "swiss pre-cuts every round and pairs each one on
    advance") — a group-less event reads out as one table over the whole field."""
    assert isinstance(results_for(DrawType.swiss), SwissResults)


def test_a_swiss_field_stands_in_one_table_ordered_by_the_swiss_chain() -> None:
    """Four entrants over two rounds, no groups: A wins both, B wins one, C wins one, D
    wins none. The table is one list, ordered by swiss's own chain — wins, then (B and C
    having never met, and being level on Buchholz at two apiece) B's better game
    difference.
    """
    field = FieldInput(
        entrants=(A, B, C, D),
        fixture_count=4,
        outcomes=(
            _outcome(A, C, 3, 0),
            _outcome(B, D, 3, 1),
            _outcome(A, B, 3, 2),
            _outcome(C, D, 3, 1),
        ),
    )

    standings = SwissResults().tabulate(field)

    assert [(row.entry_id, row.wins, row.losses) for row in standings.rows] == [
        (A, 2, 0),
        (B, 1, 1),
        (C, 1, 1),
        (D, 0, 2),
    ]
    assert [row.rank for row in standings.rows] == [1, 2, 3, 4]


def test_the_swiss_table_ranks_on_buchholz_and_shows_the_figure() -> None:
    """**Strength of schedule, above margin, and visible.**

    B and C are level on one win each and never met. B beat the field's strongest player
    (A, on two wins), C beat its weakest (E, on none), so Buchholz says B — while game
    difference (+1 against +3) and the entry id both say C. The table puts B second, and
    carries the figure that put them there.

        A beat D 3-0, A beat E 3-0  → A: 2-1
        B beat A 3-2                → B: 1-0, GD +1;  Buchholz A(2) = 2
        C beat E 3-0                → C: 1-0, GD +3;  Buchholz E(0) = 0
                                      D: 0-1,  E: 0-2
    """
    field = FieldInput(
        entrants=(A, B, C, D, E),
        fixture_count=4,
        outcomes=(
            _outcome(A, D, 3, 0),
            _outcome(A, E, 3, 0),
            _outcome(B, A, 3, 2),
            _outcome(C, E, 3, 0),
        ),
    )

    standings = SwissResults().tabulate(field)

    assert [(row.entry_id, row.buchholz) for row in standings.rows] == [
        (A, 1),
        (B, 2),
        (C, 0),
        (E, 3),
        (D, 2),
    ]


def test_a_byed_entrant_is_credited_with_a_win_and_no_games() -> None:
    """The bye reaches the table as a **win worth zero games** (ADR "swiss standings
    add Buchholz"): C sat out round 1 and reads 1-0 with a game difference of zero.

    The rule is pinned link by link in ``tests/test_group_finishing_order.py``; what
    this asserts is that the swiss table actually *passes its byes through*, which is
    the half a test of the chain alone cannot see.
    """
    field = FieldInput(
        entrants=(A, B, C),
        fixture_count=3,
        outcomes=(_outcome(A, B, 3, 1),),
        byes=(C,),
    )

    standings = SwissResults().tabulate(field)

    by_entry = {row.entry_id: row for row in standings.rows}
    assert (by_entry[C].played, by_entry[C].wins, by_entry[C].losses) == (1, 1, 0)
    assert (by_entry[C].games_won, by_entry[C].games_lost) == (0, 0)
    assert by_entry[C].game_difference == 0
    # A won a real match 3-1, so A's +2 outranks the bye's 0 — the two are level on
    # wins, on Buchholz (A's only opponent has no wins; C has no opponent) and have
    # never met. A nominal 3-0 for the bye would put C first.
    assert [row.entry_id for row in standings.rows] == [A, C, B]


def test_a_group_scores_no_byes() -> None:
    """A round-robin group passes none, and that is a fact about the format rather than
    an omission: its byed entrant sits out one round of a schedule that seats them in
    every other, so there is no result to credit. B has played nobody and reads a row
    of zeros."""
    group = _single_group(entrants=(A, B), fixture_count=1, outcomes=[])

    (standings,) = RoundRobinResults().tabulate([group]).groups

    assert all((row.played, row.wins) == (0, 0) for row in standings.rows)


def test_a_swiss_event_is_complete_and_crowned_when_every_round_is_decided() -> None:
    """A swiss ranks the whole field, so its complete table's top row is the champion —
    no single-group carve-out, because there are no groups to have more than one of."""
    field = FieldInput(
        entrants=(A, B),
        fixture_count=1,
        outcomes=(_outcome(A, B, 3, 1),),
    )

    standings = SwissResults().tabulate(field)

    assert standings.complete
    assert standings.champion == A


def test_a_swiss_event_with_rounds_left_is_live_and_uncrowned() -> None:
    """The later rounds are cut up front with their sides unknown, so they *count*
    toward completeness: a draw one round in is a live table, not a finished one, and
    an entrant who has not played yet is on it with a row of zeros."""
    field = FieldInput(
        entrants=(A, B, C, D),
        fixture_count=4,  # two rounds of two, only the first round played
        outcomes=(_outcome(A, B, 3, 0), _outcome(C, D, 3, 2)),
    )

    standings = SwissResults().tabulate(field)

    assert not standings.complete
    assert standings.champion is None
    assert {row.entry_id for row in standings.rows} == {A, B, C, D}


def test_an_uncut_swiss_event_is_not_complete() -> None:
    """``0 == 0`` must not read as finished: an event with no fixture that can still
    yield a result has not been played, it has not been cut."""
    standings = SwissResults().tabulate(
        FieldInput(entrants=(), fixture_count=0, outcomes=())
    )

    assert not standings.complete
    assert standings.champion is None
    assert standings.rows == ()


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
    group = _single_group(
        (A, B, C),
        fixture_count=3,
        outcomes=[
            _outcome(A, B, 2, 0),
            _outcome(A, C, 2, 0),
            _outcome(B, C, 2, 0),
        ],
    )
    assert _order(group) == [A, B, C]
    (standings,) = RoundRobinResults().tabulate([group]).groups
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
    group = _single_group((A, B, C, D), fixture_count=6, outcomes=outcomes)
    (standings,) = RoundRobinResults().tabulate([group]).groups
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
    group = _single_group((A, B, C), fixture_count=3, outcomes=outcomes)
    assert _order(group) == [C, A, B]


def test_game_difference_ties_break_on_games_won() -> None:
    """Mid-group, A and B each have one win and have **not** met — a two-way tie on wins
    whose head-to-head is unplayed, so it falls to game difference, then to games won. A
    won 3–1, B won 2–0: both +2 game difference, but A took **3** games to B's **2**, so
    games won puts A first. (C and D, both winless and not yet met, tie behind them.)"""
    outcomes = [
        _outcome(A, C, 3, 1),
        _outcome(B, D, 2, 0),
    ]
    group = _single_group((A, B, C, D), fixture_count=6, outcomes=outcomes)
    (standings,) = RoundRobinResults().tabulate([group]).groups
    assert [(r.entry_id, r.game_difference, r.games_won) for r in standings.rows] == [
        (A, 2, 3),
        (B, 2, 2),
        (C, -2, 1),
        (D, -2, 0),
    ]


def test_partial_standings_seat_unplayed_entrants_and_are_incomplete() -> None:
    """Mid-group: only A–B has been played (A won 2–0); C has not played at all. Every
    seated entrant still has a row — C appears with zeros — the group is **not**
    complete, and there is no champion yet.

    B and C are level on zero wins and have not met, so their two-way tie cannot be
    broken head-to-head; it falls to game difference, where C (0) sits above B (-2).
    Order: A, C, B."""
    group = _single_group(
        (A, B, C),
        fixture_count=3,
        outcomes=[_outcome(A, B, 2, 0)],
    )
    results = RoundRobinResults().tabulate([group])
    (standings,) = results.groups
    assert [r.entry_id for r in standings.rows] == [A, C, B]
    assert [(r.entry_id, r.played) for r in standings.rows] == [
        (A, 1),
        (C, 0),
        (B, 1),
    ]
    assert standings.complete is False
    assert results.complete is False
    assert results.champion is None


def test_a_complete_single_group_event_has_a_champion() -> None:
    """Every fixture decided in a single group → the event is complete and its leader is
    champion. A wins both, so A is champion."""
    group = _single_group(
        (A, B, C),
        fixture_count=3,
        outcomes=[
            _outcome(A, B, 2, 0),
            _outcome(A, C, 2, 0),
            _outcome(B, C, 2, 0),
        ],
    )
    results = RoundRobinResults().tabulate([group])
    assert results.complete is True
    assert results.champion == A


def test_a_complete_multi_group_event_crowns_no_single_champion() -> None:
    """Two groups, both fully played: the event is complete, but a multi-group
    round-robin has no single champion (that needs a knockout stage to join the
    group winners), so
    ``champion`` is ``None`` while each group still has its own leader."""
    group_a = GroupInput(
        group_id=_GROUP_A,
        entrants=(A, B),
        fixture_count=1,
        outcomes=(_outcome(A, B, 2, 0),),
    )
    group_b = GroupInput(
        group_id=_GROUP_B,
        entrants=(C, D),
        fixture_count=1,
        outcomes=(_outcome(C, D, 2, 0),),
    )
    results = RoundRobinResults().tabulate([group_a, group_b])
    assert results.complete is True
    assert results.champion is None
    assert [group.rows[0].entry_id for group in results.groups] == [A, C]


def test_a_corrected_result_re_orders_the_standings() -> None:
    """Nothing is snapshotted, so a correction is just a re-tabulation over the new
    outcomes (ADR-0788). A beats B → A leads; correct the match to B beating A and
    re-tabulate → B leads. The table follows the live result with no bookkeeping."""
    entrants = (A, B)
    before = _single_group(entrants, fixture_count=1, outcomes=[_outcome(A, B, 2, 0)])
    assert RoundRobinResults().tabulate([before]).champion == A

    after = _single_group(entrants, fixture_count=1, outcomes=[_outcome(A, B, 0, 2)])
    assert RoundRobinResults().tabulate([after]).champion == B


# ----- single-elimination finishes (ADR-0785) --------------------------------


def _bracket_match(
    round_number: int, winner: EntryId, loser: EntryId
) -> BracketFixture:
    """A decided bracket fixture: ``winner`` took 2 games, ``loser`` 0 (a decisive
    board), in the given round. Only the round and who-lost matter to the finishes; the
    games merely decide the winner off the same :class:`MatchOutcome` the groups use."""
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
# The two-stage event every test below reads (except the single-group one) is the same
# one, at different moments:
#
#   group P (A, B, C) and group Q (D, E, F), K = 2 qualifiers each → a 4-slot bracket.
#   Both groups are won on a clean sweep: A beats B and C, B beats C  → A, B, C;
#                                        D beats E and F, E beats F  → D, E, F.
#   So the qualifiers are A and B out of P, D and E out of Q.
#   Semifinals (round 1): A beats E, B beats D.   Final (round 2): **B beats A**.
#
# B is deliberately group P's *runner-up*: the champion of this event is neither group's
# leader, which is the whole point — a champion read off the standings would name A
# (or nobody, since a multi-group round-robin crowns none), never B.

_GROUP_P = GroupInput(
    group_id=_GROUP_P_ID,
    entrants=(A, B, C),
    fixture_count=3,
    outcomes=(
        MatchOutcome(entry_a_id=A, entry_b_id=B, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=A, entry_b_id=C, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=B, entry_b_id=C, entry_a_games=2, entry_b_games=0),
    ),
)
_GROUP_Q = GroupInput(
    group_id=_GROUP_Q_ID,
    entrants=(D, E, F),
    fixture_count=3,
    outcomes=(
        MatchOutcome(entry_a_id=D, entry_b_id=E, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=D, entry_b_id=F, entry_a_games=2, entry_b_games=0),
        MatchOutcome(entry_a_id=E, entry_b_id=F, entry_a_games=2, entry_b_games=0),
    ),
)


def _part_played(group: GroupInput) -> GroupInput:
    """The same group with only its first fixture decided — a live, mid-group table."""
    return GroupInput(
        group_id=group.group_id,
        entrants=group.entrants,
        fixture_count=group.fixture_count,
        outcomes=group.outcomes[:1],
    )


#: The bracket as cut: two semifinals and a final, every side TBD, nobody qualified yet.
_UNPLAYED_BRACKET = [_bracket_tbd(1), _bracket_tbd(1), _bracket_tbd(2)]
#: Both semifinals decided (A beat E, B beat D), the final still to play.
_SEMIS_ONLY = [_bracket_match(1, A, E), _bracket_match(1, B, D), _bracket_tbd(2)]
#: The whole knockout stage: B beats A in the final.
_FULL_BRACKET = [*_SEMIS_ONLY[:2], _bracket_match(2, B, A)]


def test_rr_then_ko_reads_out_both_stages_in_one_tabulation() -> None:
    """The headline claim: **one** tabulation returns the group stage's standings *and*
    the knockout stage's finishes.

    Both groups stand exactly as a round-robin's do (A, B, C and D, E, F), and the
    bracket places exactly as a single-elim's do — champion B (1), runner-up A (2), the
    two semifinal losers D and E tied 3rd. C and F never qualified, so they hold a
    standings row and **no finish**: a knockout finish is a fact about the bracket, not
    about the event's field."""
    results = RrThenKoResults().tabulate([_GROUP_P, _GROUP_Q], _FULL_BRACKET)

    assert [group.group_id for group in results.groups] == [_GROUP_P_ID, _GROUP_Q_ID]
    assert [[row.entry_id for row in group.rows] for group in results.groups] == [
        [A, B, C],
        [D, E, F],
    ]
    assert {row.entry_id: row.position for row in results.finishes} == {
        B: 1,
        A: 2,
        D: 3,
        E: 3,
    }


def test_rr_then_ko_champion_is_the_bracket_winner_not_the_group_leader() -> None:
    """The champion comes from the **bracket**, never from a group (CONTEXT.md,
    "Champion").

    Every group is won by somebody else: P by A, Q by D. B — P's *runner-up* — wins the
    knockout, so B is the event's champion. A champion read off the standings would
    name A or D (or ``None``, which is what a multi-group round-robin crowns); only
    reading the final's winner names B."""
    results = RrThenKoResults().tabulate([_GROUP_P, _GROUP_Q], _FULL_BRACKET)

    assert results.champion == B
    group_leaders = [group.rows[0].entry_id for group in results.groups]
    assert group_leaders == [A, D]
    assert results.champion not in group_leaders


def test_rr_then_ko_with_groups_part_played_stands_live_with_no_finishes() -> None:
    """Groups mid-play, nobody qualified: the standings are live and partial, the
    bracket is cut but empty.

    Only A–B has been played in each group, so every seated entrant still has a row (C
    and F on zeros) and neither group is complete. No knockout fixture is decided, so
    there are no finishes, no champion, and the event is not complete."""
    results = RrThenKoResults().tabulate(
        [_part_played(_GROUP_P), _part_played(_GROUP_Q)], _UNPLAYED_BRACKET
    )

    assert [len(group.rows) for group in results.groups] == [3, 3]
    assert [group.complete for group in results.groups] == [False, False]
    assert results.finishes == ()
    assert results.champion is None
    assert results.complete is False


def test_rr_then_ko_with_the_bracket_part_played_has_finishes_but_no_champion() -> None:
    """Groups decided, knockout mid-flight: standings complete, finishes partial, still
    no champion.

    Both semifinals are in (A beat E, B beat D) but the final is not, so D and E are
    placed — tied 3rd, measured from the final round the TBD final fixes — while A and B
    are still alive and have no finish at all. The champion is the final's winner, so it
    is ``None`` until that final is decided, and the event is not complete."""
    results = RrThenKoResults().tabulate([_GROUP_P, _GROUP_Q], _SEMIS_ONLY)

    assert [group.complete for group in results.groups] == [True, True]
    assert {row.entry_id: row.position for row in results.finishes} == {D: 3, E: 3}
    assert results.champion is None
    assert results.complete is False


def test_rr_then_ko_is_complete_only_when_both_stages_are() -> None:
    """``complete`` is **both stages decided**, asserted separately.

    Three states of the same event: groups decided and the bracket mid-flight → not
    complete; the bracket decided while a group is not → **not complete either**, even
    though the champion is already known, because the group stage this shape was handed
    has not finished; both decided → complete. (The middle state is unreachable
    through ``RrThenKoStrategy``, which seats nobody out of an unfinished group — which
    is exactly why ``complete`` must not lean on that invariant to hold.)"""
    groups_only = RrThenKoResults().tabulate([_GROUP_P, _GROUP_Q], _SEMIS_ONLY)
    assert groups_only.complete is False

    bracket_only = RrThenKoResults().tabulate(
        [_part_played(_GROUP_P), _GROUP_Q], _FULL_BRACKET
    )
    assert bracket_only.champion == B, "the knockout stage did finish"
    assert bracket_only.complete is False, "but a group has not, so the event has not"

    both = RrThenKoResults().tabulate([_GROUP_P, _GROUP_Q], _FULL_BRACKET)
    assert both.complete is True


def test_rr_then_ko_with_a_single_group_is_a_league_then_a_playoff() -> None:
    """One group is legal (ADR 20260727) — a league, then a playoff — and it reads out
    like any other two-stage event.

    A four-player group, all six fixtures played on clean sweeps → A, B, C, D. The top
    two qualify and meet in a one-fixture bracket, where **B beats A**. So the
    league leader is A and the champion is B: the group stage seeds the playoff,
    it does not win it. (This is the case a group-derived champion gets *wrong*
    rather than empty — a
    complete single-group round-robin does crown its leader, and that leader is A.)"""
    group = _single_group(
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
    results = RrThenKoResults().tabulate([group], [_bracket_match(1, B, A)])

    (standings,) = results.groups
    assert [row.entry_id for row in standings.rows] == [A, B, C, D]
    assert RoundRobinResults().tabulate([group]).champion == A, (
        "the group stage on its own would crown its leader"
    )
    assert results.champion == B, "but the event's champion is the playoff's winner"
    assert {row.entry_id: row.position for row in results.finishes} == {B: 1, A: 2}
    assert results.complete is True
