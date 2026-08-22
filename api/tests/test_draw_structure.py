"""**The vector table IS the contract** (ADR
``20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors``). The
same cases are asserted against the TypeScript derivation that drives the Draw structure
tab — ``web-client/src/components/tournaments/data/draw-structure.test.ts``, whose
``DRAW_STRUCTURE_VECTORS`` this table transcribes by hand — with identical inputs and
identical expected numbers. A change to the maths that lands on one side and not the
other fails a test.

Three rules keep the two tables readable side by side:

1. **Every vector states all seven inputs.** No defaults builder, no shared base object.
   A hidden ``group_count_mode=automatic`` is a guess, and DRY is worth less here than
   being readable as a spec.
2. **Every vector states the whole shared result**, in one ``==``.
3. **One parametrize, no per-case test functions with inline numbers.** A reviewer reads
   the two tables side by side; they cannot do that if the cases are scattered.

The case **names and their order match the TypeScript table exactly**, so the two can be
scrolled together.

## What crosses the language boundary, and what does not

The ADR shares the **numbers**, not the **copy**:

- **Shared, and must match exactly:** ``group_count``, ``group_sizes``,
  ``qualifiers_per_group``, ``total_qualifiers``, ``knockout_bracket_size``,
  ``first_round_byes``, ``group_match_count``, the numbers on ``disagreement``, and the
  ``kind`` of each impossible problem. :class:`app.draw_structure.DrawStructure` carries
  exactly that subset, so each vector's one ``==`` asserts all of it.
- **Client-only, and deliberately not transcribed:** each setting row's *source
  sentence* (there are no rows on the server), the uneven *tally* (a notice — the API
  does not object to unequal groups), and each problem's *title* and *body* (the cut's
  refusal copy lives in :mod:`app.draws`, and the client writes its own).

Both sides also pin :data:`app.draw_structure.DEFAULT_GROUP_SIZE` itself, because the
vectors alone cannot catch two implementations that changed the divisor in step.
"""

from dataclasses import dataclass

import pytest

from app.draw_structure import (
    DEFAULT_GROUP_SIZE,
    DisagreementDirection,
    DrawStructure,
    DrawStructureDisagreement,
    DrawStructureOptions,
    ImpossibleProblemKind,
    SettingOwnership,
    derive_draw_structure,
)

AUTOMATIC = SettingOwnership.automatic
MANUAL = SettingOwnership.manual


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
        # The reference's "Nothing set" screen — under OUR automatic rule, not the
        # reference's (#1386): the count divides the field by the default five, and the
        # sizes balance across it.
        name="nothing set: a 32-player cap makes seven groups",
        options=DrawStructureOptions(
            preview_field_size=32,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=7,
            group_sizes=(5, 5, 5, 5, 4, 4, 4),
            qualifiers_per_group=2,
            total_qualifiers=14,
            knockout_bracket_size=14,
            first_round_byes=2,
            group_match_count=58,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # Group count is the director's, group size is ours: the balanced split,
        # remainder to the EARLIEST groups.
        name="manual group count only: 40 players across 6 groups",
        options=DrawStructureOptions(
            preview_field_size=40,
            group_count_mode=MANUAL,
            manual_group_count=6,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=6,
            group_sizes=(7, 7, 7, 7, 6, 6),
            qualifiers_per_group=2,
            total_qualifiers=12,
            knockout_bracket_size=12,
            first_round_byes=4,
            group_match_count=114,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The other way round: the director's target size derives the count, and 40
        # divides exactly, so nothing is left over.
        name="manual group size only: 40 players in groups of 5",
        options=DrawStructureOptions(
            preview_field_size=40,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=MANUAL,
            manual_group_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=8,
            group_sizes=(5, 5, 5, 5, 5, 5, 5, 5),
            qualifiers_per_group=1,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            group_match_count=80,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The reference's "Numbers disagree" screen. BOTH numbers stand — the sizes stay
        # at the six fives the director asked for, and the ten players with nowhere to
        # go are reported rather than seated by moving somebody's number.
        name="both manual and disagreeing: 6 groups of 5 seat 30 of a 40 field",
        options=DrawStructureOptions(
            preview_field_size=40,
            group_count_mode=MANUAL,
            manual_group_count=6,
            group_size_mode=MANUAL,
            manual_group_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=6,
            group_sizes=(5, 5, 5, 5, 5, 5),
            qualifiers_per_group=2,
            total_qualifiers=12,
            knockout_bracket_size=12,
            first_round_byes=4,
            group_match_count=60,
            disagreement=DrawStructureDisagreement(
                group_count=6,
                group_size=5,
                seats=30,
                field_size=40,
                direction=DisagreementDirection.unseated,
                count=10,
            ),
            # A disagreement is a call for the director, NOT an impossible competition.
            # Every group here is playable.
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The disagreement running the other way: more seats than players.
        name="both manual, seats to spare: 8 groups of 5 seat 40 of a 30 field",
        options=DrawStructureOptions(
            preview_field_size=30,
            group_count_mode=MANUAL,
            manual_group_count=8,
            group_size_mode=MANUAL,
            manual_group_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=8,
            group_sizes=(5, 5, 5, 5, 5, 5, 5, 5),
            qualifiers_per_group=1,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            group_match_count=80,
            disagreement=DrawStructureDisagreement(
                group_count=8,
                group_size=5,
                seats=40,
                field_size=30,
                direction=DisagreementDirection.empty_seats,
                count=10,
            ),
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The reference's "Uneven field" screen, re-derived under the default divisor:
        # 22 is five groups now, not four. Legal, and said out loud.
        name="uneven but legal: a 22-player cap splits 5, 5, 4, 4, 4",
        options=DrawStructureOptions(
            preview_field_size=22,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=5,
            group_sizes=(5, 5, 4, 4, 4),
            qualifiers_per_group=2,
            total_qualifiers=10,
            knockout_bracket_size=10,
            first_round_byes=6,
            group_match_count=38,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    # -----------------------------------------------------------------------------
    # The default divisor, on each side of a multiple-of-five boundary. 39, 40 and 41
    # are the three fields #1387's 409 keys on: 39 and 40 both make eight groups, and
    # 41 is the first field that makes nine.
    # -----------------------------------------------------------------------------
    DrawStructureVector(
        # One under the boundary: still eight groups, and the short group takes the gap.
        name="a 39-player cap stays at eight groups",
        options=DrawStructureOptions(
            preview_field_size=39,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=8,
            group_sizes=(5, 5, 5, 5, 5, 5, 5, 4),
            qualifiers_per_group=1,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            group_match_count=76,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # Exactly on the boundary: the field divides, so every group holds the default
        # five and each sends its winner only — the bracket is the target eight by
        # construction.
        name="a 40-player cap derives eight groups of five",
        options=DrawStructureOptions(
            preview_field_size=40,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=8,
            group_sizes=(5, 5, 5, 5, 5, 5, 5, 5),
            qualifiers_per_group=1,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            group_match_count=80,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # One over the boundary: the ceiling tips the count to nine, and — unlike the
        # greedy fill of a TYPED five, pinned below — the balanced split leaves no group
        # of one.
        name="a 41-player cap tips into nine balanced groups",
        options=DrawStructureOptions(
            preview_field_size=41,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=9,
            group_sizes=(5, 5, 5, 5, 5, 4, 4, 4, 4),
            qualifiers_per_group=1,
            total_qualifiers=9,
            knockout_bracket_size=9,
            first_round_byes=7,
            group_match_count=74,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    # -----------------------------------------------------------------------------
    # The three impossible competitions.
    # -----------------------------------------------------------------------------
    DrawStructureVector(
        # The reference's "Field too small" screen — and the ORDERING case. Four groups
        # of one means the group rule fires, and the automatic two qualifiers out of a
        # group of one means the qualifier rule would fire too. Only the group problem
        # is reported: it is the one the director can act on, and the other is its echo.
        name=(
            "field too small: 8 players across 6 groups reports the group, "
            "not the qualifier"
        ),
        options=DrawStructureOptions(
            preview_field_size=8,
            group_count_mode=MANUAL,
            manual_group_count=6,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=6,
            group_sizes=(2, 2, 1, 1, 1, 1),
            qualifiers_per_group=2,
            total_qualifiers=12,
            knockout_bracket_size=12,
            first_round_byes=4,
            group_match_count=2,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.group,),
        ),
    ),
    DrawStructureVector(
        # One group taking one qualifier. The groups are fine, so the BRACKET rule is
        # the one that fires — and this is the only vector that catches a missing
        # ``max(2, …)`` in the byes formula: it is one bye, not none.
        name="one-player knockout: 1 group taking its top 1",
        options=DrawStructureOptions(
            preview_field_size=8,
            group_count_mode=MANUAL,
            manual_group_count=1,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=1,
        ),
        expected=DrawStructure(
            group_count=1,
            group_sizes=(8,),
            qualifiers_per_group=1,
            total_qualifiers=1,
            knockout_bracket_size=1,
            first_round_byes=1,
            group_match_count=28,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.bracket,),
        ),
    ),
    DrawStructureVector(
        # Three through from a group that only holds two.
        name="too many qualifiers: top 3 from a group of 2",
        options=DrawStructureOptions(
            preview_field_size=10,
            group_count_mode=MANUAL,
            manual_group_count=4,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=3,
        ),
        expected=DrawStructure(
            group_count=4,
            group_sizes=(3, 3, 2, 2),
            qualifiers_per_group=3,
            total_qualifiers=12,
            knockout_bracket_size=12,
            first_round_byes=4,
            group_match_count=8,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.qualifier,),
        ),
    ),
    DrawStructureVector(
        # The SECOND ordering case, and the complete set with the one above: a field of
        # one trips the group rule and the bracket rule at once, and the group wins.
        # (There is no reachable bracket-over-qualifier case: ``bracket < 2`` forces one
        # group taking one, and one qualifier can only exceed a group of zero, which
        # trips the group rule first.)
        name="ordering: a field of one is a group problem, not a bracket problem",
        options=DrawStructureOptions(
            preview_field_size=1,
            group_count_mode=MANUAL,
            manual_group_count=1,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=1,
        ),
        expected=DrawStructure(
            group_count=1,
            group_sizes=(1,),
            qualifiers_per_group=1,
            total_qualifiers=1,
            knockout_bracket_size=1,
            first_round_byes=1,
            group_match_count=0,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.group,),
        ),
    ),
    DrawStructureVector(
        # THE GREEDY EDGE, and the other half of the boundary trio above: the same 41
        # players, but the five is TYPED. Nine groups, the ninth holding the one player
        # 41 does not divide into eight fives. A balanced split would hide the problem
        # by editing a number the director typed — so the fill stays greedy and the
        # group of one is reported (#1370 decision 2).
        name="greedy fill: 41 players in groups of 5 leaves a group of one",
        options=DrawStructureOptions(
            preview_field_size=41,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=MANUAL,
            manual_group_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=9,
            group_sizes=(5, 5, 5, 5, 5, 5, 5, 5, 1),
            qualifiers_per_group=1,
            total_qualifiers=9,
            knockout_bracket_size=9,
            first_round_byes=7,
            group_match_count=80,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.group,),
        ),
    ),
    # -----------------------------------------------------------------------------
    # The edges the reference does not draw.
    # -----------------------------------------------------------------------------
    DrawStructureVector(
        # An event with NO cap previews against 16 players. Sixteen does not fill four
        # fives, so this is the vector that pins the five as a COUNT DIVISOR: the
        # balanced split gives four groups of four, where filling to five greedily would
        # give ``5, 5, 5, 1`` and refuse the out-of-the-box event (#1370 decision 1).
        name="no cap: the uncapped preview field of 16 players",
        options=DrawStructureOptions(
            preview_field_size=16,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=4,
            group_sizes=(4, 4, 4, 4),
            qualifiers_per_group=2,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            group_match_count=24,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
    DrawStructureVector(
        # The OTHER five, beside the vector above: the same field of 16, but the five is
        # TYPED. The count is the same four — the division is identical — and the fill
        # is not: greedy leaves ``5, 5, 5, 1``, and the group of one is reported rather
        # than rebalanced away, because a typed number is the director's (#1370 decision
        # 2). This pair is the side-by-side the decision asks the table to pin.
        name="a typed five on a field of 16 fills greedily: 5, 5, 5, 1",
        options=DrawStructureOptions(
            preview_field_size=16,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=MANUAL,
            manual_group_size=5,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=4,
            group_sizes=(5, 5, 5, 1),
            qualifiers_per_group=2,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            group_match_count=30,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.group,),
        ),
    ),
    DrawStructureVector(
        # A director typing a zero into the group-size box. It clamps to one, in the
        # maths and (on the client) in the copy.
        name="a manual group size of zero clamps to one, in the maths and in the copy",
        options=DrawStructureOptions(
            preview_field_size=3,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=MANUAL,
            manual_group_size=0,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=3,
            group_sizes=(1, 1, 1),
            qualifiers_per_group=3,
            total_qualifiers=9,
            knockout_bracket_size=9,
            first_round_byes=7,
            group_match_count=0,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.group,),
        ),
    ),
    DrawStructureVector(
        # A field of nobody — the state a brand-new event with a zero cap would preview.
        # This is also the vector that pins the ``max(1, …)`` clamp on the automatic
        # count: ``ceil(0 / 5)`` is 0, and the clamp is what makes it one group rather
        # than none.
        name="an empty field: the one group has no players at all",
        options=DrawStructureOptions(
            preview_field_size=0,
            group_count_mode=AUTOMATIC,
            manual_group_count=None,
            group_size_mode=AUTOMATIC,
            manual_group_size=None,
            qualifiers_mode=AUTOMATIC,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=1,
            group_sizes=(0,),
            qualifiers_per_group=8,
            total_qualifiers=8,
            knockout_bracket_size=8,
            first_round_byes=0,
            group_match_count=0,
            disagreement=None,
            impossible_problems=(ImpossibleProblemKind.group,),
        ),
    ),
    DrawStructureVector(
        # A director who clears every input. The mode still says ``manual``, but there
        # is no number, so nothing has been set: the derivation falls back to automatic.
        # Byte-identical to the "nothing set" vector.
        name="a manual mode with no number is automatic, badge and all",
        options=DrawStructureOptions(
            preview_field_size=32,
            group_count_mode=MANUAL,
            manual_group_count=None,
            group_size_mode=MANUAL,
            manual_group_size=None,
            qualifiers_mode=MANUAL,
            manual_qualifiers=None,
        ),
        expected=DrawStructure(
            group_count=7,
            group_sizes=(5, 5, 5, 5, 4, 4, 4),
            qualifiers_per_group=2,
            total_qualifiers=14,
            knockout_bracket_size=14,
            first_round_byes=2,
            group_match_count=58,
            disagreement=None,
            impossible_problems=(),
        ),
    ),
]


@pytest.mark.parametrize(
    "vector", DRAW_STRUCTURE_VECTORS, ids=[v.name for v in DRAW_STRUCTURE_VECTORS]
)
def test_derive_draw_structure(vector: DrawStructureVector) -> None:
    assert derive_draw_structure(vector.options) == vector.expected


def test_default_group_size_is_five() -> None:
    """Pinned on both sides (``draw-structure.test.ts`` asserts its twin), because the
    vectors alone cannot catch two implementations that changed the divisor in step."""
    assert DEFAULT_GROUP_SIZE == 5
