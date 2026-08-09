"""**The vector table IS the contract** (ADR
``20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors``). The
same cases are asserted against the TypeScript derivation that drives the Draw structure
tab — ``web-client/src/components/tournaments/data/draw-structure.test.ts``, whose
``DRAW_STRUCTURE_VECTORS`` this table transcribes by hand — with identical inputs and
identical expected numbers. A change to the maths that lands on one side and not the
other fails a test.

Three rules keep the two tables readable side by side:

1. **Every vector states all eight inputs.** No defaults builder, no shared base object.
   A hidden ``pool_count_mode=automatic`` is a guess, and DRY is worth less here than
   being readable as a spec.
2. **Every vector states the whole shared result**, in one ``==``.
3. **One parametrize, no per-case test functions with inline numbers.** A reviewer reads
   the two tables side by side; they cannot do that if the cases are scattered.

The case **names and their order match the TypeScript table exactly**, so the two can be
scrolled together.

## What crosses the language boundary, and what does not

The ADR shares the **numbers**, not the **copy**:

- **Shared, and must match exactly:** ``pool_count``, ``pool_sizes``,
  ``qualifiers_per_pool``, ``total_qualifiers``, ``knockout_bracket_size``,
  ``first_round_byes``, ``pool_match_count``, the effective ``ownership``, the numbers
  on ``disagreement``, whether the split is uneven, and the ``kind`` of each impossible
  problem.
- **Client-only, and deliberately not transcribed:** each setting row's *source
  sentence* (there are no rows on the server), the uneven *tally*
  (``2 pools of 6 · 2 pools of 5`` is a notice, and the API does not object to unequal
  pools — only the boolean fact crosses), and each problem's *title* and *body*.

``unevenDistribution !== null`` on that side is ``is_uneven`` on this one, which is the
one field a reader has to map rather than match.

**The problem messages are asserted by calling their builders**, not by re-typing the
strings. The wording is the cut's own, and it is already pinned verbatim by
``test_draws.py``, ``test_tournaments.py``, ``test_rr_then_ko.py``,
``test_schedule_preview_snapshot.py`` and ``test_schedule_preview_solve.py``. A sixth
copy here would pin nothing those do not. What these calls *do* pin is which builder the
derivation reaches for and **which numbers it hands it** — a swapped pair of arguments
reds.

**The unseated-entrants sentence is the exception, and is pinned verbatim at the foot
of this file.** It is new copy with no older home (chore 5c), so calling its builder
here and again at the cut would pin nobody's words. This file is the one place it is
typed out.
"""

from dataclasses import dataclass

import pytest

from app.draw_structure import (
    ONE_PLAYER_KNOCKOUT_MESSAGE,
    DisagreementDirection,
    DrawStructure,
    DrawStructureDisagreement,
    DrawStructureOptions,
    DrawStructureOwnership,
    ImpossibleProblem,
    ImpossibleProblemKind,
    SettingOwnership,
    derive_draw_structure,
    pool_too_small_for_pool_size_message,
    pool_too_small_message,
    too_many_qualifiers_message,
    unseated_entrants_message,
)

AUTOMATIC = SettingOwnership.automatic
MANUAL = SettingOwnership.manual

ALL_AUTOMATIC = DrawStructureOwnership(
    pool_count=AUTOMATIC, pool_size=AUTOMATIC, qualifiers=AUTOMATIC
)


def _pool_problem(field_size: int, pool_count: int) -> tuple[ImpossibleProblem, ...]:
    return (
        ImpossibleProblem(
            kind=ImpossibleProblemKind.pool,
            message=pool_too_small_message(field_size, pool_count),
        ),
    )


def _pool_size_problem(
    field_size: int, pool_size: int
) -> tuple[ImpossibleProblem, ...]:
    """The same pool problem, worded for a pool size the DIRECTOR set.

    Two helpers because the sentence follows the knob that produced the sizes, not the
    condition: a size the director typed is filled greedily, so blaming the pool count
    would name a number they do not own (#1320's own defect). Which vectors use which is
    the contract — a vector that swapped them would be asserting a refusal that
    misattributes.
    """
    return (
        ImpossibleProblem(
            kind=ImpossibleProblemKind.pool,
            message=pool_too_small_for_pool_size_message(field_size, pool_size),
        ),
    )


@dataclass(frozen=True, slots=True)
class DrawStructureVector:
    """What the case is about, in the domain's words, plus its inputs and its result."""

    name: str
    options: DrawStructureOptions
    expected: DrawStructure


#: The shared contract. Mirrored in the client derivation's own table.
DRAW_STRUCTURE_VECTORS: list[DrawStructureVector] = [
    # -----------------------------------------------------------------------------
    # The reference's own five states, plus the ones it does not draw.
    # -----------------------------------------------------------------------------
    DrawStructureVector(
        # The reference's "Nothing set" screen. One pool per reservation row — today's
        # behaviour, kept as the automatic answer.
        name="nothing set: 32 players across 4 pool reservations",
        options=DrawStructureOptions(
            preview_field_size=32,
            pool_reservation_count=4,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=4,
            pool_sizes=(8, 8, 8, 8),
            qualifiers_per_pool=2,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            pool_match_count=112,
            ownership=ALL_AUTOMATIC,
            disagreement=None,
            is_uneven=False,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # Pool count is the director's, pool size is ours: the balanced split, remainder
        # to the EARLIEST pools.
        name="manual pool count only: 40 players across 6 pools",
        options=DrawStructureOptions(
            preview_field_size=40,
            pool_reservation_count=4,
            pool_count_mode=MANUAL,
            manual_pool_count=6,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=6,
            pool_sizes=(7, 7, 7, 7, 6, 6),
            qualifiers_per_pool=2,
            total_qualifiers=12,
            knockout_bracket_size=12,
            first_round_byes=4,
            pool_match_count=114,
            ownership=DrawStructureOwnership(
                pool_count=MANUAL, pool_size=AUTOMATIC, qualifiers=AUTOMATIC
            ),
            disagreement=None,
            # 4 pools of 7 · 2 pools of 6 — the tally is the client's, the fact is ours.
            is_uneven=True,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The other way round: the director's target size derives the count, and 40
        # divides exactly, so nothing is left over.
        name="manual pool size only: 40 players in pools of 5",
        options=DrawStructureOptions(
            preview_field_size=40,
            pool_reservation_count=4,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=MANUAL,
            manual_pool_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=8,
            pool_sizes=(5, 5, 5, 5, 5, 5, 5, 5),
            qualifiers_per_pool=1,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            pool_match_count=80,
            ownership=DrawStructureOwnership(
                pool_count=AUTOMATIC, pool_size=MANUAL, qualifiers=AUTOMATIC
            ),
            disagreement=None,
            is_uneven=False,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The reference's "Numbers disagree" screen. BOTH numbers stand — the sizes stay
        # at the six fives the director asked for, and the ten players with nowhere to
        # go are reported rather than seated by moving somebody's number.
        name="both manual and disagreeing: 6 pools of 5 seat 30 of a 40 field",
        options=DrawStructureOptions(
            preview_field_size=40,
            pool_reservation_count=6,
            pool_count_mode=MANUAL,
            manual_pool_count=6,
            pool_size_mode=MANUAL,
            manual_pool_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=6,
            pool_sizes=(5, 5, 5, 5, 5, 5),
            qualifiers_per_pool=2,
            total_qualifiers=12,
            knockout_bracket_size=12,
            first_round_byes=4,
            pool_match_count=60,
            ownership=DrawStructureOwnership(
                pool_count=MANUAL, pool_size=MANUAL, qualifiers=AUTOMATIC
            ),
            disagreement=DrawStructureDisagreement(
                pool_count=6,
                pool_size=5,
                seats=30,
                field_size=40,
                direction=DisagreementDirection.unseated,
                count=10,
            ),
            is_uneven=False,
            # A disagreement is a call for the director, NOT an impossible competition.
            # Every pool here is playable.
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The disagreement running the other way: more seats than players.
        name="both manual, seats to spare: 8 pools of 5 seat 40 of a 30 field",
        options=DrawStructureOptions(
            preview_field_size=30,
            pool_reservation_count=8,
            pool_count_mode=MANUAL,
            manual_pool_count=8,
            pool_size_mode=MANUAL,
            manual_pool_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=8,
            pool_sizes=(5, 5, 5, 5, 5, 5, 5, 5),
            qualifiers_per_pool=1,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            pool_match_count=80,
            ownership=DrawStructureOwnership(
                pool_count=MANUAL, pool_size=MANUAL, qualifiers=AUTOMATIC
            ),
            disagreement=DrawStructureDisagreement(
                pool_count=8,
                pool_size=5,
                seats=40,
                field_size=30,
                direction=DisagreementDirection.empty_seats,
                count=10,
            ),
            is_uneven=False,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The reference's "Uneven field" screen. Legal, and said out loud — the bigger
        # pools play more matches, and nothing has been silently reshaped.
        name="uneven but legal: 22 players across 4 pools",
        options=DrawStructureOptions(
            preview_field_size=22,
            pool_reservation_count=4,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=4,
            pool_sizes=(6, 6, 5, 5),
            qualifiers_per_pool=2,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            pool_match_count=50,
            ownership=ALL_AUTOMATIC,
            disagreement=None,
            is_uneven=True,
            impossible_problems=(),
        ),
    ),
    # -----------------------------------------------------------------------------
    # The three impossible competitions.
    # -----------------------------------------------------------------------------
    DrawStructureVector(
        # The reference's "Field too small" screen. Four pools of one means the pool
        # rule fires, and that is the only rule left to fire here: the automatic count
        # clamps to the smallest pool, so it is one qualifier out of a pool of one, and
        # ``1 > 1`` is false. The pool-over-qualifier ORDERING now lives in the "empty
        # field" vector below, where one qualifier out of a pool of nobody would fire
        # the qualifier rule and the pool problem wins anyway.
        #
        # The name is kept as the client's table has it, so the two still scroll
        # together, even though the clamp has taken the qualifier half of it away.
        name=(
            "field too small: 8 players across 6 pools reports the pool, "
            "not the qualifier"
        ),
        options=DrawStructureOptions(
            preview_field_size=8,
            pool_reservation_count=6,
            pool_count_mode=MANUAL,
            manual_pool_count=6,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=6,
            pool_sizes=(2, 2, 1, 1, 1, 1),
            qualifiers_per_pool=1,
            total_qualifiers=6,
            knockout_bracket_size=6,
            first_round_byes=2,
            pool_match_count=2,
            ownership=DrawStructureOwnership(
                pool_count=MANUAL, pool_size=AUTOMATIC, qualifiers=AUTOMATIC
            ),
            disagreement=None,
            is_uneven=True,
            impossible_problems=_pool_problem(8, 6),
        ),
    ),
    DrawStructureVector(
        # One pool taking one qualifier. The pools are fine, so the BRACKET rule is the
        # one that fires — and this is one of the two vectors that catch a missing
        # ``max(2, …)`` in the byes formula: ``2 ^ ceil(log2(max(2, 1))) - 1`` is one
        # bye, not none.
        name="one-player knockout: 1 pool taking its top 1",
        options=DrawStructureOptions(
            preview_field_size=8,
            pool_reservation_count=1,
            pool_count_mode=MANUAL,
            manual_pool_count=1,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=1,
        ),
        expected=DrawStructure(
            pool_count=1,
            pool_sizes=(8,),
            qualifiers_per_pool=1,
            total_qualifiers=1,
            knockout_bracket_size=1,
            first_round_byes=1,
            pool_match_count=28,
            ownership=DrawStructureOwnership(
                pool_count=MANUAL, pool_size=AUTOMATIC, qualifiers=MANUAL
            ),
            disagreement=None,
            is_uneven=False,
            impossible_problems=(
                ImpossibleProblem(
                    kind=ImpossibleProblemKind.bracket,
                    message=ONE_PLAYER_KNOCKOUT_MESSAGE,
                ),
            ),
        ),
    ),
    DrawStructureVector(
        # Three through from a pool that only holds two.
        name="too many qualifiers: top 3 from a pool of 2",
        options=DrawStructureOptions(
            preview_field_size=10,
            pool_reservation_count=4,
            pool_count_mode=MANUAL,
            manual_pool_count=4,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=3,
        ),
        expected=DrawStructure(
            pool_count=4,
            pool_sizes=(3, 3, 2, 2),
            qualifiers_per_pool=3,
            total_qualifiers=12,
            knockout_bracket_size=12,
            first_round_byes=4,
            pool_match_count=8,
            ownership=DrawStructureOwnership(
                pool_count=MANUAL, pool_size=AUTOMATIC, qualifiers=MANUAL
            ),
            disagreement=None,
            is_uneven=True,
            impossible_problems=(
                ImpossibleProblem(
                    kind=ImpossibleProblemKind.qualifier,
                    message=too_many_qualifiers_message(3, 2),
                ),
            ),
        ),
    ),
    DrawStructureVector(
        # The SECOND ordering case, and the complete set with the one above: a field of
        # one trips the pool rule and the bracket rule at once, and the pool wins.
        # (There is no reachable bracket-over-qualifier case: ``bracket < 2`` forces
        # one pool taking one, and one qualifier can only exceed a pool of zero, which
        # trips the pool rule first.)
        name="ordering: a field of one is a pool problem, not a bracket problem",
        options=DrawStructureOptions(
            preview_field_size=1,
            pool_reservation_count=1,
            pool_count_mode=MANUAL,
            manual_pool_count=1,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=1,
        ),
        expected=DrawStructure(
            pool_count=1,
            pool_sizes=(1,),
            qualifiers_per_pool=1,
            total_qualifiers=1,
            knockout_bracket_size=1,
            first_round_byes=1,
            pool_match_count=0,
            ownership=DrawStructureOwnership(
                pool_count=MANUAL, pool_size=AUTOMATIC, qualifiers=MANUAL
            ),
            disagreement=None,
            is_uneven=False,
            # Both nouns singular, and the only vector that reaches that inflection.
            impossible_problems=_pool_problem(1, 1),
        ),
    ),
    DrawStructureVector(
        # THE GREEDY EDGE. Nine pools, the ninth holding the one player 41 does not
        # divide into eight fives. A balanced split would give ``5,5,5,5,5,5,5,4,4`` and
        # hide the problem by editing a number the director typed — so the fill stays
        # greedy and the pool of one is reported.
        #
        # And it is reported in the POOL SIZE's words. 41 balanced across nine pools
        # leaves nobody stranded, so the count sentence would blame a number this
        # director does not own — the misattribution #1320 was filed about.
        name="greedy fill: 41 players in pools of 5 leaves a pool of one",
        options=DrawStructureOptions(
            preview_field_size=41,
            pool_reservation_count=4,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=MANUAL,
            manual_pool_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=9,
            pool_sizes=(5, 5, 5, 5, 5, 5, 5, 5, 1),
            qualifiers_per_pool=1,
            total_qualifiers=9,
            knockout_bracket_size=9,
            first_round_byes=7,
            pool_match_count=80,
            ownership=DrawStructureOwnership(
                pool_count=AUTOMATIC, pool_size=MANUAL, qualifiers=AUTOMATIC
            ),
            disagreement=None,
            is_uneven=True,
            impossible_problems=_pool_size_problem(41, 5),
        ),
    ),
    # -----------------------------------------------------------------------------
    # The edges the reference does not draw.
    # -----------------------------------------------------------------------------
    DrawStructureVector(
        # An event with NO cap previews against 16 players
        # (``app.schedule_preview.DEFAULT_UNCAPPED_FIELD``). The derivation just takes
        # the number — the honest "16 players because this event has no cap" basis label
        # is the caller's job.
        name="no cap: the uncapped preview field of 16 players",
        options=DrawStructureOptions(
            preview_field_size=16,
            pool_reservation_count=4,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=4,
            pool_sizes=(4, 4, 4, 4),
            qualifiers_per_pool=2,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            pool_match_count=24,
            ownership=ALL_AUTOMATIC,
            disagreement=None,
            is_uneven=False,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # An event with no pool rows yet. The count clamps to one, which is also what
        # makes ``min(pool_sizes)`` total.
        name=(
            "no pool reservations yet: the count clamps to one and the sentence says so"
        ),
        options=DrawStructureOptions(
            preview_field_size=16,
            pool_reservation_count=0,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=1,
            pool_sizes=(16,),
            qualifiers_per_pool=8,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            pool_match_count=120,
            ownership=ALL_AUTOMATIC,
            disagreement=None,
            is_uneven=False,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # THE REGRESSION. The pair of the vector above: one pool again, but a cap of
        # six, so the aim of eight does not fit. The automatic count is
        # ``min(ceil(8 / 1), 6)`` — six, not eight — and the structure is playable.
        #
        # Unclamped, this derived eight qualifiers out of a pool of six and then refused
        # its own number, which made every save on a capped one-pool event impossible,
        # a rename included, while the qualifier count the event had stored was fine.
        #
        # Six out of six means the WHOLE POOL qualifies, and that is the specified
        # answer rather than an oversight: a director who wants a narrower knockout out
        # of one pool types the number, which makes it theirs.
        name="one pool under a cap of 8: the automatic count clamps to the pool",
        options=DrawStructureOptions(
            preview_field_size=6,
            pool_reservation_count=1,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=1,
            pool_sizes=(6,),
            qualifiers_per_pool=6,
            total_qualifiers=6,
            knockout_bracket_size=6,
            first_round_byes=2,
            pool_match_count=15,
            ownership=ALL_AUTOMATIC,
            disagreement=None,
            is_uneven=False,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # A director typing a zero into the pool-size box. It clamps to one, and the
        # clamped value is what the derivation divides by — and what the refusal says
        # out loud, since the size is the number this director owns. The automatic
        # qualifier count clamps to the pool of one alongside it.
        name="a manual pool size of zero clamps to one, in the maths and in the copy",
        options=DrawStructureOptions(
            preview_field_size=3,
            pool_reservation_count=4,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=MANUAL,
            manual_pool_size=0,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=3,
            pool_sizes=(1, 1, 1),
            qualifiers_per_pool=1,
            total_qualifiers=3,
            knockout_bracket_size=3,
            first_round_byes=1,
            pool_match_count=0,
            ownership=DrawStructureOwnership(
                pool_count=AUTOMATIC, pool_size=MANUAL, qualifiers=AUTOMATIC
            ),
            disagreement=None,
            is_uneven=False,
            impossible_problems=_pool_size_problem(3, 1),
        ),
    ),
    DrawStructureVector(
        # A field of nobody — the state a brand-new event with a zero cap would preview.
        # This is now the ORDERING case: the automatic count floors at one qualifier,
        # one out of a pool of zero would fire the qualifier rule, and the pool problem
        # is reported instead because it is the fact the director can act on.
        name="an empty field: the pools have no players at all",
        options=DrawStructureOptions(
            preview_field_size=0,
            pool_reservation_count=3,
            pool_count_mode=AUTOMATIC,
            manual_pool_count=None,
            pool_size_mode=AUTOMATIC,
            manual_pool_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=3,
            pool_sizes=(0, 0, 0),
            qualifiers_per_pool=1,
            total_qualifiers=3,
            knockout_bracket_size=3,
            first_round_byes=1,
            pool_match_count=0,
            ownership=ALL_AUTOMATIC,
            disagreement=None,
            is_uneven=False,
            impossible_problems=_pool_problem(0, 3),
        ),
    ),
    DrawStructureVector(
        # A director who clears every input. The mode still says manual, but there is no
        # number, so nothing has been set: the derivation falls back to automatic AND
        # reports the ownership as automatic. Same result as the "nothing set" vector.
        name="a manual mode with no number is automatic, badge and all",
        options=DrawStructureOptions(
            preview_field_size=32,
            pool_reservation_count=4,
            pool_count_mode=MANUAL,
            manual_pool_count=None,
            pool_size_mode=MANUAL,
            manual_pool_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            pool_count=4,
            pool_sizes=(8, 8, 8, 8),
            qualifiers_per_pool=2,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            pool_match_count=112,
            ownership=ALL_AUTOMATIC,
            disagreement=None,
            is_uneven=False,
            impossible_problems=(),
        ),
    ),
]


@pytest.mark.parametrize(
    "vector",
    DRAW_STRUCTURE_VECTORS,
    ids=lambda vector: vector.name,
)
def test_derive_draw_structure(vector: DrawStructureVector) -> None:
    assert derive_draw_structure(vector.options) == vector.expected


def test_the_table_covers_every_case_the_client_table_does() -> None:
    """A guard on the transcription itself. The client table holds seventeen vectors,
    and a Python table that quietly held sixteen would still be green — the drift this
    ADR is about is precisely a case that exists on one side only."""
    assert len(DRAW_STRUCTURE_VECTORS) == 17
    assert len({vector.name for vector in DRAW_STRUCTURE_VECTORS}) == 17


def _vector(name: str) -> DrawStructureVector:
    """One vector by **name**, never by list position: the whole point of this table is
    that a case can be inserted into it without silently re-pointing another test."""
    return next(
        vector for vector in DRAW_STRUCTURE_VECTORS if vector.name.startswith(name)
    )


def test_a_possible_structure_says_so() -> None:
    """``is_impossible`` is the one question chores 4b and 5c ask, so it is asserted
    rather than left to a reader of the tuple."""
    possible = derive_draw_structure(_vector("nothing set").options)
    impossible = derive_draw_structure(_vector("field too small").options)
    assert possible.is_impossible is False
    assert impossible.is_impossible is True


# ----- the unseated sentence, which is the cut's alone (chore 5c) --------------------
#
# Unlike the three impossible messages, this copy is **new** and has no other file
# pinning it, so it is pinned verbatim here — from the vector's own disagreement, so a
# swapped ``seats``/``field_size`` reds rather than reading plausibly.
#
# There is no empty-seats sentence to pin. Only the ``unseated`` direction refuses a
# cut, so only that direction has words on this side; the empty-seats copy is the
# client's panel's, and the client writes it (see ``unseated_entrants_message``).


def test_the_unseated_sentence_states_the_arithmetic_and_refuses_to_choose() -> None:
    """The ADR's own sentence: what the structure seats, what the field is, and how many
    entrants have nowhere to go — then who has to decide.

    Deliberately **not** the impossible-competition wording. Nothing here is unplayable:
    six pools of five is a fine competition, it is simply not one for forty players, and
    the way out is the director picking a number rather than making a number legal.
    """
    disagreement = derive_draw_structure(
        _vector("both manual and disagreeing").options
    ).disagreement
    assert disagreement is not None
    assert unseated_entrants_message(disagreement) == (
        "6 pools of 5 seat 30, and this event has 40 entrants — 10 entrants have "
        "nowhere to go. Cutting would have to change one of those numbers for you, "
        "so change the pool count or the pool size, then cut again."
    )


def test_every_noun_and_verb_in_the_sentence_inflects() -> None:
    """One pool and one entrant are both reachable — a manual ``1`` is a number a
    director can type — and a refusal reading ``1 pools of 1 seat 1`` would be the app's
    own carelessness quoted back at somebody it is refusing."""
    assert unseated_entrants_message(
        DrawStructureDisagreement(
            pool_count=1,
            pool_size=1,
            seats=1,
            field_size=2,
            direction=DisagreementDirection.unseated,
            count=1,
        )
    ) == (
        "1 pool of 1 seats 1, and this event has 2 entrants — 1 entrant has nowhere "
        "to go. Cutting would have to change one of those numbers for you, so change "
        "the pool count or the pool size, then cut again."
    )
