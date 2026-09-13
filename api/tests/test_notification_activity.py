"""Delayed notification work respects current Account activity."""

import pytest
from sqlalchemy import select, text

from app.models import Notification
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory
from tests._helpers import FakeSender, make_user


@pytest.mark.parametrize("erased", [False, True])
async def test_notify_skips_inactive_cached_recipient(db_session, erased):
    from app.identity_lifecycle import erase_account

    user = await make_user(db_session, "inactive-notify")
    if erased:
        await erase_account(db_session, user.id)
    else:
        await db_session.execute(
            text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
            {"id": user.id},
        )
    await db_session.commit()
    sender = FakeSender()
    result = await NotificationService(db_session, sender).notify(
        user_id=user.id,
        category=NotificationCategory.MATCH_CALLS,
        title="Private result",
        body="Score",
    )
    assert not result.in_app_created
    assert not result.emailed
    assert result.pushed == 0
    assert sender.sent == []
    assert await db_session.scalar(select(Notification.id)) is None


async def test_push_holds_recipient_activity_through_external_delivery(
    db_session, monkeypatch
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models import DeviceToken

    user = await make_user(db_session, "push-activity-race")
    db_session.add(
        DeviceToken(
            user_id=user.id, token="push-race", platform="ios", environment="sandbox"
        )
    )
    await db_session.commit()
    sender = FakeSender()
    reached, release = asyncio.Event(), asyncio.Event()
    original = sender.send

    async def paused_send(*args, **kwargs):
        reached.set()
        await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(sender, "send", paused_send)
    sessions = async_sessionmaker(db_session.bind, expire_on_commit=False)
    async with sessions() as delivery, sessions() as lifecycle:
        delivery_pid = await delivery.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        push = asyncio.create_task(
            NotificationService(delivery, sender).send_to_user(
                user.id,
                title="Private",
                body="Match result",
            )
        )
        await asyncio.wait_for(reached.wait(), 5)
        suspension = asyncio.create_task(
            lifecycle.execute(
                text(
                    "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
                ),
                {"id": user.id},
            )
        )
        try:
            async with asyncio.timeout(5):
                while delivery_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": lifecycle_pid}
                ):
                    assert not suspension.done(), (
                        "suspension bypassed in-flight delivery"
                    )
                    await asyncio.sleep(0.01)
        finally:
            release.set()
            await push
            await delivery.rollback()
            await suspension
            await lifecycle.rollback()
    assert len(sender.sent) == 1


@pytest.mark.parametrize("suspended", [False, True])
async def test_queued_notification_email_rechecks_activity_before_delivery(
    db_session, engine, fake_email_queue, monkeypatch, suspended
):
    import asyncio
    from datetime import UTC, datetime

    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app import email
    from app.notifications import jobs
    from app.notifications.taxonomy import NotificationChannel

    fake_email_queue._is_async = True
    user = await make_user(db_session, "delayed-email")
    user.email = "delayed@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    result = await NotificationService(db_session, FakeSender()).notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="Private draw",
        body="Draw details",
        channels=[NotificationChannel.EMAIL],
    )
    assert result.emailed
    await db_session.commit()
    queued = fake_email_queue.jobs[-1]
    if suspended:
        await db_session.execute(
            text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
            {"id": user.id},
        )
        await db_session.commit()
    sent = []
    monkeypatch.setattr(
        email, "send_notification_email", lambda *args: sent.append(args)
    )
    worker_engine = create_async_engine(engine.url, poolclass=NullPool)
    monkeypatch.setattr(jobs, "get_engine", lambda: worker_engine)
    try:
        await asyncio.to_thread(queued.perform)
    finally:
        await worker_engine.dispose()
    assert len(sent) == (0 if suspended else 1)


async def test_match_call_recipients_exclude_inactive_accounts(db_session):
    from app.match_calls import load_copy_ingredients
    from app.models import Tournament, TournamentFixture
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(db_session, tag="inactive-call")
    fixture = await db_session.scalar(
        select(TournamentFixture).where(TournamentFixture.match_id == match.id)
    )
    tournament = await db_session.get(Tournament, fixture.scope_tournament_id)
    ingredients = await load_copy_ingredients(db_session, tournament, [fixture])
    recipient_id = next(
        account.id
        for accounts in ingredients.accounts_by_player.values()
        for account in accounts
    )
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": recipient_id},
    )
    await db_session.commit()
    ingredients = await load_copy_ingredients(db_session, tournament, [fixture])
    assert recipient_id not in {
        account.id
        for accounts in ingredients.accounts_by_player.values()
        for account in accounts
    }


async def test_device_registration_refuses_inactive_cached_account(db_session):
    from app.notifications.service import InactiveNotificationAccount
    from app.schemas.notification import RegisterDeviceTokenRequest

    user = await make_user(db_session, "inactive-device-registration")
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": user.id},
    )
    await db_session.commit()
    with pytest.raises(InactiveNotificationAccount):
        await NotificationService(db_session, FakeSender()).register_device_token(
            user,
            RegisterDeviceTokenRequest(
                token="inactive-device", platform="ios", environment="sandbox"
            ),
        )


async def test_queued_notification_job_skips_recipient_suspended_before_worker(
    db_session, engine, fake_notifications_queue, monkeypatch
):
    import asyncio

    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.notifications import jobs
    from app.schemas.notification import NotificationJob

    user = await make_user(db_session, "delayed-notification")
    service = NotificationService(db_session, FakeSender())
    service.enqueue_notification(
        NotificationJob(
            user_id=user.id,
            category=NotificationCategory.MATCH_CALLS,
            title="Table call",
            body="Go to table 2",
        )
    )
    queued = fake_notifications_queue.jobs[-1]
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": user.id},
    )
    await db_session.commit()
    sender = FakeSender()
    worker_engine = create_async_engine(engine.url, poolclass=NullPool)
    monkeypatch.setattr(jobs, "get_engine", lambda: worker_engine)
    monkeypatch.setattr(jobs, "push_sender_from_env", lambda: sender)
    try:
        await asyncio.to_thread(queued.perform)
    finally:
        await worker_engine.dispose()
    assert sender.sent == []
    assert await db_session.scalar(select(Notification.id)) is None


async def test_inactive_cached_account_cannot_change_notification_preferences(
    db_session,
):
    from app.notifications.service import InactiveNotificationAccount
    from app.schemas.notification import NotificationPreferencesUpdate

    user = await make_user(db_session, "inactive-preferences")
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": user.id},
    )
    await db_session.commit()
    with pytest.raises(InactiveNotificationAccount):
        await NotificationService(db_session, FakeSender()).update_preferences(
            user,
            NotificationPreferencesUpdate.model_validate(
                {
                    "channels": [{"channel": "push", "enabled": False}],
                }
            ),
        )


async def test_preference_update_holds_activity_until_commit(db_session, monkeypatch):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.schemas.notification import NotificationPreferencesUpdate

    user = await make_user(db_session, "preference-activity-race")
    entered, release = asyncio.Event(), asyncio.Event()
    original = NotificationService._set_channel_override

    async def paused_update(self, *args, **kwargs):
        entered.set()
        await release.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(NotificationService, "_set_channel_override", paused_update)
    sessions = async_sessionmaker(db_session.bind, expire_on_commit=False)
    async with sessions() as writer, sessions() as lifecycle:
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        update = asyncio.create_task(
            NotificationService(writer, FakeSender()).update_preferences(
                user,
                NotificationPreferencesUpdate.model_validate(
                    {
                        "channels": [{"channel": "push", "enabled": False}],
                    }
                ),
            )
        )
        await asyncio.wait_for(entered.wait(), 5)
        suspension = asyncio.create_task(
            lifecycle.execute(
                text(
                    "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
                ),
                {"id": user.id},
            )
        )
        try:
            async with asyncio.timeout(5):
                while writer_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": lifecycle_pid}
                ):
                    assert not suspension.done(), (
                        "suspension bypassed preference writer"
                    )
                    await asyncio.sleep(0.01)
        finally:
            release.set()
            await update
            await suspension
            await lifecycle.rollback()


async def test_retired_proposer_receives_standing_result_acceptance(
    db_session, fake_notifications_queue
):
    from app.identity_lifecycle import retire_player
    from app.match_result_notifications import notify_result_accepted
    from app.models import MatchResult
    from app.result_acceptance import accept_result
    from tests._helpers import enqueued_notification_jobs
    from tests.test_accept_result_service import _propose_standing

    match_id, result_id, opponent_id = await _propose_standing(
        db_session,
        creator_name="retired-result-proposer",
        opponent_name="active-result-acceptor",
    )
    proposal = await db_session.get(MatchResult, result_id)
    proposer_id = proposal.submitted_for_player_id
    account_id = proposal.submitted_by_user_id
    await retire_player(db_session, proposer_id)
    await db_session.commit()
    fake_notifications_queue.empty()
    completed = await accept_result(
        db_session, match_id, opponent_id, result_id=result_id
    )
    await notify_result_accepted(
        NotificationService(db_session, FakeSender()), completed, proposer_id
    )
    notices = enqueued_notification_jobs(fake_notifications_queue)
    assert [notice.user_id for notice in notices] == [account_id]
    assert notices[0].collapse_id == f"result-accepted:{match_id}"
