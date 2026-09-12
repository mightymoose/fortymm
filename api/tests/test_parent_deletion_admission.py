"""Parent deletion cannot queue behind large retained-history mutations."""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import Tournament
from app.tournament_draw_limits import lock_draw_actor
from tests.test_swiss import authed_client as authed_client
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


@pytest.mark.parametrize("parent", ["event", "tournament"])
async def test_parent_delete_refuses_busy_actor_before_tournament_lock(
    authed_client, db_session, engine, default_league, parent
):
    client, owner = authed_client
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    await _enter_field(db_session, event, 4, prefix="parent-delete")
    actor_id, tournament_id, event_id = owner.id, tournament.id, event.id
    tournament_url = f"/v1/tournaments/{tournament_id}"
    event_url = f"{tournament_url}/events/{event_id}"
    assert (await client.post(f"{event_url}/draw")).status_code == 201
    url = event_url if parent == "event" else tournament_url
    sessions = async_sessionmaker(engine)
    async with sessions() as gate:
        await lock_draw_actor(gate, actor_id)
        await gate.execute(
            select(Tournament.id)
            .where(Tournament.id == tournament_id)
            .with_for_update()
        )
        async with asyncio.timeout(1):
            refused = await client.delete(url)
        assert refused.status_code == 409, refused.text
        assert "Retry" in refused.json()["detail"]
        await gate.rollback()
    deleted = await client.delete(url)
    assert deleted.status_code == 204, deleted.text


@pytest.mark.parametrize("operation", ["edit", "solve"])
async def test_owner_write_refuses_busy_actor_before_tournament_lock(
    authed_client, db_session, engine, default_league, operation
):
    client, owner = authed_client
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    await _enter_field(db_session, event, 2, prefix="owner-write")
    tournament_id, actor_id = tournament.id, owner.id
    assert (
        await client.post(f"/v1/tournaments/{tournament_id}/events/{event.id}/draw")
    ).status_code == 201

    async def request():
        if operation == "edit":
            return await client.patch(f"/v1/tournaments/{tournament_id}", json={})
        return await client.post(f"/v1/tournaments/{tournament_id}/schedule/solves")

    async with async_sessionmaker(engine)() as gate:
        await lock_draw_actor(gate, actor_id)
        await gate.execute(
            select(Tournament.id)
            .where(Tournament.id == tournament_id)
            .with_for_update()
        )
        async with asyncio.timeout(1):
            response = await request()
        assert response.status_code == 409, response.text
        assert "already in progress" in response.json()["detail"]
    response = await request()
    assert response.status_code == (200 if operation == "edit" else 202), response.text
