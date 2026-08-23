"""Unit tests for the pure draw-planning domain (``app.draws``, ADR-0786).

No database, no app — every test here builds its input from literals, which is the
point of keeping the strategies pure.
"""

import dataclasses
import uuid
from collections import Counter
from collections.abc import Collection, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from itertools import combinations

import pytest
from pydantic import ValidationError

from app.draws import (
    AdvancePlan,
    DegenerateDraw,
    DrawConfig,
    DrawError,
    Entrant,
    EntryId,
    FixtureGames,
    FixtureId,
    FixtureStage,
    FixtureState,
    GroupId,
    MatchId,
    MissingBracketSlot,
    MissingFixtureGames,
    MissingStageAssignment,
    OrderedEntrant,
    PlannedFixture,
    QualifierSeat,
    RoundRobinStrategy,
    RrThenKoStrategy,
    SeatedPairing,
    Side,
    SideFill,
    SingleElimStrategy,
    SwissStrategy,
    group_label,
    group_letter,
    order_entrants,
    qualifier_seed_assignment,
    reads_entrants,
    reads_fixture_games,
    ready_fixtures,
    strategy_for,
    swiss_byes,
    swiss_pairings,
    unseated_entrant_allowance,
)
from app.models.tournament import DrawType
from app.schemas.tournament import (
    DrawSettingsWriteArm,
    RoundRobinDrawSettingsWrite,
    RrThenKoDrawSettingsWrite,
    SingleElimDrawSettingsWrite,
    SwissDrawSettingsWrite,
    draw_settings_from_storage,
)

REGISTRATION_OPENED = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)


def _settings(draw_type: DrawType) -> DrawSettingsWriteArm:
    """The union arm ``draw_type`` names, with whatever configuration that arm
    **requires** filled in — the shape ``strategy_for`` takes since the settings column
    became one JSON object (ADR "a draw type's settings are one NOT NULL JSON object").

    Built through the same parse the storage boundary uses, so a draw type whose arm
    needs a setting this helper does not supply reds here with a ``ValidationError``
    rather than resolving to a strategy configured by omission.
    """
    required: dict[DrawType, dict[str, int]] = {
        DrawType.rr_then_ko: {"qualifiers_per_group": 2},
        DrawType.swiss: {"rounds": 3},
    }
    return draw_settings_from_storage(draw_type, required.get(draw_type, {}))


def _entry_id(n: int) -> EntryId:
    """A stable, readable entry id — ``…-0000000000NN``."""
    return EntryId(uuid.UUID(int=n))


def _entrant(n: int, *, seed: int | None = None, minutes: int = 0) -> Entrant:
    return Entrant(
        entry_id=_entry_id(n),
        seed=seed,
        created_at=REGISTRATION_OPENED + timedelta(minutes=minutes),
    )


def _ordered(count: int) -> list[OrderedEntrant]:
    """``count`` entrants in draw order: entrant ``i`` is seed ``i`` (1-based)."""
    return [
        OrderedEntrant(entry_id=_entry_id(i), position=i) for i in range(1, count + 1)
    ]


#: The field argument for the three strategies that **do not read it**. ``advance``
#: takes the event's entrants as well as its fixtures because a swiss bye is the
#: absence of a fixture row, so swiss cannot recover its field from the rows.
#: Round-robin seats its whole field in every group, and a bracket seats even its byed
#: seeds at cut time. Passing an empty field to those three asserts they never look.
NO_FIELD: tuple[OrderedEntrant, ...] = ()


@pytest.mark.parametrize(
    ("position", "letter"),
    [
        (0, "A"),
        (1, "B"),
        (25, "Z"),
        # The carry is ``n // 26 - 1``, not the naive ``n // 26``: the two agree for
        # positions 0..25 and disagree here first — a bijective base-26 digit has no
        # zero, so position 26 is "AA", not "BA" (the naive form's answer). This is
        # the case that actually catches an off-by-one in the carry.
        (26, "AA"),
        (27, "AB"),
        (51, "AZ"),
        (52, "BA"),
    ],
)
def test_group_letter_and_label(position: int, letter: str) -> None:
    """Ported from ``web-client/src/components/tournaments/data/draw-structure.ts``'s
    ``groupLetter`` (ADR 20260808, "draw-structure derivation runs on both sides and
    shares its vectors") — the same bijective base-26 vectors, pinned on both sides of
    the wire.

    ⚠️ **This table is asserted on the other side too**:
    ``web-client/src/components/tournaments/data/draw-structure.test.ts`` pins the
    identical seven ``(position, label)`` pairs, with a comment pointing back at this
    file (ticket #1369). Change one table and you must change the other, or the two
    derivations drift and only a director notices.
    """
    assert group_letter(position) == letter
    assert group_label(position) == f"Group {letter}"


def _seed_of(entry_id: EntryId | None) -> int:
    """Invert :func:`_ordered` — the seed number behind an entry id."""
    assert entry_id is not None
    return entry_id.int


#: The base a test group id is minted from. A group id is a ``uuid`` (ADR 20260801) —
#: the ``tournament_event_stage_groups`` primary key the server mints — so the
#: ``"A"``/``"B"`` the snake matrix below is written in are **labels**, not ids, and
#: :func:`_group` is the one place they become the ids the domain actually carries.
#: Derived from the letter rather than random so the same matrix entry names the same
#: group on every run and a failure is readable.
_GROUP_ID_BASE = 0xB00_10000


def _group(letter: str) -> GroupId:
    """The group id the matrix's ``letter`` stands for."""
    return GroupId(uuid.UUID(int=_GROUP_ID_BASE + (ord(letter) - ord("A"))))


def _group_ids(count: int) -> tuple[GroupId, ...]:
    """The first ``count`` groups' ids, in the event's own group order."""
    return tuple(_group(chr(ord("A") + i)) for i in range(count))


def _ordered_group_id(rank: int) -> GroupId:
    """A group id whose place in the ids' OWN sort order is ``rank`` (1 sorts first).

    The sort tie-break in ``ready_fixtures`` compares ids, and a random uuid's order is
    not something a test can state — so the handful of tests that are about that
    tie-break mint ids whose order is known, and say so."""
    return GroupId(uuid.UUID(int=_GROUP_ID_BASE + 0x1000 + rank))


def _config(group_count: int) -> DrawConfig:
    return DrawConfig(group_ids=_group_ids(group_count))


#: The stage a swiss draw's fixtures are dealt into — one stage, position 0, running
#: swiss (``app.tournament_event_stages.stage_template``). Named once because the
#: hand-built ``PlannedFixture`` literals below stand in for a cut this strategy would
#: have written, and every one of them carries it.
_SWISS_STAGE = FixtureStage(position=0, draw_type=DrawType.swiss)


def _members_by_group(fixtures: list[PlannedFixture]) -> dict[GroupId | None, set[int]]:
    """Group membership is *derived from the fixtures* — there is no assignment table
    (ADR-0786), so this is how the rest of the system will read it too."""
    members: dict[GroupId | None, set[int]] = {}
    for f in fixtures:
        members.setdefault(f.group_id, set()).update(
            {_seed_of(f.entry_a_id), _seed_of(f.entry_b_id)}
        )
    return members


def _pairs_by_group(
    fixtures: list[PlannedFixture],
) -> dict[GroupId | None, list[tuple[int, int]]]:
    """Every fixture as a seed pair, normalized so (1,2) and (2,1) are the same pair."""
    pairs: dict[GroupId | None, list[tuple[int, int]]] = {}
    for f in fixtures:
        a, b = _seed_of(f.entry_a_id), _seed_of(f.entry_b_id)
        pairs.setdefault(f.group_id, []).append((min(a, b), max(a, b)))
    return pairs


# The matrix the draw must hold for: (entrants, groups) → the exact snake membership,
# spelled out by hand rather than recomputed, so a broken snake cannot agree with a
# broken expectation. Group A takes 1, 2P, 2P+1, …; group B takes 2, 2P−1, …
SNAKE_MATRIX: list[tuple[int, int, dict[str, list[int]]]] = [
    (5, 1, {"A": [1, 2, 3, 4, 5]}),
    (6, 2, {"A": [1, 4, 5], "B": [2, 3, 6]}),
    (7, 2, {"A": [1, 4, 5], "B": [2, 3, 6, 7]}),
    (9, 3, {"A": [1, 6, 7], "B": [2, 5, 8], "C": [3, 4, 9]}),
]
MATRIX_IDS = [f"N={n},P={p}" for n, p, _ in SNAKE_MATRIX]


class TestOrderEntrants:
    def test_seeded_ascend_before_unseeded_which_follow_registration_order(
        self,
    ) -> None:
        # Deliberately shuffled input: the *order it arrives in* must not matter.
        entrants = [
            _entrant(1, minutes=30),  # unseeded, registered 3rd
            _entrant(2, seed=2, minutes=90),  # seeded 2, registered last
            _entrant(3, minutes=10),  # unseeded, registered 2nd
            _entrant(4, seed=1, minutes=60),  # seeded 1, registered 4th
            _entrant(5, minutes=5),  # unseeded, registered 1st
        ]

        assert [e.entry_id for e in order_entrants(entrants)] == [
            _entry_id(4),  # seed 1
            _entry_id(2),  # seed 2
            _entry_id(5),  # then the unseeded, oldest registration first
            _entry_id(3),
            _entry_id(1),
        ]

    def test_positions_are_one_based_and_contiguous(self) -> None:
        ordered = order_entrants([_entrant(i, minutes=i) for i in range(1, 5)])

        assert [e.position for e in ordered] == [1, 2, 3, 4]

    def test_all_unseeded_is_pure_registration_order(self) -> None:
        ordered = order_entrants(
            [_entrant(1, minutes=50), _entrant(2, minutes=10), _entrant(3, minutes=30)]
        )

        assert [e.entry_id for e in ordered] == [
            _entry_id(2),
            _entry_id(3),
            _entry_id(1),
        ]

    def test_a_seed_never_loses_to_an_earlier_registration(self) -> None:
        # The unseeded entrant registered first; the seed still leads the draw.
        ordered = order_entrants(
            [_entrant(1, minutes=0), _entrant(2, seed=7, minutes=99)]
        )

        assert [e.entry_id for e in ordered] == [_entry_id(2), _entry_id(1)]

    def test_the_seeds_own_order_beats_their_registration_order(self) -> None:
        # The seeds are ordered BY SEED, not by when they registered — and the two are
        # made to disagree here on purpose, because a field where they agree cannot tell
        # the two rules apart. Seed 1 registered dead last, seed 3 first; the draw is
        # 1, 2, 3 regardless, which is the whole point of a seed.
        #
        # (This is the case the ordering key's second element exists for. Collapse it to
        # a constant — the seeded then tie, and fall through to ``created_at`` — and
        # every other ordering test here still passes: they all seed in registration
        # order. Mutation testing is what found that, and this is what it found.)
        ordered = order_entrants(
            [
                _entrant(1, seed=3, minutes=0),
                _entrant(2, seed=2, minutes=30),
                _entrant(3, seed=1, minutes=60),
            ]
        )

        assert [e.entry_id for e in ordered] == [
            _entry_id(3),  # seed 1, registered last
            _entry_id(2),  # seed 2
            _entry_id(1),  # seed 3, registered first
        ]

    def test_identical_registration_instants_still_order_deterministically(
        self,
    ) -> None:
        # Same created_at (one transaction, one clock read) — the entry id breaks the
        # tie, because a re-cut must reproduce the draw exactly. No randomness anywhere.
        entrants = [_entrant(i, minutes=0) for i in (3, 1, 2)]

        first = order_entrants(entrants)
        second = order_entrants(list(reversed(entrants)))

        assert first == second
        assert [e.entry_id for e in first] == [_entry_id(1), _entry_id(2), _entry_id(3)]

    def test_no_entrants_is_an_empty_order_not_an_error(self) -> None:
        assert order_entrants([]) == []


class TestStrategyRegistry:
    def test_round_robin_resolves_to_the_round_robin_strategy(self) -> None:
        assert isinstance(
            strategy_for(RoundRobinDrawSettingsWrite()),
            RoundRobinStrategy,
        )

    def test_single_elim_resolves_to_the_single_elim_strategy(self) -> None:
        # The second implemented arm (ADR-0785).
        assert isinstance(
            strategy_for(SingleElimDrawSettingsWrite()),
            SingleElimStrategy,
        )

    def test_swiss_resolves_to_the_configured_swiss_strategy(self) -> None:
        """The fourth arm (ADR "swiss pre-cuts every round and pairs each one on
        advance") — configured, like rr-then-ko's: the round count is not a detail of
        the dispatch, it is the number of rounds the cut writes, so it is asserted to
        have arrived rather than merely to have been accepted."""
        strategy = strategy_for(SwissDrawSettingsWrite(rounds=5))

        assert strategy == SwissStrategy(rounds=5)

    def test_a_swiss_arm_cannot_be_built_without_a_round_count(self) -> None:
        """A swiss configuration with no round count is not a value ``strategy_for`` can
        be handed: ``rounds`` is required on the arm, with no default, so the refusal is
        at the boundary where the arm is built rather than a strategy configured by
        omission (ADR: "``R`` is a required, explicit setting")."""
        with pytest.raises(ValidationError, match="rounds"):
            SwissDrawSettingsWrite()  # type: ignore[call-arg]  # the point of the test

    def test_rr_then_ko_resolves_to_the_configured_rr_then_ko_strategy(self) -> None:
        """The third arm (ADR 20260727) — and the first whose strategy is *configured*:
        the qualifier count is not a detail of the dispatch, it is what the strategy
        cuts with, so it is asserted to have arrived rather than merely to have been
        accepted."""
        strategy = strategy_for(RrThenKoDrawSettingsWrite(qualifiers_per_group=3))

        assert strategy == RrThenKoStrategy(qualifiers_per_group=3)

    def test_an_rr_then_ko_arm_cannot_be_built_without_a_qualifier_count(self) -> None:
        """The old "``strategy_for`` refuses ``qualifiers_per_group=None``" test, moved
        one layer out and made stronger.

        ``strategy_for`` now takes the **arm**, so a configuration with no count is not
        a value it can be handed at all: the count is a required field, and the refusal
        happens where the arm would be built (ADR "a draw type's settings are one NOT
        NULL JSON object"). A K nobody chose is unrepresentable rather than caught."""
        with pytest.raises(ValidationError, match="qualifiers_per_group"):
            RrThenKoDrawSettingsWrite()  # type: ignore[call-arg]  # the point of the test

    def test_every_draw_type_resolves_to_a_strategy_and_none_refuses(self) -> None:
        """``strategy_for`` is **total** — the enum holds only draw types that run (ADR
        "a draw type is a seeded row, and the enum holds only what runs"), so there is
        no refusal arm left to reach and nothing may resolve to ``None``.

        This is the assertion that reds if a member is ever added to ``DrawType``
        without a strategy — alongside the type error the catch-all-free ``match``
        already is. It replaces the old "unimplemented types raise": that refusal has
        no input any more, because Pydantic rejects an un-backed slug at the request
        boundary instead.

        Every member goes through :func:`_settings`, which is also the assertion that
        each one HAS an arm: a member with none reds here on the parse, before the
        dispatch is even reached."""
        for draw_type in DrawType:
            assert strategy_for(_settings(draw_type)) is not None

    def test_the_games_gate_names_every_draw_type_and_only_the_one_that_reads_them(
        self,
    ) -> None:
        """``reads_fixture_games`` is what lets the materialization seam — which runs
        inside the score-accept transaction on **every** result — skip loading game
        counts nothing will read.

        A whole-enum equality, so a new ``DrawType`` reds here as well as failing to
        type-check in the catch-all-free ``match``: the gate is a claim about which
        strategies read ``FixtureState.games``, and a wrong answer is either a discarded
        query per result (harmless, slow) or a ``MissingFixtureGames`` on the seam
        (loud), never a silently mis-seated qualifier.
        """
        assert {
            draw_type: reads_fixture_games(draw_type) for draw_type in DrawType
        } == {
            DrawType.round_robin: False,
            DrawType.single_elim: False,
            DrawType.rr_then_ko: True,
            # Swiss pairs each round off the standings, whose chain counts games
            # (Buchholz, then game difference), so it declares the games it will read.
            DrawType.swiss: True,
        }

    def test_the_field_gate_names_every_draw_type_and_only_the_one_that_reads_it(
        self,
    ) -> None:
        """``reads_entrants`` is the games gate's sibling: it lets the same seam skip
        loading a field nothing will read, on every result submission.

        A whole-enum equality, so a new ``DrawType`` reds here as well as failing to
        type-check. The three ``False``\\ s are not "these formats have no byes" — they
        are "their byed entrants are seated in some other row", which is what makes the
        fixtures a complete description of their field and leaves swiss the only one
        that has to be told."""
        assert {draw_type: reads_entrants(draw_type) for draw_type in DrawType} == {
            DrawType.round_robin: False,
            DrawType.single_elim: False,
            DrawType.rr_then_ko: False,
            # A swiss bye is the absence of a row, so the seated set is not the field.
            DrawType.swiss: True,
        }

    def test_a_draw_type_the_field_gate_clears_advances_the_same_without_a_field(
        self,
    ) -> None:
        """And *true of the strategies*, not merely asserted about them: for every draw
        type the gate clears, a played-out draw advances byte-identically whether it is
        handed the field or an empty sequence.

        The falsifiable half. A strategy that started reading the field would part
        company here, rather than silently pairing nobody at the one seam that skips the
        load."""
        for draw_type in DrawType:
            if reads_entrants(draw_type):
                continue
            strategy = strategy_for(_settings(draw_type))
            ordered = _ordered(8)
            planned = strategy.plan_initial(_config(2), ordered)
            # One call for every draw type in the loop, ``group_ids`` harmless for the
            # two that never read ``group_position`` — only ``rr_then_ko`` genuinely
            # varies, since rr-then-ko's own advance() is the one reader of ``stage``
            # (ADR 20260815 decision 6) among the three this loop reaches.
            cut = _persisted(
                planned,
                group_ids=_config(2).group_ids,
                rr_then_ko=draw_type is DrawType.rr_then_ko,
            )
            played = _played(
                cut,
                {
                    frozenset({f.entry_a_id.int, f.entry_b_id.int}): (
                        min(f.entry_a_id.int, f.entry_b_id.int),
                        3,
                        1,
                    )
                    for f in cut
                    if f.entry_a_id is not None and f.entry_b_id is not None
                },
            )
            assert not strategy.advance(cut, ordered).is_empty, (
                f"{draw_type.value}: two empty plans would compare equal for free"
            )

            for state in (cut, played):
                assert strategy.advance(state, ordered) == strategy.advance(
                    state, NO_FIELD
                )

    @pytest.mark.parametrize("field_size", [6, 7])
    def test_the_bye_allowance_names_every_draw_type_and_only_swiss_byes_absently(
        self, field_size: int
    ) -> None:
        """``unseated_entrant_allowance`` is what lets a draw's currency tell a **byed**
        entrant from one who entered after the cut.

        A whole-enum equality at both parities, so a new ``DrawType`` reds here as well
        as failing to type-check in the catch-all-free ``match``. The three zeros are
        not "these formats have no byes" — an odd round-robin group byes somebody every
        round — they are "their byed entrants are seated in some *other* fixture", which
        is what makes the strict comparison right for them and wrong for swiss.
        """
        assert {
            draw_type: unseated_entrant_allowance(draw_type, field_size)
            for draw_type in DrawType
        } == {
            DrawType.round_robin: 0,
            DrawType.single_elim: 0,
            DrawType.rr_then_ko: 0,
            # A swiss round seats ⌊n/2⌋ pairs, so an odd field leaves exactly one
            # entrant in no fixture at all.
            DrawType.swiss: field_size % 2,
        }

    def test_the_bye_allowance_matches_what_the_swiss_cut_actually_leaves_unseated(
        self,
    ) -> None:
        """And the allowance is *true of the strategy*, not merely asserted about it:
        for each field size, the entrants the cut leaves in no fixture are counted off
        the fixtures it emits.

        This is the falsifiable half. A cut that started seating its byed entrant (or a
        parity slip in either direction) would part company with the allowance here,
        rather than in a go-live 409 three layers away.
        """
        for field_size in range(2, 10):
            ordered = _ordered(field_size)
            fixtures = SwissStrategy(rounds=1).plan_initial(DrawConfig(), ordered)
            seated = {
                entry_id
                for f in fixtures
                for entry_id in (f.entry_a_id, f.entry_b_id)
                if entry_id is not None
            }
            unseated = {entrant.entry_id for entrant in ordered} - seated

            assert len(unseated) == unseated_entrant_allowance(
                DrawType.swiss, field_size
            ), f"field of {field_size}"

    def test_a_draw_type_the_gate_clears_advances_the_same_without_its_games(
        self,
    ) -> None:
        """And the gate's answer is *true of the strategies*, not just asserted about
        them: for every draw type it clears, a fully-played draw advances
        byte-identically with the game counts stripped out.

        This is the falsifiable half. A strategy that started reading the field would
        plan something different from the two states and red here, rather than silently
        advancing on ``games=None`` at the one seam that would have skipped the load.
        """
        for draw_type in DrawType:
            if reads_fixture_games(draw_type):
                continue
            strategy = strategy_for(_settings(draw_type))
            cut = _persisted(strategy.plan_initial(_config(2), _ordered(8)))
            with_games = _played(
                cut,
                {
                    frozenset({f.entry_a_id.int, f.entry_b_id.int}): (
                        min(f.entry_a_id.int, f.entry_b_id.int),
                        3,
                        1,
                    )
                    for f in cut
                    if f.entry_a_id is not None and f.entry_b_id is not None
                },
            )
            without_games = [dataclasses.replace(f, games=None) for f in with_games]
            assert any(f.games is not None for f in with_games), (
                f"{draw_type.value}: the two states must actually differ"
            )

            assert strategy.advance(with_games, NO_FIELD) == strategy.advance(
                without_games, NO_FIELD
            )

    def test_the_draw_type_lives_in_exactly_one_place_and_it_is_not_the_config(
        self,
    ) -> None:
        """``strategy_for`` (above) is where a draw type is *read*, and picking the
        strategy is the whole of what it decides. ``DrawConfig`` used to carry a copy of
        it as well — populated by ``draw_config``, read by no strategy, and chosen from
        the event's own column *before* the config was ever built.

        A second source of truth for a settled decision, and one that could contradict
        the strategy holding it: ``RoundRobinStrategy().plan_initial(DrawConfig(
        draw_type=DrawType.single_elim, …))`` was a sentence you could write, and
        nothing anywhere would notice. Nothing *could*: mutation testing set the field
        to ``None`` and killed no test, because no production code read it.

        So this asserts on the config's **shape**, not on a behaviour — there is no
        behaviour to assert on, which is precisely the finding. It is the only assertion
        that can fail when the field comes back, and it is what stops the next strategy
        to land from branching on ``config.draw_type`` in the belief that it is
        authoritative.
        """
        assert [field.name for field in dataclasses.fields(DrawConfig)] == ["group_ids"]


class TestRoundRobinCut:
    @pytest.mark.parametrize(
        ("entrants", "groups", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_entrants_are_snaked_across_the_groups(
        self, entrants: int, groups: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(
            _config(groups), _ordered(entrants)
        )

        members = _members_by_group(fixtures)
        # Keyed back onto the matrix's letters: the group ids are uuids
        # (ADR 20260801), and ``_group`` is the one place a letter becomes one.
        assert {
            letter: sorted(members[_group(letter)]) for letter in expected
        } == expected
        assert set(members) == {_group(letter) for letter in expected}

    @pytest.mark.parametrize(
        ("entrants", "groups", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_group_sizes_differ_by_at_most_one_and_cover_every_entrant(
        self, entrants: int, groups: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(
            _config(groups), _ordered(entrants)
        )

        sizes = [len(m) for m in _members_by_group(fixtures).values()]
        assert len(sizes) == groups
        assert max(sizes) - min(sizes) <= 1
        assert sum(sizes) == entrants

    @pytest.mark.parametrize(
        ("entrants", "groups", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_every_within_group_pair_meets_exactly_once_and_no_cross_group_pair_exists(
        self, entrants: int, groups: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(
            _config(groups), _ordered(entrants)
        )

        pairs_by_group = _pairs_by_group(fixtures)
        assert set(pairs_by_group) == {_group(p) for p in expected}

        for group_id, seeds in expected.items():
            pairs = pairs_by_group[_group(group_id)]
            n = len(seeds)
            # All-play-all: exactly n(n-1)/2 fixtures...
            assert len(pairs) == n * (n - 1) // 2
            # ...no pair twice...
            assert max(Counter(pairs).values()) == 1
            # ...and precisely the pairs of THIS group's members — which is also what
            # rules out any cross-group pairing, since no other seed appears at all.
            assert set(pairs) == {
                (min(a, b), max(a, b)) for a, b in combinations(sorted(seeds), 2)
            }

    @pytest.mark.parametrize(
        ("entrants", "groups", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_nobody_plays_twice_in_the_same_round_of_their_group(
        self, entrants: int, groups: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(
            _config(groups), _ordered(entrants)
        )

        per_round: dict[tuple[GroupId | None, int], list[int]] = {}
        for f in fixtures:
            per_round.setdefault((f.group_id, f.round), []).extend(
                [_seed_of(f.entry_a_id), _seed_of(f.entry_b_id)]
            )

        for (group_id, round_number), seeds in per_round.items():
            assert len(seeds) == len(set(seeds)), (
                f"group {group_id} round {round_number} plays someone twice: {seeds}"
            )

    @pytest.mark.parametrize(
        ("entrants", "groups", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_rounds_and_positions_are_one_based_and_contiguous(
        self, entrants: int, groups: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(
            _config(groups), _ordered(entrants)
        )

        for group_id, seeds in expected.items():
            group_fixtures = [f for f in fixtures if f.group_id == _group(group_id)]
            n = len(seeds)
            # An even group plays n-1 rounds; an odd one needs n (each entrant sits out
            # exactly once), which is the whole reason a bye exists.
            expected_rounds = n - 1 if n % 2 == 0 else n
            rounds = sorted({f.round for f in group_fixtures})
            assert rounds == list(range(1, expected_rounds + 1))

            for round_number in rounds:
                positions = sorted(
                    f.position for f in group_fixtures if f.round == round_number
                )
                # 1-based and gapless *within the round* — a dropped bye must not leave
                # a hole in the numbering.
                assert positions == list(range(1, len(positions) + 1))

    @pytest.mark.parametrize(
        ("entrants", "groups", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_a_bye_is_the_absence_of_a_fixture_never_a_null_side(
        self, entrants: int, groups: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(
            _config(groups), _ordered(entrants)
        )

        # NULL means "TBD" and nothing else; a round-robin fixture is never TBD.
        assert all(
            f.entry_a_id is not None and f.entry_b_id is not None for f in fixtures
        )

        for group_id, seeds in expected.items():
            n = len(seeds)
            if n % 2 == 0:
                continue
            # An odd group sits one entrant out per round: (n-1)/2 fixtures, not n/2
            # rounded up, and certainly not a phantom row.
            per_round = Counter(
                f.round for f in fixtures if f.group_id == _group(group_id)
            )
            assert set(per_round.values()) == {(n - 1) // 2}

    def test_the_same_input_cuts_the_same_draw_twice(self) -> None:
        # Re-cutting is a sanctioned, reviewable act — it must be reproducible, which
        # is why the ordering has no rating fallback and no randomness.
        strategy = RoundRobinStrategy()
        config, entrants = _config(3), _ordered(9)

        assert strategy.plan_initial(config, entrants) == strategy.plan_initial(
            config, entrants
        )

    def test_a_fresh_strategy_instance_cuts_the_same_draw(self) -> None:
        config, entrants = _config(2), _ordered(7)

        assert RoundRobinStrategy().plan_initial(
            config, entrants
        ) == RoundRobinStrategy().plan_initial(config, entrants)

    def test_the_smallest_legal_group_is_two_entrants_playing_once(self) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(1), _ordered(2))

        assert fixtures == [
            PlannedFixture(
                stage=FixtureStage(position=0, draw_type=DrawType.round_robin),
                group_id=_group("A"),
                round=1,
                position=1,
                entry_a_id=_entry_id(1),
                entry_b_id=_entry_id(2),
            )
        ]

    # The refusal's message is not diagnostics — it is **copy**. ``_draw_refusal``
    # passes a ``DegenerateDraw``'s ``str()`` through to the 422 body verbatim, on
    # purpose (only the strategy knows *which* degeneracy it hit), so the sentence
    # authored here is the sentence a director reads, and the numbers in it are the
    # numbers they have to change. It is pinned where it is written.
    @pytest.mark.parametrize(
        ("entrants", "groups", "message"),
        [
            pytest.param(
                1,
                1,
                "1 entrant across 1 group would leave a group with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="a-lone-entrant-has-nobody-to-play",
            ),
            pytest.param(
                0,
                1,
                "0 entrants across 1 group would leave a group with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="a-ghost-group",
            ),
            pytest.param(
                3,
                2,
                "3 entrants across 2 groups would leave a group with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="the-snake-would-leave-group-B-with-one",
            ),
            pytest.param(
                5,
                3,
                "5 entrants across 3 groups would leave a group with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="...and-group-C-with-one",
            ),
        ],
    )
    def test_a_group_of_fewer_than_two_is_refused(
        self, entrants: int, groups: int, message: str
    ) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            RoundRobinStrategy().plan_initial(_config(groups), _ordered(entrants))

        assert isinstance(excinfo.value, DrawError)
        # Both numbers, because either one of them is a thing the director can move:
        # cut fewer groups, or go and find another player.
        assert str(excinfo.value) == message

    def test_the_refusal_inflects_its_count_nouns(self) -> None:
        # Singular counts get singular nouns — never "1 entrants" and never the lazy
        # "group(s)" — so a one-entrant, one-group refusal reads like a sentence.
        with pytest.raises(DegenerateDraw) as singular:
            RoundRobinStrategy().plan_initial(_config(1), _ordered(1))
        singular_message = str(singular.value)
        assert "1 entrant across 1 group" in singular_message
        assert "1 entrants" not in singular_message
        assert "group(s)" not in singular_message

        # Plural counts stay plural.
        with pytest.raises(DegenerateDraw) as plural:
            RoundRobinStrategy().plan_initial(_config(2), _ordered(3))
        assert "3 entrants across 2 groups" in str(plural.value)

    def test_a_draw_with_no_groups_is_refused(self) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            RoundRobinStrategy().plan_initial(DrawConfig(group_ids=()), _ordered(4))

        # A different degeneracy and a different sentence: no arrangement of the field
        # fixes this one, so it names the groups rather than the entrants.
        assert str(excinfo.value) == "A round-robin draw needs at least one group."

    def test_groups_are_named_by_the_events_own_group_ids(self) -> None:
        # A group id is the event's own group row's uuid, not an index we mint.
        morning, evening = GroupId(uuid.uuid4()), GroupId(uuid.uuid4())
        config = DrawConfig(group_ids=(morning, evening))

        fixtures = RoundRobinStrategy().plan_initial(config, _ordered(6))

        assert {f.group_id for f in fixtures} == {
            morning,
            evening,
        }


_RR_THEN_KO_GROUP_STAGE = FixtureStage(position=0, draw_type=DrawType.round_robin)
_RR_THEN_KO_KNOCKOUT_STAGE = FixtureStage(position=1, draw_type=DrawType.single_elim)


def _persisted(
    planned: Sequence[PlannedFixture],
    *,
    materialized: bool = False,
    group_ids: Sequence[GroupId] = (),
    rr_then_ko: bool = False,
) -> list[FixtureState]:
    """The planned fixtures as they'd read back after ``plan_initial`` was persisted.

    ``group_ids`` and ``rr_then_ko`` are optional, and exist for the one draw type whose
    fixtures the real seam resolves two extra discriminators for — the composite. Every
    other draw type's test calls this with neither, and every fixture's
    ``group_position``/``stage`` come back unresolved (``None``), exactly as before this
    helper absorbed what used to be a near-duplicate ``_persisted_rr_then_ko``.

    ``group_ids``: ``app.tournament_draws.group_order`` resolves each group's place
    in the event's own group order — the same sequence ``DrawConfig.group_ids``
    carries.
    Omitted (the default, ``()``) leaves every group's position unresolved — the shape a
    caller that skipped that plumbing hands the strategy, and the fallback the
    labelling repair degrades to.

    ``rr_then_ko``: mirrors ``app.tournament_draws.cut_draw``'s own write — every
    GROUPED fixture belongs to stage 0 (round-robin) and every UN-GROUPED one to stage 1
    (single-elim), the exact template ``app.tournament_event_stages.stage_template``
    mints for ``DrawType.rr_then_ko``. That is a fact about the WRITER, not a rule this
    helper is entitled to apply to a fixture some other test hands it wearing a
    different shape — a test that needs a fixture whose group-ness and stage DISAGREE
    builds that ONE fixture by hand with ``dataclasses.replace(..., stage=...)`` over
    this helper's ordinary output, rather than asking this function to guess at a shape
    it does not itself derive (see
    ``TestRrThenKoAdvance.test_rr_then_ko_splits_by_stage_not_by_group_ness``).
    """
    group_position = {group_id: index for index, group_id in enumerate(group_ids)}
    return [
        FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=1000 + i)),
            group_id=f.group_id,
            group_position=(
                group_position.get(f.group_id) if f.group_id is not None else None
            ),
            stage=(
                (
                    _RR_THEN_KO_GROUP_STAGE
                    if f.group_id is not None
                    else _RR_THEN_KO_KNOCKOUT_STAGE
                )
                if rr_then_ko
                else None
            ),
            round=f.round,
            position=f.position,
            entry_a_id=f.entry_a_id,
            entry_b_id=f.entry_b_id,
            match_id=MatchId(uuid.UUID(int=2000 + i)) if materialized else None,
        )
        for i, f in enumerate(planned)
    ]


class TestRoundRobinAdvance:
    def test_a_freshly_cut_draw_is_ready_in_its_entirety_and_fills_nothing(
        self,
    ) -> None:
        # Round-robin pairings are fully determined at the cut, so advance() has no side
        # to fill — every fixture is ready the moment the tournament goes live.
        planned = RoundRobinStrategy().plan_initial(_config(2), _ordered(7))
        fixtures = _persisted(planned)

        plan = RoundRobinStrategy().advance(fixtures, NO_FIELD)

        assert plan.side_fills == ()
        assert set(plan.ready_fixture_ids) == {f.fixture_id for f in fixtures}
        assert not plan.is_empty

    def test_ready_ids_are_ordered_by_group_round_position(self) -> None:
        fixtures = _persisted(
            RoundRobinStrategy().plan_initial(_config(2), _ordered(6))
        )
        by_id = {f.fixture_id: f for f in fixtures}

        # Feed them in deliberately scrambled — the plan must not inherit input order.
        plan = RoundRobinStrategy().advance(list(reversed(fixtures)), NO_FIELD)

        keys = [
            (by_id[fid].group_id or "", by_id[fid].round, by_id[fid].position)
            for fid in plan.ready_fixture_ids
        ]
        assert keys == sorted(keys)

    def test_advancing_an_already_materialized_draw_is_a_no_op(self) -> None:
        # THE idempotence claim: apply the plan (matches now exist), re-run advance, and
        # it proposes nothing. That is what lets advance() run after every result.
        planned = RoundRobinStrategy().plan_initial(_config(2), _ordered(6))

        plan = RoundRobinStrategy().advance(
            _persisted(planned, materialized=True), NO_FIELD
        )

        assert plan == AdvancePlan()
        assert plan.is_empty

    def test_advance_is_a_pure_function_of_the_state(self) -> None:
        fixtures = _persisted(
            RoundRobinStrategy().plan_initial(_config(1), _ordered(5))
        )
        strategy = RoundRobinStrategy()

        assert strategy.advance(fixtures, NO_FIELD) == strategy.advance(
            fixtures, NO_FIELD
        )

    def test_a_decided_fixture_is_not_ready_again(self) -> None:
        # match_id is ON DELETE SET NULL, so a decided fixture can lose its match link.
        # It must not rise from the dead and be played a second time.
        decided = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=1)),
            group_id=_group("A"),
            round=1,
            position=1,
            entry_a_id=_entry_id(1),
            entry_b_id=_entry_id(2),
            winner_entry_id=_entry_id(1),
            match_id=None,
        )

        assert RoundRobinStrategy().advance([decided], NO_FIELD).is_empty

    def test_a_fixture_with_an_unknown_side_is_never_ready(self) -> None:
        pending = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=1)),
            group_id=None,
            round=2,
            position=1,
            entry_a_id=_entry_id(1),
            entry_b_id=None,  # TBD
        )

        assert pending.is_pending
        assert RoundRobinStrategy().advance([pending], NO_FIELD).is_empty

    def test_an_empty_draw_advances_to_an_empty_plan(self) -> None:
        assert RoundRobinStrategy().advance([], NO_FIELD) == AdvancePlan()


class TestReadyFixtures:
    """``ready_fixtures`` is shared by every strategy — "ready" is a property of the
    fixture, not of the draw type — so it is tested as the total function it is, against
    inputs no single strategy produces on its own."""

    def _state(
        self,
        n: int,
        *,
        group_id: GroupId | None,
        round: int,
        position: int,
        group_position: int | None = None,
    ) -> FixtureState:
        return FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=n)),
            group_id=group_id,
            round=round,
            position=position,
            group_position=group_position,
            entry_a_id=_entry_id(1),
            entry_b_id=_entry_id(2),
        )

    def test_the_plan_runs_the_groups_in_the_events_order_not_the_ids(self) -> None:
        """Ten groups, and the plan runs 1..10 — not the ids' 1, 10, 2, 3…

        Group ids are client-minted strings (``p-1-…``, ``p-2-…``, ``p-10-…``) and
        lexicographically ``p-10-`` falls between ``p-1-`` and ``p-2-``, so the id sort
        this used to do materialized a ten-group event's matches with group 10's
        wedged between group 1's and group 2's. The order the plan runs in is the
        director's (``group_position``, ADR 20260801) — the same order the read path
        renders and the same one the snake dealt against.

        The ids are handed in *deliberately mismatched* to the positions: the group
        at position 0 carries the id that sorts LAST and the group at position 9 the
        id that sorts first. So the two rules do not merely differ, they are opposites
        — an
        implementation that fell back to the id could not accidentally agree with this
        assertion on any prefix of it. (Under the old client-minted ids this was spelled
        ``p-10-…``/``p-1-…``; a group id is a uuid now, so the mismatch is constructed
        from ids whose numeric order is known.)
        """
        groups = [(_ordered_group_id(10 - index), index) for index in range(10)]
        states = [
            self._state(
                index + 1,
                group_id=group_id,
                round=1,
                position=1,
                group_position=position,
            )
            for index, (group_id, position) in enumerate(groups)
        ]

        ready = ready_fixtures(list(reversed(states)))

        assert ready == tuple(state.fixture_id for state in states)

    def test_a_group_of_unknown_position_sorts_behind_the_placed_ones_by_id(
        self,
    ) -> None:
        """A fixture whose group order was not resolved — a caller that passed no group
        positions, or a group stored before ``position`` existed — still has a *defined*
        place: after every group that has a position, ordered among its own kind by id.

        That is the pre-position order preserved exactly where the position cannot
        speak, rather than an unresolved fixture jumping the queue. It matters because
        ``0`` is a real position (the *first* group), so "unknown" must not collapse
        onto it: the
        placed group below sits at 0, holds the id that sorts *last*, and still comes
        first.

        The un-grouped fixture is here to pin the other end. Its position is ``None``
        too — it is in no group, so there is nothing to place — which is exactly why
        "grouped?" has to stay the *outermost* question: decided on position alone the
        KO fixture would tie with the unplaced groups and win the id tie-break outright
        (no id sorts before ``""``), landing in front of the groups that feed it.
        """
        placed = self._state(
            1, group_id=_ordered_group_id(9), round=1, position=1, group_position=0
        )
        unplaced_b = self._state(2, group_id=_ordered_group_id(2), round=1, position=1)
        unplaced_a = self._state(3, group_id=_ordered_group_id(1), round=1, position=1)
        ko = self._state(4, group_id=None, round=1, position=1)

        ready = ready_fixtures([ko, unplaced_b, unplaced_a, placed])

        assert ready == (
            placed.fixture_id,
            unplaced_a.fixture_id,
            unplaced_b.fixture_id,
            ko.fixture_id,
        )

    def test_grouped_fixtures_are_ready_before_un_grouped_ones(self) -> None:
        # The mixed set is the one a grouped-then-knockout draw will hand this: the
        # group fixtures carry a group ref, the KO fixtures behind them carry NULL.
        # A ``None`` does not compare against a ``str``, so the sort key has to
        # *decide* where the ungrouped sit rather than fall over — and where they
        # sit has to be a fact, not
        # whatever order the rows came back in.
        ko = self._state(1, group_id=None, round=1, position=1)
        b1 = self._state(2, group_id=_group("B"), round=1, position=1)
        a2 = self._state(3, group_id=_group("A"), round=1, position=2)
        a1 = self._state(4, group_id=_group("A"), round=1, position=1)
        a_round2 = self._state(5, group_id=_group("A"), round=2, position=1)

        # Fed in scrambled — and it is the *stated* order that is asserted, not merely
        # that the output is self-consistently sorted (which a reversed rule would also
        # be).
        ready = ready_fixtures([ko, a_round2, b1, a2, a1])

        assert ready == (
            a1.fixture_id,
            a2.fixture_id,
            a_round2.fixture_id,
            b1.fixture_id,
            ko.fixture_id,  # the un-grouped sort last, behind every group
        )

    def test_readiness_ignores_the_draw_type_that_planned_the_fixture(self) -> None:
        # Same three states, asked of the shared helper and of the strategy: a fixture
        # that is ready is ready, and a strategy cannot make it less so.
        ready = self._state(1, group_id=_group("A"), round=1, position=1)
        materialized = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=2)),
            group_id=_group("A"),
            round=1,
            position=2,
            entry_a_id=_entry_id(3),
            entry_b_id=_entry_id(4),
            match_id=MatchId(uuid.UUID(int=99)),
        )
        pending = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=3)),
            group_id=None,
            round=2,
            position=1,
            entry_a_id=_entry_id(1),
            entry_b_id=None,
        )
        fixtures = [ready, materialized, pending]

        assert ready_fixtures(fixtures) == (ready.fixture_id,)
        assert RoundRobinStrategy().advance(fixtures, NO_FIELD) == AdvancePlan(
            side_fills=(), ready_fixture_ids=(ready.fixture_id,)
        )


def _single_elim_round_one(
    fixtures: list[PlannedFixture],
) -> dict[int, frozenset[int]]:
    """Round-1 matches as ``position → the pair of seeds``. Every round-1 fixture seats
    two known seeds (a bye never makes a round-1 row), so both sides are non-``None``
    here."""
    return {
        f.position: frozenset({_seed_of(f.entry_a_id), _seed_of(f.entry_b_id)})
        for f in fixtures
        if f.round == 1
    }


def _single_elim_round_two_prefills(
    fixtures: list[PlannedFixture],
) -> dict[tuple[int, str], int]:
    """The round-2 sides a bye seated at cut time: ``(position, "a"/"b") → seed``. A
    ``None`` side is TBD and left out — so this is exactly the byed seeds and where they
    sit."""
    prefills: dict[tuple[int, str], int] = {}
    for f in fixtures:
        if f.round != 2:
            continue
        if f.entry_a_id is not None:
            prefills[(f.position, "a")] = _seed_of(f.entry_a_id)
        if f.entry_b_id is not None:
            prefills[(f.position, "b")] = _seed_of(f.entry_b_id)
    return prefills


# The bracket each K must cut, spelled out by hand (never recomputed, so a broken
# seeding cannot agree with a broken expectation): the round-1 seed pairings by
# position, the byed seeds and the round-2 side each lands on, and the per-round
# fixture counts. The seeding is the standard recursive table
# ``[1,2] → [1,4,3,2] → [1,8,5,4,3,6,7,2] → …`` (ADR-0785); byes fall on the top
# ``B − N`` seeds.
SINGLE_ELIM_MATRIX: list[
    tuple[
        int,
        dict[int, frozenset[int]],
        dict[tuple[int, str], int],
        dict[int, int],
    ]
] = [
    # K, round-1 pairings, round-2 bye seatings, per-round counts
    (2, {1: frozenset({1, 2})}, {}, {1: 1}),
    (3, {2: frozenset({2, 3})}, {(1, "a"): 1}, {1: 1, 2: 1}),
    (4, {1: frozenset({1, 4}), 2: frozenset({2, 3})}, {}, {1: 2, 2: 1}),
    (
        5,
        {2: frozenset({4, 5})},
        # Seeds 1, 2, 3 bye; seed 1 into semifinal 1, and seeds 3 & 2 fill BOTH sides of
        # semifinal 2 — a both-byes fixture that is fully known at the cut.
        {(1, "a"): 1, (2, "a"): 3, (2, "b"): 2},
        {1: 1, 2: 2, 3: 1},
    ),
    (
        8,
        {
            1: frozenset({1, 8}),
            2: frozenset({4, 5}),
            3: frozenset({3, 6}),
            4: frozenset({2, 7}),
        },
        {},
        {1: 4, 2: 2, 3: 1},
    ),
    (
        16,
        {
            1: frozenset({1, 16}),
            2: frozenset({8, 9}),
            3: frozenset({5, 12}),
            4: frozenset({4, 13}),
            5: frozenset({3, 14}),
            6: frozenset({6, 11}),
            7: frozenset({7, 10}),
            8: frozenset({2, 15}),
        },
        {},
        {1: 8, 2: 4, 3: 2, 4: 1},
    ),
]
SINGLE_ELIM_IDS = [f"K={k}" for k, _, _, _ in SINGLE_ELIM_MATRIX]


class TestSingleElimCut:
    def test_every_bracket_fixture_is_dealt_into_the_stages_one_group(self) -> None:
        """#1483: a single-elim cut stamps every fixture — round one and every later
        round — with the one group its stage holds, and puts them on that stage.

        The group is the hop the scheduler resolves a reservation through
        (``app.schedule_solves.restricting_reservation_key``), so a bracket that named
        none was placed across the tournament's whole table catalogue however narrowly
        its director had booked. It is not a claim that a bracket is a group: the
        stage's own draw type is ``single-elim``, which is what every labelling and
        bucketing surface reads.
        """
        cut = SingleElimStrategy().plan_initial(_config(1), _ordered(4))

        assert {f.group_id for f in cut} == {_group("A")}
        assert {f.round for f in cut} == {1, 2}, "later rounds too, not only round one"
        assert {f.stage for f in cut} == {
            FixtureStage(position=0, draw_type=DrawType.single_elim)
        }

    def test_a_cut_against_no_configured_group_still_plans_an_ungrouped_bracket(
        self,
    ) -> None:
        """The arm production does not take. A bare ``DrawConfig()`` names no group, so
        ``_sole_group`` answers ``None`` and the bracket is planned exactly as it was
        before the floor existed — a caller that never asked about groups is not made
        to raise about them."""
        cut = SingleElimStrategy().plan_initial(DrawConfig(), _ordered(4))

        assert {f.group_id for f in cut} == {None}

    @pytest.mark.parametrize(
        ("k", "round_one", "prefills", "counts"),
        SINGLE_ELIM_MATRIX,
        ids=SINGLE_ELIM_IDS,
    )
    def test_round_one_pairings_are_the_standard_seeding(
        self,
        k: int,
        round_one: dict[int, frozenset[int]],
        prefills: dict[tuple[int, str], int],
        counts: dict[int, int],
    ) -> None:
        # Un-grouped: single-elim ignores ``group_ids`` and every fixture carries a
        # ``None`` group ref.
        fixtures = SingleElimStrategy().plan_initial(DrawConfig(), _ordered(k))

        assert all(f.group_id is None for f in fixtures)
        assert _single_elim_round_one(fixtures) == round_one

    @pytest.mark.parametrize(
        ("k", "round_one", "prefills", "counts"),
        SINGLE_ELIM_MATRIX,
        ids=SINGLE_ELIM_IDS,
    )
    def test_byes_fall_on_the_top_seeds_and_seat_into_round_two(
        self,
        k: int,
        round_one: dict[int, frozenset[int]],
        prefills: dict[tuple[int, str], int],
        counts: dict[int, int],
    ) -> None:
        fixtures = SingleElimStrategy().plan_initial(DrawConfig(), _ordered(k))

        assert _single_elim_round_two_prefills(fixtures) == prefills
        # A bye is absence, never a NULL round-1 side: the byed seeds are exactly the
        # top ``B − N`` seeds, and they appear nowhere in round 1.
        byed = set(prefills.values())
        round_one_seeds = {s for pair in round_one.values() for s in pair}
        assert byed.isdisjoint(round_one_seeds)
        if byed:
            assert byed == set(range(1, len(byed) + 1))  # the *top* seeds

    @pytest.mark.parametrize(
        ("k", "round_one", "prefills", "counts"),
        SINGLE_ELIM_MATRIX,
        ids=SINGLE_ELIM_IDS,
    )
    def test_per_round_fixture_counts(
        self,
        k: int,
        round_one: dict[int, frozenset[int]],
        prefills: dict[tuple[int, str], int],
        counts: dict[int, int],
    ) -> None:
        fixtures = SingleElimStrategy().plan_initial(DrawConfig(), _ordered(k))

        assert Counter(f.round for f in fixtures) == Counter(counts)
        # ADR-0786: a 5-entrant single-elim persists 4 rows.
        assert len(fixtures) == sum(counts.values())

    @pytest.mark.parametrize(
        ("k", "round_one", "prefills", "counts"),
        SINGLE_ELIM_MATRIX,
        ids=SINGLE_ELIM_IDS,
    )
    def test_the_top_two_seeds_can_only_meet_in_the_final(
        self,
        k: int,
        round_one: dict[int, frozenset[int]],
        prefills: dict[tuple[int, str], int],
        counts: dict[int, int],
    ) -> None:
        # The defining property of a correct bracket: seeds 1 and 2 start in opposite
        # halves, so their successor chains only converge at the final. Walk each seed's
        # entry point (round-1 match or round-2 bye) up via ``ceil(position / 2)`` and
        # confirm they share no fixture until the last round.
        fixtures = SingleElimStrategy().plan_initial(DrawConfig(), _ordered(k))
        final_round = max(f.round for f in fixtures)

        path_one = _successor_path(fixtures, seed=1, final_round=final_round)
        path_two = _successor_path(fixtures, seed=2, final_round=final_round)
        shared = set(path_one) & set(path_two)
        assert shared == {(final_round, 1)}, (
            f"seeds 1 and 2 share {shared}, not just the final, for K={k}"
        )

    def test_the_five_entrant_both_byes_semifinal_is_fully_known(self) -> None:
        # The three round-2 shapes at the cut, on one bracket: a played-feeder side that
        # is TBD, a bye-filled side, and a semifinal with both sides byes — which
        # is emitted fully known and will materialize at go-live like any other fixture.
        fixtures = SingleElimStrategy().plan_initial(DrawConfig(), _ordered(5))
        by_rp = {(f.round, f.position): f for f in fixtures}

        semi_with_a_feeder = by_rp[(2, 1)]
        assert _seed_of(semi_with_a_feeder.entry_a_id) == 1  # bye
        assert semi_with_a_feeder.entry_b_id is None  # TBD — the seed 4 v 5 winner

        both_byes = by_rp[(2, 2)]
        assert both_byes.entry_a_id is not None and both_byes.entry_b_id is not None
        assert {_seed_of(both_byes.entry_a_id), _seed_of(both_byes.entry_b_id)} == {
            2,
            3,
        }

    def test_the_same_input_cuts_the_same_bracket_twice(self) -> None:
        strategy = SingleElimStrategy()

        assert strategy.plan_initial(
            DrawConfig(), _ordered(11)
        ) == strategy.plan_initial(DrawConfig(), _ordered(11))

    @pytest.mark.parametrize("k", [1, 0], ids=["one-entrant", "no-entrants"])
    def test_a_bracket_of_fewer_than_two_is_refused(self, k: int) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            SingleElimStrategy().plan_initial(DrawConfig(), _ordered(k))

        assert isinstance(excinfo.value, DrawError)
        assert str(excinfo.value) == (
            "A single-elimination draw needs at least 2 entrants — a bracket of "
            "one has nobody to play."
        )


def _successor_path(
    fixtures: list[PlannedFixture], *, seed: int, final_round: int
) -> list[tuple[int, int]]:
    """The ``(round, position)`` coordinates a seed passes through if it wins out, from
    its entry point (round-1 match, or the round-2 slot it byes onto) up to the final —
    following the same ``ceil(position / 2)`` topology :func:`app.draws._successor`
    encodes."""
    entry_id = _entry_id(seed)
    start: tuple[int, int] | None = None
    for f in fixtures:
        if f.entry_a_id == entry_id or f.entry_b_id == entry_id:
            start = (f.round, f.position)
            break
    assert start is not None
    round_number, position = start
    path = [start]
    while round_number < final_round:
        round_number, position = round_number + 1, (position + 1) // 2
        path.append((round_number, position))
    return path


class TestSingleElimAdvance:
    def _persisted_bracket(self, k: int) -> list[FixtureState]:
        return _persisted(SingleElimStrategy().plan_initial(DrawConfig(), _ordered(k)))

    def _decide(
        self,
        fixtures: list[FixtureState],
        *,
        round: int,
        position: int,
        winner: EntryId,
    ) -> list[FixtureState]:
        """The same state with the fixture at ``(round, position)`` marked decided —
        what the completion seam does before it re-runs ``advance``."""
        return [
            dataclasses.replace(f, winner_entry_id=winner)
            if (f.round, f.position) == (round, position)
            else f
            for f in fixtures
        ]

    def test_an_odd_position_winner_seats_into_the_successors_a_side(self) -> None:
        fixtures = self._persisted_bracket(8)
        by_rp = {(f.round, f.position): f for f in fixtures}
        winner = by_rp[(1, 1)].entry_a_id
        assert winner is not None

        plan = SingleElimStrategy().advance(
            self._decide(fixtures, round=1, position=1, winner=winner), NO_FIELD
        )

        # position 1 is odd → side a of round 2, position ceil(1/2) = 1.
        assert plan.side_fills == (
            SideFill(fixture_id=by_rp[(2, 1)].fixture_id, side=Side.a, entry_id=winner),
        )

    def test_an_even_position_winner_seats_into_the_successors_b_side(self) -> None:
        fixtures = self._persisted_bracket(8)
        by_rp = {(f.round, f.position): f for f in fixtures}
        winner = by_rp[(1, 2)].entry_b_id
        assert winner is not None

        plan = SingleElimStrategy().advance(
            self._decide(fixtures, round=1, position=2, winner=winner), NO_FIELD
        )

        # position 2 is even → side b of round 2, position ceil(2/2) = 1.
        assert plan.side_fills == (
            SideFill(fixture_id=by_rp[(2, 1)].fixture_id, side=Side.b, entry_id=winner),
        )

    def test_advance_is_idempotent_once_the_seat_is_applied(self) -> None:
        # THE idempotence claim: decide a fixture, apply the side-fill its advance
        # proposed, feed the result back — the second advance seats nothing.
        fixtures = self._persisted_bracket(8)
        by_rp = {(f.round, f.position): f for f in fixtures}
        winner = by_rp[(1, 1)].entry_a_id
        assert winner is not None

        decided = self._decide(fixtures, round=1, position=1, winner=winner)
        applied = [
            dataclasses.replace(f, entry_a_id=winner)
            if (f.round, f.position) == (2, 1)
            else f
            for f in decided
        ]

        assert SingleElimStrategy().advance(applied, NO_FIELD).side_fills == ()

    def test_a_champion_is_seated_nowhere_the_final_has_no_successor(self) -> None:
        # A decided final must not seat its winner into a non-existent round after
        # it — the champion is read through the results, never seated.
        fixtures = self._persisted_bracket(4)
        by_rp = {(f.round, f.position): f for f in fixtures}
        # Fill the final's sides (as go-live would) and crown one side.
        champion = _entry_id(1)
        final = by_rp[(2, 1)]
        decided_final = dataclasses.replace(
            final,
            entry_a_id=_entry_id(1),
            entry_b_id=_entry_id(2),
            winner_entry_id=champion,
        )
        state = [decided_final if f is final else f for f in fixtures]

        assert SingleElimStrategy().advance(state, NO_FIELD).side_fills == ()

    def test_a_freshly_cut_bracket_is_ready_exactly_where_both_sides_are_known(
        self,
    ) -> None:
        # At the cut nothing is decided, so nothing is seated; readiness is exactly the
        # fixtures whose sides are already known — the round-1 match and the both-byes
        # semifinal — never the half-filled or wholly-TBD ones.
        fixtures = self._persisted_bracket(5)
        by_rp = {(f.round, f.position): f for f in fixtures}

        plan = SingleElimStrategy().advance(fixtures, NO_FIELD)

        assert plan.side_fills == ()
        ready = set(plan.ready_fixture_ids)
        assert by_rp[(1, 2)].fixture_id in ready  # the seed 4 v 5 match
        assert by_rp[(2, 2)].fixture_id in ready  # both-byes semifinal, fully known
        assert by_rp[(2, 1)].fixture_id not in ready  # one side still TBD
        assert by_rp[(3, 1)].fixture_id not in ready  # final, both sides TBD


#: The legal configuration space the ADR defines: ``K ≥ 1`` (Pydantic, at the request
#: boundary) and ``P × K ≥ 2`` (at the cut). Swept whole rather than sampled — the
#: guarantee is universal, so a handful of hand-picked cases would not be evidence for
#: it. ``P`` runs past any club-night group count and ``K`` past any plausible cut.
LEGAL_QUALIFIER_CONFIGURATIONS = [
    (group_count, per_group)
    for group_count in range(1, 9)
    for per_group in range(1, 5)
    if group_count * per_group >= 2
]


def _group_letter(group_index: int) -> str:
    """``0 → 'A'`` — the same labelling :func:`_group_ids` gives the groups
    themselves."""
    return chr(ord("A") + group_index)


def _seat_label(seat: QualifierSeat) -> str:
    """``A1`` — group A's winner; ``C2`` — group C's runner-up."""
    return f"{_group_letter(seat.group_index)}{seat.place}"


def _round_one_seed_pairs(qualifier_count: int) -> list[tuple[int, int]]:
    """Which **seed numbers** meet in round one of a bracket holding this many
    qualifiers.

    Reconstructed by cutting a real single-elimination bracket over that many entrants,
    rather than by restating ``B+1−s``: the knockout stage of an rr-then-ko draw is the
    same bracket shape (the ADR reuses ``_seed_slots`` unchanged), and reading it off
    the public cutter keeps the property test independent of the assignment's own idea
    of who plays whom. Byed seeds have no round-1 fixture, so they simply do not appear
    — which is correct, a bye can never be a rematch.
    """
    fixtures = SingleElimStrategy().plan_initial(
        DrawConfig(), _ordered(qualifier_count)
    )
    return [
        (_seed_of(f.entry_a_id), _seed_of(f.entry_b_id))
        for f in fixtures
        if f.round == 1
    ]


class TestQualifierSeedAssignment:
    """Seeding group qualifiers into the knockout bracket (ADR "rr-then-ko cuts both
    stages upfront and seeds qualifiers rematch-free").

    The claim these defend is absolute, not statistical: across the *whole* legal
    configuration space, no round-one knockout fixture holds two qualifiers out of
    the same group — and the one-group case is exempt on purpose, which is asserted
    as its own positive property rather than skipped.
    """

    def test_no_round_one_pairing_holds_two_qualifiers_from_the_same_group(
        self,
    ) -> None:
        offenders = [
            f"P={group_count} K={per_group}: seeds {left} v {right} are both out of "
            f"group {_group_letter(assignment[left].group_index)} "
            f"({_seat_label(assignment[left])} vs {_seat_label(assignment[right])})"
            for group_count, per_group in LEGAL_QUALIFIER_CONFIGURATIONS
            # One group is a waiver, asserted positively in its own test below.
            if group_count >= 2
            for assignment in [qualifier_seed_assignment(group_count, per_group)]
            for left, right in _round_one_seed_pairs(group_count * per_group)
            if assignment[left].group_index == assignment[right].group_index
        ]

        assert offenders == []

    def test_one_group_seeds_qualifiers_by_place_and_is_all_rematches_by_design(
        self,
    ) -> None:
        # The waiver, stated as a property rather than an exclusion: with a single group
        # every knockout match *is* a rematch, because every qualifier came out of the
        # same group. That is "league, then a playoff" working, not the guarantee
        # failing — so assert it holds rather than skipping the case.
        for per_group in (2, 3, 4):
            assignment = qualifier_seed_assignment(1, per_group)

            assert assignment == {
                seed: QualifierSeat(group_index=0, place=seed)
                for seed in range(1, per_group + 1)
            }
            pairs = _round_one_seed_pairs(per_group)
            assert pairs, f"K={per_group} should have a round-1 match to be a rematch"
            assert all(
                assignment[left].group_index == assignment[right].group_index
                for left, right in pairs
            )

    def test_seeds_are_place_major_and_each_qualifier_is_seeded_exactly_once(
        self,
    ) -> None:
        # The shape the guarantee is built on: place block k owns seeds kP+1..kP+P, and
        # holds every group exactly once — which is what makes an intra-block round-one
        # pair safe for free, and what leaves the group order free to be chosen.
        for group_count, per_group in LEGAL_QUALIFIER_CONFIGURATIONS:
            assignment = qualifier_seed_assignment(group_count, per_group)
            qualifier_count = group_count * per_group

            assert sorted(assignment) == list(range(1, qualifier_count + 1))
            assert len(set(assignment.values())) == qualifier_count
            for block in range(per_group):
                seeds = range(block * group_count + 1, (block + 1) * group_count + 1)
                assert {assignment[seed].place for seed in seeds} == {block + 1}
                assert {assignment[seed].group_index for seed in seeds} == set(
                    range(group_count)
                )

    def test_the_same_qualifier_configuration_always_gets_the_same_seeds(self) -> None:
        # A re-cut must reproduce the bracket, exactly as `order_entrants` promises for
        # the draw order — the augmenting search walks groups in ascending index order
        # precisely so its answer is a function of the inputs and not of iteration luck.
        # Collected rather than asserted in the loop so a red names *which* (P, K)
        # wobbled, and how, instead of dying on the first one.
        offenders = [
            f"P={group_count} K={per_group}: "
            f"{ {seed: _seat_label(s) for seed, s in first.items()} } "
            f"then { {seed: _seat_label(s) for seed, s in second.items()} }"
            for group_count, per_group in LEGAL_QUALIFIER_CONFIGURATIONS
            for first in [qualifier_seed_assignment(group_count, per_group)]
            for second in [qualifier_seed_assignment(group_count, per_group)]
            if first != second
        ]

        assert offenders == []

    def test_a_configuration_outside_the_legal_space_is_refused(self) -> None:
        # Programmer errors, not director errors: the director-facing refusals are the
        # strategy's `DegenerateDraw`s at the cut, where the entrant count is in hand.
        with pytest.raises(ValueError):
            qualifier_seed_assignment(0, 2)
        with pytest.raises(ValueError):
            qualifier_seed_assignment(2, 0)
        with pytest.raises(ValueError):
            # A "bracket" of one qualifier has nobody to play.
            qualifier_seed_assignment(1, 1)


# ── round-robin then knockout ────────────────────────────────────────────────────
#
# The cut matrix, spelled out by hand rather than recomputed: (groups, entrants,
# qualifiers per group) → the qualifier count, the derived bracket size, the round-1
# positions that exist (the byed ones are *absent*), and the per-round knockout fixture
# counts. Bracket size is the smallest power of two ≥ P × K and is never configured.
RR_THEN_KO_MATRIX: list[tuple[int, int, int, int, int, set[int], dict[int, int]]] = [
    # P, N, K, qualifiers, bracket, round-1 positions, per-round counts
    (1, 4, 2, 2, 2, {1}, {1: 1}),  # one group: league, then a playoff
    (2, 8, 2, 4, 4, {1, 2}, {1: 2, 2: 1}),  # exact power of two: no byes
    (3, 12, 1, 3, 4, {2}, {1: 1, 2: 1}),  # 1 bye — seed 1 walks into the final
    (3, 12, 2, 6, 8, {2, 3}, {1: 2, 2: 2, 3: 1}),  # 2 byes into the semifinals
    (4, 16, 1, 4, 4, {1, 2}, {1: 2, 2: 1}),
    (5, 20, 3, 15, 16, {2, 3, 4, 5, 6, 7, 8}, {1: 7, 2: 4, 3: 2, 4: 1}),
]
RR_THEN_KO_IDS = [f"P={p},N={n},K={k}" for p, n, k, _, _, _, _ in RR_THEN_KO_MATRIX]

#: Group A of the 3-group, 12-entrant cut — seeds 1, 6, 7 and 12 — played out so that
#: the finishing order is 6, 12, 7, 1: the top seed loses everything and the group's
#: second seed wins it. Keyed by the *pair* and valued ``(winner, winner's games,
#: loser's games)``, so a result reads the same whichever way round the fixture seated
#: the two.
GROUP_A_RESULTS: dict[frozenset[int], tuple[int, int, int]] = {
    frozenset({1, 12}): (12, 3, 0),
    frozenset({6, 7}): (6, 3, 1),
    frozenset({1, 7}): (7, 3, 2),
    frozenset({12, 6}): (6, 3, 2),
    frozenset({1, 6}): (6, 3, 0),
    frozenset({7, 12}): (12, 3, 1),
}
GROUP_A_FINISHING_ORDER = [6, 12, 7, 1]

#: A four-entrant group with a **three-way tie on wins** — 1 beat 2 beat 3 beat 1, and
#: all three beat 4. A cycle cannot be broken head-to-head, so the order falls through
#: to the game tiebreakers, which is the whole point: it settles 2 above 1 *even though
#: 1 beat 2*, so an order computed on wins (+ head-to-head, + entry id) cannot make it.
CYCLIC_GROUP_RESULTS: dict[frozenset[int], tuple[int, int, int]] = {
    frozenset({1, 2}): (1, 3, 2),
    frozenset({2, 3}): (2, 3, 0),
    frozenset({1, 3}): (3, 3, 1),
    frozenset({1, 4}): (1, 3, 0),
    frozenset({2, 4}): (2, 3, 1),
    frozenset({3, 4}): (3, 3, 2),
}
#: Game difference: 2 → +4, 1 → +2, 3 → 0, 4 → −6.
CYCLIC_GROUP_FINISHING_ORDER = [2, 1, 3, 4]


def _rr_then_ko(qualifiers_per_group: int) -> RrThenKoStrategy:
    return RrThenKoStrategy(qualifiers_per_group=qualifiers_per_group)


def _knockout(fixtures: Sequence[PlannedFixture]) -> list[PlannedFixture]:
    """The knockout stage of an **rr-then-ko** cut — the fixtures its composite deals
    onto the single-elim stage the template mints at position 1.

    Read off the fixture's own stage, not off ``group_id IS NULL``. That spelling was
    right only while an un-grouped fixture could belong to nothing else; #1483 makes a
    whole-event single-elim bracket grouped, so "un-grouped" and "the knockout half"
    are no longer the same set anywhere but inside this one composite."""
    return [f for f in fixtures if f.stage.position == 1]


def _grouped(fixtures: Sequence[PlannedFixture]) -> list[PlannedFixture]:
    """The group half of an **rr-then-ko** cut — its round-robin stage, position 0."""
    return [f for f in fixtures if f.stage.draw_type is DrawType.round_robin]


def _played(
    fixtures: Sequence[FixtureState],
    results: Mapping[frozenset[int], tuple[int, int, int]],
) -> list[FixtureState]:
    """Play out every fixture whose seed pair appears in ``results`` — what the
    completion seam leaves behind: a written-back ``winner_entry_id``, the match's game
    counts oriented ``entry_a`` ↔ side 1, and a materialized match."""
    played: list[FixtureState] = []
    for index, fixture in enumerate(fixtures):
        if fixture.entry_a_id is None or fixture.entry_b_id is None:
            played.append(fixture)
            continue
        result = results.get(
            frozenset({fixture.entry_a_id.int, fixture.entry_b_id.int})
        )
        if result is None:
            played.append(fixture)
            continue
        winner_seed, winner_games, loser_games = result
        winner = _entry_id(winner_seed)
        a_won = fixture.entry_a_id == winner
        played.append(
            dataclasses.replace(
                fixture,
                winner_entry_id=winner,
                games=FixtureGames(
                    entry_a_games=winner_games if a_won else loser_games,
                    entry_b_games=loser_games if a_won else winner_games,
                ),
                match_id=MatchId(uuid.UUID(int=3000 + index)),
            )
        )
    return played


def _voided(
    fixtures: Sequence[FixtureState],
    pairs: Collection[frozenset[int]],
    *,
    keep_winner: bool = True,
) -> list[FixtureState]:
    """Void the fixtures whose seed pair appears in ``pairs`` — what an account merge's
    self-play collision leaves behind (ADR-0013): a terminal match that can never
    produce a result, and therefore no games.

    ``keep_winner`` is the nastier of the two real shapes and the default: the match was
    **completed first**, so the completion wrote ``winner_entry_id`` back onto the
    fixture, and voiding does not clear it (``app.match_voiding.void_match`` touches the
    match and its sides, not the draw). The fixture is left reading *decided, with no
    games* — which is exactly the shape ``MissingFixtureGames`` fires on for an
    unvoided fixture, so this is also what pins that guard's exclusion. ``False`` is the
    other shape: voided before anybody played, no winner ever written.
    """
    voided: list[FixtureState] = []
    for index, fixture in enumerate(fixtures):
        pair = (
            frozenset({fixture.entry_a_id.int, fixture.entry_b_id.int})
            if fixture.entry_a_id is not None and fixture.entry_b_id is not None
            else None
        )
        if pair is None or pair not in pairs:
            voided.append(fixture)
            continue
        voided.append(
            dataclasses.replace(
                fixture,
                match_voided=True,
                games=None,
                winner_entry_id=(fixture.entry_a_id if keep_winner else None),
                # A voided fixture always has a match — voiding is something done TO
                # one — so it keeps the id ``_played`` gave it, or gets one here if it
                # was voided without ever being scored.
                match_id=fixture.match_id or MatchId(uuid.UUID(int=4000 + index)),
            )
        )
    return voided


def _lower_seed_wins(
    fixtures: Sequence[FixtureState],
) -> dict[frozenset[int], tuple[int, int, int]]:
    """A whole-draw sweep in which the better seed always wins 3-1, so every group
    finishes in seed order and the qualifiers are its two best seeds."""
    return {
        pair: (min(pair), 3, 1)
        for fixture in fixtures
        if fixture.group_id is not None
        and fixture.entry_a_id is not None
        and fixture.entry_b_id is not None
        for pair in [frozenset({fixture.entry_a_id.int, fixture.entry_b_id.int})]
    }


def _knockout_sides(
    fixtures: Sequence[FixtureState],
) -> dict[tuple[int, int, str], int | None]:
    """Every knockout side as ``(round, position, "a"/"b") → seed`` (``None`` = still
    unknown), which is how a director reads a half-seeded bracket."""
    sides: dict[tuple[int, int, str], int | None] = {}
    for fixture in fixtures:
        if fixture.group_id is not None:
            continue
        for side, entry_id in (("a", fixture.entry_a_id), ("b", fixture.entry_b_id)):
            sides[(fixture.round, fixture.position, side)] = (
                None if entry_id is None else entry_id.int
            )
    return sides


def _apply(fixtures: Sequence[FixtureState], plan: AdvancePlan) -> list[FixtureState]:
    """Apply a plan's side-fills, exactly as ``materialize_event`` does before it
    decides readiness — the state a *second* ``advance()`` sees, and so the input every
    idempotence claim is made against."""
    filled = {f.fixture_id: f for f in fixtures}
    for fill in plan.side_fills:
        target = filled[fill.fixture_id]
        filled[fill.fixture_id] = dataclasses.replace(
            target,
            **(
                {"entry_a_id": fill.entry_id}
                if fill.side is Side.a
                else {"entry_b_id": fill.entry_id}
            ),
        )
    return [filled[f.fixture_id] for f in fixtures]


class TestRrThenKoCut:
    """One stroke cuts both stages: every group's round-robin *and* the whole bracket,
    the latter entirely TBD-sided (ADR "rr-then-ko cuts both stages upfront")."""

    def test_rr_then_ko_cuts_the_group_stage_a_round_robin_draw_would_have_cut(
        self,
    ) -> None:
        # Structural, not "equivalent": the group fixtures are round-robin's own cut,
        # so the two cannot drift.
        cut = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        assert _grouped(cut) == RoundRobinStrategy().plan_initial(
            _config(3), _ordered(12)
        )

    @pytest.mark.parametrize(
        (
            "group_count",
            "entrants",
            "per_group",
            "qualifiers",
            "bracket",
            "r1",
            "counts",
        ),
        RR_THEN_KO_MATRIX,
        ids=RR_THEN_KO_IDS,
    )
    def test_rr_then_ko_cuts_the_whole_bracket_with_every_side_unknown(
        self,
        group_count: int,
        entrants: int,
        per_group: int,
        qualifiers: int,
        bracket: int,
        r1: set[int],
        counts: dict[int, int],
    ) -> None:
        cut = _rr_then_ko(per_group).plan_initial(
            _config(group_count), _ordered(entrants)
        )
        knockout = _knockout(cut)

        assert group_count * per_group == qualifiers
        # Bracket size is *derived* (smallest power of two ≥ P × K), never configured.
        assert 2 ** len(counts) == bracket
        assert Counter(f.round for f in knockout) == counts
        # Nobody has qualified, so every knockout side is TBD — and a TBD side is a
        # ``None``, never a placeholder entry.
        assert all(f.entry_a_id is None and f.entry_b_id is None for f in knockout)

    @pytest.mark.parametrize(
        (
            "group_count",
            "entrants",
            "per_group",
            "qualifiers",
            "bracket",
            "r1",
            "counts",
        ),
        RR_THEN_KO_MATRIX,
        ids=RR_THEN_KO_IDS,
    )
    def test_rr_then_ko_byes_are_absent_round_one_fixtures_never_null_sided_rows(
        self,
        group_count: int,
        entrants: int,
        per_group: int,
        qualifiers: int,
        bracket: int,
        r1: set[int],
        counts: dict[int, int],
    ) -> None:
        # Which seeds bye is settled at cut time — the top B − Q of them — even though
        # nobody has played, which is exactly what lets the bracket be cut upfront.
        cut = _rr_then_ko(per_group).plan_initial(
            _config(group_count), _ordered(entrants)
        )

        positions = {f.position for f in _knockout(cut) if f.round == 1}
        assert positions == r1
        byed_seeds = set(range(1, qualifiers + 1)) - {
            seed
            for pair in _single_elim_round_one(
                SingleElimStrategy().plan_initial(DrawConfig(), _ordered(qualifiers))
            ).values()
            for seed in pair
        }
        assert byed_seeds == set(range(1, bracket - qualifiers + 1))

    def test_rr_then_ko_cuts_the_bracket_a_single_elim_over_the_qualifiers_would(
        self,
    ) -> None:
        # The knockout stage *is* a single-elimination bracket — the same shape, byes
        # and all — with its seats not yet known. Asserted against the real cutter
        # rather than a restatement, so the two cannot drift.
        cut = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        # Normalised on the two axes the two cuts legitimately differ on, so what is
        # left is the bracket's own shape: the seats (a composite's qualifiers are
        # unknown at the cut) and the STAGE (a composite's bracket is its position-1
        # stage, a whole-event single-elim's is its only stage, position 0).
        assert _knockout(cut) == [
            dataclasses.replace(
                f,
                entry_a_id=None,
                entry_b_id=None,
                stage=FixtureStage(position=1, draw_type=DrawType.single_elim),
            )
            for f in SingleElimStrategy().plan_initial(DrawConfig(), _ordered(6))
        ]

    def test_rr_then_ko_knockout_rounds_restart_at_one_in_their_own_namespace(
        self,
    ) -> None:
        # The unique constraint is ``(stage_id, group_id, round, position)`` with NULLS
        # NOT DISTINCT, so the knockout stage is its own numbering namespace and starts
        # again at round 1 — a group round 1 and a knockout round 1 are different keys,
        # and nothing in the cut collides.
        cut = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        assert min(f.round for f in _knockout(cut)) == 1
        assert min(f.round for f in _grouped(cut)) == 1
        keys = [(f.stage.position, f.group_id, f.round, f.position) for f in cut]
        assert len(set(keys)) == len(keys)

    def test_the_composite_does_not_deal_its_bracket_into_the_group_stages_group(
        self,
    ) -> None:
        """#1483 gives ``_knockout_fixtures`` a group parameter, and the composite must
        keep passing none.

        The builder is SHARED with the whole-event single-elim cut, which now hands it
        the one group its stage holds. A composite that let that argument through would
        deal its bracket into the round-robin half's group — corrupting the very
        standings its qualifiers are picked from, and (via the group's reservation)
        confining a bracket to the window booked for the groups it follows.

        Its knockout stage gets groups of its own in #1484, materialised per stage;
        until then the whole half is ``group_id=None``.
        """
        cut = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        assert {f.group_id for f in _knockout(cut)} == {None}
        assert None not in {f.group_id for f in _grouped(cut)}

    def test_rr_then_ko_cuts_the_same_draw_twice(self) -> None:
        first = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))
        second = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        assert first == second

    def test_rr_then_ko_takes_the_whole_group_when_everyone_qualifies(self) -> None:
        # K = ⌊N/P⌋ is legal: the group stage then exists purely to *seed* the knockout.
        cut = _rr_then_ko(4).plan_initial(_config(4), _ordered(16))

        assert len(_knockout(cut)) == 8 + 4 + 2 + 1  # a full 16-slot bracket, no byes
        assert {f.position for f in _knockout(cut) if f.round == 1} == set(range(1, 9))

    def test_rr_then_ko_a_single_group_is_legal_and_is_league_then_a_playoff(
        self,
    ) -> None:
        # The one-group waiver: every knockout match is necessarily a rematch, which is
        # the format working as intended, not a refusal.
        cut = _rr_then_ko(2).plan_initial(_config(1), _ordered(5))

        assert {f.group_id for f in _grouped(cut)} == {_group("A")}
        assert len(_knockout(cut)) == 1  # a two-qualifier final

    def test_rr_then_ko_refuses_to_take_more_qualifiers_than_the_smallest_group_holds(
        self,
    ) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            # 7 entrants over 2 groups deals 3 and 4, so 4 qualifiers per group is more
            # than the smaller group has players.
            _rr_then_ko(4).plan_initial(_config(2), _ordered(7))

        assert str(excinfo.value) == (
            "Taking 4 qualifiers from each group is more than the 3 entrants in the "
            "smallest group — take fewer qualifiers from each group, or add entrants."
        )
        assert isinstance(excinfo.value, DrawError)

    def test_rr_then_ko_refuses_a_knockout_stage_of_fewer_than_two_qualifiers(
        self,
    ) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            _rr_then_ko(1).plan_initial(_config(1), _ordered(5))

        assert str(excinfo.value) == (
            "Taking 1 qualifier from a single group leaves one player in the knockout "
            "stage, who would have nobody to play — take more qualifiers from each "
            "group, or configure more groups."
        )

    def test_rr_then_ko_refuses_a_group_of_fewer_than_two(self) -> None:
        # Inherited from the snake, unchanged: the group floor comes free with the group
        # stage, so rr-then-ko does not restate it.
        with pytest.raises(DegenerateDraw) as excinfo:
            _rr_then_ko(1).plan_initial(_config(3), _ordered(5))

        assert "fewer than 2 entrants" in str(excinfo.value)

    def test_rr_then_ko_refuses_fewer_than_one_qualifier_per_group_at_construction(
        self,
    ) -> None:
        # A *programmer* error, not a director one — K ≥ 1 is a static constraint at the
        # request boundary — so it is a ValueError, and the illegal strategy cannot even
        # be built.
        with pytest.raises(ValueError, match="qualifiers_per_group must be at least 1"):
            RrThenKoStrategy(qualifiers_per_group=0)


class TestRrThenKoAdvance:
    """Each group seats its qualifiers the moment *it* is decided, into slots settled at
    the cut — with the other groups still playing."""

    def _cut(self) -> list[FixtureState]:
        """The 3-group, 12-entrant, top-2 draw as it reads back after the cut. The snake
        deals group A seeds 1, 6, 7, 12; B 2, 5, 8, 11; C 3, 4, 9, 10."""
        return _persisted(
            _rr_then_ko(2).plan_initial(_config(3), _ordered(12)),
            group_ids=_config(3).group_ids,
            rr_then_ko=True,
        )

    def test_rr_then_ko_seats_a_finished_groups_qualifiers_and_nobody_elses(
        self,
    ) -> None:
        # THE claim: group A is decided while B and C are still playing, and A's two
        # qualifiers take their predetermined slots at once. The slots are fixed by
        # ``qualifier_seed_assignment(3, 2)``, which never sees a result: group A's
        # winner is seed 1 (which byes into semifinal 1) and its runner-up is seed 6
        # (round 1, position 3, side b).
        fixtures = _played(self._cut(), GROUP_A_RESULTS)
        by_slot = {(f.round, f.position): f for f in fixtures if f.group_id is None}

        plan = _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert plan.side_fills == (
            SideFill(
                fixture_id=by_slot[(2, 1)].fixture_id,
                side=Side.a,
                entry_id=_entry_id(6),
            ),
            SideFill(
                fixture_id=by_slot[(1, 3)].fixture_id,
                side=Side.b,
                entry_id=_entry_id(12),
            ),
        )
        # Every other knockout side is still unknown: B and C have not finished.
        assert _knockout_sides(_apply(fixtures, plan)) == {
            (1, 2, "a"): None,
            (1, 2, "b"): None,
            (1, 3, "a"): None,
            (1, 3, "b"): 12,
            (2, 1, "a"): 6,
            (2, 1, "b"): None,
            (2, 2, "a"): None,
            (2, 2, "b"): None,
            (3, 1, "a"): None,
            (3, 1, "b"): None,
        }

    def test_rr_then_ko_qualifiers_are_the_top_of_the_groups_finishing_order(
        self,
    ) -> None:
        # The qualifiers are the top K of *the* finishing order — the same function the
        # standings table is built from — and this group proves the whole tiebreak chain
        # is live: a three-way cycle on wins is settled on game difference, which seats
        # entry 2 above entry 1 even though 1 beat 2 head-to-head. An order computed on
        # wins alone (or wins + head-to-head + entry id) puts 1 first.
        cut = _persisted(
            _rr_then_ko(2).plan_initial(_config(1), _ordered(4)),
            group_ids=_config(1).group_ids,
            rr_then_ko=True,
        )
        fixtures = _played(cut, CYCLIC_GROUP_RESULTS)

        plan = _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert _knockout_sides(_apply(fixtures, plan)) == {
            (1, 1, "a"): CYCLIC_GROUP_FINISHING_ORDER[0],
            (1, 1, "b"): CYCLIC_GROUP_FINISHING_ORDER[1],
        }

    def test_rr_then_ko_seats_nothing_for_a_group_that_is_still_playing(self) -> None:
        # Per-group, not all-or-nothing — and the converse: a group with results in
        # it but a fixture still to play seats nobody, because its order is not
        # settled.
        cut = self._cut()
        partial = dict(list(GROUP_A_RESULTS.items())[:-1])

        assert _rr_then_ko(2).advance(_played(cut, partial), NO_FIELD).side_fills == ()

    def test_rr_then_ko_is_idempotent_once_the_qualifiers_are_seated(self) -> None:
        # THE idempotence claim: apply the plan, feed the result back, and the second
        # advance seats nobody — a SideFill only ever fills an *empty* side.
        fixtures = _played(self._cut(), GROUP_A_RESULTS)
        first = _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert (
            _rr_then_ko(2).advance(_apply(fixtures, first), NO_FIELD).side_fills == ()
        )

    def test_rr_then_ko_plans_nothing_at_all_over_its_own_fully_applied_plan(
        self,
    ) -> None:
        # The stronger form: with the fills applied *and* the newly-ready fixtures
        # materialized (what ``materialize_event`` does in the same transaction), the
        # whole plan is empty — which is what makes re-running after every result safe.
        fixtures = _played(self._cut(), GROUP_A_RESULTS)
        applied = _apply(fixtures, _rr_then_ko(2).advance(fixtures, NO_FIELD))
        materialized = [
            dataclasses.replace(f, match_id=MatchId(uuid.UUID(int=4000 + i)))
            if f.match_id is None
            else f
            for i, f in enumerate(applied)
        ]

        assert _rr_then_ko(2).advance(materialized, NO_FIELD) == AdvancePlan()

    def test_rr_then_ko_advances_the_knockout_as_a_single_elim_bracket_does(
        self,
    ) -> None:
        # Once the bracket is under way it is single-elim's own forward seating: a
        # decided knockout fixture seats its winner into its successor slot.
        cut = self._cut()
        seeded = [
            dataclasses.replace(
                f,
                entry_a_id=_entry_id(3),
                entry_b_id=_entry_id(6),
                winner_entry_id=_entry_id(3),
            )
            if (f.group_id, f.round, f.position) == (None, 1, 3)
            else f
            for f in cut
        ]
        by_slot = {(f.round, f.position): f for f in seeded if f.group_id is None}

        plan = _rr_then_ko(2).advance(seeded, NO_FIELD)

        # Round 1 position 3 is odd → side a of round 2, position 2.
        assert (
            SideFill(
                fixture_id=by_slot[(2, 2)].fixture_id,
                side=Side.a,
                entry_id=_entry_id(3),
            )
            in plan.side_fills
        )

    def test_rr_then_ko_never_seats_a_group_winner_forward_into_a_knockout_slot(
        self,
    ) -> None:
        # A group fixture has no successor — its ``(round, position)`` lives in the
        # group's own namespace, and reading it as a bracket coordinate would seat a
        # group winner into a knockout slot belonging to somebody else. Only the
        # *finished* group's qualifier seating touches the bracket, so a half-played
        # group fills
        # nothing.
        cut = self._cut()
        partial = dict(list(GROUP_A_RESULTS.items())[:2])

        assert _rr_then_ko(2).advance(_played(cut, partial), NO_FIELD).side_fills == ()

    def test_rr_then_ko_round_one_never_pairs_two_qualifiers_out_of_one_group(
        self,
    ) -> None:
        # The rematch-free guarantee, end to end through a real cut and advance rather
        # than on the seed map alone.
        planned = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))
        group_of = {
            seed: group_id
            for group_id, seeds in _members_by_group(_grouped(planned)).items()
            for seed in seeds
        }
        cut = _persisted(
            planned,
            group_ids=_config(3).group_ids,
            rr_then_ko=True,
        )
        fixtures = _played(cut, _lower_seed_wins(cut))

        seeded = _apply(fixtures, _rr_then_ko(2).advance(fixtures, NO_FIELD))

        round_one = [
            (f.entry_a_id, f.entry_b_id)
            for f in seeded
            if f.group_id is None and f.round == 1
        ]
        assert round_one
        for entry_a, entry_b in round_one:
            assert entry_a is not None and entry_b is not None
            assert group_of[entry_a.int] != group_of[entry_b.int]

    def test_rr_then_ko_labels_groups_by_the_directors_position_not_sorted_ids(
        self,
    ) -> None:
        # ADR 20260815 decision 7's rider: the qualifier seam labels groups by
        # ``group_position`` — the director's own order, the same one
        # ``DrawConfig.group_ids`` carries and the snake dealt against — never by
        # ``sorted(group_ids)``. Pinned with ids whose OWN sort order is the exact
        # opposite of the director's,
        # so an implementation that fell back to the id could not accidentally agree:
        # the group at position 0 carries the id that sorts LAST.
        group_ids = (_ordered_group_id(2), _ordered_group_id(1))
        config = DrawConfig(group_ids=group_ids)
        # Two groups of two (seeds 1, 4 snake into position 0; 2, 3 into position 1),
        # one qualifier each — the smallest bracket big enough to have a "seed 1" and a
        # "seed 2" to tell apart.
        planned = _rr_then_ko(1).plan_initial(config, _ordered(4))
        cut = _persisted(
            planned,
            group_ids=group_ids,
            rr_then_ko=True,
        )
        fixtures = _played(cut, _lower_seed_wins(cut))

        seeded = _apply(fixtures, _rr_then_ko(1).advance(fixtures, NO_FIELD))

        final = next(f for f in seeded if f.group_id is None)
        # qualifier_seed_assignment(2, 1) is unambiguous here: seed 1 is group-index 0's
        # winner, seed 2 is group-index 1's. Labelled by POSITION, group-index 0 is the
        # position-0 group (seeds 1, 4) — entrant 1 wins it — so entrant 1 must be seed
        # 1 (side a) whatever order the ids happen to sort in. The old ``sorted(group_
        # ids)`` labelling would swap this: the position-1 group's id sorts first, so it
        # would (wrongly) become group-index 0 and hand seed 1 to entrant 2 instead.
        assert (final.entry_a_id, final.entry_b_id) == (_entry_id(1), _entry_id(2))

    def test_rr_then_ko_a_freshly_cut_draw_is_ready_only_in_its_groups(self) -> None:
        # At the cut every group pairing is known and every knockout side is TBD, so the
        # group stage materializes at go-live and the bracket waits.
        cut = self._cut()

        plan = _rr_then_ko(2).advance(cut, NO_FIELD)

        assert plan.side_fills == ()
        assert set(plan.ready_fixture_ids) == {
            f.fixture_id for f in cut if f.group_id is not None
        }

    def test_rr_then_ko_refuses_to_order_a_group_it_cannot_see_the_games_of(
        self,
    ) -> None:
        # THE trap this raise exists for: ``FixtureState.games`` is populated by the ORM
        # projection, but the materialization seam does not pass game counts yet, so
        # every fixture reaching advance() carries ``games=None``. Ordering a group
        # without them would silently fall back to wins alone and choose different
        # qualifiers from the standings on screen — with the whole suite still green,
        # because nothing else reads the field. So it fails loudly instead.
        gameless = [
            dataclasses.replace(f, winner_entry_id=f.entry_a_id)
            if f.group_id is not None
            else f
            for f in self._cut()
        ]

        with pytest.raises(MissingFixtureGames) as excinfo:
            _rr_then_ko(2).advance(gameless, NO_FIELD)

        assert "no game counts" in str(excinfo.value)
        assert "18 decided group fixtures" in str(excinfo.value)
        # Not a DrawError: this is a wiring bug, not something a director can fix by
        # re-cutting, so it must not be dressed up as a 422.
        assert not isinstance(excinfo.value, DrawError)

    def test_rr_then_ko_refuses_a_bracket_that_was_cut_for_a_different_k(self) -> None:
        # The sibling of the gameless refusal above, and the same reasoning: a bracket
        # cut for K=1 advanced at K=2 has qualifiers whose predetermined slot does not
        # exist. Skipping them seats *some* of the qualifiers and leaves the draw
        # quietly wrong — the outcome the event editor's 409 freeze calls unacceptable —
        # the domain says so instead of the freeze being the only thing standing between
        # a director and a half-seated bracket.
        cut = _persisted(
            _rr_then_ko(1).plan_initial(_config(2), _ordered(4)),
            group_ids=_config(2).group_ids,
            rr_then_ko=True,
        )
        fixtures = _played(cut, _lower_seed_wins(cut))

        with pytest.raises(MissingBracketSlot) as excinfo:
            _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert "cut for a different number of qualifiers" in str(excinfo.value)
        # Not a DrawError: a frozen K means nothing a director can type reaches this, so
        # it is a wiring bug and a 500, not a 422 they could act on.
        assert not isinstance(excinfo.value, DrawError)

    def test_rr_then_ko_refuses_fixtures_with_no_stage_resolved(self) -> None:
        # ``MissingBracketSlot`` and ``MissingFixtureGames``'s sibling: a caller that
        # skips the stage plumbing (``_persisted``'s plain, ``rr_then_ko=False``
        # default — shared by every OTHER draw type's tests, and ignorant of stages)
        # hands ``advance()`` fixtures with ``stage`` unresolved (``None``) at all.
        # Silently, that is a fixture matching neither of this composite's two stages:
        # it drops out of both, no qualifier is ever seated, no bracket fixture is ever
        # ready, and nothing raises — a whole-suite-stays-green failure. It fails
        # loudly instead.
        cut = _persisted(_rr_then_ko(2).plan_initial(_config(3), _ordered(12)))

        with pytest.raises(MissingStageAssignment) as excinfo:
            _rr_then_ko(2).advance(cut, NO_FIELD)

        assert "neither of this composite's own stages" in str(excinfo.value)
        # Not a DrawError: nothing a director can type reaches this, so it is a wiring
        # bug and a 500, not a 422 they could act on.
        assert not isinstance(excinfo.value, DrawError)

    def test_rr_then_ko_splits_by_stage_not_by_group_ness(self) -> None:
        # THE discriminating case item 5/ADR 20260815 decision 6 exists for: an
        # UN-GROUPED fixture (``group_id=None``) whose STAGE is nonetheless the GROUP
        # stage — the exact shape a swiss round's fixtures also carry (both are
        # ``group_id IS NULL``), and the reason ``_stage_split`` may not derive its
        # split from ``group_id is None`` (see :class:`FixtureStage`'s docstring).
        # Built entirely from literals, not from a real cut — the disagreement this
        # proves cannot arise from ``cut_draw``'s own write (which always sets
        # ``group_id`` to match the group stage), only from a hostile or buggy caller,
        # which is exactly what this fixture models.
        #
        # Decided (a winner, no games) with nothing else in the input carrying any
        # games, it must still trip the ``MissingFixtureGames`` guard the way a real
        # GROUP fixture would, proving ``_stage_split`` sorted it into the group half by
        # its STAGE. A ``group_id is None``-keyed split would instead sort it into the
        # knockout half — where nothing reads games at all — and this assertion would
        # find no raise.
        ungrouped_but_group_staged = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=9001)),
            group_id=None,
            stage=_RR_THEN_KO_GROUP_STAGE,
            round=1,
            position=1,
            entry_a_id=_entry_id(1),
            entry_b_id=_entry_id(2),
            winner_entry_id=_entry_id(1),
        )

        with pytest.raises(MissingFixtureGames):
            _rr_then_ko(1).advance([ungrouped_but_group_staged], NO_FIELD)

    def test_rr_then_ko_tolerates_one_result_in_flux_among_scored_neighbours(
        self,
    ) -> None:
        # The other side of that raise, and why it is scoped the way it is: a *single*
        # fixture whose match left ``completed`` (a correction under review) keeps its
        # written-back winner while its games go away. That is an ordinary live state —
        # its group is simply not finished — and must not blow up the whole advance.
        fixtures = _played(self._cut(), GROUP_A_RESULTS)
        in_flux = [
            dataclasses.replace(f, games=None)
            if f.games is not None and f.round == 1 and f.position == 1
            else f
            for f in fixtures
        ]

        plan = _rr_then_ko(2).advance(in_flux, NO_FIELD)

        assert plan.side_fills == ()

    def test_rr_then_ko_finishes_a_group_holding_a_voided_pairing(self) -> None:
        # THE claim of the voided-fixture fix: a **voided** pairing can never produce a
        # result, so it is left OUT of "every fixture carries a score" instead of
        # counting as a score that never arrives. Requiring it would hold the group one
        # outcome short forever — never finished, its qualifiers never seated, the
        # knockout never ready, nothing a director could do about it — while the
        # standings, which already exclude voided pairings from a group's
        # ``fixture_count``, called that same group ``complete``.
        #
        # And the order is genuinely the one the REMAINING results produce, not a
        # leftover: played in full, this group finishes 2, 1, 3, 4 and qualifies {2, 1}
        # (``CYCLIC_GROUP_FINISHING_ORDER``). With 1-v-4 voided, 1 drops to a single win
        # and 3 rises past it, so the group finishes 2, 3, 1, 4 and qualifies
        # **{2, 3}**: a different runner-up, which is what makes this evidence
        # about the ordering and not just about the seating.
        cut = _persisted(
            _rr_then_ko(2).plan_initial(_config(1), _ordered(4)),
            group_ids=_config(1).group_ids,
            rr_then_ko=True,
        )
        voided_pair = frozenset({1, 4})
        played = _played(
            cut,
            {
                pair: result
                for pair, result in CYCLIC_GROUP_RESULTS.items()
                if pair != voided_pair
            },
        )
        fixtures = _voided(played, {voided_pair})

        plan = _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert _knockout_sides(_apply(fixtures, plan)) == {
            (1, 1, "a"): 2,
            (1, 1, "b"): 3,
        }

    def test_rr_then_ko_seats_nobody_out_of_a_group_whose_every_pairing_was_voided(
        self,
    ) -> None:
        # The floor under the rule above. Skipping voided fixtures cannot become
        # "finish a group on no results at all": with nothing to rank on, the tiebreak
        # chain falls through to its entry-id fallback and would hand back an order that
        # is arbitrary rather than earned. So the group is not finished, and nobody is
        # seated — the one place this deliberately parts company with the standings,
        # which call such a group ``complete`` and show a table of zeros.
        cut = _persisted(
            _rr_then_ko(2).plan_initial(_config(1), _ordered(4)),
            group_ids=_config(1).group_ids,
            rr_then_ko=True,
        )
        fixtures = _voided(cut, set(CYCLIC_GROUP_RESULTS))

        plan = _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert plan.side_fills == ()

    def test_rr_then_ko_does_not_read_a_voided_pairing_as_a_lost_projection(
        self,
    ) -> None:
        # ``MissingFixtureGames`` fires on "decided, and no games anywhere", and a
        # completed-then-voided fixture reads exactly like that: voiding takes the match
        # out of ``completed`` (so the games go away) without clearing the
        # ``winner_entry_id`` the completion wrote back. Left in the guard's sights, a
        # single voided pairing in a draw nobody else has scored yet would be a 500.
        cut = self._cut()
        fixtures = _voided(cut, {frozenset({1, 6})})

        plan = _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert plan.side_fills == (), "group A has five pairings still to play"

    def test_rr_then_ko_still_refuses_a_lost_projection_beside_a_voided_pairing(
        self,
    ) -> None:
        # The other half: excluding voided fixtures must not blunt the guard. A group
        # played out and then projected WITHOUT its game counts still raises, and the
        # count it reports is the fixtures that should have had games — five of
        # group A's six, because the sixth is voided and genuinely has none.
        played = _played(self._cut(), GROUP_A_RESULTS)
        gameless = [
            dataclasses.replace(f, games=None) if f.group_id is not None else f
            for f in played
        ]
        fixtures = _voided(gameless, {frozenset({1, 6})})

        with pytest.raises(MissingFixtureGames) as excinfo:
            _rr_then_ko(2).advance(fixtures, NO_FIELD)

        assert "5 decided group fixtures" in str(excinfo.value)


class TestSwissCut:
    """The cut pre-writes **every** round: ``R × ⌊n/2⌋`` fixtures, round 1 seeded from
    the draw order and every later round left with both sides TBD (ADR "swiss pre-cuts
    every round and pairs each one on advance")."""

    def test_every_round_is_dealt_into_the_stages_one_group(self) -> None:
        """#1483: every swiss fixture names the one group its stage holds, which is the
        hop that confines the rounds to the reservation the director booked.

        Swiss still ranks one field in one table — the group is a scheduling fact and
        not a format one, and the stage's own ``swiss`` draw type is what every
        labelling surface reads.
        """
        cut = SwissStrategy(rounds=3).plan_initial(_config(1), _ordered(8))

        assert {f.group_id for f in cut} == {_group("A")}
        assert {f.round for f in cut} == {1, 2, 3}, (
            "every round, not only the seeded one"
        )
        assert {f.stage for f in cut} == {_SWISS_STAGE}

    @pytest.mark.parametrize(
        ("entrants", "rounds", "per_round"),
        [
            (8, 3, 4),
            (7, 3, 3),  # odd: one entrant sits out, so ⌊7/2⌋ = 3 pairings a round
            (6, 5, 3),  # R = n − 1, the most rounds this field can carry
            (2, 1, 1),
            (9, 4, 4),
        ],
        ids=["n=8,R=3", "n=7,R=3", "n=6,R=5", "n=2,R=1", "n=9,R=4"],
    )
    def test_every_round_is_cut_with_floor_n_over_two_fixtures(
        self, entrants: int, rounds: int, per_round: int
    ) -> None:
        """The count is the whole claim of the pre-cut: ``R`` rounds exist the moment
        the draw does, each holding ⌊n/2⌋ pairings — the odd entrant's absence, not a
        row with a NULL side, is what an odd field costs."""
        fixtures = SwissStrategy(rounds=rounds).plan_initial(
            DrawConfig(), _ordered(entrants)
        )

        assert len(fixtures) == rounds * per_round
        assert Counter(f.round for f in fixtures) == {
            round_number: per_round for round_number in range(1, rounds + 1)
        }

    def test_round_one_pairs_the_top_half_against_the_bottom_half(self) -> None:
        """Round 1 is seeded from the draw order: with eight entrants seed 1 meets seed
        5, 2 meets 6, and so on — the top seed drawn against the best of the bottom
        half, which is what "seeded from the draw order" buys over pairing 1 with 2."""
        fixtures = SwissStrategy(rounds=3).plan_initial(DrawConfig(), _ordered(8))

        round_one = sorted(
            (f for f in fixtures if f.round == 1), key=lambda f: f.position
        )
        assert [
            (f.position, _seed_of(f.entry_a_id), _seed_of(f.entry_b_id))
            for f in round_one
        ] == [(1, 1, 5), (2, 2, 6), (3, 3, 7), (4, 4, 8)]

    def test_an_odd_field_byes_the_lowest_ranked_entrant_by_absence(self) -> None:
        """Seven entrants: three pairings, and seed 7 has no round-1 fixture at all.

        A bye is the *absence* of a row (ADR-0786), never a row with one side NULL —
        which here would be indistinguishable from a later round waiting to be paired.
        The lowest-ranked entrant takes it, which is the swiss rule (CONTEXT.md, "Bye")
        applied to a first round in which nobody has a score yet."""
        fixtures = SwissStrategy(rounds=3).plan_initial(DrawConfig(), _ordered(7))

        round_one = [f for f in fixtures if f.round == 1]
        assert len(round_one) == 3
        seated = {
            seed
            for f in round_one
            for seed in (_seed_of(f.entry_a_id), _seed_of(f.entry_b_id))
        }
        assert seated == {1, 2, 3, 4, 5, 6}

    def test_every_later_round_is_written_with_both_sides_unknown(self) -> None:
        """Rounds 2..R exist as rows with no players: ``advance()`` fills them once the
        round before is decided, exactly as it fills a single-elim bracket's later
        rounds."""
        fixtures = SwissStrategy(rounds=4).plan_initial(DrawConfig(), _ordered(8))

        later = [f for f in fixtures if f.round > 1]
        assert len(later) == 12
        assert all(f.entry_a_id is None and f.entry_b_id is None for f in later)

    def test_positions_are_contiguous_within_each_round_and_ungrouped(self) -> None:
        """``(round, position)`` is a fixture's identity — the uniqueness constraint is
        ``(event_id, group_id, round, position)`` — so positions run 1..⌊n/2⌋ inside
        each round with no gaps. Every fixture is ungrouped: swiss ranks one field in
        one table, which is why the schedule preview refuses it."""
        fixtures = SwissStrategy(rounds=3).plan_initial(DrawConfig(), _ordered(9))

        by_round: dict[int, list[int]] = {}
        for f in fixtures:
            by_round.setdefault(f.round, []).append(f.position)
        assert by_round == {1: [1, 2, 3, 4], 2: [1, 2, 3, 4], 3: [1, 2, 3, 4]}
        assert all(f.group_id is None for f in fixtures)

    def test_a_draw_ignores_the_events_groups(self) -> None:
        """Swiss is group-less whatever the event's group list says: a director who
        configured groups and then chose swiss gets one un-grouped field, not a draw
        dealt across them."""
        fixtures = SwissStrategy(rounds=2).plan_initial(_config(2), _ordered(6))

        assert all(f.group_id is None for f in fixtures)
        assert len(fixtures) == 6

    def test_more_rounds_than_the_field_can_play_rematch_free_is_refused(self) -> None:
        """``R > n − 1 + n % 2`` is a :class:`DegenerateDraw` at the CUT: five entrants
        can play at most five rounds without a rematch, so a swiss of nine rounds does
        not exist. Refused here rather than at configure time because ``n`` is not known
        when the setting is written — and the message names both numbers, because it is
        director-facing copy the endpoint passes straight through."""
        with pytest.raises(DegenerateDraw) as refusal:
            SwissStrategy(rounds=9).plan_initial(DrawConfig(), _ordered(5))

        message = str(refusal.value)
        assert "9 rounds" in message
        assert "5 rounds" in message
        assert "5 entrants" in message

    def test_the_refusal_inflects_its_nouns_for_the_smallest_field(self) -> None:
        """Two entrants play exactly **one** rematch-free round, so the sentence is the
        one shape where both nouns are singular. Director-facing copy is passed through
        to the director verbatim, and "the 1 rounds" reads as a bug in the product."""
        with pytest.raises(DegenerateDraw) as refusal:
            SwissStrategy(rounds=2).plan_initial(DrawConfig(), _ordered(2))

        assert str(refusal.value) == (
            "2 rounds is more than the 1 round a field of 2 entrants can play without "
            "a rematch — play fewer rounds, or add entrants."
        )

    def test_an_even_field_plays_at_most_n_minus_one_rounds(self) -> None:
        """Everybody plays every round, so an even field's ceiling really is the count
        of distinct opponents: six entrants play five rounds and no more. The boundary
        is inclusive on the legal side, and refusing a sixth round is what stops a
        rematch."""
        fixtures = SwissStrategy(rounds=5).plan_initial(DrawConfig(), _ordered(6))
        assert len(fixtures) == 15  # 5 rounds × ⌊6/2⌋

        with pytest.raises(DegenerateDraw) as refusal:
            SwissStrategy(rounds=6).plan_initial(DrawConfig(), _ordered(6))

        assert str(refusal.value) == (
            "6 rounds is more than the 5 rounds a field of 6 entrants can play without "
            "a rematch — play fewer rounds, or add entrants."
        )

    def test_an_odd_field_plays_a_full_n_rounds(self) -> None:
        """The parity the ``n - 1`` rule got wrong. An odd field byes exactly one
        entrant per round, so over ``n`` rounds everybody plays ``n - 1`` matches and
        sits out once — meeting every opponent, with no rematch. Five entrants play five
        rounds, which a bound of ``n - 1`` refused as illegal (QA found it from the UI),
        and the sixth round is the first that must repeat a pairing."""
        fixtures = SwissStrategy(rounds=5).plan_initial(DrawConfig(), _ordered(5))
        assert len(fixtures) == 10  # 5 rounds × ⌊5/2⌋

        with pytest.raises(DegenerateDraw) as refusal:
            SwissStrategy(rounds=6).plan_initial(DrawConfig(), _ordered(5))

        assert str(refusal.value) == (
            "6 rounds is more than the 5 rounds a field of 5 entrants can play without "
            "a rematch — play fewer rounds, or add entrants."
        )

    def test_a_field_of_one_is_refused(self) -> None:
        """Mirrors single-elim's floor: a swiss of one has nobody to play, and the
        entrant-count refusal has to be said before the round-count one so the message
        names the real problem."""
        with pytest.raises(DegenerateDraw, match="at least 2 entrants"):
            SwissStrategy(rounds=1).plan_initial(DrawConfig(), _ordered(1))

    def test_an_empty_field_is_refused_by_the_same_sentence(self) -> None:
        """Zero entrants take the entrant-count refusal, not the round-count one, and
        the sentence has to be true of them: a field of none has nobody to play just as
        a field of one does, and copy that says "a field of one" describes the wrong
        event to the director who cut an empty one."""
        with pytest.raises(DegenerateDraw) as refusal:
            SwissStrategy(rounds=1).plan_initial(DrawConfig(), _ordered(0))

        assert str(refusal.value) == (
            "A Swiss draw needs at least 2 entrants — a smaller field has nobody to "
            "play."
        )

    def test_a_round_count_below_one_is_a_programmer_error(self) -> None:
        """``R >= 1`` is static — a Pydantic constraint at the request boundary — so a
        strategy constructed below it is a wiring bug, not a director's mistake, and is
        a ``ValueError`` rather than a ``DegenerateDraw``."""
        with pytest.raises(ValueError, match="rounds must be at least 1"):
            SwissStrategy(rounds=0)


#: Round 1 of an 8-entrant cut (1v5, 2v6, 3v7, 4v8), played so that the standings it
#: produces are a **permutation** of the draw order rather than the draw order itself:
#: seed 5 beats 1 and seed 7 beats 3, and the margins separate the two winners left
#: level on wins. A round-2 pairing computed off the seeds instead of the table cannot
#: agree with the expectation below by luck.
_ROUND_ONE_UPSETS: dict[frozenset[int], tuple[int, int, int]] = {
    frozenset({1, 5}): (5, 3, 0),
    frozenset({2, 6}): (2, 3, 1),
    frozenset({3, 7}): (7, 3, 2),
    frozenset({4, 8}): (4, 3, 0),
}


def _seed_pairs(
    fixtures: Sequence[FixtureState], round_number: int
) -> list[tuple[int, int, int]]:
    """``(position, seed a, seed b)`` for one round, in position order."""
    return [
        (f.position, _seed_of(f.entry_a_id), _seed_of(f.entry_b_id))
        for f in sorted(fixtures, key=lambda f: f.position)
        if f.round == round_number
    ]


def _paired_rows(
    fixtures: Sequence[FixtureState], round_number: int
) -> list[tuple[int, int, int]]:
    """:func:`_seed_pairs` for a round some of whose rows can never be paired.

    A field that shrinks after the cut leaves a round with more rows than pairings, and
    ``_seed_pairs`` reads every row (its ``_seed_of`` asserts a seat). This one reports
    the rows that carry a pairing and says nothing about the rest, so a test can assert
    both the pairings and how many rows were left."""
    return [
        (f.position, f.entry_a_id.int, f.entry_b_id.int)
        for f in sorted(fixtures, key=lambda f: f.position)
        if f.round == round_number
        and f.entry_a_id is not None
        and f.entry_b_id is not None
    ]


def _seated(fixtures: Sequence[FixtureState], round_number: int) -> set[int]:
    """The seeds seated in one round — everybody but that round's bye."""
    return {
        entry_id.int
        for f in fixtures
        if f.round == round_number
        for entry_id in (f.entry_a_id, f.entry_b_id)
        if entry_id is not None
    }


#: The five-entrant, four-round chain the bye and forced-rematch tests drive. Round 1 is
#: the cut's own (1v3, 2v4, seed 5 byed); rounds 2 and 3 are whatever ``advance`` pairs,
#: written out here so a change to the pairing rule shows up as a ``_played`` call that
#: matches no fixture rather than as a quietly different tournament.
_FIVE_ENTRANT_RESULTS: list[dict[frozenset[int], tuple[int, int, int]]] = [
    {frozenset({1, 3}): (1, 3, 0), frozenset({2, 4}): (2, 3, 0)},
    {frozenset({1, 2}): (1, 3, 0), frozenset({5, 3}): (5, 3, 0)},
    {frozenset({1, 5}): (1, 3, 0), frozenset({2, 4}): (2, 3, 0)},
]


def _five_entrant_rounds(
    cut: Sequence[FixtureState], rounds: int
) -> list[FixtureState]:
    """A five-entrant swiss driven ``rounds`` rounds forward — every round after the
    first paired by ``advance`` itself, then played out."""
    played = _played(cut, _FIVE_ENTRANT_RESULTS[0])
    for results in _FIVE_ENTRANT_RESULTS[1:rounds]:
        played = _played(
            _apply(played, SwissStrategy(rounds=4).advance(played, _ordered(5))),
            results,
        )
    return played


class TestSwissAdvance:
    """Once every fixture in a round carries a result, ``advance`` pairs the next round
    into the rows the cut already wrote: the field ordered by the standings, walked, and
    each entrant given the nearest one below they have not met (ADR "swiss pre-cuts
    every round and pairs each one on advance")."""

    def _cut(self, *, rounds: int = 3, entrants: int = 8) -> list[FixtureState]:
        return _persisted(
            SwissStrategy(rounds=rounds).plan_initial(DrawConfig(), _ordered(entrants))
        )

    def _advance(
        self, fixtures: Sequence[FixtureState], field: Sequence[OrderedEntrant]
    ) -> AdvancePlan:
        return SwissStrategy(rounds=3).advance(fixtures, field)

    def test_a_freshly_cut_draw_is_ready_in_round_one_only_and_fills_nothing(
        self,
    ) -> None:
        """Nothing is decided, so there is nothing to pair: round 1 was seeded at the
        cut and rounds 2..R wait for it."""
        fixtures = self._cut()

        plan = self._advance(fixtures, _ordered(8))

        assert plan.side_fills == ()
        assert set(plan.ready_fixture_ids) == {
            f.fixture_id for f in fixtures if f.round == 1
        }
        assert not plan.is_empty

    def test_a_materialized_round_one_leaves_an_empty_plan(self) -> None:
        """Round 1 is being *played*, not decided: its fixtures carry matches, so they
        are no longer ready, and round 2 must not be paired off a table that is still
        moving."""
        fixtures = [
            dataclasses.replace(f, match_id=MatchId(uuid.UUID(int=4000 + i)))
            if f.round == 1
            else f
            for i, f in enumerate(self._cut())
        ]

        plan = self._advance(fixtures, _ordered(8))

        assert plan.is_empty

    def test_a_decided_round_one_pairs_round_two_in_standings_order(self) -> None:
        """The claim in one assertion: **who** meets whom, and **where**.

        Round 1 upsets the seeding — 5 beats 1, 7 beats 3 — so the table reads
        4, 5, 2, 7, 3, 6, 1, 8 (seed 4 above seed 5 on the entry-id fallback, the two
        being level on wins, game difference and games won). Pairing that order down the
        list gives 4v5, 2v7, 3v6, 1v8, and a fixture's ``position`` is its **pairing
        rank**, so the pairing holding the top-ranked entrant is position 1.

        Pairing by the draw order instead would give 1v2, 3v4, 5v6, 7v8 — a different
        answer in every position, which is what makes this test discriminating."""
        played = _played(self._cut(), _ROUND_ONE_UPSETS)

        plan = self._advance(played, _ordered(8))

        assert _seed_pairs(_apply(played, plan), 2) == [
            (1, 4, 5),
            (2, 2, 7),
            (3, 3, 6),
            (4, 1, 8),
        ]

    def test_the_walk_takes_the_nearest_opponent_it_has_not_already_met(self) -> None:
        """**The rematch-avoidance test, built so that the naive answer is wrong.**

        Four entrants, three rounds, driven all the way through. Round 1 is 1v3, 2v4;
        the standings stay 1, 2, 3, 4 throughout, so round 2 pairs 1v2 and 3v4 —
        indistinguishable from pairing adjacent entrants. Round 3 is where they part:
        every adjacent pair has now met, so pairing down the standings unchecked would
        emit 1v2 and 3v4 again, both repeats. Skipping to the nearest **unmet** opponent
        gives 1v4 and 2v3 — the only rematch-free round left."""
        round_one = _played(
            self._cut(rounds=3, entrants=4),
            {frozenset({1, 3}): (1, 3, 0), frozenset({2, 4}): (2, 3, 0)},
        )
        round_two = _played(
            _apply(round_one, self._advance(round_one, _ordered(4))),
            {frozenset({1, 2}): (1, 3, 0), frozenset({3, 4}): (3, 3, 0)},
        )

        plan = self._advance(round_two, _ordered(4))

        assert _seed_pairs(round_two, 2) == [(1, 1, 2), (2, 3, 4)]
        assert _seed_pairs(_apply(round_two, plan), 3) == [(1, 1, 4), (2, 2, 3)]

    def test_only_the_next_round_is_paired(self) -> None:
        """Round 3 cannot be paired off round 1's table — it is paired off round 2's,
        which has not been played. So a decided round 1 fills round 2 and nothing
        else."""
        played = _played(self._cut(), _ROUND_ONE_UPSETS)

        applied = _apply(played, self._advance(played, _ordered(8)))

        assert all(
            f.entry_a_id is None and f.entry_b_id is None
            for f in applied
            if f.round == 3
        )

    def test_a_round_with_one_result_outstanding_pairs_nothing(self) -> None:
        """A swiss round pairs off the whole table, so one unreported result blocks the
        next round for the entire field (ADR, "a stalled round stalls the whole
        event"). Three of round 1's four fixtures decided is not a table."""
        partial = dict(_ROUND_ONE_UPSETS)
        del partial[frozenset({4, 8})]
        played = _played(self._cut(), partial)

        plan = self._advance(played, _ordered(8))

        assert plan.side_fills == ()

    def test_a_voided_pairing_does_not_stall_the_round(self) -> None:
        """A voided match will never produce a result, so requiring one would leave the
        event one score short forever, with no move a director could make. The round
        counts as decided without it — the same exception the group-finished test
        makes.

        Seed 4 is ahead of seed 3 in the second pairing because the standings put them
        there: 4 lost to the field's only winner (Buchholz 1) and 3's single fixture was
        voided, so 3 has faced nobody (Buchholz 0). Both are on no wins and a game
        difference the chain never reaches."""
        cut = self._cut(rounds=3, entrants=4)
        played = _played(cut, {frozenset({2, 4}): (2, 3, 0)})
        voided = [
            dataclasses.replace(
                f, match_id=MatchId(uuid.UUID(int=5000)), match_voided=True
            )
            if f.round == 1 and _seed_of(f.entry_a_id) == 1
            else f
            for f in played
        ]

        plan = self._advance(voided, _ordered(4))

        assert _seed_pairs(_apply(voided, plan), 2) == [(1, 2, 1), (2, 4, 3)]

    def test_the_field_is_the_entrants_so_round_ones_bye_is_paired_next(self) -> None:
        """**The field comes from the entrants, never from the seated set.** Seed 5 has
        no round-1 fixture at all — a bye is the absence of a row — so a pairing built
        from the rows would drop them out of the event from here on. They are paired in
        round 2, and the bye passes to the lowest-ranked entrant who has not had one."""
        played = _played(
            self._cut(rounds=4, entrants=5),
            {frozenset({1, 3}): (1, 3, 0), frozenset({2, 4}): (2, 3, 0)},
        )

        applied = _apply(played, SwissStrategy(rounds=4).advance(played, _ordered(5)))

        assert _seed_pairs(applied, 2) == [(1, 1, 2), (2, 5, 3)]
        assert _seated(applied, 2) == {1, 2, 3, 5}

    def test_a_latecomer_seated_nowhere_is_paired_into_the_next_round(self) -> None:
        """A draw cut for eight that a ninth entrant joined holds exactly the rows a
        draw cut for nine holds (``unseated_entrant_allowance``), so the latecomer is an
        entrant with no fixture anywhere. Pairing from the entrants is what gets them a
        match; pairing from the rows would leave them entered and unplayable."""
        played = _played(self._cut(), _ROUND_ONE_UPSETS)

        applied = _apply(played, self._advance(played, _ordered(9)))

        assert 9 in _seated(applied, 2)
        assert len(_seated(applied, 2)) == 8

    def test_the_bye_goes_to_the_lowest_ranked_entrant_who_has_not_had_one(
        self,
    ) -> None:
        """Nobody sits out twice before everybody has sat out once (CONTEXT.md, "Bye").
        Five entrants over three played rounds bye a different entrant each time, and
        the one taking it is always the lowest-ranked entrant still without one.

        This chain pins the *sequence*, not the byeless preference: its bye holders bank
        a win and float up the table, so "lowest-ranked byeless" and "lowest-ranked"
        happen to agree every round and it would pass against an implementation that
        never checked. ``test_the_bye_skips_an_entrant_who_has_had_one_even_when_they
        _rank_last`` is the one that tells them apart."""
        played = _five_entrant_rounds(self._cut(rounds=4, entrants=5), 3)

        byes = [
            {1, 2, 3, 4, 5} - _seated(played, round_number)
            for round_number in (1, 2, 3)
        ]

        assert byes == [{5}, {4}, {3}]

    def test_the_pairing_counts_a_bye_as_a_win_when_it_ranks_the_field(self) -> None:
        """**The two layers rank one table.** A bye is a win worth zero games in the
        standings (ADR "swiss standings add Buchholz"), and the next round is paired by
        walking those standings — so the win has to count *here* too, or the draw would
        pair the field in an order that contradicts the table on screen.

        Seven entrants, three rounds, driven through two rounds of real results. By
        round 3 the two byed entrants are seed 7 (round 1) and seed 5 (round 2), and
        their bye wins move both of them up the table: 7 into the two-win group above
        every one-win player, and 5 above seed 4. Score the byes as nothing and
        the walk sees a different order and emits three different pairings —
        2v4, 7v1, 6v5 — including one the rematch rule then has to work around.

        The one-win group is ordered by **Buchholz**, so it reads 1, 6, 5, 4: seed 1
        played the eventual leader and seed 4 played the winless seed 3, which outweighs
        seed 4's better game difference (+2 against −2). The table is therefore
        2, 7, 1, 6, 5, 4, 3 and the walk pairs 2v7, 1v6, 5v4 with seed 3 byed.
        """
        cut = _persisted(
            SwissStrategy(rounds=3).plan_initial(DrawConfig(), _ordered(7))
        )
        round_one = _played(
            cut,
            {
                frozenset({1, 4}): (1, 3, 2),
                frozenset({2, 5}): (2, 3, 2),
                frozenset({3, 6}): (6, 3, 2),
            },
        )
        round_two = _played(
            _apply(round_one, SwissStrategy(rounds=3).advance(round_one, _ordered(7))),
            {
                frozenset({1, 2}): (2, 3, 0),
                frozenset({6, 7}): (7, 3, 2),
                frozenset({3, 4}): (4, 3, 0),
            },
        )

        plan = SwissStrategy(rounds=3).advance(round_two, _ordered(7))

        assert _seed_pairs(round_two, 2) == [(1, 1, 2), (2, 6, 7), (3, 3, 4)]
        assert _seed_pairs(_apply(round_two, plan), 3) == [
            (1, 2, 7),
            (2, 1, 6),
            (3, 5, 4),
        ]
        assert _seated(_apply(round_two, plan), 3) == {1, 2, 4, 5, 6, 7}, (
            "seed 3 takes round 3's bye, being the lowest-ranked entrant without one"
        )

    def test_the_bye_skips_an_entrant_who_has_had_one_even_when_they_rank_last(
        self,
    ) -> None:
        """**The byeless preference, in the only case that tests it.**

        "The lowest-ranked entrant who has not yet had a bye" and "the lowest-ranked
        entrant" are the same answer in most fields, because a bye banks a win and
        floats its holder *up* the table, leaving somebody byeless at the bottom. A test
        built on such a field passes against an implementation that never looks at who
        has already sat out.

        So this one sinks the bye holder instead. Seed 5 sits out round 1, then loses
        round 2, and comes into round 3 **last**: five entrants, and the table reads
        1, 2, 3, 4, 5 (seed 4 and seed 5 both on one win and a game difference of −3,
        separated by the entry-id fallback).

            round 1   1 beat 3, 2 beat 4          5 byed
            round 2   1 beat 2, 3 beat 5          4 byed
            round 3   the bye is seed 3's — the lowest-ranked of 1, 2 and 3, the
                      entrants who have not had one

        Ignore the preference and the bye goes to seed 5 for the **second** time, while
        three players have never sat out at all. That is what this reds on.
        """
        round_one = _played(
            self._cut(rounds=3, entrants=5),
            {frozenset({1, 3}): (1, 3, 0), frozenset({2, 4}): (2, 3, 0)},
        )
        round_two = _played(
            _apply(round_one, SwissStrategy(rounds=3).advance(round_one, _ordered(5))),
            {frozenset({1, 2}): (1, 3, 0), frozenset({3, 5}): (3, 3, 0)},
        )

        plan = SwissStrategy(rounds=3).advance(round_two, _ordered(5))

        applied = _apply(round_two, plan)
        assert _seed_pairs(applied, 2) == [(1, 1, 2), (2, 5, 3)]
        assert _seated(applied, 3) == {1, 2, 4, 5}, (
            "seed 3 takes round 3's bye. Seed 5 is ranked below them and would take it "
            "again under a rule that only reads the standings — a second bye for the "
            "one entrant who has already had one"
        )
        assert [
            {1, 2, 3, 4, 5} - _seated(applied, round_number)
            for round_number in (1, 2, 3)
        ] == [{5}, {4}, {3}], "three rounds, three different entrants sitting out"

    def test_once_everybody_has_had_a_bye_it_falls_back_to_the_lowest_ranked(
        self,
    ) -> None:
        """The other half of the rule: with the byeless set empty, selection takes the
        lowest-ranked entrant overall rather than refusing or looking forever.

        The state is one **the cut refuses to write** — three entrants cannot be given
        four rounds — so it is built by hand here rather than driven through
        ``plan_initial``. It is not unreachable: the cut compares ``R`` against the
        field it sees, and a field that **shrinks** afterwards (an account merge
        withdraws a guest whose entry seats played fixtures) carries the old ``R`` into
        a smaller field, which is exactly this. A branch that raised or looped would be
        a live event stopped dead.

            round 1   1 beat 2    3 byed
            round 2   1 beat 3    2 byed
            round 3   2 beat 3    1 byed
            round 4   everybody has sat out once, so the bye is seed 3's, last on the
                      table — and the round is paired, as a rematch, because after
                      three rounds these three have met everybody
        """
        played = _played(
            _persisted(
                [
                    PlannedFixture(
                        stage=_SWISS_STAGE,
                        group_id=None,
                        round=1,
                        position=1,
                        entry_a_id=_entry_id(1),
                        entry_b_id=_entry_id(2),
                    ),
                    PlannedFixture(
                        stage=_SWISS_STAGE,
                        group_id=None,
                        round=2,
                        position=1,
                        entry_a_id=_entry_id(1),
                        entry_b_id=_entry_id(3),
                    ),
                    PlannedFixture(
                        stage=_SWISS_STAGE,
                        group_id=None,
                        round=3,
                        position=1,
                        entry_a_id=_entry_id(2),
                        entry_b_id=_entry_id(3),
                    ),
                    PlannedFixture(
                        stage=_SWISS_STAGE, group_id=None, round=4, position=1
                    ),
                ]
            ),
            {
                frozenset({1, 2}): (1, 3, 0),
                frozenset({1, 3}): (1, 3, 0),
                frozenset({2, 3}): (2, 3, 0),
            },
        )

        plan = SwissStrategy(rounds=4).advance(played, _ordered(3))

        assert not plan.is_empty, (
            "a field that has run out of byeless entrants is still paired — the "
            "fallback is a choice, not a refusal"
        )
        assert _seed_pairs(_apply(played, plan), 4) == [(1, 1, 2)]
        assert _seated(_apply(played, plan), 4) == {1, 2}, "seed 3 sits out again"

    def test_a_forced_rematch_is_paired_rather_than_refused(self) -> None:
        """**The last resort, reached by a draw the cut itself writes.** Five entrants,
        three rounds in: by round 3 the standings put seeds 2 and 4 last among those
        still to be paired, and they met in round 1. No rematch-free pairing is left for
        them, and the round is paired anyway — 2v4 again — because refusing would strand
        a live event with a round nobody can play.

        The pairing above it, 1v5, is fresh: the fallback is taken only by the pair that
        has no alternative, not by the whole round."""
        round_two = _five_entrant_rounds(self._cut(rounds=4, entrants=5), 2)

        plan = SwissStrategy(rounds=4).advance(round_two, _ordered(5))

        assert _seed_pairs(_apply(round_two, plan), 3) == [(1, 1, 5), (2, 2, 4)]
        assert (2, 2, 4) in _seed_pairs(round_two, 1)  # the repeat, round 1's own

    def test_a_field_that_shrinks_after_the_cut_keeps_pairing_its_later_rounds(
        self,
    ) -> None:
        """**The deadlock, and the one withdrawal that caused it.**

        Eight entrants are cut for four rounds — four rows a round — and round 1 is
        played by all eight. Seed 8 then leaves, which the ordinary withdrawal endpoint
        cannot do to a live event but the account merge can: it flips a colliding
        guest's entry to ``withdrawn`` rather than deleting it, *because* the row seats
        played fixtures. Seven entrants make three pairings, so round 2 is paired into
        three of its four rows and the fourth stays ``NULL`` for good.

        That fourth row is what has to be understood as **permanently unpairable**
        rather than pending. Read as pending it made round 2 neither wholly unpaired nor
        decided, and the walk answered "no round is pairable" on that call and on every
        call after: rounds 3 and 4 were never paired, the event never read complete, and
        a played draw cannot be un-cut — no move a director could make.

        The pairings are asserted exactly, in both rounds, so this cannot pass by
        pairing *something*. Round 2's table is the seven survivors' (5, 2, 7, 3, 6, 1,
        4), seed 4 takes the bye, and round 3 is paired off round 2's table in turn.

        Seed 4 is last on it, and that is the shrink showing up in the standings rather
        than a quirk: seed 8's departure takes seed 4's only result with it (an outcome
        naming an entry outside the field is left out), so seed 4 has no wins and, on
        the step above game difference, **no opposition at all** — Buchholz 0, below the
        three entrants who lost to somebody who is still here. The one-win group is
        ordered by game difference, the chain's next link, since all three beat a
        winless opponent.
        """
        played = _played(self._cut(rounds=4, entrants=8), _ROUND_ONE_UPSETS)

        round_two = _apply(played, SwissStrategy(rounds=4).advance(played, _ordered(7)))

        assert _paired_rows(round_two, 2) == [(1, 5, 2), (2, 7, 6), (3, 3, 1)]
        assert _seated(round_two, 2) == {1, 2, 3, 5, 6, 7}, "seed 4 sits round 2 out"
        assert len([f for f in round_two if f.round == 2]) == 4, (
            "the cut's fourth row is still there — it is unpairable, not deleted"
        )

        decided = _played(
            round_two,
            {
                frozenset({5, 2}): (5, 3, 0),
                frozenset({7, 6}): (7, 3, 0),
                frozenset({3, 1}): (3, 3, 0),
            },
        )
        round_three = _apply(
            decided, SwissStrategy(rounds=4).advance(decided, _ordered(7))
        )

        assert _paired_rows(round_three, 3) == [(1, 5, 7), (2, 3, 2), (3, 4, 6)], (
            "round 3 is paired off round 2's table — the round that was neither "
            "wholly unpaired nor decided, and stalled the walk forever"
        )
        assert _seated(round_three, 3) == {2, 3, 4, 5, 6, 7}, "seed 1 sits round 3 out"

    def test_a_shrunk_round_is_not_paired_a_second_time(self) -> None:
        """The idempotence the fix must not cost. A round paired down to a shrunk field
        has a ``NULL`` row left in it, and "has a ``NULL`` row" is exactly what the
        pairable check no longer means — so the guard has to be that the round is
        **full**, not that it is untouched. Re-run over the applied state and it plans
        no fill, and the rows it filled keep the entrants they were given."""
        played = _played(self._cut(rounds=4, entrants=8), _ROUND_ONE_UPSETS)
        applied = _apply(played, SwissStrategy(rounds=4).advance(played, _ordered(7)))

        second = SwissStrategy(rounds=4).advance(applied, _ordered(7))

        assert second.side_fills == ()
        assert _paired_rows(applied, 2) == [(1, 5, 2), (2, 7, 6), (3, 3, 1)]

    def test_a_shrunk_field_runs_out_of_byeless_entrants(self) -> None:
        """**The byeless fallback is reachable through the real cut**, and the docstring
        beside it used to argue it was not.

        That argument read the ceiling as ``R ≤ n − 1``, so the byes handed out (one a
        round) could never cover the field. It reasoned about ``n`` at the cut. Six
        entrants are cut for five rounds here — legal — and three of them are left after
        round 1, so rounds 2, 3 and 4 bye one survivor each and round 5 has nobody
        byeless to pick. It hands the bye to the lowest-ranked entrant overall, a second
        one for seed 3, rather than raising or looping in the middle of a live event.

        Every round after the first is paired by ``advance`` itself, which is what makes
        this a statement about a draw the system can actually be in."""
        played = _played(
            self._cut(rounds=5, entrants=6),
            {
                frozenset({1, 4}): (1, 3, 0),
                frozenset({2, 5}): (2, 3, 0),
                frozenset({3, 6}): (3, 3, 0),
                # Every pairing the three survivors can be given, so each round is
                # played out whichever two of them meet.
                frozenset({1, 2}): (1, 3, 0),
                frozenset({1, 3}): (1, 3, 0),
                frozenset({2, 3}): (2, 3, 0),
            },
        )
        for _ in range(4):
            played = _played(
                _apply(played, SwissStrategy(rounds=5).advance(played, _ordered(3))),
                {
                    frozenset({1, 2}): (1, 3, 0),
                    frozenset({1, 3}): (1, 3, 0),
                    frozenset({2, 3}): (2, 3, 0),
                },
            )

        assert [
            {1, 2, 3} - _seated(played, round_number) for round_number in (2, 3, 4, 5)
        ] == [{3}, {2}, {1}, {3}], (
            "three byeless entrants last three rounds; the fourth falls back to the "
            "lowest-ranked, who has already had one"
        )

    def test_re_running_the_advance_pairs_the_round_again_no_differently(self) -> None:
        """**Idempotence, in the two steps the seam takes.** Apply the fills and the
        round is no longer *wholly* unpaired, so it is no longer pairable and a second
        run plans no fill.

        The second plan is not *empty*, and must not be: the round it just paired is
        genuinely ready to become matches, which is what the caller does with it next
        (``materialize_event`` re-derives readiness over the filled state). Materialize
        those rows and the third run is the empty plan the contract asks for."""
        played = _played(self._cut(), _ROUND_ONE_UPSETS)
        applied = _apply(played, self._advance(played, _ordered(8)))

        second = self._advance(applied, _ordered(8))

        assert second.side_fills == ()
        assert set(second.ready_fixture_ids) == {
            f.fixture_id for f in applied if f.round == 2
        }
        materialized = [
            dataclasses.replace(f, match_id=MatchId(uuid.UUID(int=6000 + i)))
            if f.fixture_id in second.ready_fixture_ids
            else f
            for i, f in enumerate(applied)
        ]
        assert self._advance(materialized, _ordered(8)) == AdvancePlan()

    def test_a_corrected_earlier_result_does_not_re_pair_a_paired_round(self) -> None:
        """A round-1 result taken back into correction un-decides round 1 — but round 2
        is already paired and possibly being played, and a fill only ever lands on a
        wholly unpaired round. So the pairings stand, exactly as single-elim never
        un-seats a winner."""
        played = _played(self._cut(), _ROUND_ONE_UPSETS)
        applied = _apply(played, self._advance(played, _ordered(8)))
        in_correction = [
            dataclasses.replace(f, games=None)
            if f.round == 1 and _seed_of(f.entry_a_id) == 1
            else f
            for f in applied
        ]

        plan = self._advance(in_correction, _ordered(8))

        assert plan.side_fills == ()
        assert _seed_pairs(in_correction, 2) == [
            (1, 4, 5),
            (2, 2, 7),
            (3, 3, 6),
            (4, 1, 8),
        ]

    def test_an_empty_draw_advances_to_nothing(self) -> None:
        assert self._advance([], _ordered(8)) == AdvancePlan()


class TestSwissByes:
    """Who has sat out, derived from the rows — because a bye is the *absence* of a
    row (CONTEXT.md, "Bye") and there is nothing else to read it off."""

    def _byes(
        self,
        field: Sequence[int],
        pairings: Sequence[tuple[int, int, int]],
        *,
        undecided: Collection[tuple[int, int, int]] = (),
    ) -> list[int]:
        """The byes of a field whose ``pairings`` are ``(round, seed a, seed b)``. Every
        pairing is decided unless it is named in ``undecided`` — a bye is scored with
        its round, so the flag is what a round being over means here."""
        return [
            entry_id.int
            for entry_id in swiss_byes(
                [_entry_id(seed) for seed in field],
                [
                    SeatedPairing(
                        round=round_number,
                        entry_a_id=_entry_id(a),
                        entry_b_id=_entry_id(b),
                        decided=(round_number, a, b) not in undecided,
                    )
                    for round_number, a, b in pairings
                ],
            )
        ]

    def test_the_entrant_missing_from_a_paired_round_took_its_bye(self) -> None:
        assert self._byes([1, 2, 3], [(1, 1, 2)]) == [3]

    def test_an_even_field_byes_nobody(self) -> None:
        assert self._byes([1, 2, 3, 4], [(1, 1, 2), (1, 3, 4)]) == []

    def test_each_paired_round_yields_its_own_bye(self) -> None:
        """One id per bye taken, so the multiset carries how many each entrant has —
        which is what the selection rule ("who has not had one") reads."""
        assert self._byes([1, 2, 3], [(1, 1, 2), (2, 1, 3)]) == [3, 2]

    def test_the_same_entrant_byed_twice_appears_twice(self) -> None:
        assert self._byes([1, 2, 3], [(1, 1, 2), (2, 2, 1)]) == [3, 3]

    def test_a_round_nobody_is_paired_into_yields_no_byes(self) -> None:
        """**The one that stops a freshly cut draw handing everybody a bye.** Rounds 2
        and 3 of a swiss draw exist as rows with both sides unknown from the moment it
        is cut, so they contribute no pairings — and a round with no pairing is a round
        waiting to be paired, not a round the whole field sat out."""
        assert self._byes([1, 2, 3], [(1, 1, 2)]) == [3]

    def test_a_round_still_being_played_scores_no_bye_yet(self) -> None:
        """**A bye is scored with its round.** Round 2 is paired but one of its matches
        is still on, so nobody has a result for that round — and the entrant sitting it
        out does not get one either. Credit it early and a freshly cut seven-player draw
        would show its byed entrant top of the table before a ball was hit."""
        pairings = [(1, 1, 2), (1, 3, 4), (2, 1, 3), (2, 2, 4)]

        assert self._byes([1, 2, 3, 4, 5], pairings, undecided=[(2, 2, 4)]) == [5]

    def test_a_round_of_one_undecided_match_scores_no_bye_at_all(self) -> None:
        """The same rule at the start of an event: round 1 is paired at the cut, so its
        pairings exist from day one, and none of them has been played."""
        assert self._byes([1, 2, 3], [(1, 1, 2)], undecided=[(1, 1, 2)]) == []

    def test_an_entrant_seated_nowhere_is_byed_in_every_paired_round(self) -> None:
        """The latecomer: a draw cut for four that a fifth player joined seats them in
        no round at all. They are in the field, so they collect a bye for every round
        that has been paired — which is what stops the selection rule handing them yet
        another one."""
        pairings = [(1, 1, 2), (1, 3, 4), (2, 1, 3), (2, 2, 4)]

        assert self._byes([1, 2, 3, 4, 5], pairings) == [5, 5]


class TestSwissPairings:
    """The pairing rule on its own: an order in, pairs out. Pure, so the branch that
    matters most — the forced rematch — is pinned directly rather than through a
    tournament contrived to reach it."""

    def _pairs(
        self, order: Sequence[int], met: Collection[frozenset[int]] = ()
    ) -> list[tuple[int, int]]:
        pairings = swiss_pairings(
            [_entry_id(seed) for seed in order],
            {frozenset(_entry_id(seed) for seed in pair) for pair in met},
        )
        return [(a.int, b.int) for a, b in pairings]

    def test_a_field_that_has_met_nobody_pairs_straight_down_the_order(self) -> None:
        assert self._pairs([4, 1, 3, 2]) == [(4, 1), (3, 2)]

    def test_an_entrant_already_met_is_skipped_for_the_next_one_down(self) -> None:
        """The whole rule in one line: 1 has met 2, so 1 takes 3 — and 2, still
        unpaired, takes the nearest entrant left."""
        assert self._pairs([1, 2, 3, 4], {frozenset({1, 2})}) == [(1, 3), (2, 4)]

    def test_a_rematch_is_the_last_resort_rather_than_a_refusal(self) -> None:
        """**Never a refusal.** With 1 having met everybody below them, no rematch-free
        pairing for 1 exists — and the walk pairs them anyway, with the nearest, rather
        than returning a short list that would leave a live event with fixtures nobody
        can play. The repeat is 1v2, and 3v4 is untouched by it."""
        met = {frozenset({1, 2}), frozenset({1, 3}), frozenset({1, 4})}

        assert self._pairs([1, 2, 3, 4], met) == [(1, 2), (3, 4)]

    def test_a_field_in_which_everyone_has_met_everyone_still_pairs(self) -> None:
        """The extreme of the same rule — every pair is a repeat, so every pairing is a
        rematch, and the round still happens."""
        met = {frozenset(pair) for pair in combinations([1, 2, 3, 4], 2)}

        assert self._pairs([1, 2, 3, 4], met) == [(1, 2), (3, 4)]

    def test_an_odd_order_leaves_its_last_entrant_unpaired(self) -> None:
        """Total, not raising: the caller takes the bye out before calling, and a
        miscount that got past it costs a fixture rather than a 500 mid-event."""
        assert self._pairs([1, 2, 3]) == [(1, 2)]

    def test_an_empty_order_pairs_nothing(self) -> None:
        assert self._pairs([]) == []
