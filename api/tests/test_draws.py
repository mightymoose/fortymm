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
    FixtureState,
    MatchId,
    MissingBracketSlot,
    MissingFixtureGames,
    OrderedEntrant,
    PlannedFixture,
    PoolId,
    QualifierSeat,
    RoundRobinStrategy,
    RrThenKoStrategy,
    Side,
    SideFill,
    SingleElimStrategy,
    SwissStrategy,
    order_entrants,
    qualifier_seed_assignment,
    reads_fixture_games,
    ready_fixtures,
    strategy_for,
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
        DrawType.rr_then_ko: {"qualifiers_per_pool": 2},
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


def _seed_of(entry_id: EntryId | None) -> int:
    """Invert :func:`_ordered` — the seed number behind an entry id."""
    assert entry_id is not None
    return entry_id.int


#: The base a test pool id is minted from. A pool id is a ``uuid`` (ADR 20260801) — the
#: ``tournament_event_pools`` primary key the server mints — so the ``"A"``/``"B"`` the
#: snake matrix below is written in are **labels**, not ids, and :func:`_pool` is the
#: one place they become the ids the domain actually carries. Derived from the letter
#: rather than random so the same matrix entry names the same pool on every run and a
#: failure is readable.
_POOL_ID_BASE = 0xB00_10000


def _pool(letter: str) -> PoolId:
    """The pool id the matrix's ``letter`` stands for."""
    return PoolId(uuid.UUID(int=_POOL_ID_BASE + (ord(letter) - ord("A"))))


def _pool_ids(count: int) -> tuple[PoolId, ...]:
    """The first ``count`` pools' ids, in the event's own pool order."""
    return tuple(_pool(chr(ord("A") + i)) for i in range(count))


def _ordered_pool_id(rank: int) -> PoolId:
    """A pool id whose place in the ids' OWN sort order is ``rank`` (1 sorts first).

    The sort tie-break in ``ready_fixtures`` compares ids, and a random uuid's order is
    not something a test can state — so the handful of tests that are about that
    tie-break mint ids whose order is known, and say so."""
    return PoolId(uuid.UUID(int=_POOL_ID_BASE + 0x1000 + rank))


def _config(pool_count: int) -> DrawConfig:
    return DrawConfig(pool_ids=_pool_ids(pool_count))


def _members_by_pool(fixtures: list[PlannedFixture]) -> dict[PoolId | None, set[int]]:
    """Pool membership is *derived from the fixtures* — there is no assignment table
    (ADR-0786), so this is how the rest of the system will read it too."""
    members: dict[PoolId | None, set[int]] = {}
    for f in fixtures:
        members.setdefault(f.pool_id, set()).update(
            {_seed_of(f.entry_a_id), _seed_of(f.entry_b_id)}
        )
    return members


def _pairs_by_pool(
    fixtures: list[PlannedFixture],
) -> dict[PoolId | None, list[tuple[int, int]]]:
    """Every fixture as a seed pair, normalized so (1,2) and (2,1) are the same pair."""
    pairs: dict[PoolId | None, list[tuple[int, int]]] = {}
    for f in fixtures:
        a, b = _seed_of(f.entry_a_id), _seed_of(f.entry_b_id)
        pairs.setdefault(f.pool_id, []).append((min(a, b), max(a, b)))
    return pairs


# The matrix the draw must hold for: (entrants, pools) → the exact snake membership,
# spelled out by hand rather than recomputed, so a broken snake cannot agree with a
# broken expectation. Pool A takes 1, 2P, 2P+1, …; pool B takes 2, 2P−1, …
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
        strategy = strategy_for(RrThenKoDrawSettingsWrite(qualifiers_per_pool=3))

        assert strategy == RrThenKoStrategy(qualifiers_per_pool=3)

    def test_an_rr_then_ko_arm_cannot_be_built_without_a_qualifier_count(self) -> None:
        """The old "``strategy_for`` refuses ``qualifiers_per_pool=None``" test, moved
        one layer out and made stronger.

        ``strategy_for`` now takes the **arm**, so a configuration with no count is not
        a value it can be handed at all: the count is a required field, and the refusal
        happens where the arm would be built (ADR "a draw type's settings are one NOT
        NULL JSON object"). A K nobody chose is unrepresentable rather than caught."""
        with pytest.raises(ValidationError, match="qualifiers_per_pool"):
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

    @pytest.mark.parametrize("field_size", [6, 7])
    def test_the_bye_allowance_names_every_draw_type_and_only_swiss_byes_absently(
        self, field_size: int
    ) -> None:
        """``unseated_entrant_allowance`` is what lets a draw's currency tell a **byed**
        entrant from one who entered after the cut.

        A whole-enum equality at both parities, so a new ``DrawType`` reds here as well
        as failing to type-check in the catch-all-free ``match``. The three zeros are
        not "these formats have no byes" — an odd round-robin pool byes somebody every
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

            assert strategy.advance(with_games) == strategy.advance(without_games)

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
        assert [field.name for field in dataclasses.fields(DrawConfig)] == ["pool_ids"]


class TestRoundRobinCut:
    @pytest.mark.parametrize(
        ("entrants", "pools", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_entrants_are_snaked_across_the_pools(
        self, entrants: int, pools: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        members = _members_by_pool(fixtures)
        # Keyed back onto the matrix's letters: the pool ids are uuids
        # (ADR 20260801), and ``_pool`` is the one place a letter becomes one.
        assert {
            letter: sorted(members[_pool(letter)]) for letter in expected
        } == expected
        assert set(members) == {_pool(letter) for letter in expected}

    @pytest.mark.parametrize(
        ("entrants", "pools", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_pool_sizes_differ_by_at_most_one_and_cover_every_entrant(
        self, entrants: int, pools: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        sizes = [len(m) for m in _members_by_pool(fixtures).values()]
        assert len(sizes) == pools
        assert max(sizes) - min(sizes) <= 1
        assert sum(sizes) == entrants

    @pytest.mark.parametrize(
        ("entrants", "pools", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_every_within_pool_pair_meets_exactly_once_and_no_cross_pool_pair_exists(
        self, entrants: int, pools: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        pairs_by_pool = _pairs_by_pool(fixtures)
        assert set(pairs_by_pool) == {_pool(p) for p in expected}

        for pool_id, seeds in expected.items():
            pairs = pairs_by_pool[_pool(pool_id)]
            n = len(seeds)
            # All-play-all: exactly n(n-1)/2 fixtures...
            assert len(pairs) == n * (n - 1) // 2
            # ...no pair twice...
            assert max(Counter(pairs).values()) == 1
            # ...and precisely the pairs of THIS pool's members — which is also what
            # rules out any cross-pool pairing, since no other seed appears at all.
            assert set(pairs) == {
                (min(a, b), max(a, b)) for a, b in combinations(sorted(seeds), 2)
            }

    @pytest.mark.parametrize(
        ("entrants", "pools", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_nobody_plays_twice_in_the_same_round_of_their_pool(
        self, entrants: int, pools: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        per_round: dict[tuple[PoolId | None, int], list[int]] = {}
        for f in fixtures:
            per_round.setdefault((f.pool_id, f.round), []).extend(
                [_seed_of(f.entry_a_id), _seed_of(f.entry_b_id)]
            )

        for (pool_id, round_number), seeds in per_round.items():
            assert len(seeds) == len(set(seeds)), (
                f"pool {pool_id} round {round_number} plays someone twice: {seeds}"
            )

    @pytest.mark.parametrize(
        ("entrants", "pools", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_rounds_and_positions_are_one_based_and_contiguous(
        self, entrants: int, pools: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        for pool_id, seeds in expected.items():
            pool_fixtures = [f for f in fixtures if f.pool_id == _pool(pool_id)]
            n = len(seeds)
            # An even pool plays n-1 rounds; an odd one needs n (each entrant sits out
            # exactly once), which is the whole reason a bye exists.
            expected_rounds = n - 1 if n % 2 == 0 else n
            rounds = sorted({f.round for f in pool_fixtures})
            assert rounds == list(range(1, expected_rounds + 1))

            for round_number in rounds:
                positions = sorted(
                    f.position for f in pool_fixtures if f.round == round_number
                )
                # 1-based and gapless *within the round* — a dropped bye must not leave
                # a hole in the numbering.
                assert positions == list(range(1, len(positions) + 1))

    @pytest.mark.parametrize(
        ("entrants", "pools", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_a_bye_is_the_absence_of_a_fixture_never_a_null_side(
        self, entrants: int, pools: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        # NULL means "TBD" and nothing else; a round-robin fixture is never TBD.
        assert all(
            f.entry_a_id is not None and f.entry_b_id is not None for f in fixtures
        )

        for pool_id, seeds in expected.items():
            n = len(seeds)
            if n % 2 == 0:
                continue
            # An odd pool sits one entrant out per round: (n-1)/2 fixtures, not n/2
            # rounded up, and certainly not a phantom row.
            per_round = Counter(
                f.round for f in fixtures if f.pool_id == _pool(pool_id)
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

    def test_the_smallest_legal_pool_is_two_entrants_playing_once(self) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(1), _ordered(2))

        assert fixtures == [
            PlannedFixture(
                pool_id=_pool("A"),
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
        ("entrants", "pools", "message"),
        [
            pytest.param(
                1,
                1,
                "1 entrant across 1 pool would leave a pool with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="a-lone-entrant-has-nobody-to-play",
            ),
            pytest.param(
                0,
                1,
                "0 entrants across 1 pool would leave a pool with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="a-ghost-pool",
            ),
            pytest.param(
                3,
                2,
                "3 entrants across 2 pools would leave a pool with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="the-snake-would-leave-pool-B-with-one",
            ),
            pytest.param(
                5,
                3,
                "5 entrants across 3 pools would leave a pool with fewer than 2 "
                "entrants, who would have nobody to play.",
                id="...and-pool-C-with-one",
            ),
        ],
    )
    def test_a_pool_of_fewer_than_two_is_refused(
        self, entrants: int, pools: int, message: str
    ) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        assert isinstance(excinfo.value, DrawError)
        # Both numbers, because either one of them is a thing the director can move:
        # cut fewer pools, or go and find another player.
        assert str(excinfo.value) == message

    def test_the_refusal_inflects_its_count_nouns(self) -> None:
        # Singular counts get singular nouns — never "1 entrants" and never the lazy
        # "pool(s)" — so a one-entrant, one-pool refusal reads like a sentence.
        with pytest.raises(DegenerateDraw) as singular:
            RoundRobinStrategy().plan_initial(_config(1), _ordered(1))
        singular_message = str(singular.value)
        assert "1 entrant across 1 pool" in singular_message
        assert "1 entrants" not in singular_message
        assert "pool(s)" not in singular_message

        # Plural counts stay plural.
        with pytest.raises(DegenerateDraw) as plural:
            RoundRobinStrategy().plan_initial(_config(2), _ordered(3))
        assert "3 entrants across 2 pools" in str(plural.value)

    def test_a_draw_with_no_pools_is_refused(self) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            RoundRobinStrategy().plan_initial(DrawConfig(pool_ids=()), _ordered(4))

        # A different degeneracy and a different sentence: no arrangement of the field
        # fixes this one, so it names the pools rather than the entrants.
        assert str(excinfo.value) == "A round-robin draw needs at least one pool."

    def test_pools_are_named_by_the_events_own_pool_ids(self) -> None:
        # A pool id is the event's own pool row's uuid, not an index we mint.
        morning, evening = PoolId(uuid.uuid4()), PoolId(uuid.uuid4())
        config = DrawConfig(pool_ids=(morning, evening))

        fixtures = RoundRobinStrategy().plan_initial(config, _ordered(6))

        assert {f.pool_id for f in fixtures} == {
            morning,
            evening,
        }


def _persisted(
    planned: list[PlannedFixture], *, materialized: bool = False
) -> list[FixtureState]:
    """The planned fixtures as they'd read back after ``plan_initial`` was persisted."""
    return [
        FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=1000 + i)),
            pool_id=f.pool_id,
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

        plan = RoundRobinStrategy().advance(fixtures)

        assert plan.side_fills == ()
        assert set(plan.ready_fixture_ids) == {f.fixture_id for f in fixtures}
        assert not plan.is_empty

    def test_ready_ids_are_ordered_by_pool_round_position(self) -> None:
        fixtures = _persisted(
            RoundRobinStrategy().plan_initial(_config(2), _ordered(6))
        )
        by_id = {f.fixture_id: f for f in fixtures}

        # Feed them in deliberately scrambled — the plan must not inherit input order.
        plan = RoundRobinStrategy().advance(list(reversed(fixtures)))

        keys = [
            (by_id[fid].pool_id or "", by_id[fid].round, by_id[fid].position)
            for fid in plan.ready_fixture_ids
        ]
        assert keys == sorted(keys)

    def test_advancing_an_already_materialized_draw_is_a_no_op(self) -> None:
        # THE idempotence claim: apply the plan (matches now exist), re-run advance, and
        # it proposes nothing. That is what lets advance() run after every result.
        planned = RoundRobinStrategy().plan_initial(_config(2), _ordered(6))

        plan = RoundRobinStrategy().advance(_persisted(planned, materialized=True))

        assert plan == AdvancePlan()
        assert plan.is_empty

    def test_advance_is_a_pure_function_of_the_state(self) -> None:
        fixtures = _persisted(
            RoundRobinStrategy().plan_initial(_config(1), _ordered(5))
        )
        strategy = RoundRobinStrategy()

        assert strategy.advance(fixtures) == strategy.advance(fixtures)

    def test_a_decided_fixture_is_not_ready_again(self) -> None:
        # match_id is ON DELETE SET NULL, so a decided fixture can lose its match link.
        # It must not rise from the dead and be played a second time.
        decided = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=1)),
            pool_id=_pool("A"),
            round=1,
            position=1,
            entry_a_id=_entry_id(1),
            entry_b_id=_entry_id(2),
            winner_entry_id=_entry_id(1),
            match_id=None,
        )

        assert RoundRobinStrategy().advance([decided]).is_empty

    def test_a_fixture_with_an_unknown_side_is_never_ready(self) -> None:
        pending = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=1)),
            pool_id=None,
            round=2,
            position=1,
            entry_a_id=_entry_id(1),
            entry_b_id=None,  # TBD
        )

        assert pending.is_pending
        assert RoundRobinStrategy().advance([pending]).is_empty

    def test_an_empty_draw_advances_to_an_empty_plan(self) -> None:
        assert RoundRobinStrategy().advance([]) == AdvancePlan()


class TestReadyFixtures:
    """``ready_fixtures`` is shared by every strategy — "ready" is a property of the
    fixture, not of the draw type — so it is tested as the total function it is, against
    inputs no single strategy produces on its own."""

    def _state(
        self,
        n: int,
        *,
        pool_id: PoolId | None,
        round: int,
        position: int,
        pool_position: int | None = None,
    ) -> FixtureState:
        return FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=n)),
            pool_id=pool_id,
            round=round,
            position=position,
            pool_position=pool_position,
            entry_a_id=_entry_id(1),
            entry_b_id=_entry_id(2),
        )

    def test_the_plan_runs_the_pools_in_the_events_order_not_the_ids(self) -> None:
        """Ten pools, and the plan runs 1..10 — not the ids' 1, 10, 2, 3…

        Pool ids are client-minted strings (``p-1-…``, ``p-2-…``, ``p-10-…``) and
        lexicographically ``p-10-`` falls between ``p-1-`` and ``p-2-``, so the id sort
        this used to do materialized a ten-pool event's matches with pool 10's wedged
        between pool 1's and pool 2's. The order the plan runs in is the director's
        (``pool_position``, ADR 20260801) — the same order the read path renders and the
        same one the snake dealt against.

        The ids are handed in *deliberately mismatched* to the positions: the pool at
        position 0 carries the id that sorts LAST and the pool at position 9 the id that
        sorts first. So the two rules do not merely differ, they are opposites — an
        implementation that fell back to the id could not accidentally agree with this
        assertion on any prefix of it. (Under the old client-minted ids this was spelled
        ``p-10-…``/``p-1-…``; a pool id is a uuid now, so the mismatch is constructed
        from ids whose numeric order is known.)
        """
        pools = [(_ordered_pool_id(10 - index), index) for index in range(10)]
        states = [
            self._state(
                index + 1,
                pool_id=pool_id,
                round=1,
                position=1,
                pool_position=position,
            )
            for index, (pool_id, position) in enumerate(pools)
        ]

        ready = ready_fixtures(list(reversed(states)))

        assert ready == tuple(state.fixture_id for state in states)

    def test_a_pool_of_unknown_position_sorts_behind_the_placed_ones_by_id(
        self,
    ) -> None:
        """A fixture whose pool order was not resolved — a caller that passed no pool
        positions, or a pool stored before ``position`` existed — still has a *defined*
        place: after every pool that has a position, ordered among its own kind by id.

        That is the pre-position order preserved exactly where the position cannot
        speak, rather than an unresolved fixture jumping the queue. It matters because
        ``0`` is a real position (the *first* pool), so "unknown" must not collapse
        onto it: the
        placed pool below sits at 0, holds the id that sorts *last*, and still comes
        first.

        The un-pooled fixture is here to pin the other end. Its position is ``None``
        too — it is in no pool, so there is nothing to place — which is exactly why
        "pooled?" has to stay the *outermost* question: decided on position alone the
        KO fixture would tie with the unplaced pools and win the id tie-break outright
        (no id sorts before ``""``), landing in front of the pools that feed it.
        """
        placed = self._state(
            1, pool_id=_ordered_pool_id(9), round=1, position=1, pool_position=0
        )
        unplaced_b = self._state(2, pool_id=_ordered_pool_id(2), round=1, position=1)
        unplaced_a = self._state(3, pool_id=_ordered_pool_id(1), round=1, position=1)
        ko = self._state(4, pool_id=None, round=1, position=1)

        ready = ready_fixtures([ko, unplaced_b, unplaced_a, placed])

        assert ready == (
            placed.fixture_id,
            unplaced_a.fixture_id,
            unplaced_b.fixture_id,
            ko.fixture_id,
        )

    def test_pooled_fixtures_are_ready_before_un_pooled_ones(self) -> None:
        # The mixed set is the one a pooled-then-knockout draw will hand this: the pool
        # fixtures carry a pool ref, the KO fixtures behind them carry NULL. A ``None``
        # does not compare against a ``str``, so the sort key has to *decide* where the
        # un-pooled sit rather than fall over — and where they sit has to be a fact, not
        # whatever order the rows came back in.
        ko = self._state(1, pool_id=None, round=1, position=1)
        b1 = self._state(2, pool_id=_pool("B"), round=1, position=1)
        a2 = self._state(3, pool_id=_pool("A"), round=1, position=2)
        a1 = self._state(4, pool_id=_pool("A"), round=1, position=1)
        a_round2 = self._state(5, pool_id=_pool("A"), round=2, position=1)

        # Fed in scrambled — and it is the *stated* order that is asserted, not merely
        # that the output is self-consistently sorted (which a reversed rule would also
        # be).
        ready = ready_fixtures([ko, a_round2, b1, a2, a1])

        assert ready == (
            a1.fixture_id,
            a2.fixture_id,
            a_round2.fixture_id,
            b1.fixture_id,
            ko.fixture_id,  # the un-pooled sort last, behind every pool
        )

    def test_readiness_ignores_the_draw_type_that_planned_the_fixture(self) -> None:
        # Same three states, asked of the shared helper and of the strategy: a fixture
        # that is ready is ready, and a strategy cannot make it less so.
        ready = self._state(1, pool_id=_pool("A"), round=1, position=1)
        materialized = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=2)),
            pool_id=_pool("A"),
            round=1,
            position=2,
            entry_a_id=_entry_id(3),
            entry_b_id=_entry_id(4),
            match_id=MatchId(uuid.UUID(int=99)),
        )
        pending = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=3)),
            pool_id=None,
            round=2,
            position=1,
            entry_a_id=_entry_id(1),
            entry_b_id=None,
        )
        fixtures = [ready, materialized, pending]

        assert ready_fixtures(fixtures) == (ready.fixture_id,)
        assert RoundRobinStrategy().advance(fixtures) == AdvancePlan(
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
        # Un-pooled: single-elim ignores ``pool_ids`` and every fixture carries a
        # ``None`` pool ref.
        fixtures = SingleElimStrategy().plan_initial(DrawConfig(), _ordered(k))

        assert all(f.pool_id is None for f in fixtures)
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
            self._decide(fixtures, round=1, position=1, winner=winner)
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
            self._decide(fixtures, round=1, position=2, winner=winner)
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

        assert SingleElimStrategy().advance(applied).side_fills == ()

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

        assert SingleElimStrategy().advance(state).side_fills == ()

    def test_a_freshly_cut_bracket_is_ready_exactly_where_both_sides_are_known(
        self,
    ) -> None:
        # At the cut nothing is decided, so nothing is seated; readiness is exactly the
        # fixtures whose sides are already known — the round-1 match and the both-byes
        # semifinal — never the half-filled or wholly-TBD ones.
        fixtures = self._persisted_bracket(5)
        by_rp = {(f.round, f.position): f for f in fixtures}

        plan = SingleElimStrategy().advance(fixtures)

        assert plan.side_fills == ()
        ready = set(plan.ready_fixture_ids)
        assert by_rp[(1, 2)].fixture_id in ready  # the seed 4 v 5 match
        assert by_rp[(2, 2)].fixture_id in ready  # both-byes semifinal, fully known
        assert by_rp[(2, 1)].fixture_id not in ready  # one side still TBD
        assert by_rp[(3, 1)].fixture_id not in ready  # final, both sides TBD


#: The legal configuration space the ADR defines: ``K ≥ 1`` (Pydantic, at the request
#: boundary) and ``P × K ≥ 2`` (at the cut). Swept whole rather than sampled — the
#: guarantee is universal, so a handful of hand-picked cases would not be evidence for
#: it. ``P`` runs past any club-night pool count and ``K`` past any plausible cut.
LEGAL_QUALIFIER_CONFIGURATIONS = [
    (pool_count, per_pool)
    for pool_count in range(1, 9)
    for per_pool in range(1, 5)
    if pool_count * per_pool >= 2
]


def _pool_letter(pool_index: int) -> str:
    """``0 → 'A'`` — the same labelling :func:`_pool_ids` gives the pools themselves."""
    return chr(ord("A") + pool_index)


def _seat_label(seat: QualifierSeat) -> str:
    """``A1`` — pool A's winner; ``C2`` — pool C's runner-up."""
    return f"{_pool_letter(seat.pool_index)}{seat.place}"


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
    """Seeding pool qualifiers into the knockout bracket (ADR "rr-then-ko cuts both
    stages upfront and seeds qualifiers rematch-free").

    The claim these defend is absolute, not statistical: across the *whole* legal
    configuration space, no round-one knockout fixture holds two qualifiers out of the
    same pool — and the one-pool case is exempt on purpose, which is asserted as its own
    positive property rather than skipped.
    """

    def test_no_round_one_pairing_holds_two_qualifiers_from_the_same_pool(
        self,
    ) -> None:
        offenders = [
            f"P={pool_count} K={per_pool}: seeds {left} v {right} are both out of "
            f"pool {_pool_letter(assignment[left].pool_index)} "
            f"({_seat_label(assignment[left])} vs {_seat_label(assignment[right])})"
            for pool_count, per_pool in LEGAL_QUALIFIER_CONFIGURATIONS
            # One pool is a waiver, asserted positively in its own test below.
            if pool_count >= 2
            for assignment in [qualifier_seed_assignment(pool_count, per_pool)]
            for left, right in _round_one_seed_pairs(pool_count * per_pool)
            if assignment[left].pool_index == assignment[right].pool_index
        ]

        assert offenders == []

    def test_one_pool_seeds_qualifiers_by_place_and_is_all_rematches_by_design(
        self,
    ) -> None:
        # The waiver, stated as a property rather than an exclusion: with a single pool
        # every knockout match *is* a rematch, because every qualifier came out of the
        # same pool. That is "league, then a playoff" working, not the guarantee
        # failing — so assert it holds rather than skipping the case.
        for per_pool in (2, 3, 4):
            assignment = qualifier_seed_assignment(1, per_pool)

            assert assignment == {
                seed: QualifierSeat(pool_index=0, place=seed)
                for seed in range(1, per_pool + 1)
            }
            pairs = _round_one_seed_pairs(per_pool)
            assert pairs, f"K={per_pool} should have a round-1 match to be a rematch"
            assert all(
                assignment[left].pool_index == assignment[right].pool_index
                for left, right in pairs
            )

    def test_seeds_are_place_major_and_each_qualifier_is_seeded_exactly_once(
        self,
    ) -> None:
        # The shape the guarantee is built on: place block k owns seeds kP+1..kP+P, and
        # holds every pool exactly once — which is what makes an intra-block round-one
        # pair safe for free, and what leaves the pool order free to be chosen.
        for pool_count, per_pool in LEGAL_QUALIFIER_CONFIGURATIONS:
            assignment = qualifier_seed_assignment(pool_count, per_pool)
            qualifier_count = pool_count * per_pool

            assert sorted(assignment) == list(range(1, qualifier_count + 1))
            assert len(set(assignment.values())) == qualifier_count
            for block in range(per_pool):
                seeds = range(block * pool_count + 1, (block + 1) * pool_count + 1)
                assert {assignment[seed].place for seed in seeds} == {block + 1}
                assert {assignment[seed].pool_index for seed in seeds} == set(
                    range(pool_count)
                )

    def test_the_same_qualifier_configuration_always_gets_the_same_seeds(self) -> None:
        # A re-cut must reproduce the bracket, exactly as `order_entrants` promises for
        # the draw order — the augmenting search walks pools in ascending index order
        # precisely so its answer is a function of the inputs and not of iteration luck.
        # Collected rather than asserted in the loop so a red names *which* (P, K)
        # wobbled, and how, instead of dying on the first one.
        offenders = [
            f"P={pool_count} K={per_pool}: "
            f"{ {seed: _seat_label(s) for seed, s in first.items()} } "
            f"then { {seed: _seat_label(s) for seed, s in second.items()} }"
            for pool_count, per_pool in LEGAL_QUALIFIER_CONFIGURATIONS
            for first in [qualifier_seed_assignment(pool_count, per_pool)]
            for second in [qualifier_seed_assignment(pool_count, per_pool)]
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
# The cut matrix, spelled out by hand rather than recomputed: (pools, entrants,
# qualifiers per pool) → the qualifier count, the derived bracket size, the round-1
# positions that exist (the byed ones are *absent*), and the per-round knockout fixture
# counts. Bracket size is the smallest power of two ≥ P × K and is never configured.
RR_THEN_KO_MATRIX: list[tuple[int, int, int, int, int, set[int], dict[int, int]]] = [
    # P, N, K, qualifiers, bracket, round-1 positions, per-round counts
    (1, 4, 2, 2, 2, {1}, {1: 1}),  # one pool: league, then a playoff
    (2, 8, 2, 4, 4, {1, 2}, {1: 2, 2: 1}),  # exact power of two: no byes
    (3, 12, 1, 3, 4, {2}, {1: 1, 2: 1}),  # 1 bye — seed 1 walks into the final
    (3, 12, 2, 6, 8, {2, 3}, {1: 2, 2: 2, 3: 1}),  # 2 byes into the semifinals
    (4, 16, 1, 4, 4, {1, 2}, {1: 2, 2: 1}),
    (5, 20, 3, 15, 16, {2, 3, 4, 5, 6, 7, 8}, {1: 7, 2: 4, 3: 2, 4: 1}),
]
RR_THEN_KO_IDS = [f"P={p},N={n},K={k}" for p, n, k, _, _, _, _ in RR_THEN_KO_MATRIX]

#: Pool A of the 3-pool, 12-entrant cut — seeds 1, 6, 7 and 12 — played out so that
#: the finishing order is 6, 12, 7, 1: the top seed loses everything and the pool's
#: second seed wins it. Keyed by the *pair* and valued ``(winner, winner's games,
#: loser's games)``, so a result reads the same whichever way round the fixture seated
#: the two.
POOL_A_RESULTS: dict[frozenset[int], tuple[int, int, int]] = {
    frozenset({1, 12}): (12, 3, 0),
    frozenset({6, 7}): (6, 3, 1),
    frozenset({1, 7}): (7, 3, 2),
    frozenset({12, 6}): (6, 3, 2),
    frozenset({1, 6}): (6, 3, 0),
    frozenset({7, 12}): (12, 3, 1),
}
POOL_A_FINISHING_ORDER = [6, 12, 7, 1]

#: A four-entrant pool with a **three-way tie on wins** — 1 beat 2 beat 3 beat 1, and
#: all three beat 4. A cycle cannot be broken head-to-head, so the order falls through
#: to the game tiebreakers, which is the whole point: it settles 2 above 1 *even though
#: 1 beat 2*, so an order computed on wins (+ head-to-head, + entry id) cannot make it.
CYCLIC_POOL_RESULTS: dict[frozenset[int], tuple[int, int, int]] = {
    frozenset({1, 2}): (1, 3, 2),
    frozenset({2, 3}): (2, 3, 0),
    frozenset({1, 3}): (3, 3, 1),
    frozenset({1, 4}): (1, 3, 0),
    frozenset({2, 4}): (2, 3, 1),
    frozenset({3, 4}): (3, 3, 2),
}
#: Game difference: 2 → +4, 1 → +2, 3 → 0, 4 → −6.
CYCLIC_POOL_FINISHING_ORDER = [2, 1, 3, 4]


def _rr_then_ko(qualifiers_per_pool: int) -> RrThenKoStrategy:
    return RrThenKoStrategy(qualifiers_per_pool=qualifiers_per_pool)


def _knockout(fixtures: Sequence[PlannedFixture]) -> list[PlannedFixture]:
    """The knockout stage — which *is* ``pool_id IS NULL`` (ADR-0786), no new column."""
    return [f for f in fixtures if f.pool_id is None]


def _pooled(fixtures: Sequence[PlannedFixture]) -> list[PlannedFixture]:
    return [f for f in fixtures if f.pool_id is not None]


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
    """A whole-draw sweep in which the better seed always wins 3-1, so every pool
    finishes in seed order and the qualifiers are its two best seeds."""
    return {
        pair: (min(pair), 3, 1)
        for fixture in fixtures
        if fixture.pool_id is not None
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
        if fixture.pool_id is not None:
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
    """One stroke cuts both stages: every pool's round-robin *and* the whole bracket,
    the latter entirely TBD-sided (ADR "rr-then-ko cuts both stages upfront")."""

    def test_rr_then_ko_cuts_the_pool_stage_a_round_robin_draw_would_have_cut(
        self,
    ) -> None:
        # Structural, not "equivalent": the pool fixtures are round-robin's own cut,
        # so the two cannot drift.
        cut = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        assert _pooled(cut) == RoundRobinStrategy().plan_initial(
            _config(3), _ordered(12)
        )

    @pytest.mark.parametrize(
        ("pool_count", "entrants", "per_pool", "qualifiers", "bracket", "r1", "counts"),
        RR_THEN_KO_MATRIX,
        ids=RR_THEN_KO_IDS,
    )
    def test_rr_then_ko_cuts_the_whole_bracket_with_every_side_unknown(
        self,
        pool_count: int,
        entrants: int,
        per_pool: int,
        qualifiers: int,
        bracket: int,
        r1: set[int],
        counts: dict[int, int],
    ) -> None:
        cut = _rr_then_ko(per_pool).plan_initial(
            _config(pool_count), _ordered(entrants)
        )
        knockout = _knockout(cut)

        assert pool_count * per_pool == qualifiers
        # Bracket size is *derived* (smallest power of two ≥ P × K), never configured.
        assert 2 ** len(counts) == bracket
        assert Counter(f.round for f in knockout) == counts
        # Nobody has qualified, so every knockout side is TBD — and a TBD side is a
        # ``None``, never a placeholder entry.
        assert all(f.entry_a_id is None and f.entry_b_id is None for f in knockout)

    @pytest.mark.parametrize(
        ("pool_count", "entrants", "per_pool", "qualifiers", "bracket", "r1", "counts"),
        RR_THEN_KO_MATRIX,
        ids=RR_THEN_KO_IDS,
    )
    def test_rr_then_ko_byes_are_absent_round_one_fixtures_never_null_sided_rows(
        self,
        pool_count: int,
        entrants: int,
        per_pool: int,
        qualifiers: int,
        bracket: int,
        r1: set[int],
        counts: dict[int, int],
    ) -> None:
        # Which seeds bye is settled at cut time — the top B − Q of them — even though
        # nobody has played, which is exactly what lets the bracket be cut upfront.
        cut = _rr_then_ko(per_pool).plan_initial(
            _config(pool_count), _ordered(entrants)
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

        assert _knockout(cut) == [
            dataclasses.replace(f, entry_a_id=None, entry_b_id=None)
            for f in SingleElimStrategy().plan_initial(DrawConfig(), _ordered(6))
        ]

    def test_rr_then_ko_knockout_rounds_restart_at_one_in_their_own_namespace(
        self,
    ) -> None:
        # The unique constraint is ``(event_id, pool_id, round, position)`` with NULLS
        # NOT DISTINCT, so ``pool_id IS NULL`` is its own numbering namespace and the
        # knockout starts again at round 1 — a pool round 1 and a knockout round 1 are
        # different keys, and nothing in the cut collides.
        cut = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        assert min(f.round for f in _knockout(cut)) == 1
        assert min(f.round for f in _pooled(cut)) == 1
        keys = [(f.pool_id, f.round, f.position) for f in cut]
        assert len(set(keys)) == len(keys)

    def test_rr_then_ko_cuts_the_same_draw_twice(self) -> None:
        first = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))
        second = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))

        assert first == second

    def test_rr_then_ko_takes_the_whole_pool_when_everyone_qualifies(self) -> None:
        # K = ⌊N/P⌋ is legal: the pool stage then exists purely to *seed* the knockout.
        cut = _rr_then_ko(4).plan_initial(_config(4), _ordered(16))

        assert len(_knockout(cut)) == 8 + 4 + 2 + 1  # a full 16-slot bracket, no byes
        assert {f.position for f in _knockout(cut) if f.round == 1} == set(range(1, 9))

    def test_rr_then_ko_a_single_pool_is_legal_and_is_league_then_a_playoff(
        self,
    ) -> None:
        # The one-pool waiver: every knockout match is necessarily a rematch, which is
        # the format working as intended, not a refusal.
        cut = _rr_then_ko(2).plan_initial(_config(1), _ordered(5))

        assert {f.pool_id for f in _pooled(cut)} == {_pool("A")}
        assert len(_knockout(cut)) == 1  # a two-qualifier final

    def test_rr_then_ko_refuses_to_take_more_qualifiers_than_the_smallest_pool_holds(
        self,
    ) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            # 7 entrants over 2 pools deals 3 and 4, so 4 qualifiers per pool is more
            # than the smaller pool has players.
            _rr_then_ko(4).plan_initial(_config(2), _ordered(7))

        assert str(excinfo.value) == (
            "Taking 4 qualifiers from each pool is more than the 3 entrants in the "
            "smallest pool — take fewer qualifiers from each pool, or add entrants."
        )
        assert isinstance(excinfo.value, DrawError)

    def test_rr_then_ko_refuses_a_knockout_stage_of_fewer_than_two_qualifiers(
        self,
    ) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            _rr_then_ko(1).plan_initial(_config(1), _ordered(5))

        assert str(excinfo.value) == (
            "Taking 1 qualifier from a single pool leaves one player in the knockout "
            "stage, who would have nobody to play — take more qualifiers from each "
            "pool, or configure more pools."
        )

    def test_rr_then_ko_refuses_a_pool_of_fewer_than_two(self) -> None:
        # Inherited from the snake, unchanged: the pool floor comes free with the pool
        # stage, so rr-then-ko does not restate it.
        with pytest.raises(DegenerateDraw) as excinfo:
            _rr_then_ko(1).plan_initial(_config(3), _ordered(5))

        assert "fewer than 2 entrants" in str(excinfo.value)

    def test_rr_then_ko_refuses_fewer_than_one_qualifier_per_pool_at_construction(
        self,
    ) -> None:
        # A *programmer* error, not a director one — K ≥ 1 is a static constraint at the
        # request boundary — so it is a ValueError, and the illegal strategy cannot even
        # be built.
        with pytest.raises(ValueError, match="qualifiers_per_pool must be at least 1"):
            RrThenKoStrategy(qualifiers_per_pool=0)


class TestRrThenKoAdvance:
    """Each pool seats its qualifiers the moment *it* is decided, into slots settled at
    the cut — with the other pools still playing."""

    def _cut(self) -> list[FixtureState]:
        """The 3-pool, 12-entrant, top-2 draw as it reads back after the cut. The snake
        deals pool A seeds 1, 6, 7, 12; B 2, 5, 8, 11; C 3, 4, 9, 10."""
        return _persisted(_rr_then_ko(2).plan_initial(_config(3), _ordered(12)))

    def test_rr_then_ko_seats_a_finished_pools_qualifiers_and_nobody_elses(
        self,
    ) -> None:
        # THE claim: pool A is decided while B and C are still playing, and A's two
        # qualifiers take their predetermined slots at once. The slots are fixed by
        # ``qualifier_seed_assignment(3, 2)``, which never sees a result: pool A's
        # winner is seed 1 (which byes into semifinal 1) and its runner-up is seed 6
        # (round 1, position 3, side b).
        fixtures = _played(self._cut(), POOL_A_RESULTS)
        by_slot = {(f.round, f.position): f for f in fixtures if f.pool_id is None}

        plan = _rr_then_ko(2).advance(fixtures)

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

    def test_rr_then_ko_qualifiers_are_the_top_of_the_pools_finishing_order(
        self,
    ) -> None:
        # The qualifiers are the top K of *the* finishing order — the same function the
        # standings table is built from — and this pool proves the whole tiebreak chain
        # is live: a three-way cycle on wins is settled on game difference, which seats
        # entry 2 above entry 1 even though 1 beat 2 head-to-head. An order computed on
        # wins alone (or wins + head-to-head + entry id) puts 1 first.
        cut = _persisted(_rr_then_ko(2).plan_initial(_config(1), _ordered(4)))
        fixtures = _played(cut, CYCLIC_POOL_RESULTS)

        plan = _rr_then_ko(2).advance(fixtures)

        assert _knockout_sides(_apply(fixtures, plan)) == {
            (1, 1, "a"): CYCLIC_POOL_FINISHING_ORDER[0],
            (1, 1, "b"): CYCLIC_POOL_FINISHING_ORDER[1],
        }

    def test_rr_then_ko_seats_nothing_for_a_pool_that_is_still_playing(self) -> None:
        # Per-pool, not all-or-nothing — and the converse: a pool with results in it but
        # a fixture still to play seats nobody, because its order is not settled.
        cut = self._cut()
        partial = dict(list(POOL_A_RESULTS.items())[:-1])

        assert _rr_then_ko(2).advance(_played(cut, partial)).side_fills == ()

    def test_rr_then_ko_is_idempotent_once_the_qualifiers_are_seated(self) -> None:
        # THE idempotence claim: apply the plan, feed the result back, and the second
        # advance seats nobody — a SideFill only ever fills an *empty* side.
        fixtures = _played(self._cut(), POOL_A_RESULTS)
        first = _rr_then_ko(2).advance(fixtures)

        assert _rr_then_ko(2).advance(_apply(fixtures, first)).side_fills == ()

    def test_rr_then_ko_plans_nothing_at_all_over_its_own_fully_applied_plan(
        self,
    ) -> None:
        # The stronger form: with the fills applied *and* the newly-ready fixtures
        # materialized (what ``materialize_event`` does in the same transaction), the
        # whole plan is empty — which is what makes re-running after every result safe.
        fixtures = _played(self._cut(), POOL_A_RESULTS)
        applied = _apply(fixtures, _rr_then_ko(2).advance(fixtures))
        materialized = [
            dataclasses.replace(f, match_id=MatchId(uuid.UUID(int=4000 + i)))
            if f.match_id is None
            else f
            for i, f in enumerate(applied)
        ]

        assert _rr_then_ko(2).advance(materialized) == AdvancePlan()

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
            if (f.pool_id, f.round, f.position) == (None, 1, 3)
            else f
            for f in cut
        ]
        by_slot = {(f.round, f.position): f for f in seeded if f.pool_id is None}

        plan = _rr_then_ko(2).advance(seeded)

        # Round 1 position 3 is odd → side a of round 2, position 2.
        assert (
            SideFill(
                fixture_id=by_slot[(2, 2)].fixture_id,
                side=Side.a,
                entry_id=_entry_id(3),
            )
            in plan.side_fills
        )

    def test_rr_then_ko_never_seats_a_pool_winner_forward_into_a_knockout_slot(
        self,
    ) -> None:
        # A pool fixture has no successor — its ``(round, position)`` lives in the
        # pool's own namespace, and reading it as a bracket coordinate would seat a pool
        # winner into a knockout slot belonging to somebody else. Only the *finished*
        # pool's qualifier seating touches the bracket, so a half-played pool fills
        # nothing.
        cut = self._cut()
        partial = dict(list(POOL_A_RESULTS.items())[:2])

        assert _rr_then_ko(2).advance(_played(cut, partial)).side_fills == ()

    def test_rr_then_ko_round_one_never_pairs_two_qualifiers_out_of_one_pool(
        self,
    ) -> None:
        # The rematch-free guarantee, end to end through a real cut and advance rather
        # than on the seed map alone.
        planned = _rr_then_ko(2).plan_initial(_config(3), _ordered(12))
        pool_of = {
            seed: pool_id
            for pool_id, seeds in _members_by_pool(_pooled(planned)).items()
            for seed in seeds
        }
        cut = _persisted(planned)
        fixtures = _played(cut, _lower_seed_wins(cut))

        seeded = _apply(fixtures, _rr_then_ko(2).advance(fixtures))

        round_one = [
            (f.entry_a_id, f.entry_b_id)
            for f in seeded
            if f.pool_id is None and f.round == 1
        ]
        assert round_one
        for entry_a, entry_b in round_one:
            assert entry_a is not None and entry_b is not None
            assert pool_of[entry_a.int] != pool_of[entry_b.int]

    def test_rr_then_ko_a_freshly_cut_draw_is_ready_only_in_its_pools(self) -> None:
        # At the cut every pool pairing is known and every knockout side is TBD, so the
        # pool stage materializes at go-live and the bracket waits.
        cut = self._cut()

        plan = _rr_then_ko(2).advance(cut)

        assert plan.side_fills == ()
        assert set(plan.ready_fixture_ids) == {
            f.fixture_id for f in cut if f.pool_id is not None
        }

    def test_rr_then_ko_refuses_to_order_a_pool_it_cannot_see_the_games_of(
        self,
    ) -> None:
        # THE trap this raise exists for: ``FixtureState.games`` is populated by the ORM
        # projection, but the materialization seam does not pass game counts yet, so
        # every fixture reaching advance() carries ``games=None``. Ordering a pool
        # without them would silently fall back to wins alone and choose different
        # qualifiers from the standings on screen — with the whole suite still green,
        # because nothing else reads the field. So it fails loudly instead.
        gameless = [
            dataclasses.replace(f, winner_entry_id=f.entry_a_id)
            if f.pool_id is not None
            else f
            for f in self._cut()
        ]

        with pytest.raises(MissingFixtureGames) as excinfo:
            _rr_then_ko(2).advance(gameless)

        assert "no game counts" in str(excinfo.value)
        assert "18 decided pool fixtures" in str(excinfo.value)
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
        cut = _persisted(_rr_then_ko(1).plan_initial(_config(2), _ordered(4)))
        fixtures = _played(cut, _lower_seed_wins(cut))

        with pytest.raises(MissingBracketSlot) as excinfo:
            _rr_then_ko(2).advance(fixtures)

        assert "cut for a different number of qualifiers" in str(excinfo.value)
        # Not a DrawError: a frozen K means nothing a director can type reaches this, so
        # it is a wiring bug and a 500, not a 422 they could act on.
        assert not isinstance(excinfo.value, DrawError)

    def test_rr_then_ko_tolerates_one_result_in_flux_among_scored_neighbours(
        self,
    ) -> None:
        # The other side of that raise, and why it is scoped the way it is: a *single*
        # fixture whose match left ``completed`` (a correction under review) keeps its
        # written-back winner while its games go away. That is an ordinary live state —
        # its pool is simply not finished — and must not blow up the whole advance.
        fixtures = _played(self._cut(), POOL_A_RESULTS)
        in_flux = [
            dataclasses.replace(f, games=None)
            if f.games is not None and f.round == 1 and f.position == 1
            else f
            for f in fixtures
        ]

        plan = _rr_then_ko(2).advance(in_flux)

        assert plan.side_fills == ()

    def test_rr_then_ko_finishes_a_pool_holding_a_voided_pairing(self) -> None:
        # THE claim of the voided-fixture fix: a **voided** pairing can never produce a
        # result, so it is left OUT of "every fixture carries a score" instead of
        # counting as a score that never arrives. Requiring it would hold the pool one
        # outcome short forever — never finished, its qualifiers never seated, the
        # knockout never ready, nothing a director could do about it — while the
        # standings, which already exclude voided pairings from a pool's
        # ``fixture_count``, called that same pool ``complete``.
        #
        # And the order is genuinely the one the REMAINING results produce, not a
        # leftover: played in full, this pool finishes 2, 1, 3, 4 and qualifies {2, 1}
        # (``CYCLIC_POOL_FINISHING_ORDER``). With 1-v-4 voided, 1 drops to a single win
        # and 3 rises past it, so the pool finishes 2, 3, 1, 4 and qualifies **{2, 3}**:
        # a different runner-up, which is what makes this evidence about the ordering
        # and not just about the seating.
        cut = _persisted(_rr_then_ko(2).plan_initial(_config(1), _ordered(4)))
        voided_pair = frozenset({1, 4})
        played = _played(
            cut,
            {
                pair: result
                for pair, result in CYCLIC_POOL_RESULTS.items()
                if pair != voided_pair
            },
        )
        fixtures = _voided(played, {voided_pair})

        plan = _rr_then_ko(2).advance(fixtures)

        assert _knockout_sides(_apply(fixtures, plan)) == {
            (1, 1, "a"): 2,
            (1, 1, "b"): 3,
        }

    def test_rr_then_ko_seats_nobody_out_of_a_pool_whose_every_pairing_was_voided(
        self,
    ) -> None:
        # The floor under the rule above. Skipping voided fixtures cannot become
        # "finish a pool on no results at all": with nothing to rank on, the tiebreak
        # chain falls through to its entry-id fallback and would hand back an order that
        # is arbitrary rather than earned. So the pool is not finished, and nobody is
        # seated — the one place this deliberately parts company with the standings,
        # which call such a pool ``complete`` and show a table of zeros.
        cut = _persisted(_rr_then_ko(2).plan_initial(_config(1), _ordered(4)))
        fixtures = _voided(cut, set(CYCLIC_POOL_RESULTS))

        plan = _rr_then_ko(2).advance(fixtures)

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

        plan = _rr_then_ko(2).advance(fixtures)

        assert plan.side_fills == (), "pool A has five pairings still to play"

    def test_rr_then_ko_still_refuses_a_lost_projection_beside_a_voided_pairing(
        self,
    ) -> None:
        # The other half: excluding voided fixtures must not blunt the guard. A pool
        # played out and then projected WITHOUT its game counts still raises, and the
        # count it reports is the fixtures that should have had games — five of pool A's
        # six, because the sixth is voided and genuinely has none.
        played = _played(self._cut(), POOL_A_RESULTS)
        gameless = [
            dataclasses.replace(f, games=None) if f.pool_id is not None else f
            for f in played
        ]
        fixtures = _voided(gameless, {frozenset({1, 6})})

        with pytest.raises(MissingFixtureGames) as excinfo:
            _rr_then_ko(2).advance(fixtures)

        assert "5 decided pool fixtures" in str(excinfo.value)


class TestSwissCut:
    """The cut pre-writes **every** round: ``R × ⌊n/2⌋`` fixtures, round 1 seeded from
    the draw order and every later round left with both sides TBD (ADR "swiss pre-cuts
    every round and pairs each one on advance")."""

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

    def test_positions_are_contiguous_within_each_round_and_unpooled(self) -> None:
        """``(round, position)`` is a fixture's identity — the uniqueness constraint is
        ``(event_id, pool_id, round, position)`` — so positions run 1..⌊n/2⌋ inside each
        round with no gaps. Every fixture is un-pooled: swiss ranks one field in one
        table, which is why the schedule preview refuses it."""
        fixtures = SwissStrategy(rounds=3).plan_initial(DrawConfig(), _ordered(9))

        by_round: dict[int, list[int]] = {}
        for f in fixtures:
            by_round.setdefault(f.round, []).append(f.position)
        assert by_round == {1: [1, 2, 3, 4], 2: [1, 2, 3, 4], 3: [1, 2, 3, 4]}
        assert all(f.pool_id is None for f in fixtures)

    def test_a_draw_ignores_the_events_pools(self) -> None:
        """Swiss is pool-less whatever the event's pool list says: a director who
        configured pools and then chose swiss gets one un-pooled field, not a draw
        dealt across them."""
        fixtures = SwissStrategy(rounds=2).plan_initial(_config(2), _ordered(6))

        assert all(f.pool_id is None for f in fixtures)
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


class TestSwissAdvance:
    """Round 1 was paired at the cut, so all ``advance`` has to report today is
    readiness. Pairing rounds 2..R off the standings is its own slice, and its absence
    is asserted here rather than stubbed."""

    def _cut(self, *, rounds: int = 3, entrants: int = 8) -> list[FixtureState]:
        return _persisted(
            SwissStrategy(rounds=rounds).plan_initial(DrawConfig(), _ordered(entrants))
        )

    def test_a_freshly_cut_draw_is_ready_in_round_one_only_and_fills_nothing(
        self,
    ) -> None:
        fixtures = self._cut()

        plan = SwissStrategy(rounds=3).advance(fixtures)

        assert plan.side_fills == ()
        assert set(plan.ready_fixture_ids) == {
            f.fixture_id for f in fixtures if f.round == 1
        }
        assert not plan.is_empty

    def test_a_materialized_round_one_leaves_an_empty_plan(self) -> None:
        """Idempotence: apply the plan (the fixtures now carry matches) and re-running
        it proposes nothing — the later rounds are still pending, so they are not
        ready, and round 1 is no longer."""
        fixtures = [
            dataclasses.replace(f, match_id=MatchId(uuid.UUID(int=4000 + i)))
            if f.round == 1
            else f
            for i, f in enumerate(self._cut())
        ]

        plan = SwissStrategy(rounds=3).advance(fixtures)

        assert plan.is_empty

    def test_a_decided_round_one_pairs_nothing_yet(self) -> None:
        """**The honest limit of this slice.** Round 1 played out in full still fills no
        side of round 2: pairing by standings is the next chore, and a stub that seated
        somebody here would be writing pairings nothing computed.

        It is asserted rather than left unsaid so that the chore landing the pairing has
        a test to *change*, and so nothing quietly reports a round ready that has no
        players in it."""
        played = _played(
            self._cut(),
            {
                frozenset({1, 5}): (1, 3, 0),
                frozenset({2, 6}): (2, 3, 1),
                frozenset({3, 7}): (7, 3, 2),
                frozenset({4, 8}): (4, 3, 0),
            },
        )

        plan = SwissStrategy(rounds=3).advance(played)

        assert plan.side_fills == ()
        assert plan.ready_fixture_ids == ()
        assert all(
            f.entry_a_id is None and f.entry_b_id is None for f in played if f.round > 1
        )
