"""Unit tests for the pure draw-planning domain (``app.draws``, ADR-0786).

No database, no app — every test here builds its input from literals, which is the
point of keeping the strategies pure.
"""

import dataclasses
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
    Side,
    SideFill,
    SingleElimStrategy,
    order_entrants,
    ready_fixtures,
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
        assert isinstance(strategy_for(DrawType.round_robin), RoundRobinStrategy)

    def test_single_elim_resolves_to_the_single_elim_strategy(self) -> None:
        # The second implemented arm (ADR-0785).
        assert isinstance(strategy_for(DrawType.single_elim), SingleElimStrategy)

    def test_every_draw_type_resolves_to_a_strategy_and_none_refuses(self) -> None:
        """``strategy_for`` is **total** — the enum holds only draw types that run (ADR
        "a draw type is a seeded row, and the enum holds only what runs"), so there is
        no refusal arm left to reach and nothing may resolve to ``None``.

        This is the assertion that reds if a member is ever added to ``DrawType``
        without a strategy — alongside the type error the catch-all-free ``match``
        already is. It replaces the old "unimplemented types raise": that refusal has
        no input any more, because Pydantic rejects an un-backed slug at the request
        boundary instead."""
        for draw_type in DrawType:
            assert strategy_for(draw_type) is not None

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
        # A pool id is a string ref into the event's JSONB pools, not an index we mint.
        config = DrawConfig(
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
    ) -> FixtureState:
        return FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=n)),
            pool_id=pool_id,
            round=round,
            position=position,
            entry_a_id=_entry_id(1),
            entry_b_id=_entry_id(2),
        )

    def test_pooled_fixtures_are_ready_before_un_pooled_ones(self) -> None:
        # The mixed set is the one a pooled-then-knockout draw will hand this: the pool
        # fixtures carry a pool ref, the KO fixtures behind them carry NULL. A ``None``
        # does not compare against a ``str``, so the sort key has to *decide* where the
        # un-pooled sit rather than fall over — and where they sit has to be a fact, not
        # whatever order the rows came back in.
        ko = self._state(1, pool_id=None, round=1, position=1)
        b1 = self._state(2, pool_id=PoolId("B"), round=1, position=1)
        a2 = self._state(3, pool_id=PoolId("A"), round=1, position=2)
        a1 = self._state(4, pool_id=PoolId("A"), round=1, position=1)
        a_round2 = self._state(5, pool_id=PoolId("A"), round=2, position=1)

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
        ready = self._state(1, pool_id=PoolId("A"), round=1, position=1)
        materialized = FixtureState(
            fixture_id=FixtureId(uuid.UUID(int=2)),
            pool_id=PoolId("A"),
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
