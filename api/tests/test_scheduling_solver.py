"""Unit tests for the pure CP-SAT scheduling domain (``app.scheduling``, ADR
"the schedule is solved; the call is pinned").

No database, no app — every test builds its snapshot from literals, which is
the point of keeping the solver pure. The property-flavored tests use small
seeded random instances (a few dozen fixtures at most) under a 2-second time
cap so the suite stays fast and deterministic.
"""

import dataclasses
import random

import pytest

from app.scheduling import (
    BUCKET_MIN,
    REST_MIN,
    EventId,
    EventSettings,
    FixtureId,
    IncoherentSnapshot,
    InProgressMatch,
    MatchLength,
    Pin,
    PlacedFixture,
    PlayerId,
    PoolId,
    PreviousPlacement,
    ScheduleFixture,
    SchedulePool,
    ScheduleSnapshot,
    SolveResult,
    TableId,
    Verdict,
    Window,
    match_minutes,
    solve,
)

# Short cap: every instance here solves in well under a second.
CAP = 2.0

SOLVED = (Verdict.optimal, Verdict.feasible)


def _tables(count: int) -> tuple[TableId, ...]:
    return tuple(TableId(f"T{i}") for i in range(1, count + 1))


def _players(count: int) -> list[PlayerId]:
    return [PlayerId(f"P{i}") for i in range(1, count + 1)]


def _fixture(
    n: int,
    player_a: PlayerId,
    player_b: PlayerId,
    *,
    event: str = "E1",
    pool: str = "A",
    pin: Pin | None = None,
    completed: bool = False,
) -> ScheduleFixture:
    return ScheduleFixture(
        id=FixtureId(f"F{n}"),
        event_id=EventId(event),
        pool_id=PoolId(pool),
        player_a_id=player_a,
        player_b_id=player_b,
        pin=pin,
        completed=completed,
    )


def _one_pool_snapshot(
    fixtures: tuple[ScheduleFixture, ...],
    *,
    tables: int = 3,
    window: tuple[int, int] = (0, 480),
    length_games: MatchLength = 3,
    now_min: int = 0,
    in_progress: tuple[InProgressMatch, ...] = (),
    previous_plan: tuple[PreviousPlacement, ...] = (),
) -> ScheduleSnapshot:
    table_ids = _tables(tables)
    return ScheduleSnapshot(
        table_ids=table_ids,
        pools=(SchedulePool(PoolId("A"), table_ids, Window(*window)),),
        events=(EventSettings(EventId("E1"), length_games),),
        fixtures=fixtures,
        now_min=now_min,
        in_progress=in_progress,
        previous_plan=previous_plan,
    )


def _random_snapshot(
    seed: int,
    *,
    n_fixtures: int = 12,
    n_players: int = 6,
    n_tables: int = 3,
    two_pools: bool = False,
) -> ScheduleSnapshot:
    """A small random instance. Few players against many fixtures forces real
    contention, so the rest floor and per-player no-overlap actually bite."""
    rng = random.Random(seed)
    players = _players(n_players)
    table_ids = _tables(n_tables)
    if two_pools:
        pools = (
            SchedulePool(PoolId("A"), table_ids[:2], Window(0, 480)),
            SchedulePool(PoolId("B"), table_ids[2:], Window(60, 540)),
        )
        events = (
            EventSettings(EventId("E1"), 3),
            EventSettings(EventId("E2"), 5),
        )
    else:
        pools = (SchedulePool(PoolId("A"), table_ids, Window(0, 480)),)
        events = (EventSettings(EventId("E1"), 3),)
    fixtures = []
    for n in range(1, n_fixtures + 1):
        player_a, player_b = rng.sample(players, 2)
        if two_pools and n % 2 == 0:
            fixtures.append(_fixture(n, player_a, player_b, event="E2", pool="B"))
        else:
            fixtures.append(_fixture(n, player_a, player_b))
    return ScheduleSnapshot(
        table_ids=table_ids,
        pools=pools,
        events=events,
        fixtures=tuple(fixtures),
        now_min=0,
    )


def _assert_hard_constraints(snapshot: ScheduleSnapshot, result: SolveResult) -> None:
    """Every invariant a solved plan must satisfy, checked from the output
    alone: coverage, pool tables, windows, the grid, table no-overlap
    (including in-progress occupancy), and the per-player rest floor."""
    assert result.verdict in SOLVED
    pools = {p.id: p for p in snapshot.pools}
    events = {e.id: e for e in snapshot.events}
    fixtures = {f.id: f for f in snapshot.fixtures}
    running = {m.fixture_id: m for m in snapshot.in_progress}
    placed = {p.fixture_id: p for p in result.placements}

    expected = {
        f.id for f in snapshot.fixtures if not f.completed and f.id not in running
    }
    assert set(placed) == expected

    by_table: dict[TableId, list[tuple[int, int]]] = {}
    by_player: dict[PlayerId, list[tuple[int, int]]] = {}

    for placement in result.placements:
        fixture = fixtures[placement.fixture_id]
        duration = match_minutes(events[fixture.event_id].length_games)
        assert placement.end_min == placement.start_min + duration
        by_table.setdefault(placement.table_id, []).append(
            (placement.start_min, placement.end_min)
        )
        for player in (fixture.player_a_id, fixture.player_b_id):
            by_player.setdefault(player, []).append(
                (placement.start_min, placement.end_min)
            )
        if fixture.pin is not None:
            # Pins echoed byte for byte; windows do not apply to them.
            assert placement.table_id == fixture.pin.table_id
            assert placement.start_min == fixture.pin.start_min
        else:
            pool = pools[fixture.pool_id]
            assert placement.table_id in pool.table_ids
            assert placement.start_min >= snapshot.now_min
            assert placement.start_min >= pool.window.start_min
            assert placement.end_min <= pool.window.end_min
            assert placement.start_min % BUCKET_MIN == 0

    for match in snapshot.in_progress:
        fixture = fixtures[match.fixture_id]
        duration = match_minutes(events[fixture.event_id].length_games)
        occ_end = max(match.start_min + duration, snapshot.now_min + BUCKET_MIN)
        by_table.setdefault(match.table_id, []).append((match.start_min, occ_end))
        for player in (fixture.player_a_id, fixture.player_b_id):
            by_player.setdefault(player, []).append((match.start_min, occ_end))

    for intervals in by_table.values():
        intervals.sort()
        for (_, end), (start, _) in zip(intervals, intervals[1:], strict=False):
            assert start >= end, "two matches overlap on a table"
    for intervals in by_player.values():
        intervals.sort()
        for (_, end), (start, _) in zip(intervals, intervals[1:], strict=False):
            assert start >= end + REST_MIN, "player rest floor violated"


class TestDurations:
    @pytest.mark.parametrize(
        ("length_games", "minutes"),
        [(1, 15), (3, 25), (5, 35), (7, 45)],
    )
    def test_match_minutes_mapping(
        self, length_games: MatchLength, minutes: int
    ) -> None:
        assert match_minutes(length_games) == minutes

    def test_rest_floor_and_bucket_constants(self) -> None:
        assert REST_MIN == 10
        assert BUCKET_MIN == 5


class TestHardConstraints:
    @pytest.mark.parametrize("seed", [0, 1, 2, 3])
    def test_random_single_pool_instances(self, seed: int) -> None:
        snapshot = _random_snapshot(seed)
        _assert_hard_constraints(snapshot, solve(snapshot, time_cap_s=CAP))

    @pytest.mark.parametrize("seed", [10, 11, 12])
    def test_random_two_pool_instances(self, seed: int) -> None:
        """Tables split between pools, two events with different durations,
        players shared across both — cross-event no-double-booking."""
        snapshot = _random_snapshot(seed, two_pools=True, n_fixtures=14)
        _assert_hard_constraints(snapshot, solve(snapshot, time_cap_s=CAP))

    def test_contended_instance_respects_rest_between_back_to_backs(
        self,
    ) -> None:
        """One player in every fixture: the plan is forced into a chain of
        that player's matches, each ≥ REST_MIN after the previous end."""
        star, *rest = _players(4)
        fixtures = tuple(_fixture(n, star, rest[n % 3]) for n in range(1, 6))
        snapshot = _one_pool_snapshot(fixtures)
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)
        starts = sorted(p.start_min for p in result.placements)
        duration = match_minutes(3)
        for earlier, later in zip(starts, starts[1:], strict=False):
            assert later >= earlier + duration + REST_MIN

    def test_completed_fixtures_are_ignored(self) -> None:
        p1, p2, p3, p4 = _players(4)
        fixtures = (
            _fixture(1, p1, p2, completed=True),
            _fixture(2, p3, p4),
        )
        result = solve(_one_pool_snapshot(fixtures), time_cap_s=CAP)
        assert result.verdict in SOLVED
        assert [p.fixture_id for p in result.placements] == [FixtureId("F2")]


class TestPinsArePromises:
    def test_pinned_placements_survive_arbitrary_resolves(self) -> None:
        """THE invariant: a pin's (table, start) is byte-identical in the
        output across re-solves with mutated unpinned inputs — added and
        removed fixtures, junk previous plans, shrunk capacity elsewhere,
        and a later clock."""
        base = _random_snapshot(seed=7)
        first = solve(base, time_cap_s=CAP)
        assert first.verdict in SOLVED

        # Call the two earliest placements: their plan becomes their pin.
        called = {p.fixture_id: p for p in first.placements[:2]}
        pinned_fixtures = tuple(
            dataclasses.replace(
                f, pin=Pin(called[f.id].table_id, called[f.id].start_min)
            )
            if f.id in called
            else f
            for f in base.fixtures
        )
        pinned_snap = dataclasses.replace(base, fixtures=pinned_fixtures)

        extra_players = _players(8)
        added = pinned_snap.fixtures + (
            _fixture(90, extra_players[6], extra_players[7]),
            _fixture(91, extra_players[6], extra_players[7]),
            _fixture(92, extra_players[7], extra_players[6]),
        )
        an_unpinned = next(f.id for f in pinned_snap.fixtures if f.id not in called)
        pin_tables = {p.table_id for p in called.values()}
        spare_table = next(t for t in pinned_snap.table_ids if t not in pin_tables)
        shrunk_tables = tuple(t for t in pinned_snap.table_ids if t != spare_table)
        variants = [
            pinned_snap,
            dataclasses.replace(pinned_snap, fixtures=added),
            dataclasses.replace(
                pinned_snap,
                fixtures=tuple(f for f in pinned_snap.fixtures if f.id != an_unpinned),
            ),
            dataclasses.replace(
                pinned_snap,
                previous_plan=tuple(
                    PreviousPlacement(f.id, TableId("T1"), 400 + 5 * i)
                    for i, f in enumerate(pinned_snap.fixtures)
                ),
            ),
            dataclasses.replace(
                pinned_snap,
                table_ids=shrunk_tables,
                pools=(SchedulePool(PoolId("A"), shrunk_tables, Window(0, 480)),),
            ),
            dataclasses.replace(pinned_snap, now_min=45),
        ]
        for variant in variants:
            result = solve(variant, time_cap_s=CAP)
            assert result.verdict in SOLVED
            placed = {p.fixture_id: p for p in result.placements}
            for fixture_id, promise in called.items():
                assert placed[fixture_id].table_id == promise.table_id
                assert placed[fixture_id].start_min == promise.start_min

    def test_hard_constraints_hold_around_pins(self) -> None:
        """Run the full hard-constraint check over a plan that CONTAINS a pin
        — pin table occupancy and the pinned players' rest floor were
        previously unasserted through ``_assert_hard_constraints``. One table
        forces every unpinned fixture to schedule around the pin's occupancy,
        and the shared players force the rest floor to bite on both sides of
        it."""
        p1, p2, p3, p4 = _players(4)
        fixtures = (
            _fixture(1, p1, p2, pin=Pin(TableId("T1"), 60)),
            _fixture(2, p1, p3),  # shares p1 with the pin
            _fixture(3, p2, p4),  # shares p2 with the pin
            _fixture(4, p3, p4),
        )
        snapshot = _one_pool_snapshot(fixtures, tables=1)
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)

    def test_pin_outside_its_window_is_kept(self) -> None:
        """Pins outrank windows: an overrun pin past the pool's end is echoed
        verbatim, not squeezed back inside."""
        p1, p2, p3, p4 = _players(4)
        fixtures = (
            _fixture(1, p1, p2, pin=Pin(TableId("T1"), 470)),
            _fixture(2, p3, p4),
        )
        snapshot = _one_pool_snapshot(fixtures, window=(0, 480))
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict in SOLVED
        placed = {p.fixture_id: p for p in result.placements}
        pinned = placed[FixtureId("F1")]
        assert (pinned.table_id, pinned.start_min) == (TableId("T1"), 470)
        assert pinned.end_min == 495  # past the window, kept anyway

    def test_pin_in_the_past_is_kept_when_now_advances(self) -> None:
        p1, p2, p3, p4 = _players(4)
        fixtures = (
            _fixture(1, p1, p2, pin=Pin(TableId("T1"), 30)),
            _fixture(2, p3, p4),
        )
        snapshot = _one_pool_snapshot(fixtures, now_min=40)
        result = solve(snapshot, time_cap_s=CAP)
        placed = {p.fixture_id: p for p in result.placements}
        assert placed[FixtureId("F1")].start_min == 30
        assert placed[FixtureId("F2")].start_min >= 40


class TestInfeasibility:
    def test_window_too_small_for_one_match_is_infeasible(self) -> None:
        p1, p2 = _players(2)
        snapshot = _one_pool_snapshot(
            (_fixture(1, p1, p2),),
            window=(0, 20),  # 25-minute match
        )
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.infeasible
        assert result.placements == ()
        assert result.stats.objective is None

    def test_combinatorially_overfull_day_is_infeasible(self) -> None:
        """Each match fits its window alone; three of them cannot share the
        single table — infeasibility proven by the solver, not the guard."""
        players = _players(6)
        fixtures = tuple(
            _fixture(n, players[2 * (n - 1)], players[2 * n - 1]) for n in (1, 2, 3)
        )
        snapshot = _one_pool_snapshot(fixtures, tables=1, window=(0, 60))
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.infeasible
        assert result.placements == ()

    def test_pool_with_no_tables_is_infeasible(self) -> None:
        p1, p2 = _players(2)
        snapshot = ScheduleSnapshot(
            table_ids=(),
            pools=(SchedulePool(PoolId("A"), (), Window(0, 480)),),
            events=(EventSettings(EventId("E1"), 3),),
            fixtures=(_fixture(1, p1, p2),),
            now_min=0,
        )
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.infeasible
        assert result.placements == ()


class TestInProgress:
    def test_table_is_blocked_until_estimated_end(self) -> None:
        """One table: nothing lands on it before the running match's
        estimated end (start 0 + 25 minutes)."""
        p1, p2, p3, p4 = _players(4)
        fixtures = (_fixture(1, p1, p2), _fixture(2, p3, p4))
        snapshot = _one_pool_snapshot(
            fixtures,
            tables=1,
            now_min=10,
            in_progress=(InProgressMatch(FixtureId("F1"), TableId("T1"), 0),),
        )
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)
        placed = {p.fixture_id: p for p in result.placements}
        assert set(placed) == {FixtureId("F2")}  # F1 is reality, not plan
        assert placed[FixtureId("F2")].start_min >= 25

    def test_shared_player_rests_after_the_running_match(self) -> None:
        """A free second table does not help the player still on court: their
        next match starts ≥ estimated end + rest floor."""
        p1, p2, p3 = _players(3)
        fixtures = (_fixture(1, p1, p2), _fixture(2, p1, p3))
        snapshot = _one_pool_snapshot(
            fixtures,
            tables=2,
            now_min=10,
            in_progress=(InProgressMatch(FixtureId("F1"), TableId("T1"), 0),),
        )
        result = solve(snapshot, time_cap_s=CAP)
        placed = {p.fixture_id: p for p in result.placements}
        assert placed[FixtureId("F2")].start_min >= 25 + REST_MIN

    def test_overrunning_match_blocks_at_least_a_beat_past_now(self) -> None:
        """Estimated end long past: occupancy is max(est end, now + bucket),
        so the table stays blocked just ahead of the clock."""
        p1, p2, p3, p4 = _players(4)
        fixtures = (_fixture(1, p1, p2), _fixture(2, p3, p4))
        snapshot = _one_pool_snapshot(
            fixtures,
            tables=1,
            now_min=60,  # the 0-started 25-minute match is 35 minutes over
            in_progress=(InProgressMatch(FixtureId("F1"), TableId("T1"), 0),),
        )
        result = solve(snapshot, time_cap_s=CAP)
        placed = {p.fixture_id: p for p in result.placements}
        assert placed[FixtureId("F2")].start_min >= 60 + BUCKET_MIN


class TestDegenerateAndStability:
    def test_no_fixtures_is_trivially_optimal(self) -> None:
        snapshot = _one_pool_snapshot(())
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.optimal
        assert result.placements == ()
        assert result.stats.objective == 0

    def test_all_completed_is_trivially_optimal(self) -> None:
        p1, p2 = _players(2)
        snapshot = _one_pool_snapshot((_fixture(1, p1, p2, completed=True),))
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.optimal
        assert result.placements == ()

    def test_previous_plan_is_kept_when_still_tier_optimal(self) -> None:
        """Feed a solve's own optimal output back as previous_plan: the
        stability tier must reproduce it exactly — the board does not churn
        cosmetically between identical worlds."""
        # A generous cap, deliberately larger than CAP: the stability claim is
        # only meaningful against a *proven* optimum, and a loaded CI runner can
        # hit a short cap mid-proof and honestly answer `feasible` (seen on
        # GitHub Actions). The instance solves in milliseconds when unloaded.
        snapshot = _random_snapshot(seed=3)
        first = solve(snapshot, time_cap_s=30.0)
        assert first.verdict is Verdict.optimal
        replay = dataclasses.replace(
            snapshot,
            previous_plan=tuple(
                PreviousPlacement(p.fixture_id, p.table_id, p.start_min)
                for p in first.placements
            ),
        )
        second = solve(replay, time_cap_s=30.0)
        assert second.verdict is Verdict.optimal
        assert second.placements == first.placements

    def test_solver_reports_wall_time(self) -> None:
        snapshot = _random_snapshot(seed=0, n_fixtures=4)
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict in SOLVED
        assert result.stats.wall_time_ms >= 0
        assert result.stats.objective is not None


class TestIncoherentSnapshots:
    def test_in_progress_match_without_its_fixture_raises(self) -> None:
        snapshot = _one_pool_snapshot(
            (),
            in_progress=(InProgressMatch(FixtureId("ghost"), TableId("T1"), 0),),
        )
        with pytest.raises(IncoherentSnapshot):
            solve(snapshot, time_cap_s=CAP)

    def test_fixture_with_unknown_pool_raises(self) -> None:
        p1, p2 = _players(2)
        snapshot = _one_pool_snapshot((_fixture(1, p1, p2, pool="ghost"),))
        with pytest.raises(IncoherentSnapshot):
            solve(snapshot, time_cap_s=CAP)

    def test_fixture_against_oneself_raises(self) -> None:
        (p1,) = _players(1)
        snapshot = _one_pool_snapshot((_fixture(1, p1, p1),))
        with pytest.raises(IncoherentSnapshot):
            solve(snapshot, time_cap_s=CAP)

    def test_placed_fixture_shape_is_frozen(self) -> None:
        placement = PlacedFixture(FixtureId("F1"), TableId("T1"), 0, 25)
        with pytest.raises(dataclasses.FrozenInstanceError):
            placement.start_min = 5  # type: ignore[misc]
