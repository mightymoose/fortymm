"""Unit tests for the pure CP-SAT scheduling domain (``app.scheduling``, ADR
"the schedule is solved; the call is pinned").

No database, no app — every test builds its snapshot from literals, which is
the point of keeping the solver pure. The property-flavored tests use small
seeded random instances (a few dozen fixtures at most) under a 2-second time
cap so the suite stays fast and deterministic.
"""

import dataclasses
import random
from typing import Any

import pytest
from ortools.sat.python import cp_model

from app.scheduling import (
    BUCKET_MIN,
    REST_MIN,
    EventId,
    EventSettings,
    FixtureId,
    IncoherentSnapshot,
    InfeasibilityReason,
    InProgressMatch,
    MatchLength,
    NoSingleCause,
    Pin,
    PlacedFixture,
    PlayerId,
    PoolHasNoTables,
    PoolId,
    PoolOverCapacity,
    PreviousPlacement,
    RestShadow,
    ScheduleFixture,
    SchedulePool,
    ScheduleSnapshot,
    SolveResult,
    TableId,
    Verdict,
    Window,
    WindowTooShortForMatch,
    _build_model,
    _chosen_table,
    _SolverModel,
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
    rest_shadows: tuple[RestShadow, ...] = (),
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
        rest_shadows=rest_shadows,
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
            # A called match holds its table as a hard constant; its start can
            # slide later but never earlier than promised. Windows do not apply.
            assert placement.table_id == fixture.pin.table_id
            assert placement.start_min >= fixture.pin.start_min
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

    # A rest shadow is a just-completed match that ended at ``completed_at_min``
    # and occupies no table — a zero-length player interval, so the shared rest-
    # floor check below forces that player's next match to start ≥ end + rest.
    for shadow in snapshot.rest_shadows:
        by_player.setdefault(shadow.player_id, []).append(
            (shadow.completed_at_min, shadow.completed_at_min)
        )

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
        """THE invariant, post-ADR "a called match holds its table and slides
        later": across re-solves with mutated unpinned inputs — added and
        removed fixtures, junk previous plans, shrunk capacity elsewhere, and a
        later clock — a called match's *table* is byte-identical and its *start*
        never precedes the promise. (The stronger "start is byte-identical too"
        no longer holds: a called match's start is now a variable that can slide
        later under contention; the no-drift-when-uncontended case is proven
        exactly, against a proven optimum, in
        ``TestCalledMatchesSlideNotBreak``.)"""
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
                assert placed[fixture_id].start_min >= promise.start_min

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


class TestCalledMatchesSlideNotBreak:
    """A called match holds its *table* as a hard constant but its *start* is a
    variable that can only be pushed later (ADR "a called match holds its table
    and slides later", #1141). The promise contradictions that used to make a
    day INFEASIBLE — a called match under an in-progress overrun, two called
    matches promised the same table at overlapping times — now auto-resolve by
    sliding one later on the same table. Each test here goes red before that
    change: the old fully-rigid pin overlapped a fixed interval and the solve
    answered INFEASIBLE."""

    def test_called_match_slides_behind_an_overrunning_predecessor(self) -> None:
        """The motivating bug: a match ahead of a called one on the *same*
        shared table overruns its estimate, so the called match's promised slot
        overlaps the still-busy court. Old model (pin a rigid constant): the two
        fixed intervals overlap on the table -> INFEASIBLE, the whole board
        frozen. New model: the called match slides later on the *same* table,
        just past the occupancy, and the day is feasible.

        Proves: overrun predecessor behind a same-table pin -> feasible/optimal
        with the called fixture slid later ON THE SAME TABLE."""
        p1, p2, p3, p4 = _players(4)
        # F1 started at 0 (a 25-minute best-of-3) but now is 60 — 35 minutes
        # over. Its occupancy blocks T1 through max(0 + 25, 60 + 5) = 65. F2 is
        # called to that same T1 at 30, which overlaps [0, 65). It must slide.
        fixtures = (
            _fixture(1, p1, p2),
            _fixture(2, p3, p4, pin=Pin(TableId("T1"), 30)),
        )
        snapshot = _one_pool_snapshot(
            fixtures,
            tables=1,
            now_min=60,
            in_progress=(InProgressMatch(FixtureId("F1"), TableId("T1"), 0),),
        )
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)
        called = {p.fixture_id: p for p in result.placements}[FixtureId("F2")]
        assert called.table_id == TableId("T1")  # never a different court
        # Slid just past the overrunning occupancy end (65), off-grid-friendly.
        assert called.start_min == 65

    def test_uncontended_called_match_holds_its_off_grid_start_exactly(
        self,
    ) -> None:
        """With no contention the slide bottoms out at the promised floor: the
        solved start equals ``pin.start_min`` exactly, with zero drift. The
        promised time is deliberately *off* the 5-minute grid to prove the
        start is not snapped (snapping would both drift and over-delay).

        Proves: no contention -> solved start == pin.start_min exactly, off
        grid, no grid-snap and no drift."""
        p1, p2 = _players(2)
        off_grid = 63  # not a multiple of BUCKET_MIN
        assert off_grid % BUCKET_MIN != 0
        snapshot = _one_pool_snapshot(
            (_fixture(1, p1, p2, pin=Pin(TableId("T1"), off_grid)),),
        )
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict in SOLVED
        placed = {p.fixture_id: p for p in result.placements}[FixtureId("F1")]
        assert placed.table_id == TableId("T1")
        assert placed.start_min == off_grid  # no snap, no drift
        assert placed.end_min == off_grid + match_minutes(3)

    def test_called_matchs_table_is_invariant_across_a_resolve(self) -> None:
        """The one-line rule: a called match may be pushed later on a re-solve
        but never moved to a different table. Solve twice — once uncontended,
        once with an overrun on the pinned table that forces a slide — and the
        table is identical both times even as the start moves.

        Proves: a called fixture's ``table_id`` is invariant across a re-solve."""
        p1, p2, p3, p4 = _players(4)
        pin = Pin(TableId("T2"), 100)
        base = _one_pool_snapshot(
            (_fixture(1, p1, p2, pin=pin), _fixture(2, p3, p4)),
            tables=3,
        )
        first = solve(base, time_cap_s=CAP)
        assert first.verdict in SOLVED
        first_called = {p.fixture_id: p for p in first.placements}[FixtureId("F1")]
        assert first_called.table_id == TableId("T2")
        assert first_called.start_min == 100  # uncontended: at the floor

        # Re-solve with an overrun on T2 that overlaps the promise, forcing a
        # slide — but never a table change.
        contended = dataclasses.replace(
            base,
            now_min=110,
            in_progress=(InProgressMatch(FixtureId("F2"), TableId("T2"), 100),),
        )
        # F2 becomes the running match; drop its unpinned duplicate placement by
        # keeping it as the in-progress fixture (already in `fixtures`).
        second = solve(contended, time_cap_s=CAP)
        assert second.verdict in SOLVED
        second_called = {p.fixture_id: p for p in second.placements}[FixtureId("F1")]
        assert second_called.table_id == TableId("T2")  # table never varies
        assert second_called.start_min > 100  # but the start slid later

    def test_two_called_matches_same_table_overlap_resolves_by_sliding(
        self,
    ) -> None:
        """Two promises to the same table at overlapping times. Old model: two
        rigid fixed intervals overlap on T1 -> INFEASIBLE. New model: one holds
        its floor and the other slides just past it — feasible, both still on
        T1, non-overlapping.

        Proves: two called fixtures promised the same table at overlapping times
        resolve to one sliding later (feasible), not INFEASIBLE."""
        p1, p2, p3, p4 = _players(4)
        fixtures = (
            _fixture(1, p1, p2, pin=Pin(TableId("T1"), 0)),  # [0, 25)
            _fixture(2, p3, p4, pin=Pin(TableId("T1"), 10)),  # promised [10, 35)
        )
        snapshot = _one_pool_snapshot(fixtures, tables=1)
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)
        placed = {p.fixture_id: p for p in result.placements}
        assert placed[FixtureId("F1")].table_id == TableId("T1")
        assert placed[FixtureId("F2")].table_id == TableId("T1")
        # F1 holds its 0 floor; F2 slides from 10 to just past F1's end (25).
        starts = sorted(p.start_min for p in result.placements)
        assert starts == [0, 25]


def _reasons_by_kind(
    result: SolveResult,
) -> dict[str, list[InfeasibilityReason]]:
    by_kind: dict[str, list[InfeasibilityReason]] = {}
    for reason in result.reasons:
        by_kind.setdefault(reason.kind, []).append(reason)
    return by_kind


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
        assert result.reasons == (
            WindowTooShortForMatch(
                pool_id=PoolId("A"),
                fixture_id=FixtureId("F1"),
                needed_min=25,
                window_span_min=20,
            ),
        )

    def test_pool_over_capacity_is_reported_without_the_solver(self) -> None:
        """Three back-to-back-impossible matches on one table in a 60-minute
        window: aggregate demand (75) exceeds table-minutes (60), so the
        pigeonhole guard proves it infeasible — no CP-SAT run, and it blames the
        pool by id with the raw minute arithmetic."""
        players = _players(6)
        fixtures = tuple(
            _fixture(n, players[2 * (n - 1)], players[2 * n - 1]) for n in (1, 2, 3)
        )
        snapshot = _one_pool_snapshot(fixtures, tables=1, window=(0, 60))
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.infeasible
        assert result.placements == ()
        assert result.reasons == (
            PoolOverCapacity(
                pool_id=PoolId("A"),
                required_min=75,  # 3 * 25
                capacity_min=60,  # 60-minute window * 1 table
                table_count=1,
            ),
        )

    def test_over_capacity_excludes_pinned_fixtures(self) -> None:
        """Capacity is scoped to *unpinned* demand only: a pin is not constrained
        to its pool's tables or window (ADR-0790), so it must not be summed into
        the pigeonhole bound. Here the lone unpinned fixture fits the window on
        its own (25 <= 45), so the pool is never reported as over capacity even
        though pinned + unpinned would exceed it. This is the completeness
        trade-off: with a single shared table the pin's occupancy genuinely does
        leave no room, so CP-SAT proves it infeasible and it surfaces as the
        honest NoSingleCause residual, never a false PoolOverCapacity."""
        p1, p2, p3, p4 = _players(4)
        fixtures = (
            _fixture(1, p1, p2, pin=Pin(TableId("T1"), 0)),  # 25 min pinned [0,25]
            _fixture(2, p3, p4),  # 25 min unpinned
        )
        # One table, a 45-minute window. Unpinned alone (25) fits 45, so no
        # PoolOverCapacity — but with the pin holding T1 for [0,25] the unpinned
        # 25-min match can't also fit before 45, so CP-SAT proves infeasibility.
        snapshot = _one_pool_snapshot(fixtures, tables=1, window=(0, 45))
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.infeasible
        by_kind = _reasons_by_kind(result)
        assert "pool_over_capacity" not in by_kind
        assert result.reasons == (NoSingleCause(required_min=50, available_min=45),)

    def test_no_tables_pool_with_only_a_pinned_fixture_is_not_flagged(self) -> None:
        """Regression: a pool with no tables whose only fixture is *pinned* to a
        catalogue table owned by another pool (a supported off-pool director
        placement, ADR-0790) must not fire PoolHasNoTables — that arm is about a
        pool's *unpinned* fixtures having nowhere to go, and this pool has none.
        The pinned fixture is honored on its table and the day solves."""
        p1, p2, p3, p4 = _players(4)
        catalogue = _tables(1)  # T1 belongs to pool B; pool A owns no tables
        snapshot = ScheduleSnapshot(
            table_ids=catalogue,
            pools=(
                SchedulePool(PoolId("A"), (), Window(0, 480)),  # no tables
                SchedulePool(PoolId("B"), catalogue, Window(0, 480)),
            ),
            events=(EventSettings(EventId("E1"), 3),),
            fixtures=(
                # F1 lives in the no-tables pool A but is pinned onto T1 (pool B's
                # table) — an off-pool placement the director is allowed to make.
                _fixture(1, p1, p2, pool="A", pin=Pin(TableId("T1"), 0)),
                _fixture(2, p3, p4, pool="B"),  # unpinned, plenty of room
            ),
            now_min=0,
        )
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict in SOLVED
        by_kind = _reasons_by_kind(result)
        assert "pool_has_no_tables" not in by_kind
        assert result.reasons == ()

    def test_off_pool_pin_does_not_push_a_pool_over_capacity(self) -> None:
        """Regression: a pool owning one table with a comfortable window and a
        single unpinned fixture that fits (25 <= 60) must not be reported over
        capacity just because it *also* owns a fixture pinned to an outside table
        whose duration would overflow the window if naively summed in
        (25 + 45 = 70 > 60). Pins are not bound to the pool's tables/window, so
        only the unpinned demand counts — and it fits, so the day solves."""
        p1, p2, p3, p4 = _players(4)
        catalogue = _tables(2)  # T1 is pool A's; T2 is the outside table
        snapshot = ScheduleSnapshot(
            table_ids=catalogue,
            pools=(SchedulePool(PoolId("A"), (TableId("T1"),), Window(0, 60)),),
            events=(EventSettings(EventId("E1"), 3),),
            fixtures=(
                _fixture(1, p1, p2, pool="A"),  # 25 min unpinned, fits T1 in [0,60]
                # F2 is pool A's but pinned onto T2 (outside A's tables); 45 min.
                _fixture(2, p3, p4, pool="A", pin=Pin(TableId("T2"), 0)),
            ),
            now_min=0,
        )
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict in SOLVED
        by_kind = _reasons_by_kind(result)
        assert "pool_over_capacity" not in by_kind
        assert result.reasons == ()

    def test_tight_shared_window_is_no_single_cause(self) -> None:
        """Every certain guard passes — each match fits its window, two tables
        give room to spare, the pool is well under aggregate capacity — yet the
        two matches share a player and cannot both fit with the rest floor in the
        tight window, so CP-SAT proves it infeasible. No single structural cause
        explains that, so the residual :class:`NoSingleCause` is attached, with
        aggregate room to spare (``required_min <= available_min``)."""
        p1, p2, p3 = _players(3)
        fixtures = (_fixture(1, p1, p2), _fixture(2, p1, p3))  # share P1
        # 55-minute window, 2 tables. Each 25-min match starts by 30 (fits), and
        # 2*25=50 <= 55*2=110 (under capacity) — but P1's chain needs 25+10+25=60.
        snapshot = _one_pool_snapshot(fixtures, tables=2, window=(0, 55))
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.infeasible
        assert result.placements == ()
        assert result.reasons == (NoSingleCause(required_min=50, available_min=110),)
        (only,) = result.reasons
        assert isinstance(only, NoSingleCause)
        assert only.required_min <= only.available_min

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
        assert result.reasons == (PoolHasNoTables(pool_id=PoolId("A")),)

    def test_no_tables_dominates_over_capacity_for_the_same_pool(self) -> None:
        """A no-tables pool is trivially over capacity too (capacity 0), but the
        more specific PoolHasNoTables wins — a pool reports exactly one cause."""
        p1, p2 = _players(2)
        snapshot = ScheduleSnapshot(
            table_ids=(),
            pools=(SchedulePool(PoolId("A"), (), Window(0, 480)),),
            events=(EventSettings(EventId("E1"), 3),),
            fixtures=(_fixture(1, p1, p2),),
            now_min=0,
        )
        result = solve(snapshot, time_cap_s=CAP)
        assert result.reasons == (PoolHasNoTables(pool_id=PoolId("A")),)

    def test_all_structural_causes_are_collected_at_once(self) -> None:
        """Two independently-broken pools: one has no tables, the other is over
        capacity. Both causes are reported in a single solve (not first-fail),
        each blaming its own pool."""
        p1, p2, p3, p4 = _players(4)
        table_ids = _tables(1)  # the single table belongs to pool B only
        snapshot = ScheduleSnapshot(
            table_ids=table_ids,
            pools=(
                SchedulePool(PoolId("A"), (), Window(0, 480)),  # no tables
                SchedulePool(PoolId("B"), table_ids, Window(0, 40)),  # over cap
            ),
            events=(EventSettings(EventId("E1"), 3),),
            fixtures=(
                _fixture(1, p1, p2, pool="A"),
                _fixture(2, p3, p4, pool="B"),
                _fixture(3, p1, p3, pool="B"),  # 2 * 25 = 50 > 40 * 1
            ),
            now_min=0,
        )
        result = solve(snapshot, time_cap_s=CAP)
        assert result.verdict is Verdict.infeasible
        by_kind = _reasons_by_kind(result)
        assert by_kind["pool_has_no_tables"] == [PoolHasNoTables(pool_id=PoolId("A"))]
        assert by_kind["pool_over_capacity"] == [
            PoolOverCapacity(
                pool_id=PoolId("B"),
                required_min=50,
                capacity_min=40,
                table_count=1,
            )
        ]
        assert len(result.reasons) == 2

    def test_solvable_snapshot_carries_no_reasons(self) -> None:
        """The contract's other half: every non-infeasible verdict — here a
        comfortably solvable day — carries an empty reason tuple."""
        p1, p2, p3, p4 = _players(4)
        fixtures = (_fixture(1, p1, p2), _fixture(2, p3, p4))
        result = solve(_one_pool_snapshot(fixtures), time_cap_s=CAP)
        assert result.verdict in SOLVED
        assert result.reasons == ()

    def test_trivial_optimal_carries_no_reasons(self) -> None:
        result = solve(_one_pool_snapshot(()), time_cap_s=CAP)
        assert result.verdict is Verdict.optimal
        assert result.reasons == ()


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


class TestRestShadows:
    """The 10-minute rest floor must survive a match *ending*, not just a match
    running (#1075). A completed fixture is dropped from the model, so its
    player's rest is carried by a per-human ``RestShadow`` instead."""

    def test_shadow_delays_a_freed_players_next_match(self) -> None:
        """A human who just completed at ``C`` cannot be re-placed before
        ``C + REST_MIN`` — even onto an idle table that would otherwise take
        them at ``now``. Without the shadow this fixture starts at 0; with it
        the earliest legal grid start is exactly ``C + REST_MIN``."""
        p1, p2 = _players(2)
        # A wide-open pool: three tables, an empty day, now at 0. The only
        # thing keeping F1 off the very first slot is P1's rest shadow.
        snapshot = _one_pool_snapshot(
            (_fixture(1, p1, p2),),
            rest_shadows=(RestShadow(p1, 0),),
        )
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)
        placed = {p.fixture_id: p for p in result.placements}
        assert placed[FixtureId("F1")].start_min == REST_MIN  # == 0 + REST_MIN

    def test_shadow_anchored_in_the_past_delays_relative_to_completion(
        self,
    ) -> None:
        """The floor is measured from the completion time the shadow carries,
        not from ``now``: a match that finished 3 minutes ago still owes 7."""
        p1, p2 = _players(2)
        snapshot = _one_pool_snapshot(
            (_fixture(1, p1, p2),),
            now_min=3,
            rest_shadows=(RestShadow(p1, 0),),  # finished at 0, rest until 10
        )
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)
        placed = {p.fixture_id: p for p in result.placements}
        assert placed[FixtureId("F1")].start_min == REST_MIN  # 0 + REST_MIN, > now

    def test_lone_shadow_player_does_not_crash(self) -> None:
        """A shadow for a human who is in no active fixture is a harmless lone
        interval — per-player no-overlap only bites with more than one — so the
        solve still places the unrelated fixture normally."""
        p1, p2, ghost = _players(3)
        snapshot = _one_pool_snapshot(
            (_fixture(1, p1, p2),),
            rest_shadows=(RestShadow(ghost, 0),),
        )
        result = solve(snapshot, time_cap_s=CAP)
        _assert_hard_constraints(snapshot, result)
        placed = {p.fixture_id: p for p in result.placements}
        assert placed[FixtureId("F1")].start_min == 0  # ghost's rest binds no one

    def test_two_shadows_for_one_human_solve_feasibly(self) -> None:
        """UAT wave-2 reproduction (#1145): a single human handed *two* rest
        shadows (two completions within REST_MIN of each other) must not sink
        the whole solve. Two fixed rest intervals for one player under the
        per-player no-overlap are mutually unsatisfiable — before the coalesce
        this returned global ``infeasible`` and blanked every placement.

        The defensive dedup in the pure module keeps the latest completion, so
        the solve is feasible, the unrelated fixture still lands, and P1's own
        fixture is held to the *later* shadow's floor (``2 + REST_MIN``), not
        the earlier one's. (``_assert_hard_constraints`` is deliberately NOT
        used: its checker models each shadow as an independent floor — exactly
        the pre-fix contract this coalesce retires — so it would reject two
        shadows for one player rather than reflect the dedup.)"""
        p1, p2, p3, p4 = _players(4)
        snapshot = _one_pool_snapshot(
            (_fixture(1, p1, p2), _fixture(2, p3, p4)),
            # Two completions for P1, 2 minutes apart — both within REST_MIN.
            rest_shadows=(RestShadow(p1, 0), RestShadow(p1, 2)),
        )
        result = solve(snapshot, time_cap_s=CAP)
        # Would be Verdict.infeasible + no placements without the dedup.
        assert result.verdict in SOLVED
        placed = {p.fixture_id: p for p in result.placements}
        assert set(placed) == {FixtureId("F1"), FixtureId("F2")}
        # The surviving shadow is the *later* completion: P1's floor is
        # ``2 + REST_MIN == 12``, snapped up to the next 5-minute grid start,
        # 15 — strictly later than the earlier shadow's floor (``0 + REST_MIN``
        # → grid start 10), so this pins the coalesce to the MAX completion.
        assert placed[FixtureId("F1")].start_min == 15
        # P1-free fixture is unaffected — it takes the very first slot.
        assert placed[FixtureId("F2")].start_min == 0

    def test_issue_1075_freed_table_idles_rather_than_recalling(self) -> None:
        """#1075 shape: 5 players, 2 tables, best-of-5 (35-minute matches), a
        round-robin of fixtures, and P1 who *just* finished at ``now``. The two
        tables are used immediately — but by matches that don't involve P1. P1
        is not re-called within the rest floor; the table that just freed under
        them idles rather than calling them straight back on.

        Discriminating against the bug directly: the *same* snapshot without the
        shadow re-calls P1 at ``now`` (start 0); adding the shadow strictly
        pushes P1's first match to ``>= now + REST_MIN``. That gap is the fix."""
        p1, p2, p3, p4, p5 = _players(5)
        players = [p1, p2, p3, p4, p5]
        pairs = [(players[i], players[j]) for i in range(5) for j in range(i + 1, 5)]
        fixtures = tuple(_fixture(n, a, b) for n, (a, b) in enumerate(pairs, start=1))

        def p1_earliest(result: SolveResult) -> int:
            placed = {p.fixture_id: p for p in result.placements}
            return min(
                placed[f.id].start_min
                for f in fixtures
                if p1 in (f.player_a_id, f.player_b_id)
            )

        base = _one_pool_snapshot(fixtures, tables=2, length_games=5)
        without = solve(base, time_cap_s=CAP)
        _assert_hard_constraints(base, without)
        # The bug: with nothing carrying P1's just-finished rest, P1 is re-called
        # at now — zero rest coming out of a completed match.
        assert p1_earliest(without) == 0

        shadowed = dataclasses.replace(base, rest_shadows=(RestShadow(p1, 0),))
        result = solve(shadowed, time_cap_s=CAP)
        _assert_hard_constraints(shadowed, result)
        # The fix: P1 is held out for the full rest floor.
        assert p1_earliest(result) >= REST_MIN

        # Both tables are nonetheless busy from the first slot — the day is not
        # globally stalled, only P1 is held out — and every 0-start is P1-free.
        placed = {p.fixture_id: p for p in result.placements}
        fixtures_by_id = {f.id: f for f in fixtures}
        started_at_zero = [
            fixtures_by_id[fid] for fid, p in placed.items() if p.start_min == 0
        ]
        assert len(started_at_zero) == 2
        for fixture in started_at_zero:
            assert p1 not in (fixture.player_a_id, fixture.player_b_id)


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


def _star_chain_snapshot(
    n_fixtures: int = 4, *, tables: int = 2, with_previous: bool = True
) -> ScheduleSnapshot:
    """A *star chain*: one player (``STAR``) is in every fixture, so all matches
    are mutually exclusive in time no matter which table they land on. The
    unique optimum chains them back-to-back at ``0, step, 2·step, …`` (``step``
    = duration + rest), and the ``previous_plan`` puts that chain on the first
    table. Because every match shares ``STAR``, makespan and wait are fixed by
    the chain and the only remaining freedom — which fixture takes which slot,
    on which table — is settled by the stability tier toward the previous plan,
    making it the *unique* optimum. That uniqueness lets these tests assert an
    exact board rather than just an objective."""
    star = PlayerId("STAR")
    table_ids = _tables(tables)
    step = match_minutes(3) + REST_MIN
    fixtures = tuple(
        _fixture(n, star, PlayerId(f"Q{n}")) for n in range(1, n_fixtures + 1)
    )
    previous = tuple(
        PreviousPlacement(FixtureId(f"F{n}"), table_ids[0], (n - 1) * step)
        for n in range(1, n_fixtures + 1)
    )
    return _one_pool_snapshot(
        fixtures,
        tables=tables,
        window=(0, 600),
        previous_plan=previous if with_previous else (),
    )


def _board(solver: Any, built: _SolverModel) -> set[tuple[str, str, int]]:
    """The unpinned placements of one solved model as ``(fixture, table, start)``
    triples — comparable directly against a ``previous_plan``."""
    return {
        (
            str(fixture.id),
            str(_chosen_table(solver, built.presences[fixture.id], fixture.id)),
            int(solver.Value(built.starts[fixture.id])),
        )
        for fixture in built.unpinned
    }


def _plan_board(
    placements: tuple[PreviousPlacement, ...] | tuple[PlacedFixture, ...],
) -> set[tuple[str, str, int]]:
    return {(str(p.fixture_id), str(p.table_id), p.start_min) for p in placements}


def _solve_to_optimal(
    built: _SolverModel,
) -> tuple[int, int, set[tuple[str, str, int]]]:
    """Solve a built model to proven optimality with the production parameters,
    returning ``(status, objective, board)``. A generous cap: the optimality
    claim is only meaningful against a proven optimum (a loaded runner can
    otherwise honestly answer ``feasible`` under a short cap)."""
    solver = cp_model.CpSolver()
    solver.parameters.random_seed = 0
    solver.parameters.max_time_in_seconds = 30.0
    status = solver.Solve(built.model)
    return status, int(solver.ObjectiveValue()), _board(solver, built)


def _first_solution_board(built: _SolverModel) -> set[tuple[str, str, int]]:
    """CP-SAT's *first* feasible solution under a single deterministic worker.

    One worker plus a fixed seed makes *which* solution is discovered first
    reproducible, so the warm-start hint's effect — it seeds the search at the
    previous plan — is observable. Production ``solve`` defaults to one worker
    too, but a deployment can raise ``num_search_workers`` (``SOLVE_NUM_WORKERS``,
    #1115) — under a multi-worker portfolio, aggregate branch count and
    first-solution identity are non-deterministic (a lucky worker can presolve
    either board in zero branches), so it cannot show this; hence this test
    pins a single worker explicitly rather than relying on the default."""
    solver = cp_model.CpSolver()
    solver.parameters.random_seed = 0
    solver.parameters.num_search_workers = 1
    solver.parameters.stop_after_first_solution = True
    solver.parameters.max_time_in_seconds = CAP
    status = solver.Solve(built.model)
    assert status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    return _board(solver, built)


class TestWarmStart:
    """The solver warm-starts every unpinned fixture's prior ``(table, start)``
    as a CP-SAT hint. A hint only orders the search; it can never change which
    solution is optimal — so these tests pin down both halves: correctness is
    untouched, and the hint is genuinely consumed."""

    def test_warm_started_solve_reproduces_the_previous_plan(self) -> None:
        """The black-box claim: fed a previous plan that is the unique optimum,
        the production solve returns exactly it, optimally."""
        snapshot = _star_chain_snapshot()
        result = solve(snapshot, time_cap_s=30.0)
        assert result.verdict is Verdict.optimal
        assert _plan_board(result.placements) == _plan_board(snapshot.previous_plan)

    def test_warm_start_never_changes_the_optimum(self) -> None:
        """Correctness guard: the hint can only order the search, never change
        which board is optimal. Build the real model, solve to optimality, then
        clear the hints and solve again — identical optimal objective *and*
        identical board.

        (This deliberately does **not** compare against a ``previous_plan=()``
        snapshot: the tier weights are computed per instance from the stability
        span, which is zero without a previous plan, so the two snapshots' raw
        objectives live on different scales and are never equal. The clean,
        weight-stable invariant is hinted-vs-hint-cleared on the *same* model.)
        """
        snapshot = _star_chain_snapshot()
        built = _build_model(snapshot)
        assert isinstance(built, _SolverModel)

        hinted_status, hinted_obj, hinted_board = _solve_to_optimal(built)
        built.model.ClearHints()
        cleared_status, cleared_obj, cleared_board = _solve_to_optimal(built)

        assert hinted_status == cp_model.OPTIMAL
        assert cleared_status == cp_model.OPTIMAL
        assert hinted_obj == cleared_obj
        assert hinted_board == cleared_board == _plan_board(snapshot.previous_plan)

    def test_warm_start_hint_is_consumed(self) -> None:
        """The load-bearing proof that the hint actually drives the search —
        not merely that the board matches (the stability tier alone forces that
        even cold, so board equality does not discriminate).

        Take CP-SAT's first feasible solution under one deterministic worker:
        with the warm-start hints present it is exactly the previous plan (the
        search begins there); with the hints cleared — which is precisely what
        the code did before this change — the first solution is a different,
        stability-suboptimal board. That difference *is* the hint being
        consumed, and it is why this test goes red if the ``AddHint`` warm start
        is removed: without it the hinted branch below no longer starts at the
        previous plan, so ``first == previous`` fails."""
        snapshot = _star_chain_snapshot()
        previous = _plan_board(snapshot.previous_plan)

        built = _build_model(snapshot)
        assert isinstance(built, _SolverModel)
        # Warm-started: the search starts at — and first reports — the prior plan.
        assert _first_solution_board(built) == previous

        # Hints cleared (the pre-change behaviour): the first feasible solution
        # the same deterministic search finds is a *different* board.
        built.model.ClearHints()
        assert _first_solution_board(built) != previous
