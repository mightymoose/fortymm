"""The Run-scheduler route (``POST /v1/tournaments/{id}/schedule/solves``) and the
detail BFF's solve strip (``latest_schedule_solve`` + the fixtures' pin facts) —
the owner-facing surface of ADR "the schedule is solved; the call is pinned".

The route is exercised over real HTTP with the real permission and ownership
gates (sessions via ``GET /v1/session``, CSRF hooks baked into the clients — the
``tests/test_tournaments.py`` conventions). Two queue set-ups, exactly as in
``tests/test_schedule_solve_service.py``:

* Under conftest's autouse **synchronous** fake queue, the enqueued job runs
  inline *before* the route's transaction commits, finds no committed ``queued``
  row, and exits as stale — so the queued-row tests observe the row the route
  answered with, still ``queued``, which is precisely what a real client would
  see the instant the 202 lands.
* The drain test swaps in an **async** record-only queue, commits through the
  route, then runs the recorded job the way a worker would — and reads the
  outcome back through the detail BFF, because the page is the contract: the
  solve strip and the pin facts are worth nothing in the database if they do not
  reach the payload the Schedule tab renders.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import fakeredis
import pytest
import pytest_asyncio
from httpx import AsyncClient
from rq import Queue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import queue as queue_module
from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentStatus,
    User,
)
from app.schedule_solves import RUN_SCHEDULE_SOLVE_JOB
from app.tournament_draws import cut_draw
from app.tournaments import NO_DRAWN_EVENTS_CODE, TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import grant_permissions, make_client, make_user, start_session

DATE = "2030-01-01"
#: The event's venue timezone, anchoring its wall-clock windows to real instants
#: (ADR "tournament times are timezone-aware instants").
VENUE_TZ = ZoneInfo("America/Chicago")
#: The pool window's start and end — the solve's minute-frame origin, as in the
#: service tests — as timezone-aware instants in the venue frame.
BASE = datetime(2030, 1, 1, 9, 0, tzinfo=VENUE_TZ)
WINDOW_END = datetime(2030, 1, 1, 17, 0, tzinfo=VENUE_TZ)
#: length_games=3 under the fixed duration mapping (see the service tests).
MATCH_MINUTES = 25


@pytest.fixture(autouse=True)
def _job_database(monkeypatch: pytest.MonkeyPatch, postgres_url: str) -> None:
    """The solve job opens its own engine from ``DATABASE_URL``; point it at the
    test database so both the inline no-op (sync fake queue) and the explicit
    post-commit run read the same Postgres as the test."""
    monkeypatch.setenv("DATABASE_URL", postgres_url)


@pytest.fixture
def solver_queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """An async (record-only) RQ queue on fakeredis, replacing conftest's
    synchronous one for the test that must commit before the job runs."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.SOLVER_QUEUE, connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The primary ``api_client`` with a real session whose user holds
    ``tournament.view`` + ``tournament.create`` — the tournaments-router
    convention (the solve route itself is owner-gated, not permission-gated,
    but the detail read this file also exercises is gated on ``view``)."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))
    yield api_client, user


def _solves_url(tournament_id: uuid.UUID | str) -> str:
    return f"/v1/tournaments/{tournament_id}/schedule/solves"


def _detail_url(tournament_id: uuid.UUID | str) -> str:
    return f"/v1/tournaments/{tournament_id}"


async def _make_tournament(
    db: AsyncSession,
    owner: User,
    *,
    with_event: bool = True,
    cut: bool = True,
    entrants: int = 4,
    tables: tuple[str, ...] = ("t1", "t2"),
) -> tuple[uuid.UUID, uuid.UUID | None]:
    """A published tournament owned by ``owner``: a two-table catalogue and (unless
    ``with_event=False``) one pooled round-robin event whose single pool spans both
    tables, ``entrants`` entered players, and (unless ``cut=False``) a cut draw.
    Written straight to the database — creation routes are not under test here.
    Returns plain ids, like the service tests, so nothing lazy-loads later."""
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"

    tournament = Tournament(
        name="Scheduled Open",
        status=TournamentStatus.published,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
        },
        table_catalogue=[
            {"id": table, "label": table.upper(), "court": "Main"} for table in tables
        ],
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()

    if not with_event:
        await db.commit()
        return tournament.id, None

    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_type=DrawType.round_robin,
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": DATE, "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        pools=[
            {
                "id": "pool-a",
                "name": "Pool A",
                "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                "table_ids": list(tables),
            }
        ],
    )
    db.add(event)
    await db.flush()

    for _ in range(entrants):
        player = await make_user(db, f"player-{uuid.uuid4().hex[:8]}")
        db.add(TournamentEntry(event_id=event.id, user_id=player.id))
    await db.flush()

    if cut:
        await cut_draw(db, event)
    await db.commit()
    return tournament.id, event.id


async def _solve_rows(
    db: AsyncSession, tournament_id: uuid.UUID
) -> list[ScheduleSolve]:
    return list(
        (
            await db.execute(
                select(ScheduleSolve)
                .where(ScheduleSolve.tournament_id == tournament_id)
                .order_by(ScheduleSolve.requested_at, ScheduleSolve.id)
            )
        )
        .scalars()
        .all()
    )


def _run_recorded_job(queue: Queue, expected_solve_id: str) -> None:
    """Run the oldest recorded job the way a worker would: resolve the dotted
    path (``job.func`` imports it) and call it with the enqueued args."""
    job = queue.jobs[0]
    assert job.func_name == RUN_SCHEDULE_SOLVE_JOB
    assert job.args == (expected_solve_id,)
    job.func(*job.args)


# ----- the route's refusals (404 → 401/403 → 422, ADR-0017's ordering) -------


async def test_schedule_solve_for_an_absent_tournament_is_404(
    authed_client: tuple[AsyncClient, User],
) -> None:
    client, _ = authed_client
    response = await client.post(_solves_url(uuid.uuid4()))
    assert response.status_code == 404


async def test_an_anonymous_schedule_solve_request_is_401(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """No session, no solve — refused before ownership is even a question, and
    nothing lands on the ledger."""
    _, owner = authed_client
    tournament_id, _ = await _make_tournament(db_session, owner)

    async with make_client() as anonymous:  # no ``start_session``: no cookie at all
        assert (await anonymous.post(_solves_url(tournament_id))).status_code == 401

    assert await _solve_rows(db_session, tournament_id) == []


async def test_schedule_solve_is_owner_only_no_permission_grants_it(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Running the scheduler is a property of OWNING the tournament — the same
    family as cutting a draw. The stranger here holds ``tournament.view`` +
    ``tournament.create``, so they are a fully-permitted user of the platform;
    what they are not is this tournament's director. 403, and the ledger stays
    empty — a refusal that had queued the run first would be a 403 in name only.
    """
    _, owner = authed_client
    tournament_id, _ = await _make_tournament(db_session, owner)

    async with make_client() as stranger:
        user = await start_session(stranger, db_session)
        await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))

        assert (await stranger.post(_solves_url(tournament_id))).status_code == 403

    assert await _solve_rows(db_session, tournament_id) == []


async def test_schedule_solve_with_nothing_drawn_is_a_422_with_the_code(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A tournament with no cut draw anywhere has nothing the solver can place, so
    the owner's request is refused with the machine-readable
    ``{"code": ..., "message": ...}`` shape (the ``tournament_entry_refusals``
    precedent) — whether the tournament has an event nobody has drawn, or no
    events at all. Same code both ways: the fix is the same (cut a draw), and a
    client switches on the code, not the prose. Nothing lands on the ledger."""
    client, owner = authed_client
    undrawn_id, _ = await _make_tournament(db_session, owner, cut=False)
    eventless_id, _ = await _make_tournament(db_session, owner, with_event=False)

    for tournament_id in (undrawn_id, eventless_id):
        response = await client.post(_solves_url(tournament_id))

        assert response.status_code == 422, response.text
        detail = response.json()["detail"]
        assert detail["code"] == NO_DRAWN_EVENTS_CODE
        assert isinstance(detail["message"], str) and detail["message"]
        assert await _solve_rows(db_session, tournament_id) == []


# ----- the accepted request (202) --------------------------------------------


async def test_the_owner_queues_a_manual_solve_and_gets_the_ledger_row(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """202: the work is accepted, not done. The body is the freshly-queued ledger
    row — trigger ``manual`` (this is the Run-scheduler button), status
    ``queued``, and every not-yet-reached stage an explicit ``null`` — and the
    row in the database is the row on the wire."""
    client, owner = authed_client
    tournament_id, _ = await _make_tournament(db_session, owner)

    response = await client.post(_solves_url(tournament_id))

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["trigger"] == "manual"
    assert body["status"] == "queued"
    assert body["verdict"] is None
    assert body["requested_at"] is not None
    assert body["started_at"] is None
    assert body["finished_at"] is None
    assert body["wall_time_ms"] is None
    assert body["fixtures_placed"] is None
    assert body["fixtures_pinned"] is None
    assert body["error"] is None

    (row,) = await _solve_rows(db_session, tournament_id)
    assert str(row.id) == body["id"]
    assert row.status is ScheduleSolveStatus.queued
    assert row.trigger is ScheduleSolveTrigger.manual


async def test_posting_twice_coalesces_onto_the_same_queued_row(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """One solve in flight per tournament: a second click while a run is queued is
    absorbed by it — same 202, same row id, still exactly one ``queued`` row (the
    pending run will already see whatever state motivated the second click)."""
    client, owner = authed_client
    tournament_id, _ = await _make_tournament(db_session, owner)

    first = await client.post(_solves_url(tournament_id))
    second = await client.post(_solves_url(tournament_id))

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["status"] == "queued"
    (row,) = await _solve_rows(db_session, tournament_id)
    assert str(row.id) == first.json()["id"]
    assert row.status is ScheduleSolveStatus.queued


# ----- the solve strip on the detail BFF --------------------------------------


async def test_solve_strip_is_null_until_a_solve_is_requested(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """``latest_schedule_solve`` is a present ``null`` on a tournament nobody has
    asked to schedule — the designed state of every tournament ever created, not a
    missing key the client would have to tell apart from an old server."""
    client, owner = authed_client
    tournament_id, _ = await _make_tournament(db_session, owner)

    body = (await client.get(_detail_url(tournament_id))).json()

    assert "latest_schedule_solve" in body
    assert body["latest_schedule_solve"] is None


async def test_solve_strip_carries_the_newest_row_by_requested_at(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The strip is the NEWEST ledger row by ``requested_at`` — not the first, not
    the last-succeeded. An old success followed by a fresh failure shows the
    failure: the strip reports the current state of scheduling, not the most
    flattering one."""
    client, owner = authed_client
    tournament_id, _ = await _make_tournament(db_session, owner)
    older = ScheduleSolve(
        tournament_id=tournament_id,
        trigger=ScheduleSolveTrigger.go_live,
        status=ScheduleSolveStatus.succeeded,
        verdict=SolverVerdict.optimal,
        requested_at=datetime(2030, 1, 1, 8, 0, tzinfo=UTC),
    )
    newer = ScheduleSolve(
        tournament_id=tournament_id,
        trigger=ScheduleSolveTrigger.manual,
        status=ScheduleSolveStatus.failed,
        error="the solver caught fire",
        requested_at=datetime(2030, 1, 1, 9, 0, tzinfo=UTC),
    )
    db_session.add_all([older, newer])
    await db_session.commit()

    strip = (await client.get(_detail_url(tournament_id))).json()[
        "latest_schedule_solve"
    ]

    assert strip["id"] == str(newer.id)
    assert strip["status"] == "failed"
    assert strip["trigger"] == "manual"
    assert strip["error"] == "the solver caught fire"


async def test_after_the_drained_job_the_solve_strip_and_pin_facts_reach_the_page(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    solver_queue: Queue,
) -> None:
    """End to end, read back through the page: POST queues the run, the worker
    drains it, and the detail BFF then shows the whole outcome — the strip
    ``succeeded`` with a verdict and its counts, and every fixture placed on a
    pool table inside the pool's window, carrying its pin facts (``pinned_at``
    null — every placement is still an estimate, the manual route pins nothing —
    and ``call_notified_count`` 0, nobody told)."""
    client, owner = authed_client
    tournament_id, _ = await _make_tournament(db_session, owner)

    response = await client.post(_solves_url(tournament_id))
    assert response.status_code == 202, response.text
    solve_id = response.json()["id"]

    _run_recorded_job(solver_queue, solve_id)

    # The job wrote through its own engine; drop this session's cached rows so
    # the GET below re-reads what the worker committed.
    db_session.expire_all()
    body = (await client.get(_detail_url(tournament_id))).json()

    strip = body["latest_schedule_solve"]
    assert strip["id"] == solve_id
    assert strip["status"] == "succeeded"
    assert strip["verdict"] in ("optimal", "feasible")
    assert strip["trigger"] == "manual"
    assert strip["fixtures_placed"] == 6  # round-robin over 4 entrants
    assert strip["fixtures_pinned"] == 0
    assert strip["wall_time_ms"] >= 0
    assert strip["requested_at"] is not None
    assert strip["started_at"] is not None
    assert strip["finished_at"] is not None
    assert strip["error"] is None

    (event_read,) = body["events"]
    fixtures: list[dict[str, Any]] = event_read["fixtures"]
    assert len(fixtures) == 6
    for fixture in fixtures:
        assert fixture["table_id"] in ("t1", "t2")
        start = datetime.fromisoformat(fixture["scheduled_start"]["instant"])
        assert BASE <= start
        assert start + timedelta(minutes=MATCH_MINUTES) <= WINDOW_END
        assert fixture["pinned_at"] is None
        assert fixture["call_notified_count"] == 0
