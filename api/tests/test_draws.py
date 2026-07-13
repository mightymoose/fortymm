"""Unit tests for the pure draw-planning domain (``app.draws``, ADR-0786).

No database, no app — every test here builds its input from literals, which is the
point of keeping the strategies pure.
"""

import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta
from itertools import combinations

import pytest

from app.draws import (
    AdvancePlan,
    DegenerateDraw,
    DrawConfig,
    DrawError,
    Entrant,
    EntryId,
    FixtureId,
    FixtureState,
    MatchId,
    OrderedEntrant,
    PlannedFixture,
    PoolId,
    RoundRobinStrategy,
    UnsupportedDrawType,
    order_entrants,
    strategy_for,
)
from app.models.tournament import DrawType

REGISTRATION_OPENED = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)


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


def _pool_ids(count: int) -> tuple[PoolId, ...]:
    """``('A', 'B', …)`` — pool ids are string refs into the event's JSONB pools."""
    return tuple(PoolId(chr(ord("A") + i)) for i in range(count))


def _config(pool_count: int) -> DrawConfig:
    return DrawConfig(draw_type=DrawType.round_robin, pool_ids=_pool_ids(pool_count))


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
        assert isinstance(strategy_for(DrawType.round_robin), RoundRobinStrategy)

    @pytest.mark.parametrize(
        "draw_type",
        [
            DrawType.single_elim,
            DrawType.double_elim,
            DrawType.rr_then_ko,
            DrawType.swiss,
        ],
    )
    def test_unimplemented_types_raise_a_typed_catchable_domain_error(
        self, draw_type: DrawType
    ) -> None:
        with pytest.raises(UnsupportedDrawType) as excinfo:
            strategy_for(draw_type)

        # The route needs to know *which* type it refused, to say so in the 422.
        assert excinfo.value.draw_type is draw_type
        # And it must be catchable as the one domain base a route handler switches on.
        assert isinstance(excinfo.value, DrawError)

    def test_every_draw_type_is_handled_one_way_or_the_other(self) -> None:
        # The match has no catch-all, so an unhandled member would fall through and
        # return None. Nothing may resolve to None — it must be a strategy or a refusal.
        for draw_type in DrawType:
            try:
                assert strategy_for(draw_type) is not None
            except UnsupportedDrawType:
                pass


class TestRoundRobinCut:
    @pytest.mark.parametrize(
        ("entrants", "pools", "expected"), SNAKE_MATRIX, ids=MATRIX_IDS
    )
    def test_entrants_are_snaked_across_the_pools(
        self, entrants: int, pools: int, expected: dict[str, list[int]]
    ) -> None:
        fixtures = RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        members = _members_by_pool(fixtures)
        assert {str(k): sorted(v) for k, v in members.items()} == expected

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
        assert set(pairs_by_pool) == {PoolId(p) for p in expected}

        for pool_id, seeds in expected.items():
            pairs = pairs_by_pool[PoolId(pool_id)]
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
            pool_fixtures = [f for f in fixtures if f.pool_id == PoolId(pool_id)]
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
                f.round for f in fixtures if f.pool_id == PoolId(pool_id)
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
                pool_id=PoolId("A"),
                round=1,
                position=1,
                entry_a_id=_entry_id(1),
                entry_b_id=_entry_id(2),
            )
        ]

    @pytest.mark.parametrize(
        ("entrants", "pools"),
        [
            (1, 1),  # a lone entrant has nobody to play
            (0, 1),  # a ghost pool
            (3, 2),  # the snake would leave pool B with one entrant
            (5, 3),  # ...and pool C with one
        ],
    )
    def test_a_pool_of_fewer_than_two_is_refused(
        self, entrants: int, pools: int
    ) -> None:
        with pytest.raises(DegenerateDraw) as excinfo:
            RoundRobinStrategy().plan_initial(_config(pools), _ordered(entrants))

        assert isinstance(excinfo.value, DrawError)

    def test_a_draw_with_no_pools_is_refused(self) -> None:
        with pytest.raises(DegenerateDraw):
            RoundRobinStrategy().plan_initial(
                DrawConfig(draw_type=DrawType.round_robin, pool_ids=()), _ordered(4)
            )

    def test_pools_are_named_by_the_events_own_pool_ids(self) -> None:
        # A pool id is a string ref into the event's JSONB pools, not an index we mint.
        config = DrawConfig(
            draw_type=DrawType.round_robin,
            pool_ids=(PoolId("pool-morning"), PoolId("pool-evening")),
        )

        fixtures = RoundRobinStrategy().plan_initial(config, _ordered(6))

        assert {f.pool_id for f in fixtures} == {
            PoolId("pool-morning"),
            PoolId("pool-evening"),
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
            pool_id=PoolId("A"),
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
