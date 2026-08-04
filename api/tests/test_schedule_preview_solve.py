"""The transport-neutral **schedule preview** verb + its ephemeral RQ job
(``app.schedule_preview_solve``), the non-persistent solve over a synthetic field
(ADR "a schedule preview is a non-persistent solve over a synthetic field").

These tests prove the whole preview core end to end:

* the enqueue verb on a ``draft`` tournament returns a token + the immediate
  structure (field sizes + drawn fixtures) and places a job on the **preview**
  queue (never ``solver``), with a ``job_timeout`` of ``cap + margin``;
* running that job through a real RQ worker yields a :class:`PreviewResult`
  carrying the verdict, estimated duration, match/bye counts, peak concurrent
  tables, a per-event breakdown, and the always-present honest-notes strip — and
  the fetch/wait helpers read it back off Redis;
* a **non-owner** is refused (``NotTournamentOwnerError``) and a
  **live/archived** tournament is refused (``TournamentNotPreLiveError``);
* an infeasible preview resolves its reasons through the shared resolved-reason
  machinery;
* and after the job runs, the tournament has **no** new ``TournamentEntry``,
  ``TournamentFixture`` placement, or ``ScheduleSolve`` ledger row — a real
  row-count query over all three.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import fakeredis
import pytest
from rq import Queue, SimpleWorker
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import queue as queue_module
from app.models import (
    League,
    ScheduleSolve,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.tournament import DrawType, EventFormat
from app.schedule_preview_solve import (
    PREVIEW_JOB_TIMEOUT_MARGIN_S,
    RUN_SCHEDULE_PREVIEW_JOB,
    PreviewJobInputs,
    cancel_preview,
    preview_job_state,
    request_schedule_preview,
    run_schedule_preview,
    wait_for_preview,
)
from app.schemas.schedule_preview import (
    PreviewJobStatus,
    PreviewResult,
    PreviewVerdict,
)
from app.schemas.schedule_solve import (
    PastWindowReasonRead,
    PlayerOverSubscribedRead,
    WindowTooShortForMatchRead,
)
from app.tournament_errors import (
    NotTournamentOwnerError,
    TournamentNotFoundError,
    TournamentNotPreLiveError,
)
from tests._helpers import make_user, venue_tables, with_table_aliases

# Built per tournament, never as a module constant: a catalogue is
# ``tournament_tables`` rows now (ADR 20260801). The pools name them by the positional
# ``t1``/``t2`` aliases ``with_table_aliases`` resolves.
TABLE_CATALOGUE = (("Table 1", "A"), ("Table 2", "A"))


def _pool(
    table_ids: list[str], *, start: str = "09:00", end: str = "18:00"
) -> dict[str, object]:
    return {
        "name": "Pool A",
        "slot": {"date": "2026-06-13", "start": start, "end": end},
        "table_ids": table_ids,
    }


@pytest.fixture(autouse=True)
def frozen_now(monkeypatch: pytest.MonkeyPatch) -> datetime:
    """Pin the preview's wall-clock ``now`` (the enqueue verb's ``_wall_now`` source)
    to a fixed instant just *before* these tests' 2026-06-13 windows.

    The verb now threads a real ``now`` into the builder so the snapshot carries a
    real ``now_min`` (a past-dated day trips ``PastWindow``, #1101). Pinning it keeps
    every existing case deterministic and calendar-proof: with ``now`` before the
    earliest window, ``now_min`` clips to 0 exactly as a pre-live solve of a
    still-future day would, so the happy path is unchanged as real time marches past
    the hardcoded fixture dates. The past-dated test overrides this on purpose."""
    frozen = datetime(2026, 6, 13, 6, 0, tzinfo=UTC)  # 2026-06-12 23:00 PDT, pre-window
    monkeypatch.setattr("app.schedule_preview_solve._wall_now", lambda: frozen)
    return frozen


@pytest.fixture
def preview_queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """An async (record-only) RQ queue on fakeredis standing in for the real
    ``preview`` queue, so a test can inspect the enqueued job and then run it
    through a real worker."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.PREVIEW_QUEUE, connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_preview_queue", lambda: q)
    return q


async def _make_tournament(
    db: AsyncSession,
    *,
    owner: User,
    league: League,
    status: TournamentStatus = TournamentStatus.draft,
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
        status=status,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def _add_event(
    db: AsyncSession,
    tournament: Tournament,
    *,
    max_players: int | None = 4,
    pools: list[dict[str, object]] | None = None,
    length_games: int = 5,
    name: str = "Open Singles",
    timezone: str = "America/Los_Angeles",
    draw_type: DrawType = DrawType.round_robin,
    qualifiers_per_pool: int | None = None,
) -> TournamentEvent:
    event = TournamentEvent(
        tournament_id=tournament.id,
        name=name,
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(
            draw_type, qualifiers_per_pool=qualifiers_per_pool
        ),
        max_players=max_players,
        entry_fee=Decimal("0"),
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": length_games},
        predicates=[],
        pools=with_table_aliases(
            tournament, [_pool(["t1", "t2"])] if pools is None else pools
        ),
        timezone=timezone,
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


def _run_recorded_preview_job(queue: Queue) -> None:
    """Run the single job the enqueue verb recorded, through a real (in-process)
    RQ worker, so its return value is pickled into the job's Redis result exactly
    as a deployed worker would leave it. Also asserts the job's identity + routing
    before running it."""
    (job,) = queue.jobs
    assert job.func_name == RUN_SCHEDULE_PREVIEW_JOB
    assert job.origin == queue_module.PREVIEW_QUEUE
    worker = SimpleWorker([queue], connection=queue.connection)
    worker.work(burst=True)


async def _counts(db: AsyncSession, tournament_id: uuid.UUID) -> tuple[int, int, int]:
    """A real row-count query over the three tables a preview must never write:
    (entries, fixture placements, solve-ledger rows) for this tournament. Keyed by
    a plain id so it never touches an expired ORM attribute."""
    entries = (
        await db.execute(
            select(func.count())
            .select_from(TournamentEntry)
            .join(
                TournamentEvent,
                TournamentEvent.id == TournamentEntry.event_id,
            )
            .where(TournamentEvent.tournament_id == tournament_id)
        )
    ).scalar_one()
    fixtures = (
        await db.execute(
            select(func.count())
            .select_from(TournamentFixture)
            .join(
                TournamentEvent,
                TournamentEvent.id == TournamentFixture.event_id,
            )
            .where(TournamentEvent.tournament_id == tournament_id)
        )
    ).scalar_one()
    solves = (
        await db.execute(
            select(func.count())
            .select_from(ScheduleSolve)
            .where(ScheduleSolve.tournament_id == tournament_id)
        )
    ).scalar_one()
    return entries, fixtures, solves


async def test_preview_solve_enqueues_on_the_preview_queue_and_yields_a_result(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    owner = await make_user(db_session, "prev-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=4)

    enqueued = await request_schedule_preview(
        db_session, tournament_id=tournament.id, actor=owner
    )

    # The instant structure a caller renders a skeleton from: one event's field of
    # 4, and the round-robin's C(4, 2) = 6 drawn fixtures.
    assert enqueued.token
    assert [s.field_size for s in enqueued.field_summaries] == [4]
    assert len(enqueued.fixtures) == 6
    # Each drawn fixture carries its human pool label off the event's pool config.
    assert {f.pool_name for f in enqueued.fixtures} == {"Pool A"}

    # The job landed on the PREVIEW queue with the right timeout, and running it
    # yields the full PreviewResult.
    (job,) = preview_queue.jobs
    assert job.origin == queue_module.PREVIEW_QUEUE
    assert job.timeout == 5 + PREVIEW_JOB_TIMEOUT_MARGIN_S

    _run_recorded_preview_job(preview_queue)

    state = preview_job_state(enqueued.token, tournament.id)
    assert state.status is PreviewJobStatus.done
    result = state.result
    assert result is not None
    assert result.verdict in (PreviewVerdict.optimal, PreviewVerdict.feasible)
    assert result.fits is True
    assert result.estimated_duration_min is not None
    assert result.estimated_duration_min > 0
    assert result.estimated_finish is not None
    assert result.total_matches == 6
    assert result.total_byes == 0  # 4 players is even — no byes
    assert result.peak_concurrent_tables >= 1
    assert 0.0 < result.table_utilization <= 1.0
    assert [e.matches for e in result.events] == [6]
    assert result.events[0].name == "Open Singles"
    assert result.events[0].duration_min is not None
    # The honest-notes strip: always the disjoint-field caveat + the per-event
    # synthetic count.
    assert any("more than one event" in note for note in result.notes)
    assert any("Assumed 4 entrants" in note for note in result.notes)


async def test_preview_solve_finish_anchors_on_the_earliest_window_start(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    """The wall-clock finish is anchored on the builder's returned ``base`` — the
    earliest pool window start across the tournament — so ``estimated_finish`` is
    exactly ``base + estimated_duration``. Pins the value the enqueue verb now reads
    off ``PreviewSnapshot.base`` (rather than re-walking the pools), so the anchor
    can't silently drift from the minute frame the snapshot was built on."""
    owner = await make_user(db_session, "prev-finish")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # Two pools: the earliest start (08:30) is the frame origin, not the 09:00 one.
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        pools=[
            _pool(["t1"], start="09:00", end="18:00"),
            {
                "name": "Pool B",
                "slot": {"date": "2026-06-13", "start": "08:30", "end": "18:00"},
                "table_ids": ["t2"],
            },
        ],
    )

    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)
    (job,) = preview_queue.jobs
    (inputs,) = job.args
    assert isinstance(inputs, PreviewJobInputs)
    # The base handed to the job is the earliest window start, not the later pool's —
    # an aware instant in the event's venue zone.
    assert inputs.base == datetime(
        2026, 6, 13, 8, 30, tzinfo=ZoneInfo("America/Los_Angeles")
    )

    result = PreviewResult.model_validate(run_schedule_preview(inputs))
    assert result.estimated_duration_min is not None
    assert result.estimated_finish is not None
    # Identical to base + duration — the wall-clock finish the old ``_base_wall``
    # re-derivation produced, now sourced from the builder's own ``base``.
    assert result.estimated_finish == inputs.base + timedelta(
        minutes=result.estimated_duration_min
    )


async def test_preview_solve_reports_byes_for_an_odd_field(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    owner = await make_user(db_session, "prev-byes")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=5)

    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)
    (job,) = preview_queue.jobs
    (inputs,) = job.args
    assert isinstance(inputs, PreviewJobInputs)

    result = PreviewResult.model_validate(run_schedule_preview(inputs))

    # A pool of 5 (odd) casts one bye per round over 5 rounds — 5 byes total.
    assert result.total_matches == 10  # C(5, 2)
    assert result.total_byes == 5
    assert result.events[0].byes == 5


#: The two pools an rr-then-ko subject is drawn over, with distinct ids (the shared
#: ``_pool`` helper's id is fixed, and two pools of one event may not collide).
_TWO_POOLS: list[dict[str, object]] = [
    {
        "name": "Pool A",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "table_ids": ["t1"],
    },
    {
        "name": "Pool B",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "table_ids": ["t2"],
    },
]

#: The exact honest note an rr-then-ko event earns, pinned so the wording a director
#: reads cannot drift silently. Six entrants over two pools taking the top 2 each
#: gives 4 qualifiers → a 4-slot bracket → 3 knockout fixtures, none of them
#: scheduled.
_KNOCKOUT_NOTE = (
    "Only the pool stage of Championship is scheduled here: its knockout "
    "bracket (3 further matches) is played after the pools finish and is not "
    "in this estimate."
)


async def test_preview_notes_say_an_rr_then_ko_events_knockout_stage_is_not_scheduled(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    """The preview plans an rr-then-ko event's whole draw but schedules only its pool
    stage (ADR 20260727 — a freshly cut bracket is entirely TBD-sided, so it is
    placeable only incrementally as the pools resolve; that is #1228). Silently showing
    the director a schedule that covers part of their event is the failure this note
    prevents, so the strip says so in as many words.

    The tournament also holds a plain round-robin event, which is the discriminating
    part: its pools are scheduled beside the rr-then-ko event's (both events' match
    counts are asserted), and **it** earns no such note — the strip names the event
    that is actually missing a stage, not every event on the day.
    """
    owner = await make_user(db_session, "prev-rrko-note")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(
        db_session,
        tournament,
        name="Open Singles",
        max_players=4,
        pools=[_pool(["t1"])],
    )
    await _add_event(
        db_session,
        tournament,
        name="Championship",
        max_players=6,
        pools=_TWO_POOLS,
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_pool=2,
    )

    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)
    (job,) = preview_queue.jobs
    (inputs,) = job.args
    assert isinstance(inputs, PreviewJobInputs)

    result = PreviewResult.model_validate(run_schedule_preview(inputs))

    # Both events' POOL fixtures are previewed: C(4, 2) = 6 for the round-robin, and
    # 2 × C(3, 2) = 6 for the rr-then-ko event's two pools of three. Its 3 knockout
    # fixtures are not counted — they are what the note is about.
    assert {e.name: e.matches for e in result.events} == {
        "Open Singles": 6,
        "Championship": 6,
    }
    assert result.total_matches == 12

    assert _KNOCKOUT_NOTE in result.notes
    # Exactly one event is called out, and it is not the round-robin one.
    knockout_notes = [n for n in result.notes if "knockout" in n]
    assert knockout_notes == [_KNOCKOUT_NOTE]
    assert not any("Open Singles" in n for n in knockout_notes)
    # The rest of the strip is untouched — the note is an addition, not a swap.
    assert any("more than one event" in n for n in result.notes)
    assert "Assumed 6 entrants for Championship." in result.notes


async def test_a_round_robin_only_previews_notes_carry_no_knockout_caveat(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    """The other direction: a tournament with no rr-then-ko event has no stage left
    out, so its strip is exactly the two notes it always carried. Asserted as full
    equality rather than a ``"knockout" not in`` scan, because an always-on note is
    the failure mode a one-sided test would wave through."""
    owner = await make_user(db_session, "prev-rr-only-note")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, name="Open Singles", max_players=4)

    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)
    (job,) = preview_queue.jobs
    (inputs,) = job.args
    assert isinstance(inputs, PreviewJobInputs)

    result = PreviewResult.model_validate(run_schedule_preview(inputs))

    assert result.notes == [
        "This estimate assumes no player is entered in more than one event; a "
        "real multi-event field would take longer.",
        "Assumed 4 entrants for Open Singles.",
    ]


async def test_preview_solve_refuses_a_non_owner(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    owner = await make_user(db_session, "prev-owner2")
    stranger = await make_user(db_session, "prev-stranger")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament)

    with pytest.raises(NotTournamentOwnerError):
        await request_schedule_preview(
            db_session, tournament_id=tournament.id, actor=stranger
        )
    # Nothing was enqueued.
    assert preview_queue.jobs == []


@pytest.mark.parametrize("status", [TournamentStatus.live, TournamentStatus.archived])
async def test_preview_solve_refuses_a_post_live_tournament(
    db_session: AsyncSession,
    default_league: League,
    preview_queue: Queue,
    status: TournamentStatus,
) -> None:
    owner = await make_user(db_session, f"prev-{status.value}")
    tournament = await _make_tournament(
        db_session, owner=owner, league=default_league, status=status
    )
    await _add_event(db_session, tournament)

    with pytest.raises(TournamentNotPreLiveError) as excinfo:
        await request_schedule_preview(
            db_session, tournament_id=tournament.id, actor=owner
        )
    assert excinfo.value.status == status.value
    assert preview_queue.jobs == []


async def test_preview_solve_persists_nothing(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    owner = await make_user(db_session, "prev-nopersist")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=4)
    tournament_id = tournament.id

    before = await _counts(db_session, tournament_id)
    assert before == (0, 0, 0)

    enqueued = await request_schedule_preview(
        db_session, tournament_id=tournament_id, actor=owner
    )
    _run_recorded_preview_job(preview_queue)
    state = preview_job_state(enqueued.token, tournament_id)
    assert state.status is PreviewJobStatus.done

    # After the whole preview ran: still no entry, no fixture placement, no solve
    # ledger row for this tournament.
    assert await _counts(db_session, tournament_id) == (0, 0, 0)


async def test_preview_solve_targets_the_preview_queue_not_solver(
    db_session: AsyncSession,
    default_league: League,
    preview_queue: Queue,
    fake_solver_queue: Queue,
) -> None:
    owner = await make_user(db_session, "prev-routing")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament)

    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)

    (job,) = preview_queue.jobs
    assert job.origin == queue_module.PREVIEW_QUEUE
    # The real solve queue was untouched.
    assert fake_solver_queue.jobs == []


async def test_preview_solve_infeasible_resolves_its_reasons(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    owner = await make_user(db_session, "prev-infeasible")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # A ten-minute window cannot hold a best-of-5 (35 min) match — every fixture
    # trips WindowTooShortForMatch, so the day is proved infeasible.
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        length_games=5,
        pools=[_pool(["t1"], start="09:00", end="09:10")],
        name="Tight Singles",
    )

    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)
    (job,) = preview_queue.jobs
    (inputs,) = job.args
    result = PreviewResult.model_validate(run_schedule_preview(inputs))

    assert result.verdict is PreviewVerdict.infeasible
    assert result.fits is False
    assert result.estimated_duration_min is None
    assert result.estimated_finish is None
    # The matches are still counted off the instant draw even though nothing placed.
    assert result.total_matches == 6
    assert result.peak_concurrent_tables == 0
    assert result.table_utilization == 0.0
    # The reasons are humanized through the shared resolved-reason machinery: the
    # pool's display name + HH:MM window, not the namespaced solver id.
    assert result.infeasibility_reasons
    reason = result.infeasibility_reasons[0]
    assert isinstance(reason, WindowTooShortForMatchRead)
    assert reason.pool_name == "Pool A"
    assert reason.window_start == "09:00"
    assert reason.best_of == 5


async def test_preview_over_subscribed_placeholder_resolves_to_its_label(
    db_session: AsyncSession,
    default_league: League,
    preview_queue: Queue,
) -> None:
    """The one reason arm that names a *player*, on the DB-blind preview path: a
    preview's entrants are synthetic stand-ins, not humans, so the arm resolves
    straight off the id — ``placeholder-3`` → ``Placeholder 3``, the same label
    the preview surface already shows the director — with no DB read.

    Four entrants in a round-robin means every one of them plays three
    35-minute matches: 105 minutes plus two 10-minute rests is 125 minutes of one
    person's time against a 120-minute window, so all four are certainly
    over-subscribed. Two tables keep the *pool* under capacity (210 needed
    against 120 × 2 = 240), so this arm is the only one that can fire."""
    owner = await make_user(db_session, "prev-oversubscribed")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(
        db_session,
        tournament,
        max_players=4,
        length_games=5,
        pools=[_pool(["t1", "t2"], start="09:00", end="11:00")],
    )

    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)
    (job,) = preview_queue.jobs
    (inputs,) = job.args
    result = PreviewResult.model_validate(run_schedule_preview(inputs))

    assert result.verdict is PreviewVerdict.infeasible
    reasons = result.infeasibility_reasons
    assert [r.kind for r in reasons] == ["player_over_subscribed"] * 4
    assert all(isinstance(r, PlayerOverSubscribedRead) for r in reasons)
    over_subscribed = [r for r in reasons if isinstance(r, PlayerOverSubscribedRead)]
    # The synthetic ids are shown the way the preview surface shows them — never
    # the raw ``placeholder-3`` spelling.
    assert {r.player_name for r in over_subscribed} == {
        f"Placeholder {k}" for k in (1, 2, 3, 4)
    }
    first = over_subscribed[0]
    assert first.pool_name == "Pool A"
    assert first.window_start == "09:00"
    assert first.window_end == "11:00"
    assert first.match_count == 3
    assert first.required_min == 125  # 3 * 35 + 2 * REST_MIN
    assert first.window_span_min == 120


async def test_preview_solve_past_dated_window_resolves_past_window(
    db_session: AsyncSession,
    default_league: League,
    preview_queue: Queue,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A pool dated in the **past** relative to the real ``now`` (the stale
    "today"-default-gone-a-day-old case, #1101) previews **infeasible with a
    resolved ``past_window`` reason** — the same verdict + venue-local date the live
    pre-solve reports, proving the preview agrees with go-live. This exercises the
    previously-dead ``PastWindow`` arm of ``_resolve_reason``: the verb now threads a
    real ``now`` into the builder, so the snapshot's ``now_min`` sits past the window
    end and the solver's past-window guard fires (the old hardcoded ``now_min = 0``
    could never reach it, and this same day would have falsely previewed feasible)."""
    owner = await make_user(db_session, "prev-pastwindow")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # Window is 2026-06-13 09:00–18:00 America/Los_Angeles.
    await _add_event(db_session, tournament, max_players=4, length_games=1)

    # A week after the window closed: the whole day is behind ``now``.
    monkeypatch.setattr(
        "app.schedule_preview_solve._wall_now",
        lambda: datetime(2026, 6, 20, tzinfo=UTC),
    )
    await request_schedule_preview(db_session, tournament_id=tournament.id, actor=owner)
    (job,) = preview_queue.jobs
    (inputs,) = job.args
    assert isinstance(inputs, PreviewJobInputs)

    result = PreviewResult.model_validate(run_schedule_preview(inputs))

    assert result.verdict is PreviewVerdict.infeasible
    assert result.fits is False
    # Resolved to the offending pool's venue-local calendar day — the "which day to
    # move" fact, identical to what a real infeasible solve records.
    assert result.infeasibility_reasons
    reason = result.infeasibility_reasons[0]
    assert isinstance(reason, PastWindowReasonRead)
    assert reason.date == date(2026, 6, 13)


async def test_wait_for_preview_returns_the_finished_result(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    owner = await make_user(db_session, "prev-wait")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=4)

    enqueued = await request_schedule_preview(
        db_session, tournament_id=tournament.id, actor=owner
    )
    _run_recorded_preview_job(preview_queue)

    state = wait_for_preview(enqueued.token, tournament.id, timeout_s=5.0)
    assert state.status is PreviewJobStatus.done
    assert state.result is not None
    assert state.result.total_matches == 6


async def test_preview_job_state_reports_a_missing_job_as_failed(
    preview_queue: Queue,
) -> None:
    # A token Redis never knew is a ``failed`` state, not a 404 — the
    # tournament-bind check is skipped when there is no job to read it off.
    state = preview_job_state(str(uuid.uuid4()), uuid.uuid4())
    assert state.status is PreviewJobStatus.failed
    assert state.error is not None
    assert state.result is None


async def test_preview_job_state_rejects_a_token_from_another_tournament(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    """The token is bound to the tournament it was enqueued FOR: reading a real
    job's token against a *different* tournament id raises the not-found error (→
    404), so one owner cannot poll another director's preview by pairing their own
    tournament id with the victim's token. Same bind ``cancel_preview`` enforces."""
    owner = await make_user(db_session, "prev-bind")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=4)

    enqueued = await request_schedule_preview(
        db_session, tournament_id=tournament.id, actor=owner
    )

    with pytest.raises(TournamentNotFoundError):
        preview_job_state(enqueued.token, uuid.uuid4())
    with pytest.raises(TournamentNotFoundError):
        cancel_preview(enqueued.token, uuid.uuid4())
    # The rightful tournament id still reads it.
    assert (
        preview_job_state(enqueued.token, tournament.id).status
        is PreviewJobStatus.queued
    )


async def test_preview_solve_loads_events_without_relying_on_lazy_load(
    db_session: AsyncSession, default_league: League, preview_queue: Queue
) -> None:
    """The verb must eager-load the events it draws over — a regression guard that
    the loader attaches them, since async lazy-loading would raise here."""
    owner = await make_user(db_session, "prev-eager")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    await _add_event(db_session, tournament, max_players=4, name="A")
    await _add_event(db_session, tournament, max_players=4, name="B")

    # Re-fetch a fresh, un-warmed instance so nothing is already in the identity map.
    fresh = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament.id)
        )
    ).scalar_one()
    assert fresh is not None

    enqueued = await request_schedule_preview(
        db_session, tournament_id=tournament.id, actor=owner
    )
    assert {s.field_size for s in enqueued.field_summaries} == {4}
    assert len(enqueued.field_summaries) == 2
