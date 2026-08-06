"""Unit tests for the pure schedule-preview snapshot builder
(``app.schedule_preview.build_preview_snapshot``).

The builder synthesizes a **synthetic field** and a ``ScheduleSnapshot`` from a
loaded tournament's config, persisting nothing (ADR "a schedule preview is a
non-persistent solve over a synthetic field"). These tests prove:

* a round-robin event with a cap of ``N`` yields ``N`` disjoint synthetic
  entrants and exactly the round-robin fixture set (``C(N, 2)`` in one pool);
* the field is disjoint across events (no synthetic player is in two events);
* a per-event count override changes the field size and the fixture count;
* every non-round-robin draw type (today: single-elim) is refused loud with
  the unsupported-draw domain error and produces no partial snapshot;
* no ``TournamentEntry`` / ``TournamentFixture`` row is ever created;
* the snapshot is coherent enough for the real solver to place.
"""

import re
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from itertools import combinations
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import scheduling
from app.draws import DegenerateDraw, UnsupportedDrawType
from app.models import (
    League,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.tournament import DrawType, EventFormat
from app.schedule_preview import DEFAULT_UNCAPPED_FIELD, build_preview_snapshot
from tests._helpers import (
    event_draw_settings,
    make_user,
    venue_tables,
    with_table_aliases,
)

# A venue with two tables, so a pool can be given one or both. Built per tournament,
# never as a module constant: a catalogue is ``tournament_tables`` rows now
# (ADR 20260801), and rows belong to one tournament and one session. The pools below
# name them by the positional ``t1``/``t2`` aliases ``with_table_aliases`` resolves.
TABLE_CATALOGUE = (("Table 1", "A"), ("Table 2", "A"))


def _one_pool(table_ids: list[str]) -> dict[str, object]:
    """A single pool over ``table_ids`` — one pool keeps the round-robin fixture
    count exactly ``C(N, 2)`` so a test can assert it precisely."""
    return {
        "name": "Pool A",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "table_ids": table_ids,
    }


async def _make_tournament(
    db: AsyncSession, *, owner: User, league: League
) -> Tournament:
    tournament = Tournament(
        name="Preview Open 2026",
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(*TABLE_CATALOGUE),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.draft,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def _add_event(
    db: AsyncSession,
    tournament: Tournament,
    *,
    draw_type: DrawType = DrawType.round_robin,
    qualifiers_per_pool: int | None = None,
    rounds: int | None = None,
    max_players: int | None = 6,
    pools: list[dict[str, object]] | None = None,
    length_games: int = 5,
    name: str = "Open Singles",
    timezone: str = "America/Los_Angeles",
) -> TournamentEvent:
    event = TournamentEvent(
        tournament_id=tournament.id,
        name=name,
        format=EventFormat.singles,
        draw_settings=event_draw_settings(
            draw_type, qualifiers_per_pool=qualifiers_per_pool, rounds=rounds
        ),
        max_players=max_players,
        entry_fee=Decimal("0"),
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": length_games},
        predicates=[],
        pools=with_table_aliases(
            tournament, [_one_pool(["t1"])] if pools is None else pools
        ),
        timezone=timezone,
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


async def _load(db: AsyncSession, tournament_id: uuid.UUID) -> Tournament:
    """Reload the tournament with its events eagerly attached — the builder reads
    ``tournament.events`` and issues no query of its own, so async lazy-loading
    must not be relied on."""
    return (
        await db.execute(
            select(Tournament)
            .where(Tournament.id == tournament_id)
            .options(selectinload(Tournament.events))
        )
    ).scalar_one()


def _players(snapshot: scheduling.ScheduleSnapshot) -> set[str]:
    return {
        p
        for fixture in snapshot.fixtures
        for p in (fixture.player_a_id, fixture.player_b_id)
    }


async def test_preview_snapshot_round_robin_synthesizes_full_draw(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "prev-rr")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=6)
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    # Six disjoint synthetic players, and exactly the round-robin fixture set:
    # C(6, 2) = 15 pairings in the single pool, every pair meeting once.
    players = _players(preview.snapshot)
    assert len(players) == 6
    assert len(preview.snapshot.fixtures) == len(list(combinations(range(6), 2))) == 15
    pairings = {
        frozenset((f.player_a_id, f.player_b_id)) for f in preview.snapshot.fixtures
    }
    assert len(pairings) == 15  # no pairing repeats

    # The synthetic entrants are projected as ``placeholder-N`` (N the global
    # ordinal 1..N) — the client-facing spelling the web client strips to render
    # "Placeholder N", NOT the raw UUID of the underlying entry id.
    assert players == {f"placeholder-{n}" for n in range(1, 7)}
    # Discriminating: every projected player id is ``placeholder-<int>`` (never a
    # UUID string), and a match's two sides differ.
    assert all(re.fullmatch(r"placeholder-\d+", p) for p in players)
    for f in preview.snapshot.fixtures:
        assert f.player_a_id != f.player_b_id

    # The per-event summary carries the count used.
    assert len(preview.field_summaries) == 1
    summary = preview.field_summaries[0]
    assert summary.field_size == 6
    assert summary.event_id == scheduling.EventId(str(loaded.events[0].id))
    # Nothing was left out: a round-robin has no knockout stage, so the honest-notes
    # strip downstream has no missing-stage caveat to write.
    assert summary.knockout_fixtures == 0


async def test_preview_snapshot_base_is_the_earliest_window_start(
    db_session: AsyncSession, default_league: League
) -> None:
    """The builder returns the wall-clock ``base`` its minute frame is offset from —
    the earliest pool window start across every event — so the enqueue verb reads it
    off the snapshot instead of re-walking the pools. Two pools with different starts
    pin that it is the *earliest*, and an event's own pool slots (not the event slot)
    anchor it — as a **timezone-aware instant** in the event's venue zone."""
    owner = await make_user(db_session, "prev-base")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        timezone="America/Los_Angeles",
        pools=[
            {
                "name": "Pool A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
                "table_ids": ["t1"],
            },
            {
                "name": "Pool B",
                "slot": {"date": "2026-06-13", "start": "08:15", "end": "18:00"},
                "table_ids": ["t2"],
            },
        ],
    )
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    # Aware: the earliest window start (08:15) anchored to the event's venue zone,
    # not a naive wall-clock — so the frame lives on the same instant axis as the
    # real solve and ``estimated_finish`` downstream is aware.
    assert preview.base == datetime(
        2026, 6, 13, 8, 15, tzinfo=ZoneInfo("America/Los_Angeles")
    )
    assert preview.base is not None
    assert preview.base.tzinfo is not None


async def test_preview_snapshot_places_events_from_two_timezones_on_one_axis(
    db_session: AsyncSession, default_league: League
) -> None:
    """Two events in **different venue timezones**, both nominally opening at 09:00
    local, must land on ONE instant axis (the gap #1152 closes). New York 09:00
    (13:00Z) precedes Los Angeles 09:00 (16:00Z) by 180 minutes, so ``base`` is the
    NY instant and the LA pool's window opens 180 minutes into the minute frame. A
    naive builder that ignored the zones would open both windows at offset 0 — this
    assertion is red against it."""
    owner = await make_user(db_session, "prev-multitz")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        name="East",
        timezone="America/New_York",
        pools=[_one_pool(["t1"])],
    )
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        name="West",
        timezone="America/Los_Angeles",
        pools=[_one_pool(["t2"])],
    )
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    # ``base`` is the earliest instant — New York's 09:00, not Los Angeles's.
    assert preview.base == datetime(
        2026, 6, 13, 9, 0, tzinfo=ZoneInfo("America/New_York")
    )
    # The two pools' window starts on the shared frame: NY at offset 0, LA at +180.
    starts = sorted(pool.window.start_min for pool in preview.snapshot.pools)
    assert starts == [0, 180]


async def test_preview_snapshot_past_dated_window_reports_past_window(
    db_session: AsyncSession, default_league: League
) -> None:
    """A pool dated in the **past** relative to the injected ``now`` (the stale
    "today"-default-gone-a-day-old case, #1101) previews **infeasible with a
    ``PastWindow`` reason** — exactly what the live pre-solve reports. The builder
    stamps a real ``now_min`` (``now``'s offset from the frame origin), so a window
    wholly behind ``now`` trips the solver's past-window guard; the old hardcoded
    ``now_min = 0`` could never reach that arm and falsely previewed feasible."""
    owner = await make_user(db_session, "prev-past")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # Window is 2026-06-13 09:00–18:00 America/Los_Angeles (ends 2026-06-14 01:00Z).
    await _add_event(
        db_session, tournament, max_players=4, pools=[_one_pool(["t1", "t2"])]
    )
    loaded = await _load(db_session, tournament.id)

    # A week after the window has closed: the whole day is in the past.
    now = datetime(2026, 6, 20, tzinfo=UTC)
    preview = build_preview_snapshot(loaded, now=now)

    # ``now_min`` is a real, large positive offset (not the old hardcoded 0), past
    # every window end — so the guard fires.
    assert preview.snapshot.now_min > 0
    window_end = max(pool.window.end_min for pool in preview.snapshot.pools)
    assert preview.snapshot.now_min > window_end

    result = scheduling.solve(preview.snapshot, time_cap_s=5.0)
    assert result.verdict is scheduling.Verdict.infeasible
    assert any(isinstance(r, scheduling.PastWindow) for r in result.reasons)


async def test_preview_snapshot_future_dated_window_clips_now_min_and_stays_feasible(
    db_session: AsyncSession, default_league: League
) -> None:
    """A future-dated tournament (``now`` **before** the earliest window) clips
    ``now_min`` to 0 and previews **feasible**, exactly as before this fix — the
    happy path is untouched. The day still schedules from its first window, so no
    past-window guard fires and every synthetic fixture is placed."""
    owner = await make_user(db_session, "prev-future")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        pools=[_one_pool(["t1", "t2"])],
        length_games=1,
    )
    loaded = await _load(db_session, tournament.id)

    # Two weeks before the earliest window opens: the frame hasn't started yet.
    now = datetime(2026, 6, 1, tzinfo=UTC)
    preview = build_preview_snapshot(loaded, now=now)

    # Clipped to 0 (a raw offset would be negative), so the day is free to schedule
    # from its first window — no regression to the happy path.
    assert preview.snapshot.now_min == 0

    result = scheduling.solve(preview.snapshot, time_cap_s=5.0)
    assert result.verdict in (scheduling.Verdict.optimal, scheduling.Verdict.feasible)
    assert len(result.placements) == 6  # C(4, 2), all placed
    assert not any(isinstance(r, scheduling.PastWindow) for r in result.reasons)


async def test_preview_snapshot_base_is_none_without_any_pool_window(
    db_session: AsyncSession, default_league: League
) -> None:
    """With no event (so no pool window to anchor on) the builder reports ``base``
    as ``None`` — the signal a caller uses to report a duration in minutes but no
    wall-clock finish."""
    owner = await make_user(db_session, "prev-nobase")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    assert preview.base is None
    assert preview.snapshot.fixtures == ()


async def test_preview_snapshot_uncapped_event_uses_default_field(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "prev-uncapped")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # NULL cap (ADR-0935: no cap) — the builder falls back to the default field.
    await _add_event(
        db_session, tournament, max_players=None, pools=[_one_pool(["t1"])]
    )
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    assert preview.field_summaries[0].field_size == DEFAULT_UNCAPPED_FIELD
    assert len(_players(preview.snapshot)) == DEFAULT_UNCAPPED_FIELD


async def test_preview_snapshot_fields_are_disjoint_across_events(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "prev-disjoint")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=6, name="Event A")
    await _add_event(db_session, tournament, max_players=4, name="Event B")
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    by_event: dict[str, set[str]] = {}
    for fixture in preview.snapshot.fixtures:
        by_event.setdefault(fixture.event_id, set()).update(
            (fixture.player_a_id, fixture.player_b_id)
        )
    assert len(by_event) == 2
    event_a, event_b = by_event.values()
    # No synthetic player is ever seated in two events.
    assert event_a.isdisjoint(event_b)
    # Two events' fields are 6 + 4 = 10 globally-unique players.
    assert len(event_a | event_b) == 10


async def test_preview_snapshot_count_override_resizes_field(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "prev-override")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_event(db_session, tournament, max_players=6)
    loaded = await _load(db_session, tournament.id)

    # Override the cap of 6 down to 4: field size and fixture count both follow
    # the override, not the cap.
    preview = build_preview_snapshot(loaded, count_overrides={event.id: 4})

    assert preview.field_summaries[0].field_size == 4
    assert len(_players(preview.snapshot)) == 4
    assert len(preview.snapshot.fixtures) == 6  # C(4, 2)


@pytest.mark.parametrize(
    "draw_type",
    # The two POOL-LESS draw types, which is the whole criterion: both *can* be cut,
    # but the CP-SAT table scheduler is pool-based and a draw with no pools has no
    # windows to solve over, so the preview refuses them rather than invent a grid.
    # Single-elim is the bracket (#785); swiss ranks one field in one table (ADR "swiss
    # pre-cuts every round and pairs each one on advance"). ``rr-then-ko`` is
    # deliberately NOT here: it has a pool stage that schedules perfectly well, so it
    # is previewed in part rather than refused (see the two tests below).
    [DrawType.single_elim, DrawType.swiss],
)
async def test_preview_snapshot_unsupported_draw_raises(
    db_session: AsyncSession, default_league: League, draw_type: DrawType
) -> None:
    owner = await make_user(db_session, f"prev-unsup-{draw_type.value}")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(
        db_session,
        tournament,
        draw_type=draw_type,
        # Swiss requires a round count on its settings arm; single-elim carries no
        # setting at all. The refusal is about neither — it is about the pools these
        # draw types do not have.
        rounds=3 if draw_type is DrawType.swiss else None,
        max_players=8,
    )
    loaded = await _load(db_session, tournament.id)

    with pytest.raises(UnsupportedDrawType):
        build_preview_snapshot(loaded)


async def test_preview_snapshot_previews_an_rr_then_ko_events_pool_stage_only(
    db_session: AsyncSession, default_league: League
) -> None:
    """An ``rr-then-ko`` event is previewed, and what is previewed is its **pools**.

    The knockout fixtures the cut emits alongside them (``pool_id IS NULL``) are
    dropped: the solver places a fixture into its pool's window on its pool's tables,
    and a bracket has neither. Scheduling it is #1228 — a freshly cut bracket is
    entirely TBD-sided, so it is placeable only incrementally, as the pools resolve.

    Six synthetic entrants in one pool, so the pool stage is C(6, 2) = 15 pairings and
    the bracket for the top 2 would add 1 more fixture on top. The count is what
    discriminates: a builder that passed the un-pooled fixtures through would answer 16
    here and then trip ``_schedule_fixture``'s pool assertion.
    """
    owner = await make_user(db_session, "prev-rrko")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(
        db_session,
        tournament,
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_pool=2,
        max_players=6,
    )
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    assert len(preview.snapshot.fixtures) == 15
    # The solver's key is still ``{event}:{pool}`` (see
    # ``app.schedule_preview.preview_pool_key`` for why the namespace stayed once the
    # pool ids became globally unique uuids); the pool half is looked up, not spelled.
    (pool,) = loaded.events[0].pools
    assert {f.pool_id for f in preview.snapshot.fixtures} == {
        scheduling.PoolId(f"{loaded.events[0].id}:{pool.id}")
    }
    assert preview.field_summaries[0].field_size == 6
    # What was dropped is *counted*, not silently discarded: the top 2 of the single
    # pool make a 2-slot bracket, so one knockout fixture was left out. This is the
    # fact the honest-notes strip turns into "the knockout stage is not scheduled" —
    # a builder that dropped the bracket without counting it would report 0 here and
    # leave the director reading a partial schedule with nothing to say so.
    assert preview.field_summaries[0].knockout_fixtures == 1


async def test_an_rr_then_ko_event_does_not_abort_the_tournaments_whole_preview(
    db_session: AsyncSession, default_league: League
) -> None:
    """The reason it is skipped rather than refused.

    This builder runs a **per-event loop inside a whole-tournament build**, so a
    refusal is not scoped to the event that raised it — it takes the preview of every
    event beside it. A director previewing a day that happens to contain one
    pools-then-knockout event would get no schedule at all, including for their plain
    round-robin events. The round-robin event's own 15 fixtures are asserted present,
    which is the claim a bare "it did not raise" would miss.
    """
    owner = await make_user(db_session, "prev-rrko-beside")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, name="Open Singles", max_players=6)
    await _add_event(
        db_session,
        tournament,
        name="Second Singles",
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_pool=2,
        max_players=6,
        pools=[_one_pool(["t2"])],
    )
    loaded = await _load(db_session, tournament.id)

    preview = build_preview_snapshot(loaded)

    by_event: dict[str, int] = {}
    for fixture in preview.snapshot.fixtures:
        by_event[fixture.event_id] = by_event.get(fixture.event_id, 0) + 1
    assert by_event == {
        scheduling.EventId(str(event.id)): 15 for event in loaded.events
    }


async def test_preview_snapshot_event_without_pools_refuses(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "prev-nopools")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, pools=[])
    loaded = await _load(db_session, tournament.id)

    # No pools to schedule against: the round-robin strategy refuses an empty
    # pool set — a clear domain error, never a partial snapshot.
    with pytest.raises(DegenerateDraw):
        build_preview_snapshot(loaded)


async def test_preview_snapshot_creates_no_entry_or_fixture_rows(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "prev-norows")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=6)
    loaded = await _load(db_session, tournament.id)

    build_preview_snapshot(loaded)

    # The whole point of a preview: it persists nothing. No synthetic entrant is
    # a users.id, and no fixture row is written.
    entries = (
        await db_session.execute(select(func.count()).select_from(TournamentEntry))
    ).scalar_one()
    fixtures = (
        await db_session.execute(select(func.count()).select_from(TournamentFixture))
    ).scalar_one()
    assert entries == 0
    assert fixtures == 0


async def test_preview_snapshot_is_solver_ready(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "prev-solve")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # A comfortable instance: 4 players (C(4,2)=6 short matches) over two tables
    # and a nine-hour window solves cleanly.
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        pools=[_one_pool(["t1", "t2"])],
        length_games=1,
    )
    loaded = await _load(db_session, tournament.id)

    # ``now`` before the 2026-06-13 window opens, so ``now_min`` clips to 0 and the
    # day is judged as still-upcoming (not a past-dated infeasibility) — pinned so
    # the feasibility assertion doesn't rot as real time passes the fixture date.
    now = datetime(2026, 6, 13, 6, tzinfo=UTC)
    preview = build_preview_snapshot(loaded, now=now)
    result = scheduling.solve(preview.snapshot, time_cap_s=5.0)

    # The synthetic snapshot is coherent (no IncoherentSnapshot) and feasible:
    # every synthetic fixture is placed.
    assert result.verdict in (scheduling.Verdict.optimal, scheduling.Verdict.feasible)
    assert len(result.placements) == 6
