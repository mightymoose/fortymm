"""Go-live admits large ready sets without fixture-sized SQL parameter lists."""

import pytest
from sqlalchemy import event as sql_event
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.models import League, TournamentFixture, TournamentStatus
from app.tournament_draw_service import cut_event_draw
from app.tournament_lifecycle import transition_tournament
from tests._helpers import make_user
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


async def test_go_live_binds_ready_participation_as_one_collection(
    db_session: AsyncSession,
    default_league: League,
    engine: AsyncEngine,
) -> None:
    owner = await make_user(db_session, "go-live-capacity")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    await _enter_field(db_session, event, 8, prefix="go-live-capacity")
    tournament.status = TournamentStatus.published
    await db_session.commit()
    await cut_event_draw(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
    )
    bind_counts = []

    def record_participation_binds(conn, cursor, statement, parameters, context, many):
        if "JOIN tournament_entry_participations" in statement:
            bind_counts.append(len(parameters))
            assert len(parameters) <= 8, "ready fixtures must not expand SQL bind count"

    sql_event.listen(
        engine.sync_engine, "before_cursor_execute", record_participation_binds
    )
    try:
        moved = await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=owner,
            to=TournamentStatus.live,
        )
    finally:
        sql_event.remove(
            engine.sync_engine, "before_cursor_execute", record_participation_binds
        )
    assert moved.status is TournamentStatus.live
    assert bind_counts
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(TournamentFixture)
            .where(
                TournamentFixture.scope_event_id == event.id,
                TournamentFixture.match_id.is_not(None),
            )
        )
        == 28
    )


@pytest.mark.parametrize("target", ["published", "live", "archived"])
async def test_busy_actor_transition_refuses_before_tournament_lock_and_can_retry(
    api_client,
    db_session,
    default_league,
    engine,
    target,
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models import Tournament
    from app.tournament_draw_limits import lock_draw_actor
    from tests._helpers import start_session

    owner = await start_session(api_client, db_session)
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    await _enter_field(db_session, event, 2, prefix="busy-go-live")
    tournament.status = {
        "published": TournamentStatus.draft,
        "live": TournamentStatus.published,
        "archived": TournamentStatus.live,
    }[target]
    await db_session.commit()
    await cut_event_draw(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
    )
    tournament_id, owner_id = tournament.id, owner.id
    async with async_sessionmaker(engine)() as holder:
        await lock_draw_actor(holder, owner_id)
        await holder.execute(
            select(Tournament.id)
            .where(
                Tournament.id == tournament_id,
            )
            .with_for_update()
        )
        async with asyncio.timeout(1):
            response = await api_client.post(
                f"/v1/tournaments/{tournament_id}/transitions",
                json={"to": target},
            )
        assert response.status_code == 409
        assert "already in progress" in response.json()["detail"]
    response = await api_client.post(
        f"/v1/tournaments/{tournament_id}/transitions",
        json={"to": target},
    )
    assert response.status_code == 201
    assert response.json()["status"] == target
