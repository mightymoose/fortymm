"""Unit tests for the transport-neutral solve-ledger reader
(``app.schedule_solve_queries``) — the query + shaping both the HTTP admin route
and the MCP ``list_schedule_solves`` tool compose. The reader gates nothing; the
permission lives at each adapter, so these tests drive it with a bare session and
prove only the ordering, the tournament-name join, the filter, and pagination."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentStatus,
    User,
)
from app.schedule_solve_queries import count_schedule_solves, list_schedule_solves
from tests._helpers import make_user

T0 = datetime(2030, 1, 1, 9, 0, tzinfo=UTC)


async def _make_tournament(db: AsyncSession, owner: User, name: str) -> uuid.UUID:
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"
    tournament = Tournament(
        name=name,
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
        table_catalogue=[],
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()
    return tournament.id


async def _add_solve(
    db: AsyncSession, tournament_id: uuid.UUID, *, requested_at: datetime
) -> uuid.UUID:
    row = ScheduleSolve(
        tournament_id=tournament_id,
        trigger=ScheduleSolveTrigger.manual,
        status=ScheduleSolveStatus.queued,
        requested_at=requested_at,
    )
    db.add(row)
    await db.flush()
    return row.id


async def test_reader_orders_newest_first_and_joins_tournament_name(
    db_session: AsyncSession,
) -> None:
    owner = await make_user(db_session, "reader-owner")
    spring = await _make_tournament(db_session, owner, "Spring Open")
    autumn = await _make_tournament(db_session, owner, "Autumn Cup")
    oldest = await _add_solve(db_session, spring, requested_at=T0)
    middle = await _add_solve(
        db_session, autumn, requested_at=T0 + timedelta(minutes=1)
    )
    newest = await _add_solve(
        db_session, spring, requested_at=T0 + timedelta(minutes=2)
    )
    await db_session.commit()

    items = await list_schedule_solves(db_session, page=1, page_size=25)

    assert [item.id for item in items] == [newest, middle, oldest]
    # The joined tournament name rides on each row.
    by_id = {item.id: item for item in items}
    assert by_id[newest].tournament_name == "Spring Open"
    assert by_id[middle].tournament_name == "Autumn Cup"
    assert await count_schedule_solves(db_session) == 3


async def test_reader_filters_by_tournament_and_paginates(
    db_session: AsyncSession,
) -> None:
    owner = await make_user(db_session, "reader-owner-2")
    spring = await _make_tournament(db_session, owner, "Spring Open")
    autumn = await _make_tournament(db_session, owner, "Autumn Cup")
    await _add_solve(db_session, spring, requested_at=T0)
    autumn_older = await _add_solve(
        db_session, autumn, requested_at=T0 + timedelta(minutes=1)
    )
    autumn_newer = await _add_solve(
        db_session, autumn, requested_at=T0 + timedelta(minutes=2)
    )
    await db_session.commit()

    # The filter narrows both the page and the count to one tournament's runs.
    assert await count_schedule_solves(db_session, tournament_id=autumn) == 2
    filtered = await list_schedule_solves(db_session, tournament_id=autumn)
    assert [item.id for item in filtered] == [autumn_newer, autumn_older]

    # Pagination: page 1 of size 1 is the newest, page 2 the next.
    first = await list_schedule_solves(
        db_session, tournament_id=autumn, page=1, page_size=1
    )
    second = await list_schedule_solves(
        db_session, tournament_id=autumn, page=2, page_size=1
    )
    assert [item.id for item in first] == [autumn_newer]
    assert [item.id for item in second] == [autumn_older]
