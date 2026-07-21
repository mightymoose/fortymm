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
from decimal import Decimal

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
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.tournament import DrawType, EventFormat
from app.schedule_preview_solve import (
    PREVIEW_JOB_TIMEOUT_MARGIN_S,
    RUN_SCHEDULE_PREVIEW_JOB,
    PreviewJobInputs,
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
from app.schemas.schedule_solve import WindowTooShortForMatchRead
from app.tournament_errors import (
    NotTournamentOwnerError,
    TournamentNotPreLiveError,
)
from tests._helpers import make_user

TABLE_CATALOGUE: list[dict[str, object]] = [
    {"id": "t1", "label": "Table 1", "court": "A"},
    {"id": "t2", "label": "Table 2", "court": "A"},
]


def _pool(
    table_ids: list[str], *, start: str = "09:00", end: str = "18:00"
) -> dict[str, object]:
    return {
        "id": "p-a",
        "name": "Pool A",
        "slot": {"date": "2026-06-13", "start": start, "end": end},
        "table_ids": table_ids,
    }


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
        },
        table_catalogue=TABLE_CATALOGUE,
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
) -> TournamentEvent:
    event = TournamentEvent(
        tournament_id=tournament.id,
        name=name,
        format=EventFormat.singles,
        draw_type=DrawType.round_robin,
        max_players=max_players,
        entry_fee=Decimal("0"),
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": length_games},
        predicates=[],
        pools=[_pool(["t1", "t2"])] if pools is None else pools,
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

    # The job landed on the PREVIEW queue with the right timeout, and running it
    # yields the full PreviewResult.
    (job,) = preview_queue.jobs
    assert job.origin == queue_module.PREVIEW_QUEUE
    assert job.timeout == 5 + PREVIEW_JOB_TIMEOUT_MARGIN_S

    _run_recorded_preview_job(preview_queue)

    state = preview_job_state(enqueued.token)
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
    state = preview_job_state(enqueued.token)
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

    state = wait_for_preview(enqueued.token, timeout_s=5.0)
    assert state.status is PreviewJobStatus.done
    assert state.result is not None
    assert state.result.total_matches == 6


async def test_preview_job_state_reports_a_missing_job_as_failed(
    preview_queue: Queue,
) -> None:
    state = preview_job_state(str(uuid.uuid4()))
    assert state.status is PreviewJobStatus.failed
    assert state.error is not None
    assert state.result is None


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
