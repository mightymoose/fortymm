"""The transport-neutral request-schedule-solve verb
(``app.tournament_solve_service.request_schedule_solve``) — the FastAPI-free core
the Run-scheduler route (and, later, an MCP tool) drives, exercised here directly
against ``db_session`` with no HTTP layer.

These prove the refusals and the coalescing at the *service* seam: the route tests
(``tests/test_schedule_solve_route.py``) then prove the HTTP adapter maps each
domain exception back to the exact status + body the wire contract promises.

Under conftest's autouse **synchronous** fake queue, the enqueued job runs inline
at enqueue time — before this verb commits — opens its own engine (pointed at the
test database by the ``_job_database`` fixture below), finds no committed ``queued``
row, and exits as stale. So a request lands its row committed as ``queued``, exactly
what a real client sees the instant the 202 lands.
"""

import uuid
from decimal import Decimal

import pytest
from redis.exceptions import RedisError
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
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentStatus,
    User,
)
from app.tournament_draws import cut_draw
from app.tournament_errors import (
    NoDrawnEventsError,
    NotTournamentOwnerError,
    ScheduleQueueUnavailableError,
    TournamentNotFoundError,
)
from app.tournament_event_stages import mint_stages
from app.tournament_solve_service import request_schedule_solve
from tests._helpers import (
    event_groups,
    make_user,
    venue_tables,
)

DATE = "2030-01-01"


@pytest.fixture(autouse=True)
def _job_database(monkeypatch: pytest.MonkeyPatch, postgres_url: str) -> None:
    """The inline solve job (conftest's sync fake queue) opens its own engine
    from ``DATABASE_URL``; point it at the test database so it reads the same
    Postgres as the test rather than failing to connect."""
    monkeypatch.setenv("DATABASE_URL", postgres_url)


async def _make_tournament(
    db: AsyncSession,
    *,
    with_event: bool = True,
    cut: bool = True,
    entrants: int = 4,
    tables: tuple[str, ...] = ("t1", "t2"),
) -> tuple[uuid.UUID, User]:
    """A published tournament and its owner: a two-table catalogue and (unless
    ``with_event=False``) one grouped round-robin event whose single group spans
    both tables, ``entrants`` entered players, and (unless ``cut=False``) a cut
    draw. Written straight to the database — creation routes are not under test
    here. Returns ``(tournament_id, owner)``."""
    owner = await make_user(db, f"director-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"

    catalogue = venue_tables(*((table.upper(), "Main") for table in tables))
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
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=catalogue,
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()

    if not with_event:
        await db.commit()
        return tournament.id, owner

    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": DATE, "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        stages=stages,
    )
    stages[0].groups = event_groups(
        [
            {
                "name": "Reservation A",
                "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                "table_ids": [str(row.id) for row in catalogue],
            }
        ],
        event=event,
        tournament=tournament,
    )
    db.add(event)
    await db.flush()

    for _ in range(entrants):
        player = await make_user(db, f"player-{uuid.uuid4().hex[:8]}")
        db.add(TournamentEntry(event_id=event.id, user_id=player.id))
    await db.flush()

    if cut:
        # ``TournamentEvent.groups`` is a VIEWONLY association through the event's
        # stage now (ADR 20260815) — populated on QUERY, not on construction.
        # ``cut_draw`` reads ``event.groups`` synchronously, so this needs an
        # explicit refresh first.
        await db.refresh(event, attribute_names=["groups"])
        await cut_draw(db, event)
    await db.commit()
    return tournament.id, owner


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


async def test_owner_requests_a_solve_on_a_drawn_tournament(
    db_session: AsyncSession,
) -> None:
    """The happy path: the owner of a tournament with a cut draw gets a freshly
    queued ``manual`` ledger row, and it is the one and only row on the ledger."""
    tournament_id, owner = await _make_tournament(db_session)

    row = await request_schedule_solve(
        db_session, tournament_id=tournament_id, actor=owner
    )

    assert row.status is ScheduleSolveStatus.queued
    assert row.trigger is ScheduleSolveTrigger.manual
    assert row.requested_at is not None
    (persisted,) = await _solve_rows(db_session, tournament_id)
    assert persisted.id == row.id


async def test_a_second_request_in_flight_coalesces_onto_the_same_row(
    db_session: AsyncSession,
) -> None:
    """One solve in flight per tournament: a second request while a run is queued
    is absorbed by it — the same row comes back and exactly one ``queued`` row
    exists, nothing double-queued."""
    tournament_id, owner = await _make_tournament(db_session)

    first = await request_schedule_solve(
        db_session, tournament_id=tournament_id, actor=owner
    )
    second = await request_schedule_solve(
        db_session, tournament_id=tournament_id, actor=owner
    )

    assert second.id == first.id
    assert second.status is ScheduleSolveStatus.queued
    (row,) = await _solve_rows(db_session, tournament_id)
    assert row.id == first.id


async def test_no_drawn_event_is_refused(db_session: AsyncSession) -> None:
    """A tournament whose only event has no cut draw has nothing the solver can
    place: :class:`NoDrawnEventsError`, and nothing lands on the ledger."""
    tournament_id, owner = await _make_tournament(db_session, cut=False)

    with pytest.raises(NoDrawnEventsError):
        await request_schedule_solve(
            db_session, tournament_id=tournament_id, actor=owner
        )

    assert await _solve_rows(db_session, tournament_id) == []


async def test_a_tournament_with_no_events_is_refused(
    db_session: AsyncSession,
) -> None:
    """The same refusal for a tournament with no events at all — nothing drawn is
    nothing drawn, whatever the arity."""
    tournament_id, owner = await _make_tournament(db_session, with_event=False)

    with pytest.raises(NoDrawnEventsError):
        await request_schedule_solve(
            db_session, tournament_id=tournament_id, actor=owner
        )

    assert await _solve_rows(db_session, tournament_id) == []


async def test_a_non_owner_is_refused(db_session: AsyncSession) -> None:
    """Running the scheduler is owner-gated: a stranger — even a fully-permitted
    platform user — is refused with :class:`NotTournamentOwnerError` before the
    draw's state is even looked at, and nothing lands on the ledger."""
    tournament_id, _owner = await _make_tournament(db_session)
    stranger = await make_user(db_session, f"stranger-{uuid.uuid4().hex[:8]}")

    with pytest.raises(NotTournamentOwnerError):
        await request_schedule_solve(
            db_session, tournament_id=tournament_id, actor=stranger
        )

    assert await _solve_rows(db_session, tournament_id) == []


async def test_a_missing_tournament_is_refused(db_session: AsyncSession) -> None:
    """An id that resolves to no row raises :class:`TournamentNotFoundError` — the
    404 the adapter maps it to, before ownership is even a question."""
    stranger = await make_user(db_session, f"stranger-{uuid.uuid4().hex[:8]}")

    with pytest.raises(TournamentNotFoundError):
        await request_schedule_solve(
            db_session, tournament_id=uuid.uuid4(), actor=stranger
        )


async def test_queue_down_is_refused_and_no_row_survives(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the enqueue cannot be placed (Redis down), ``request_solve`` takes its
    row back out and this verb raises :class:`ScheduleQueueUnavailableError` rather
    than returning ``None`` — and nothing is left on the ledger (no zombie row that
    would absorb every later trigger while no job ever runs)."""
    tournament_id, owner = await _make_tournament(db_session)

    class _DeadQueue:
        def enqueue(self, *args: object, **kwargs: object) -> None:
            raise RedisError("redis is down")

    monkeypatch.setattr(queue_module, "get_queue", lambda: _DeadQueue())

    with pytest.raises(ScheduleQueueUnavailableError):
        await request_schedule_solve(
            db_session, tournament_id=tournament_id, actor=owner
        )

    assert await _solve_rows(db_session, tournament_id) == []
