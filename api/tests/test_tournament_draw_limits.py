"""Draw storage refusals through the real HTTP cut endpoint."""

import pytest
from sqlalchemy import func, select

from app import tournament_draw_limits as limits
from app.models import TournamentDrawRevision, TournamentFixture
from tests.test_swiss import authed_client as authed_client
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


async def test_oversized_cut_is_refused_without_writing_history(
    authed_client, db_session, default_league, monkeypatch
):
    client, owner = authed_client
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    await _enter_field(db_session, event, 4, prefix="draw-limit")
    monkeypatch.setattr(limits, "MAX_FIXTURES_PER_CUT", 1)

    response = await client.post(
        f"/v1/tournaments/{tournament.id}/events/{event.id}/draw"
    )

    assert response.status_code == 422, response.text
    assert "1 fixtures per cut" in response.json()["detail"]
    assert (
        await db_session.scalar(
            select(func.count()).select_from(TournamentDrawRevision)
        )
        == 0
    )
    assert (
        await db_session.scalar(select(func.count()).select_from(TournamentFixture))
        == 0
    )


@pytest.mark.parametrize(
    "setting,budget,message",
    [
        ("MAX_REVISIONS_PER_TOURNAMENT", 2, "2 draw revisions per tournament"),
        ("MAX_FIXTURES_PER_TOURNAMENT", 4, "4 fixtures per tournament"),
    ],
)
async def test_tournament_budget_preserves_current_draw_on_refusal(
    authed_client, db_session, default_league, monkeypatch, setting, budget, message
):
    client, owner = authed_client
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    await _enter_field(db_session, event, 4, prefix="revision-limit")
    url = f"/v1/tournaments/{tournament.id}/events/{event.id}/draw"
    monkeypatch.setattr(limits, setting, budget)
    assert (await client.post(url)).status_code == 201
    latest = await client.post(url)
    assert latest.status_code == 201

    refused = await client.post(url)

    assert refused.status_code == 422, refused.text
    assert message in refused.json()["detail"]
    current = (await db_session.scalars(select(TournamentFixture))).all()
    assert {str(row.id) for row in current} == {row["id"] for row in latest.json()}
    assert (
        await db_session.scalar(
            select(func.count()).select_from(TournamentDrawRevision)
        )
        == 2
    )


@pytest.mark.parametrize(
    "setting,budget,message",
    [
        ("MAX_REVISIONS_PER_ACTOR", 1, "1 draw revisions per account"),
        ("MAX_FIXTURES_PER_ACTOR", 2, "2 fixtures per account"),
    ],
)
async def test_actor_budget_survives_ownership_transfer(
    authed_client, db_session, default_league, monkeypatch, setting, budget, message
):
    from app.tournament_authority import transfer_ownership
    from tests._helpers import make_user

    client, owner = authed_client
    tournaments = [
        await _make_tournament(db_session, owner=owner, league=default_league)
        for _ in range(2)
    ]
    urls = []
    for index, tournament in enumerate(tournaments):
        event = await _make_event(db_session, tournament)
        await _enter_field(db_session, event, 4, prefix=f"actor-budget-{index}")
        urls.append(f"/v1/tournaments/{tournament.id}/events/{event.id}/draw")
    monkeypatch.setattr(limits, setting, budget)
    assert (await client.post(urls[0])).status_code == 201
    assert (await client.delete(urls[0])).status_code == 204
    other_owner = await make_user(db_session, "transferred-draw-owner")
    await transfer_ownership(
        db_session, tournaments[0].id, actor_id=owner.id, account_id=other_owner.id
    )
    await db_session.commit()

    refused = await client.post(urls[1])

    assert refused.status_code == 422, refused.text
    assert message in refused.json()["detail"]
    assert (
        await db_session.scalar(
            select(func.count()).select_from(TournamentDrawRevision)
        )
        == 1
    )


async def test_actor_budget_serializes_cuts_across_tournaments_before_parent_locks(
    db_session, engine, default_league, monkeypatch
):
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.draws import DrawStorageLimitExceeded
    from app.models import Tournament, User
    from app.tournament_draw_service import cut_event_draw
    from tests._helpers import make_user

    owner = await make_user(db_session, "quota-racing-owner")
    actor_id = owner.id
    targets = []
    for index in range(2):
        tournament = await _make_tournament(
            db_session, owner=owner, league=default_league
        )
        event = await _make_event(db_session, tournament)
        await _enter_field(db_session, event, 4, prefix=f"quota-race-{index}")
        targets.append((tournament.id, event.id))
    monkeypatch.setattr(limits, "MAX_REVISIONS_PER_ACTOR", 1)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    pids = [asyncio.get_running_loop().create_future() for _ in targets]

    async def cut(index):
        async with sessions() as writer:
            actor = (
                await writer.scalars(select(User).where(User.id == actor_id))
            ).one()
            pids[index].set_result(await writer.scalar(text("SELECT pg_backend_pid()")))
            tournament_id, event_id = targets[index]
            try:
                await cut_event_draw(
                    writer, tournament_id=tournament_id, event_id=event_id, actor=actor
                )
            except DrawStorageLimitExceeded:
                return False
            return True

    async with sessions() as gate, sessions() as probe:
        await limits.lock_draw_actor(gate, actor_id)
        pending = [asyncio.create_task(cut(index)) for index in range(2)]
        try:
            async with asyncio.timeout(5):
                for pid_future, task in zip(pids, pending, strict=True):
                    pid = await pid_future
                    while not await probe.scalar(
                        text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"),
                        {"pid": pid},
                    ):
                        if task.done():
                            await task
                            raise AssertionError(
                                "Cut did not wait for the shared actor quota"
                            )
                        await asyncio.sleep(0.01)
            await probe.execute(
                select(Tournament.id)
                .where(Tournament.id.in_([target[0] for target in targets]))
                .with_for_update(nowait=True)
            )
        finally:
            await probe.rollback()
            await gate.rollback()
            outcomes = await asyncio.gather(*pending)
    assert sorted(outcomes) == [False, True]
    assert (
        await db_session.scalar(
            select(func.count()).select_from(TournamentDrawRevision)
        )
        == 1
    )


async def test_draw_revision_actor_cannot_be_reassigned_by_sql(
    authed_client, db_session, default_league
):
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from tests._helpers import make_user

    client, owner = authed_client
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    await _enter_field(db_session, event, 4, prefix="immutable-draw-actor")
    assert (
        await client.post(f"/v1/tournaments/{tournament.id}/events/{event.id}/draw")
    ).status_code == 201
    actor_id = owner.id
    other = await make_user(db_session, "other-draw-actor")
    revision = (await db_session.scalars(select(TournamentDrawRevision))).one()
    assert revision.created_by_account_id == actor_id
    with pytest.raises(IntegrityError, match="draw revision history is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_draw_revisions "
                    "SET created_by_account_id = :actor WHERE id = :id"
                ),
                {"actor": other.id, "id": revision.id},
            )
