"""The **round-robin-then-knockout draw structure**, derived from the seven numbers a
director can set (#1320, #1386), plus the ``kind`` of any impossible competition those
numbers produce.

**Pure.** No session, no query, no FastAPI, no clock. Its input and its output are small
frozen value objects, so the derivation is runnable from a REPL, a script or a test with
nothing but literals — the same seam :mod:`app.draws` holds, and for the same reason.

**The same arithmetic also runs in TypeScript, and neither side is generated from the
other** (ADR
``20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors``). The
client copy is ``web-client/src/components/tournaments/data/draw-structure.ts``, and it
drives the Draw structure tab so the number a director reads never lags the keystroke
that produced it. This copy is what makes the rule *enforceable*: ``ios/`` and the MCP
server write events too, and a rule that lives only in React is not a rule. No request
path calls this module yet — #1387 is its first production caller.

What ties the two together is **one table of vectors**, asserted on both sides with
identical inputs and identical expected numbers (``tests/test_draw_structure.py``, and
``draw-structure.test.ts`` beside the client module). A reviewer should read the two
tables side by side before reading either implementation. Anything computed here that
the vectors do not pin is drift waiting to happen — which is why the result carries only
the shared subset, and why the three impossible conditions surface as a bare
:class:`ImpossibleProblemKind` rather than a sentence. The director-facing refusal copy
stays in :mod:`app.draws`, where the cut already owns it.

The starting point is ``docs/designs/rr-then-ko-draw-structure/README.md``, section
"The derivation" — with one departure it records under "What the reference does not
settle": the automatic group count divides the field by :data:`DEFAULT_GROUP_SIZE`
rather than counting the event's reservation rows, and the sizes balance across that
count (#1370 decision 1).
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

#: The knockout the automatic qualifier count **aims at**. **A constant, not stored
#: state** (ADR ``20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-
#: the-system``): nothing writes it, so no request carries it. A director who wants a
#: different bracket sets the qualifiers themselves, which is a setting they own.
TARGET_BRACKET_SIZE = 8

#: The group size the automatic group count divides by — ``max(1, ceil(field / 5))``,
#: with the sizes then balanced across that count. **A count divisor, not a size
#: target**: a field of 16 gives four groups of four, where filling to five greedily
#: would give ``5, 5, 5, 1`` and a group of one is a competition nobody can play (#1370
#: decision 1). A director who *types* a five keeps the greedy meaning — a typed number
#: is theirs, and the app states its consequence rather than reshaping it.
#:
#: ⚠️ Duplicated in ``web-client/src/components/tournaments/data/draw-structure.ts``,
#: and the shared vectors pin both copies.
DEFAULT_GROUP_SIZE = 5


class SettingOwnership(enum.Enum):
    """Who a structural setting belongs to: the system derived it, or the director typed
    it. The client's ``Automatic`` / ``Yours`` badge is this, and nothing else."""

    automatic = "automatic"
    manual = "manual"


class DisagreementDirection(enum.Enum):
    """Which way a disagreement runs. A closed two-member domain rather than the sign of
    a subtraction, because nobody reads a signed difference aloud."""

    #: More players than the structure has seats.
    unseated = "unseated"
    #: More seats than the field has players.
    empty_seats = "empty-seats"


class ImpossibleProblemKind(enum.Enum):
    """Which of the three impossible competitions a configuration produces.

    The **kind** crosses the language boundary and the vectors pin it; no sentence lives
    here, because the client writes its own copy for a panel that also offers fixes, and
    the cut's refusal copy already lives in :mod:`app.draws`.
    """

    group = "group"
    bracket = "bracket"
    qualifier = "qualifier"


@dataclass(frozen=True, slots=True)
class DrawStructureDisagreement:
    """The director's two manual numbers do not multiply out to their field.

    **Not an error, and not corrected.** Both numbers were typed on purpose, so the app
    states the arithmetic rather than quietly reshaping one of them.
    """

    #: The manual group count, as the derivation used it (clamped, like every input).
    group_count: int
    #: The manual group size, as the derivation used it.
    group_size: int
    #: ``group_count * group_size`` — the seats the structure actually has.
    seats: int
    #: The field the derivation ran against.
    field_size: int
    direction: DisagreementDirection
    #: How many entrants have nowhere to go, or how many seats would be empty. Always
    #: positive: :attr:`direction` carries the sign.
    count: int


@dataclass(frozen=True, slots=True)
class DrawStructureOptions:
    """The seven inputs. Every one is stated at every call site and in every vector —
    there is deliberately **no defaults builder**, because the client transcribes this
    table by hand and a hidden default is a guess waiting to be made wrong.

    The reservation count is deliberately **not** here (#1386): the automatic group
    count derives from :data:`DEFAULT_GROUP_SIZE`, so adding or removing a reservation
    changes no derived number.
    """

    #: The field the derivation runs against: the event's cap, or the uncapped default
    #: (``app.schedule_preview.DEFAULT_UNCAPPED_FIELD``). Which one it is, is the
    #: caller's question — this module only takes the number, which is what keeps it a
    #: leaf.
    preview_field_size: int
    group_count_mode: SettingOwnership
    manual_group_count: int | None
    group_size_mode: SettingOwnership
    manual_group_size: int | None
    qualifiers_mode: SettingOwnership
    manual_qualifiers: int | None


@dataclass(frozen=True, slots=True)
class DrawStructure:
    """The derived structure — exactly the subset the shared vectors pin.

    The client's result carries more (source sentences, the uneven tally, panel copy);
    none of it crosses the boundary, so none of it lives here.
    """

    group_count: int
    #: One entry per group, in group order — **not** a single size, because the groups
    #: are routinely unequal and the uneven case is a first-class state, not an edge.
    group_sizes: tuple[int, ...]
    qualifiers_per_group: int
    #: ``group_count * qualifiers_per_group``: how many players leave the group stage.
    total_qualifiers: int
    #: The knockout's entry list. The same number as :attr:`total_qualifiers` by
    #: construction — two questions with one answer, and the client asks both.
    knockout_bracket_size: int
    first_round_byes: int
    #: Every all-play-all match the group stage plays, across all groups.
    group_match_count: int
    #: ``None`` when the numbers agree, or when only one of them is the director's.
    disagreement: DrawStructureDisagreement | None
    #: **At most one kind**, and always the first in ``group`` → ``bracket`` →
    #: ``qualifier`` order. One impossible competition is one thing to fix; listing the
    #: two further conditions that a group of one also trips would bury it.
    impossible_problems: tuple[ImpossibleProblemKind, ...]

    @property
    def is_impossible(self) -> bool:
        """Whether this configuration names a competition that cannot be played."""
        return bool(self.impossible_problems)


def _at_least_one(value: int) -> int:
    """The ``max(1, …)`` the spec puts on every director-supplied number. A zero or a
    negative is not a smaller structure, it is no structure."""
    return max(1, value)


def _ceil_div(dividend: int, divisor: int) -> int:
    """``ceil(dividend / divisor)`` in integers, so no float ever decides which side of
    a ceiling an exact division falls on. ``divisor`` is always at least one before it
    gets here."""
    return -(-dividend // divisor)


def _next_power_of_two(value: int) -> int:
    """The spec's ``2 ^ ceil(log2(n))``, computed by doubling — the same answer as the
    logarithm, minus the chance that a float ``log2`` misplaces an exact power of two,
    and the same shape the client's copy uses."""
    size = 1
    while size < value:
        size *= 2
    return size


def _balanced_sizes(field_size: int, group_count: int) -> tuple[int, ...]:
    """The balanced split: ``base = field // count``, and the remainder goes to the
    **earliest** groups. 22 across 5 is ``5, 5, 4, 4, 4``."""
    base, extra = divmod(field_size, group_count)
    return tuple(base + (1 if index < extra else 0) for index in range(group_count))


def _greedy_sizes(
    field_size: int, group_count: int, group_size: int
) -> tuple[int, ...]:
    """The **greedy** fill, used when the director set the group size but not the group
    count: each group takes the target in turn and the last group takes what is left.

    ⚠️ **This is deliberately not a balanced split, and must not be "fixed" into one.**
    41 players in groups of 5 gives ``5,5,5,5,5,5,5,5,1``, and that group of one is then
    an impossible competition the director is told about. Rebalancing to
    ``5,5,5,5,5,5,5,4,4`` would silently reshape a number they typed, which is the exact
    behaviour #1320 exists to remove: the app states the consequence of an input, it
    does not edit the input. The default divisor has no owner, so it balances instead
    (#1370 decision 2) — the two fives mean different things.
    """
    sizes: list[int] = []
    remaining = field_size
    for _ in range(group_count):
        take = min(group_size, remaining)
        remaining -= take
        sizes.append(take)
    return tuple(sizes)


def derive_draw_structure(options: DrawStructureOptions) -> DrawStructure:
    """Derive the whole draw structure from the seven inputs.

    **A mode of ``manual`` with no number is automatic.** A director who clears the
    input has set nothing, so the derivation falls back and uses the automatic rule —
    which is what stops a ``Yours`` badge sitting above a number the system worked out.
    """
    field_size = options.preview_field_size
    # Resolve the modes first, so the rest of the function reads one fact ("is there a
    # number here?") rather than re-asking a mode and a value together at every branch.
    manual_group_count = (
        options.manual_group_count
        if options.group_count_mode is SettingOwnership.manual
        else None
    )
    manual_group_size = (
        options.manual_group_size
        if options.group_size_mode is SettingOwnership.manual
        else None
    )
    manual_qualifiers = (
        options.manual_qualifiers
        if options.qualifiers_mode is SettingOwnership.manual
        else None
    )
    target_size = (
        _at_least_one(manual_group_size) if manual_group_size is not None else None
    )

    # Group count: the director's, else derived from a size — theirs when they typed
    # one, the default divisor otherwise. Clamped to at least one, which is what makes
    # ``min(group_sizes)`` below total.
    if manual_group_count is not None:
        group_count = _at_least_one(manual_group_count)
    else:
        divisor = target_size if target_size is not None else DEFAULT_GROUP_SIZE
        group_count = _at_least_one(_ceil_div(field_size, divisor))

    # Group sizes. Both manual means both numbers stand, product be damned — that
    # standoff is reported as a disagreement below, never resolved by moving a number.
    if target_size is None:
        group_sizes = _balanced_sizes(field_size, group_count)
    elif manual_group_count is not None:
        group_sizes = tuple(target_size for _ in range(group_count))
    else:
        group_sizes = _greedy_sizes(field_size, group_count, target_size)

    smallest_group = min(group_sizes)

    if manual_qualifiers is not None:
        qualifiers_per_group = _at_least_one(manual_qualifiers)
    else:
        qualifiers_per_group = _at_least_one(
            _ceil_div(TARGET_BRACKET_SIZE, group_count)
        )

    knockout_bracket_size = group_count * qualifiers_per_group
    # ``max(2, …)`` is what makes a one-player knockout report ONE bye rather than none:
    # the smallest bracket that can be drawn holds two, so the missing player is a bye.
    first_round_byes = (
        _next_power_of_two(max(2, knockout_bracket_size)) - knockout_bracket_size
    )
    group_match_count = sum(size * (size - 1) // 2 for size in group_sizes)

    seats = group_count * (target_size if target_size is not None else 0)
    conflict = (
        manual_group_count is not None
        and target_size is not None
        and seats != field_size
    )
    disagreement: DrawStructureDisagreement | None = None
    if conflict and target_size is not None:
        disagreement = DrawStructureDisagreement(
            group_count=group_count,
            group_size=target_size,
            seats=seats,
            field_size=field_size,
            direction=(
                DisagreementDirection.unseated
                if field_size > seats
                else DisagreementDirection.empty_seats
            ),
            count=abs(field_size - seats),
        )

    return DrawStructure(
        group_count=group_count,
        group_sizes=group_sizes,
        qualifiers_per_group=qualifiers_per_group,
        total_qualifiers=knockout_bracket_size,
        knockout_bracket_size=knockout_bracket_size,
        first_round_byes=first_round_byes,
        group_match_count=group_match_count,
        disagreement=disagreement,
        impossible_problems=_impossible_problems(
            smallest_group=smallest_group,
            knockout_bracket_size=knockout_bracket_size,
            qualifiers_per_group=qualifiers_per_group,
        ),
    )


def _impossible_problems(
    *,
    smallest_group: int,
    knockout_bracket_size: int,
    qualifiers_per_group: int,
) -> tuple[ImpossibleProblemKind, ...]:
    """The three impossible competitions, **tested in order, first hit only**.

    The order is not arbitrary. A group too small to play is often a group too small to
    qualify from — a group of one trips the qualifier rule too, and a field of one trips
    all three — but the group is the fact a director can act on, and the rest are echoes
    of it. Reporting the echoes alongside it would make one mistake look like several.
    """
    # 1. A group nobody can play in.
    if smallest_group < 2:
        return (ImpossibleProblemKind.group,)

    # 2. A knockout of one. Reachable only from one group taking one qualifier, and the
    #    winner of that group would be handed a title without playing for it.
    if knockout_bracket_size < 2:
        return (ImpossibleProblemKind.bracket,)

    # 3. More qualifiers than the smallest group holds — the group would advance players
    #    it does not have.
    if qualifiers_per_group > smallest_group:
        return (ImpossibleProblemKind.qualifier,)

    return ()
