"""The **round-robin-then-knockout draw structure**, derived from the eight numbers a
director can set (#1320), plus the name of any impossible competition those numbers
produce.

**Pure.** No session, no query, no FastAPI, no clock. Its input and its output are small
frozen value objects, so the derivation is runnable from a REPL, a script or a test with
nothing but literals — the same seam :mod:`app.draws` holds, and for the same reason.

**The same arithmetic also runs in TypeScript, and neither side is generated from the
other** (ADR
``20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors``). The
client copy is ``web-client/src/components/tournaments/data/draw-structure.ts``, and it
drives the Draw structure tab so the number a director reads never lags the keystroke
that produced it. This copy is what makes the rule *enforced*: ``ios/`` and the MCP
server write events too, and a rule that lives only in React is not a rule.

What ties the two together is **one table of vectors**, asserted on both sides with
identical inputs and identical expected numbers (``tests/test_draw_structure.py``, and
``draw-structure.test.ts`` beside the client module). A reviewer should read the two
tables side by side before reading either implementation. Anything computed here that
the vectors do not pin is drift waiting to happen.

**The copy is the cut's, not a second set of words.** The three impossible conditions
already had director-facing sentences inside :mod:`app.draws`, written, reviewed and
pinned by five test modules. They live here now, as
:func:`pool_too_small_message`, :data:`ONE_PLAYER_KNOCKOUT_MESSAGE` and
:func:`too_many_qualifiers_message`, and :mod:`app.draws` imports them — so the cut and
the derivation refuse in the same words by construction rather than by two authors
agreeing. **Two sentences are this module's own**, because the cut had no state that
reached them: :func:`pool_too_small_for_pool_size_message` is the pool refusal for a
pool size the *director* set, which the snake deal cannot produce, and
:func:`unseated_entrants_message` is the cut-time refusal for a structure that seats
fewer players than have entered (#1320, chore 5c). The import runs this way round
because this module
must stay a leaf: :mod:`app.draws` pulls in the ORM enums and the request schemas, and
nothing that imports *this* should have to.

The spec is ``docs/designs/rr-then-ko-draw-structure/README.md``, section "The
derivation".
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

#: The knockout the automatic qualifier count **aims at** — an aim, not a floor: the
#: automatic count never takes more out of a pool than it holds, so a small field
#: derives a smaller bracket rather than an impossible one. **A constant, not stored
#: state** (ADR ``20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-
#: the-system``): nothing writes it, so no request carries it. A director who wants a
#: different bracket sets the qualifiers themselves, which is a setting they own.
TARGET_BRACKET_SIZE = 8


# --------------------------------------------------------------------------------------
# The refusal copy, shared with the cut.
# --------------------------------------------------------------------------------------


def pool_too_small_message(entrant_count: int, pool_count: int) -> str:
    """A pool holding fewer than two entrants, in the words the cut already used.

    Both nouns inflect, because the sentence is reached with one entrant across one pool
    (a field of one) as readily as with forty-one across nine.
    """
    entrant_noun = "entrant" if entrant_count == 1 else "entrants"
    pool_noun = "pool" if pool_count == 1 else "pools"
    return (
        f"{entrant_count} {entrant_noun} across {pool_count} {pool_noun} would "
        "leave a pool with fewer than 2 entrants, who would have nobody to play."
    )


def pool_too_small_for_pool_size_message(entrant_count: int, pool_size: int) -> str:
    """A pool holding fewer than two entrants **when the director owns the pool size**.

    The sibling of :func:`pool_too_small_message`, and the one sentence here the cut
    does not share. The cut deals by snake, which divides the field evenly, so the pool
    *count* is the only knob that can starve a pool and naming it is honest. A manual
    pool size is filled greedily instead (:func:`_greedy_sizes`), and 41 entrants in
    pools of 5 leaves a pool of one that 41 balanced across nine would not — so the
    count sentence would blame a number the director does not own, which is the defect
    #1320 was filed about. This one names the number they typed.

    It covers the both-manual case too, where every pool is exactly the size that was
    typed: there the count sentence is not merely misattributed, it is untrue.
    """
    entrant_noun = "entrant" if entrant_count == 1 else "entrants"
    return (
        f"{entrant_count} {entrant_noun} in pools of {pool_size} would leave a pool "
        "with fewer than 2 entrants, who would have nobody to play."
    )


#: A knockout of one. Not a function, because the condition is fully determined: it is
#: reachable only from one pool taking one qualifier, so there is nothing to interpolate
#: and interpolating anyway would add branches no input can reach.
ONE_PLAYER_KNOCKOUT_MESSAGE = (
    "Taking 1 qualifier from a single pool leaves one player in the "
    "knockout stage, who would have nobody to play — take more qualifiers "
    "from each pool, or configure more pools."
)


def too_many_qualifiers_message(qualifiers_per_pool: int, smallest_pool: int) -> str:
    """More qualifiers than the smallest pool holds, in the words the cut already used.

    No noun inflection: this condition is tested *after* the pool floor, so the smallest
    pool always holds at least two.
    """
    return (
        f"Taking {qualifiers_per_pool} qualifiers from each pool is more "
        f"than the {smallest_pool} entrants in the smallest pool — take fewer "
        "qualifiers from each pool, or add entrants."
    )


# --------------------------------------------------------------------------------------
# The value objects.
# --------------------------------------------------------------------------------------


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

    The **kind** crosses the language boundary and the vectors pin it; the sentence does
    not, because the client writes its own shorter copy for a panel that also offers
    fixes, and this side cannot offer fixes.
    """

    pool = "pool"
    bracket = "bracket"
    qualifier = "qualifier"


@dataclass(frozen=True, slots=True)
class ImpossibleProblem:
    """A competition that cannot be played: what is wrong, and the words for it."""

    kind: ImpossibleProblemKind
    message: str


@dataclass(frozen=True, slots=True)
class DrawStructureDisagreement:
    """The director's two manual numbers do not multiply out to their field.

    **Not an error, and not corrected.** Both numbers were typed on purpose, so the app
    states the arithmetic rather than quietly reshaping one of them.
    """

    #: The manual pool count, as the derivation used it (clamped, like every input).
    pool_count: int
    #: The manual pool size, as the derivation used it.
    pool_size: int
    #: ``pool_count * pool_size`` — the seats the structure actually has.
    seats: int
    #: The field the derivation ran against.
    field_size: int
    direction: DisagreementDirection
    #: How many entrants have nowhere to go, or how many seats would be empty. Always
    #: positive: :attr:`direction` carries the sign.
    count: int


def unseated_entrants_message(disagreement: DrawStructureDisagreement) -> str:
    """The **cut's** refusal for a structure that seats fewer players than have entered
    — the arithmetic in the order the ADR states it (``20260808-a-structural-setting-is-
    owned-by-the-director-or-derived-by-the-system``): what the structure seats, what
    the field is, and how many entrants have nowhere to go.

    It sits beside the value object rather than up in the copy section because it takes
    the whole :class:`DrawStructureDisagreement`: every number in the sentence is one
    the derivation already computed, and re-deriving ``seats`` from loose arguments here
    would be a second copy of the arithmetic the vectors pin.

    **One direction only, and the asymmetry is the point — do not tidy it into
    symmetry.** A disagreement runs both ways (:class:`DisagreementDirection`), but only
    :attr:`~DisagreementDirection.unseated` stops a cut, so this sentence words only
    that direction and its caller
    (``app.event_draw_structure.entrants_with_nowhere_to_go``) hands it nothing else.
    Empty seats are not a problem: seven pools of six against a real field of forty
    deals ``6,6,6,6,6,6,4``, which is the legal uneven split the app already calls legal
    one slice over — and refusing it would dead-end the director hardest of all, because
    the reference's own resolution ``Use ceil(field / size) pools of {size}`` (labelled
    "Everyone gets a seat.") rounds *up* and therefore lands them exactly there.

    **Deliberately not the impossible-competition wording.** A pool of one is a
    competition nobody can play, and the director fixes it by making the numbers
    playable; this is two playable numbers that do not cover the field, and the director
    fixes it by deciding which of the two they meant. The tail says so: the cut will not
    choose for them.
    """
    pool_noun = "pool" if disagreement.pool_count == 1 else "pools"
    seat_verb = "seats" if disagreement.pool_count == 1 else "seat"
    field_noun = "entrant" if disagreement.field_size == 1 else "entrants"
    unseated_noun = "entrant has" if disagreement.count == 1 else "entrants have"
    return (
        f"{disagreement.pool_count} {pool_noun} of {disagreement.pool_size} "
        f"{seat_verb} {disagreement.seats}, and this event has "
        f"{disagreement.field_size} {field_noun} — {disagreement.count} "
        f"{unseated_noun} nowhere to go. Cutting would have "
        "to change one of those numbers for you, so change the pool count or the "
        "pool size, then cut again."
    )


@dataclass(frozen=True, slots=True)
class DrawStructureOwnership:
    """Who ended up owning each of the three numeric settings.

    The **effective** ownership, not the requested one: a ``manual`` mode carrying no
    number has set nothing, so the derivation falls back to automatic and says so here.
    Membership is absent because it has no number, so nothing derives it.
    """

    pool_count: SettingOwnership
    pool_size: SettingOwnership
    qualifiers: SettingOwnership


@dataclass(frozen=True, slots=True)
class DrawStructureOptions:
    """The eight inputs. Every one is stated at every call site and in every vector —
    there is deliberately **no defaults builder**, because the client transcribes this
    table by hand and a hidden default is a guess waiting to be made wrong."""

    #: The field the derivation runs against: the event's cap, or the uncapped default
    #: (``app.schedule_preview.DEFAULT_UNCAPPED_FIELD``). Which one it is, is the
    #: caller's question — this module only takes the number, which is what keeps it a
    #: leaf.
    preview_field_size: int
    #: How many pool rows the event already has — today's behaviour for the pool count.
    pool_reservation_count: int
    pool_count_mode: SettingOwnership
    manual_pool_count: int | None
    pool_size_mode: SettingOwnership
    manual_pool_size: int | None
    qualifiers_mode: SettingOwnership
    manual_qualifiers: int | None


@dataclass(frozen=True, slots=True)
class DrawStructure:
    """The whole derived structure."""

    pool_count: int
    #: One entry per pool, in pool order — **not** a single size, because the pools are
    #: routinely unequal and the uneven case is a first-class state, not an edge.
    pool_sizes: tuple[int, ...]
    qualifiers_per_pool: int
    #: ``pool_count * qualifiers_per_pool``: how many players leave the pool stage.
    total_qualifiers: int
    #: The knockout's entry list. The same number as :attr:`total_qualifiers` by
    #: construction — two questions with one answer, and the client asks both.
    knockout_bracket_size: int
    first_round_byes: int
    #: Every all-play-all match the pool stage plays, across all pools.
    pool_match_count: int
    ownership: DrawStructureOwnership
    #: ``None`` when the numbers agree, or when only one of them is the director's.
    disagreement: DrawStructureDisagreement | None
    #: Whether the pools come out unequal. The **fact**, not the client's tally: the API
    #: does not object to unequal pools, and ``2 pools of 6 · 2 pools of 5`` is copy.
    is_uneven: bool
    #: **At most one problem**, and always the first in ``pool`` → ``bracket`` →
    #: ``qualifier`` order. One impossible competition is one thing to fix; listing the
    #: two further conditions that a pool of one also trips would bury it.
    impossible_problems: tuple[ImpossibleProblem, ...]

    @property
    def is_impossible(self) -> bool:
        """Whether this configuration names a competition that cannot be played."""
        return bool(self.impossible_problems)


# --------------------------------------------------------------------------------------
# The arithmetic.
# --------------------------------------------------------------------------------------


def _at_least_one(value: int) -> int:
    """The ``max(1, …)`` the spec puts on every director-supplied number. A zero or a
    negative is not a smaller structure, it is no structure."""
    return max(1, value)


def _ceil_div(dividend: int, divisor: int) -> int:
    """``ceil(dividend / divisor)`` in integers, so no float ever decides which side of
    a ceiling an exact division falls on. ``divisor`` is always clamped to at least one
    before it gets here."""
    return -(-dividend // divisor)


def _next_power_of_two(value: int) -> int:
    """The spec's ``2 ^ ceil(log2(n))``, computed by doubling — the same answer as the
    logarithm, minus the chance that a float ``log2`` misplaces an exact power of two,
    and the same shape the client's copy uses."""
    size = 1
    while size < value:
        size *= 2
    return size


def _balanced_sizes(field_size: int, pool_count: int) -> tuple[int, ...]:
    """The balanced split: ``base = field // count``, and the remainder goes to the
    **earliest** pools. 22 across 4 is ``6, 6, 5, 5``."""
    base, extra = divmod(field_size, pool_count)
    return tuple(base + (1 if index < extra else 0) for index in range(pool_count))


def _greedy_sizes(field_size: int, pool_count: int, pool_size: int) -> tuple[int, ...]:
    """The **greedy** fill, used when the director set the pool size but not the pool
    count: each pool takes the target in turn and the last pool takes what is left.

    ⚠️ **This is deliberately not a balanced split, and must not be "fixed" into one.**
    41 players in pools of 5 gives ``5,5,5,5,5,5,5,5,1``, and that pool of one is then
    an impossible competition the director is told about. Rebalancing to
    ``5,5,5,5,5,5,5,4,4`` would silently reshape a number they typed, which is the exact
    behaviour #1320 exists to remove: the app states the consequence of an input, it
    does not edit the input.
    """
    sizes: list[int] = []
    remaining = field_size
    for _ in range(pool_count):
        take = min(pool_size, remaining)
        remaining -= take
        sizes.append(take)
    return tuple(sizes)


def derive_draw_structure(options: DrawStructureOptions) -> DrawStructure:
    """Derive the whole draw structure from the eight inputs.

    **A mode of ``manual`` with no number is automatic.** A director who clears the
    input has set nothing, so the derivation falls back and reports the ownership it
    actually used — which is what stops a ``Yours`` badge sitting above a number the
    system worked out.
    """
    field_size = options.preview_field_size
    # Resolve the modes first, so the rest of the function reads one fact ("is there a
    # number here?") rather than re-asking a mode and a value together at every branch.
    manual_pool_count = (
        options.manual_pool_count
        if options.pool_count_mode is SettingOwnership.manual
        else None
    )
    manual_pool_size = (
        options.manual_pool_size
        if options.pool_size_mode is SettingOwnership.manual
        else None
    )
    manual_qualifiers = (
        options.manual_qualifiers
        if options.qualifiers_mode is SettingOwnership.manual
        else None
    )
    target_size = (
        _at_least_one(manual_pool_size) if manual_pool_size is not None else None
    )

    # Pool count: the director's, else derived from their pool size, else today's
    # behaviour — one reservation row is one pool. Clamped to at least one, which is
    # what makes ``min(pool_sizes)`` below total.
    if manual_pool_count is not None:
        pool_count = _at_least_one(manual_pool_count)
    elif target_size is not None:
        pool_count = _at_least_one(_ceil_div(field_size, target_size))
    else:
        pool_count = _at_least_one(options.pool_reservation_count)

    # Pool sizes. Both manual means both numbers stand, product be damned — that
    # standoff is reported as a disagreement below, never resolved by moving a number.
    if target_size is None:
        pool_sizes = _balanced_sizes(field_size, pool_count)
    elif manual_pool_count is not None:
        pool_sizes = tuple(target_size for _ in range(pool_count))
    else:
        pool_sizes = _greedy_sizes(field_size, pool_count, target_size)

    smallest_pool = min(pool_sizes)
    largest_pool = max(pool_sizes)

    if manual_qualifiers is not None:
        qualifiers_per_pool = _at_least_one(manual_qualifiers)
    else:
        # **A number the system chooses must be one the system will accept.** Aim at the
        # eight-player knockout, but never take more out of a pool than it holds. The
        # unclamped ``ceil(8 / pool_count)`` derived a count and then refused that same
        # count: one pool under a cap of eight made every save impossible, a rename
        # included, while the qualifier count the event already stored was playable.
        #
        # ``smallest_pool`` is read here rather than recomputed because the pool sizes
        # do not depend on the qualifier count, so there is no cycle to unwind.
        #
        # The manual branch above is deliberately untouched: a number the director typed
        # is theirs, and so is the refusal it earns.
        qualifiers_per_pool = _at_least_one(
            min(_ceil_div(TARGET_BRACKET_SIZE, pool_count), smallest_pool)
        )

    knockout_bracket_size = pool_count * qualifiers_per_pool
    # ``max(2, …)`` is what makes a one-player knockout report ONE bye rather than none:
    # the smallest bracket that can be drawn holds two, so the missing player is a bye.
    first_round_byes = (
        _next_power_of_two(max(2, knockout_bracket_size)) - knockout_bracket_size
    )
    pool_match_count = sum(size * (size - 1) // 2 for size in pool_sizes)

    seats = pool_count * (target_size if target_size is not None else 0)
    conflict = (
        manual_pool_count is not None
        and target_size is not None
        and seats != field_size
    )
    disagreement: DrawStructureDisagreement | None = None
    if conflict and target_size is not None:
        disagreement = DrawStructureDisagreement(
            pool_count=pool_count,
            pool_size=target_size,
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
        pool_count=pool_count,
        pool_sizes=pool_sizes,
        qualifiers_per_pool=qualifiers_per_pool,
        total_qualifiers=knockout_bracket_size,
        knockout_bracket_size=knockout_bracket_size,
        first_round_byes=first_round_byes,
        pool_match_count=pool_match_count,
        ownership=DrawStructureOwnership(
            pool_count=(
                SettingOwnership.manual
                if manual_pool_count is not None
                else SettingOwnership.automatic
            ),
            pool_size=(
                SettingOwnership.manual
                if manual_pool_size is not None
                else SettingOwnership.automatic
            ),
            qualifiers=(
                SettingOwnership.manual
                if manual_qualifiers is not None
                else SettingOwnership.automatic
            ),
        ),
        disagreement=disagreement,
        # The ``not conflict`` guard mirrors the spec and the client. No input can
        # distinguish it: a disagreement needs both modes manual, and both manual gives
        # every pool the same size, so the two ends already agree. It stays because the
        # two implementations must read the same, not because a vector reaches it.
        is_uneven=not conflict and smallest_pool != largest_pool,
        impossible_problems=_impossible_problems(
            field_size=field_size,
            pool_count=pool_count,
            # The director's pool size, or ``None`` when the sizes came from splitting
            # the field across a count. It decides which of the two pool sentences is
            # honest, and nothing else — see
            # :func:`pool_too_small_for_pool_size_message`.
            pool_size=target_size,
            smallest_pool=smallest_pool,
            knockout_bracket_size=knockout_bracket_size,
            qualifiers_per_pool=qualifiers_per_pool,
        ),
    )


def _impossible_problems(
    *,
    field_size: int,
    pool_count: int,
    pool_size: int | None,
    smallest_pool: int,
    knockout_bracket_size: int,
    qualifiers_per_pool: int,
) -> tuple[ImpossibleProblem, ...]:
    """The three impossible competitions, **tested in order, first hit only**.

    The order is not arbitrary. A pool too small to play is often a pool too small to
    qualify from — an empty pool trips the qualifier rule whatever the count is, and a
    pool of one trips it under any manual count above one — but the pool is the fact a
    director can act on, and the rest are echoes of it. Reporting the echoes alongside
    it would make one mistake look like several.
    """
    # 1. A pool nobody can play in — named by the knob that produced the sizes, which is
    #    the pool size when the director typed one and the pool count otherwise.
    if smallest_pool < 2:
        return (
            ImpossibleProblem(
                kind=ImpossibleProblemKind.pool,
                message=(
                    pool_too_small_message(field_size, pool_count)
                    if pool_size is None
                    else pool_too_small_for_pool_size_message(field_size, pool_size)
                ),
            ),
        )

    # 2. A knockout of one. Reachable only from one pool taking one qualifier, and the
    #    winner of that pool would be handed a title without playing for it.
    if knockout_bracket_size < 2:
        return (
            ImpossibleProblem(
                kind=ImpossibleProblemKind.bracket,
                message=ONE_PLAYER_KNOCKOUT_MESSAGE,
            ),
        )

    # 3. More qualifiers than the smallest pool holds — the pool would advance players
    #    it does not have.
    if qualifiers_per_pool > smallest_pool:
        return (
            ImpossibleProblem(
                kind=ImpossibleProblemKind.qualifier,
                message=too_many_qualifiers_message(qualifiers_per_pool, smallest_pool),
            ),
        )

    return ()
