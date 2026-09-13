"""Shared mutating permission gates hold authority through side effects."""

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.identity_lifecycle import deactivate_account
from app.main import app
from app.models import Account
from app.notifications.service import NotificationService
from tests._helpers import enqueued_notification_jobs, make_user
from tests.test_notification_broadcast import grant_broadcast
from tests.test_proposal_history import wait_for_blocked
from tests.test_rbac_authz import _build_client


@pytest.mark.parametrize("first", ["broadcast", "deactivation"])
async def test_broadcast_serializes_with_suspension_before_queueing_delivery(
    db_session, engine, monkeypatch, fake_notifications_queue, first
):
    actor = await make_user(db_session, "broadcast-suspension-actor")
    await make_user(db_session, "broadcast-suspension-recipient")
    await grant_broadcast(db_session, actor)
    actor_id = actor.id
    checked, proceed = asyncio.Event(), asyncio.Event()
    original = NotificationService._broadcast_target_ids

    async def pause_before_enqueue(self, *args, **kwargs):
        checked.set()
        await proceed.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(
        NotificationService, "_broadcast_target_ids", pause_before_enqueue
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as writer, factory() as lifecycle:
        stale_actor = await writer.get(Account, actor_id)
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        try:
            async with _build_client(writer, stale_actor) as client:

                async def broadcast():
                    return await client.post(
                        "/v1/notifications/broadcast",
                        json={
                            "recipients": {"mode": "all"},
                            "title": "Announcement",
                            "body": "Body",
                        },
                    )

                if first == "deactivation":
                    await deactivate_account(lifecycle, actor_id)
                    proceed.set()
                    pending = asyncio.create_task(broadcast())
                    try:
                        await wait_for_blocked(lifecycle, writer_pid, pending)
                        await lifecycle.commit()
                        response = await pending
                        assert response.status_code == 403, response.text
                    finally:
                        await lifecycle.rollback()
                        await asyncio.gather(pending, return_exceptions=True)
                else:
                    writing = asyncio.create_task(broadcast())
                    await asyncio.wait_for(checked.wait(), 5)
                    pending = asyncio.create_task(
                        deactivate_account(lifecycle, actor_id)
                    )
                    try:
                        await wait_for_blocked(writer, lifecycle_pid, pending)
                        proceed.set()
                        response = await writing
                        assert response.status_code == 200, response.text
                        await writer.commit()
                        await pending
                        await lifecycle.commit()
                    finally:
                        proceed.set()
                        await asyncio.gather(writing, return_exceptions=True)
                        await writer.rollback()
                        await asyncio.gather(pending, return_exceptions=True)
                        await lifecycle.rollback()
        finally:
            app.dependency_overrides.clear()
    assert len(enqueued_notification_jobs(fake_notifications_queue)) == (
        2 if first == "broadcast" else 0
    )
