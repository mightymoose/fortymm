"""The Administration area's solve-ledger endpoint
(``GET /v1/admin/schedule-solves``): the ``scheduling.view`` permission gate,
the cross-tournament newest-first pagination, the ``tournament_id`` filter, and
the operator-only row facts (``input_fingerprint``, ``rerun_requested``, the
joined tournament name) that the tournament-facing ``ScheduleSolveRead``
deliberately omits."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin_schedule_solves import SCHEDULING_VIEW_PERMISSION
from app.leagues import get_default_league
from app.models import (
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
    Tournament,
    TournamentStatus,
    User,
)
from tests._helpers import grant_permissions, start_session

URL = "/v1/admin/schedule-solves"

T0 = datetime(2030, 1, 1, 9, 0, tzinfo=UTC)


async def _admin_session(api_client: AsyncClient, db_session: AsyncSession) -> User:
    """A signed-in user holding exactly the ledger permission — not the RBAC
    keys, so a pass proves the route is gated on ``scheduling.view`` itself."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (SCHEDULING_VIEW_PERMISSION,))
    return user


async def _make_tournament(db: AsyncSession, owner: User, name: str) -> uuid.UUID:
    """A minimal published tournament — the ledger joins only its id and name;
    events/draws are irrelevant here, so none are created."""
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
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()
    return tournament.id


async def _add_solve(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    requested_at: datetime,
    trigger: ScheduleSolveTrigger = ScheduleSolveTrigger.manual,
    status: ScheduleSolveStatus = ScheduleSolveStatus.queued,
    verdict: SolverVerdict | None = None,
    started_at: datetime | None = None,
    input_fingerprint: str | None = None,
    rerun_requested: bool = False,
    infeasibility_reasons: list[dict[str, Any]] | None = None,
) -> uuid.UUID:
    row = ScheduleSolve(
        tournament_id=tournament_id,
        trigger=trigger,
        status=status,
        verdict=verdict,
        requested_at=requested_at,
        started_at=started_at,
        input_fingerprint=input_fingerprint,
        rerun_requested=rerun_requested,
        infeasibility_reasons=infeasibility_reasons,
    )
    db.add(row)
    await db.flush()
    return row.id


# ----- the listing ----------------------------------------------------------


async def test_lists_solves_across_tournaments_newest_first_and_paginates(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await _admin_session(api_client, db_session)
    spring = await _make_tournament(db_session, admin, "Spring Open")
    autumn = await _make_tournament(db_session, admin, "Autumn Cup")

    # Five runs across the two tournaments. The last two share one requested_at
    # (a drift-discarded run and the rerun it requested are minted in the same
    # transaction), so the page split leans on the id DESC tie-break.
    minted: list[tuple[datetime, uuid.UUID]] = []
    for i, tournament_id in enumerate([spring, autumn, spring]):
        at = T0 + timedelta(minutes=i)
        minted.append(
            (at, await _add_solve(db_session, tournament_id, requested_at=at))
        )
    tied = T0 + timedelta(minutes=10)
    for tournament_id in (autumn, spring):
        minted.append(
            (tied, await _add_solve(db_session, tournament_id, requested_at=tied))
        )
    await db_session.commit()

    expected = [
        str(solve_id)
        for _, solve_id in sorted(minted, key=lambda m: (m[0], m[1]), reverse=True)
    ]

    first = await api_client.get(URL, params={"page_size": 2})
    assert first.status_code == 200
    data = first.json()
    assert data["page"] == 1
    assert data["page_size"] == 2
    assert data["total"] == 5
    assert [item["id"] for item in data["items"]] == expected[:2]

    second = await api_client.get(URL, params={"page": 2, "page_size": 2})
    assert second.status_code == 200
    data = second.json()
    assert data["page"] == 2
    assert data["total"] == 5
    assert [item["id"] for item in data["items"]] == expected[2:4]

    third = await api_client.get(URL, params={"page": 3, "page_size": 2})
    assert [item["id"] for item in third.json()["items"]] == expected[4:]


async def test_rows_carry_the_operator_only_facts(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await _admin_session(api_client, db_session)
    tournament_id = await _make_tournament(db_session, admin, "Winter Masters")
    await _add_solve(
        db_session,
        tournament_id,
        requested_at=T0,
        trigger=ScheduleSolveTrigger.match_completed,
        status=ScheduleSolveStatus.running,
        started_at=T0 + timedelta(seconds=5),
        input_fingerprint="a3f" * 8,
        rerun_requested=True,
    )
    await db_session.commit()

    response = await api_client.get(URL)
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    (item,) = data["items"]
    # The base ScheduleSolveRead facts…
    assert item["trigger"] == "match_completed"
    assert item["status"] == "running"
    assert item["verdict"] is None
    assert item["started_at"] is not None
    assert item["finished_at"] is None
    # …plus what the admin read adds on top.
    assert item["input_fingerprint"] == "a3f" * 8
    assert item["rerun_requested"] is True
    assert item["tournament_id"] == str(tournament_id)
    assert item["tournament_name"] == "Winter Masters"
    # A non-infeasible row carries an empty list, never a null.
    assert item["infeasibility_reasons"] == []


async def test_infeasible_row_carries_resolved_reasons(
    api_client: AsyncClient, db_session: AsyncSession
):
    """An ``infeasible`` ledger row's admin read carries the resolved reasons,
    parsed from the raw JSONB into the typed union at the boundary — the same
    ``ScheduleSolveRead`` field the detail BFF exposes."""
    admin = await _admin_session(api_client, db_session)
    tournament_id = await _make_tournament(db_session, admin, "Spring Open")
    await _add_solve(
        db_session,
        tournament_id,
        requested_at=T0,
        status=ScheduleSolveStatus.infeasible,
        verdict=SolverVerdict.infeasible,
        infeasibility_reasons=[
            {
                "kind": "window_too_short_for_match",
                "pool_name": "Pool A",
                "window_start": "09:00",
                "window_end": "09:10",
                "best_of": 5,
                "needed_min": 45,
                "window_span_min": 10,
            },
            {"kind": "no_single_cause", "required_min": 600, "available_min": 480},
        ],
    )
    await db_session.commit()

    response = await api_client.get(URL)
    assert response.status_code == 200
    (item,) = response.json()["items"]
    reasons = item["infeasibility_reasons"]
    assert [r["kind"] for r in reasons] == [
        "window_too_short_for_match",
        "no_single_cause",
    ]
    window = reasons[0]
    assert window["pool_name"] == "Pool A"
    assert window["best_of"] == 5
    assert window["needed_min"] == 45
    assert window["window_span_min"] == 10
    assert reasons[1] == {
        "kind": "no_single_cause",
        "required_min": 600,
        "available_min": 480,
    }


async def test_tournament_id_filter_narrows_rows_and_total(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await _admin_session(api_client, db_session)
    spring = await _make_tournament(db_session, admin, "Spring Open")
    autumn = await _make_tournament(db_session, admin, "Autumn Cup")
    await _add_solve(db_session, spring, requested_at=T0)
    autumn_older = await _add_solve(
        db_session, autumn, requested_at=T0 + timedelta(minutes=1)
    )
    await _add_solve(db_session, spring, requested_at=T0 + timedelta(minutes=2))
    autumn_newer = await _add_solve(
        db_session, autumn, requested_at=T0 + timedelta(minutes=3)
    )
    await db_session.commit()

    response = await api_client.get(URL, params={"tournament_id": str(autumn)})
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 2
    assert [item["id"] for item in data["items"]] == [
        str(autumn_newer),
        str(autumn_older),
    ]
    assert all(item["tournament_name"] == "Autumn Cup" for item in data["items"])


async def test_empty_ledger_is_an_empty_page_not_an_error(
    api_client: AsyncClient, db_session: AsyncSession
):
    await _admin_session(api_client, db_session)

    response = await api_client.get(URL)
    assert response.status_code == 200
    assert response.json() == {"items": [], "page": 1, "page_size": 25, "total": 0}


# ----- the gate -------------------------------------------------------------


async def test_signed_in_without_the_permission_is_403(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    response = await api_client.get(URL)
    assert response.status_code == 403
    assert response.json() == {"detail": "Forbidden."}


async def test_anonymous_is_401(api_client: AsyncClient):
    response = await api_client.get(URL)
    assert response.status_code == 401
