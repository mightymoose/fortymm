"""Registration provenance follows Account-before-Tournament merge locking."""

import asyncio

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models import Tournament, User
from app.tournament_entries import enter_event, withdraw_from_event
from tests._helpers import make_user
from tests.test_tournament_entries import _make_event


@pytest.mark.parametrize("withdraw", [False, True])
async def test_registration_change_waits_for_actor_without_holding_tournament(
    db_session: AsyncSession,
    engine: AsyncEngine,
    withdraw: bool,
) -> None:
    actor = await make_user(db_session, "registration-lock-actor")
    event = await _make_event(db_session)
    actor_id, tournament_id, event_id = actor.id, event.tournament_id, event.id
    entry_id = None
    if withdraw:
        entry = await enter_event(
            db_session,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=actor,
            user_id=None,
        )
        entry_id = entry.id
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    worker_pid: asyncio.Future[int] = asyncio.get_running_loop().create_future()

    async def register() -> None:
        async with sessions() as writer:
            loaded = (
                await writer.scalars(select(User).where(User.id == actor_id))
            ).one()
            pid = await writer.scalar(text("SELECT pg_backend_pid()"))
            worker_pid.set_result(pid)
            if withdraw:
                assert entry_id is not None
                await withdraw_from_event(
                    writer,
                    tournament_id=tournament_id,
                    event_id=event_id,
                    entry_id=entry_id,
                    actor=loaded,
                )
            else:
                await enter_event(
                    writer,
                    tournament_id=tournament_id,
                    event_id=event_id,
                    actor=loaded,
                    user_id=None,
                )

    async with sessions() as actor_lock, sessions() as probe:
        await actor_lock.execute(
            select(User.id).where(User.id == actor_id).with_for_update()
        )
        pending = asyncio.create_task(register())
        try:
            pid = await worker_pid
            async with asyncio.timeout(5):
                while not await probe.scalar(
                    text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"), {"pid": pid}
                ):
                    if pending.done():
                        await pending
                        raise AssertionError("Registration did not wait for its actor")
                    await asyncio.sleep(0.01)
            # A simultaneous Account merge can now acquire its tournament lock;
            # registration must not hold that lock while waiting for the Account.
            await probe.execute(
                select(Tournament.id)
                .where(Tournament.id == tournament_id)
                .with_for_update(nowait=True)
            )
            await probe.rollback()
        finally:
            await probe.rollback()
            await actor_lock.rollback()
            await pending
