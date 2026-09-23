"""Notification preferences: the channel masters + per-cell matrix, and how
the resolved preferences gate what ``notify`` actually delivers."""

import inspect
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app import queue as queue_module
from app.models import (
    DeviceToken,
    Notification,
    NotificationChannelSetting,
    NotificationPreference,
)
from app.notifications import jobs as notification_jobs
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory, NotificationChannel
from app.schemas.notification import (
    NotificationCellUpdate,
    NotificationChannelUpdate,
    NotificationJob,
    NotificationPreferencesUpdate,
)
from tests._helpers import FakeSender, make_user, start_session

NOTIFICATION_EMAIL_V2_QUEUE = "notification-email-v2"
DELIVER_NOTIFICATION_EMAIL_V2_JOB = (
    "app.notifications.jobs.deliver_notification_email_v2"
)


@pytest.fixture
def versioned_email_queues(fake_email_queue, monkeypatch: pytest.MonkeyPatch):
    """Model old and new workers sharing Redis but listening to distinct queues."""
    fake_email_queue._is_async = True
    new_queue = queue_module.get_notification_email_v2_queue()
    return fake_email_queue, new_queue


def _channels(data: dict) -> dict[str, dict]:
    return {c["channel"]: c for c in data["channels"]}


def _cells(data: dict, category: str) -> dict[str, dict]:
    row = next(c for c in data["categories"] if c["category"] == category)
    return {cell["channel"]: cell for cell in row["cells"]}


# ----- defaults -------------------------------------------------------------


async def test_default_channels(api_client: AsyncClient, db_session: AsyncSession):
    await start_session(api_client, db_session)
    data = (await api_client.get("/v1/notification-preferences")).json()
    channels = _channels(data)

    assert channels["in_app"] == {
        "channel": "in_app",
        "enabled": True,
        "available": True,
        "locked": True,
        "destination": "Always on, in your feed",
        "setup_required": False,
    }
    assert channels["push"]["enabled"] is True
    assert channels["push"]["locked"] is False
    assert channels["push"]["destination"] == "No devices yet — open the app"
    # No devices and no confirmed email yet: both prompt for setup.
    assert channels["push"]["setup_required"] is True
    assert channels["email"]["enabled"] is True
    assert channels["email"]["destination"] == "Add an email in settings"
    assert channels["email"]["setup_required"] is True
    # SMS isn't wired up: surfaced but unavailable + off. Unavailable channels
    # don't nudge for setup.
    assert channels["sms"]["available"] is False
    assert channels["sms"]["enabled"] is False
    assert channels["sms"]["setup_required"] is False


async def test_default_matrix_locks_match_reminders(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    data = (await api_client.get("/v1/notification-preferences")).json()
    reminders = _cells(data, "match_reminder")

    assert reminders["in_app"] == {"channel": "in_app", "enabled": True, "locked": True}
    assert reminders["push"] == {"channel": "push", "enabled": True, "locked": True}
    assert reminders["email"]["locked"] is False
    assert reminders["email"]["enabled"] is True
    assert reminders["sms"]["enabled"] is False

    # A non-locked category starts fully on for available channels.
    ratings = _cells(data, "rating_change")
    assert ratings["push"] == {"channel": "push", "enabled": True, "locked": False}


async def test_push_destination_reflects_device_count(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    db_session.add(
        DeviceToken(token="tok", platform="ios", environment="sandbox", user_id=user.id)
    )
    await db_session.commit()

    data = (await api_client.get("/v1/notification-preferences")).json()
    assert _channels(data)["push"]["destination"] == "1 device"
    # A registered device means push is set up — no nudge.
    assert _channels(data)["push"]["setup_required"] is False


async def test_email_destination_shows_confirmed_address(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    user.email = "player@fortymm.club"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()

    data = (await api_client.get("/v1/notification-preferences")).json()
    assert _channels(data)["email"]["destination"] == "player@fortymm.club"
    # A confirmed address means email is set up — no nudge.
    assert _channels(data)["email"]["setup_required"] is False


async def test_email_setup_required_until_confirmed(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    # Address on file but not yet confirmed: the channel still can't deliver, so
    # the nudge stays up.
    user.email = "player@fortymm.club"
    user.confirmed_at = None
    await db_session.commit()

    data = (await api_client.get("/v1/notification-preferences")).json()
    assert _channels(data)["email"]["setup_required"] is True


async def test_setup_required_is_gated_on_availability(db_session: AsyncSession):
    user = await make_user(db_session, "no-setup")
    # Push's prerequisite is unmet (zero devices). If the channel is available,
    # that's a nudge; if the server can't deliver on it at all, it isn't — there
    # is nothing the user could do to make it work.
    assert (
        NotificationService._channel_setup_required(
            NotificationChannel.PUSH, user, 0, available=True
        )
        is True
    )
    assert (
        NotificationService._channel_setup_required(
            NotificationChannel.PUSH, user, 0, available=False
        )
        is False
    )


# ----- updates --------------------------------------------------------------


async def test_mute_channel_master(api_client: AsyncClient, db_session: AsyncSession):
    user = await start_session(api_client, db_session)
    response = await api_client.patch(
        "/v1/notification-preferences",
        json={"channels": [{"channel": "push", "enabled": False}]},
    )
    assert response.status_code == 200
    assert _channels(response.json())["push"]["enabled"] is False

    rows = (
        (
            await db_session.execute(
                select(NotificationChannelSetting).where(
                    NotificationChannelSetting.user_id == user.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].channel == "push"
    assert rows[0].enabled is False


async def test_resetting_to_default_removes_the_override(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    await api_client.patch(
        "/v1/notification-preferences",
        json={"channels": [{"channel": "push", "enabled": False}]},
    )
    await api_client.patch(
        "/v1/notification-preferences",
        json={"channels": [{"channel": "push", "enabled": True}]},
    )
    rows = (
        (
            await db_session.execute(
                select(NotificationChannelSetting).where(
                    NotificationChannelSetting.user_id == user.id
                )
            )
        )
        .scalars()
        .all()
    )
    # Storing the default is the same as no row — the table stays sparse.
    assert rows == []


async def test_mute_one_cell(api_client: AsyncClient, db_session: AsyncSession):
    user = await start_session(api_client, db_session)
    response = await api_client.patch(
        "/v1/notification-preferences",
        json={
            "cells": [
                {"category": "rating_change", "channel": "email", "enabled": False}
            ]
        },
    )
    assert response.status_code == 200
    assert _cells(response.json(), "rating_change")["email"]["enabled"] is False

    rows = (
        (
            await db_session.execute(
                select(NotificationPreference).where(
                    NotificationPreference.user_id == user.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert (rows[0].category, rows[0].channel, rows[0].enabled) == (
        "rating_change",
        "email",
        False,
    )


async def test_locked_cell_change_is_ignored(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    response = await api_client.patch(
        "/v1/notification-preferences",
        json={
            "cells": [
                {"category": "match_reminder", "channel": "in_app", "enabled": False}
            ]
        },
    )
    assert response.status_code == 200
    assert _cells(response.json(), "match_reminder")["in_app"]["enabled"] is True
    rows = (
        (
            await db_session.execute(
                select(NotificationPreference).where(
                    NotificationPreference.user_id == user.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert rows == []


async def test_unavailable_channel_change_is_ignored(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    response = await api_client.patch(
        "/v1/notification-preferences",
        json={"channels": [{"channel": "sms", "enabled": True}]},
    )
    assert response.status_code == 200
    assert _channels(response.json())["sms"]["enabled"] is False
    rows = (
        (
            await db_session.execute(
                select(NotificationChannelSetting).where(
                    NotificationChannelSetting.user_id == user.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert rows == []


async def test_preferences_require_session(api_client: AsyncClient):
    assert (await api_client.get("/v1/notification-preferences")).status_code == 401
    assert (
        await api_client.patch("/v1/notification-preferences", json={})
    ).status_code == 401


# ----- delivery resolution (the point of preferences) -----------------------


async def _add_device(db_session: AsyncSession, user_id) -> None:
    db_session.add(
        DeviceToken(
            token=f"tok-{user_id}",
            platform="ios",
            environment="sandbox",
            user_id=user_id,
        )
    )
    await db_session.commit()


async def test_notify_defaults_deliver_in_app_push_and_email(
    db_session: AsyncSession,
    fake_email_queue,
):
    fake_email_queue._is_async = True
    user = await make_user(db_session, "deliverable")
    user.email = "d@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    await _add_device(db_session, user.id)

    sender = FakeSender()
    service = NotificationService(db_session, sender)
    result = await service.notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="Draw posted",
        body="R16 is live",
    )

    assert result.in_app_created is True
    assert result.pushed == 1
    assert result.emailed is True
    assert [p.token for p in sender.sent] == [f"tok-{user.id}"]
    stored = (
        (
            await db_session.execute(
                select(Notification).where(Notification.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    assert [n.title for n in stored] == ["Draw posted"]


async def test_notify_push_failure_does_not_drop_email(
    db_session: AsyncSession, fake_email_queue
):
    """#753: a DB error on the push path (device-token query or gone-token
    prune) must not sink the whole notification — the in-app row is already
    committed and the email still has to enqueue. The push branch catches the
    SQLAlchemyError, rolls back, and lets the remaining channels proceed."""
    fake_email_queue._is_async = True

    class DbFlappingService(NotificationService):
        async def _tokens_for_user(self, user_id):
            raise SQLAlchemyError("db connection lost mid-push")

    user = await make_user(db_session, "push-explodes")
    user.email = "boom@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    await _add_device(db_session, user.id)

    service = DbFlappingService(db_session, FakeSender())
    result = await service.notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="Draw posted",
        body="R16 is live",
    )

    # Push failed silently; the durable in-app row and the email both survive.
    assert result.pushed == 0
    assert result.in_app_created is True
    assert result.emailed is True
    stored = (
        (
            await db_session.execute(
                select(Notification).where(Notification.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    assert [n.title for n in stored] == ["Draw posted"]


async def test_notify_skips_muted_push(db_session: AsyncSession):
    user = await make_user(db_session, "muted-push")
    await _add_device(db_session, user.id)
    sender = FakeSender()
    service = NotificationService(db_session, sender)
    await service.update_preferences(
        user,
        NotificationPreferencesUpdate(
            channels=[
                NotificationChannelUpdate(
                    channel=NotificationChannel.PUSH, enabled=False
                )
            ]
        ),
    )

    result = await service.notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="t",
        body="b",
    )

    assert result.in_app_created is True
    assert result.pushed == 0
    assert sender.sent == []


async def test_notify_skips_muted_cell_even_with_channel_on(
    db_session: AsyncSession,
):
    user = await make_user(db_session, "muted-cell")
    await _add_device(db_session, user.id)
    sender = FakeSender()
    service = NotificationService(db_session, sender)
    # Push master stays on, but push is muted for this one category.
    await service.update_preferences(
        user,
        NotificationPreferencesUpdate(
            cells=[
                NotificationCellUpdate(
                    category=NotificationCategory.TOURNAMENT,
                    channel=NotificationChannel.PUSH,
                    enabled=False,
                )
            ]
        ),
    )

    result = await service.notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="t",
        body="b",
    )
    assert result.pushed == 0
    # A different category still pushes — the mute is per-cell.
    other = await service.notify(
        user_id=user.id,
        category=NotificationCategory.OPPONENT,
        title="t2",
        body="b2",
    )
    assert other.pushed == 1


async def test_notify_missing_user_is_noop(db_session: AsyncSession):
    import uuid

    service = NotificationService(db_session, FakeSender())
    result = await service.notify(
        user_id=uuid.uuid4(),
        category=NotificationCategory.TOURNAMENT,
        title="t",
        body="b",
    )
    assert result.in_app_created is False
    assert result.pushed == 0
    assert result.emailed is False


async def test_notify_reroutes_tombstoned_user_to_active_survivor(
    db_session: AsyncSession,
):
    """Delayed work addressed to a merged account follows its survivor."""
    survivor = await make_user(db_session, "survivor")
    ghost = await make_user(db_session, "ghost")
    ghost.merged_into_user_id = survivor.id
    ghost.merged_at = datetime.now(UTC)
    await db_session.commit()

    sender = FakeSender()
    service = NotificationService(db_session, sender)
    result = await service.notify(
        user_id=ghost.id,
        category=NotificationCategory.TOURNAMENT,
        title="t",
        body="b",
    )

    assert result.in_app_created is True
    assert sender.sent == []
    ghost_rows = (
        (
            await db_session.execute(
                select(Notification).where(Notification.user_id == ghost.id)
            )
        )
        .scalars()
        .all()
    )
    survivor_rows = (
        (
            await db_session.execute(
                select(Notification).where(Notification.user_id == survivor.id)
            )
        )
        .scalars()
        .all()
    )
    assert ghost_rows == []
    assert [(row.title, row.body) for row in survivor_rows] == [("t", "b")]


async def test_queued_email_re_resolves_merged_survivor_and_current_address(
    db_session: AsyncSession,
    versioned_email_queues,
    monkeypatch,
) -> None:
    old_queue, new_queue = versioned_email_queues
    payer = await make_user(db_session, "queued-email-payer")
    payer.email = "old@example.com"
    payer.confirmed_at = datetime.now(UTC)
    survivor = await make_user(db_session, "queued-email-survivor")
    survivor.email = "current@example.com"
    survivor.confirmed_at = datetime.now(UTC)
    await db_session.commit()

    queued = await NotificationService(db_session, FakeSender()).notify(
        user_id=payer.id,
        category=NotificationCategory.TOURNAMENT,
        title="Registration confirmed",
        body="Your entry is confirmed.",
        channels=[NotificationChannel.EMAIL],
    )
    assert queued.emailed is True
    assert old_queue.get_jobs() == []
    [job] = new_queue.get_jobs()
    assert job.origin == NOTIFICATION_EMAIL_V2_QUEUE
    assert job.func_name == DELIVER_NOTIFICATION_EMAIL_V2_JOB
    assert "@" not in json.dumps(job.args)

    payer.merged_into_user_id = survivor.id
    payer.merged_at = datetime.now(UTC)
    await db_session.commit()
    sent: list[str] = []
    monkeypatch.setattr(
        "app.email.send_notification_email",
        lambda to_email, *_args, **_kwargs: sent.append(to_email),
    )

    await notification_jobs._deliver_notification_email_v2(
        uuid.UUID(job.args[0]), *job.args[1:]
    )

    assert sent == ["current@example.com"]


async def test_queued_email_rechecks_preferences_and_receipt_duplicate_at_delivery(
    db_session: AsyncSession,
    versioned_email_queues,
    monkeypatch,
) -> None:
    old_queue, new_queue = versioned_email_queues
    user = await make_user(db_session, "queued-email-dedup")
    user.email = "receipt@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()

    queued = await NotificationService(db_session, FakeSender()).notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="Registration confirmed",
        body="Your entry is confirmed.",
        channels=[NotificationChannel.EMAIL],
        email_already_delivered_to="RECEIPT@example.com",
    )
    assert queued.emailed is True
    assert old_queue.get_jobs() == []
    [job] = new_queue.get_jobs()
    assert job.func_name == DELIVER_NOTIFICATION_EMAIL_V2_JOB
    assert "@" not in json.dumps(job.args)
    sent: list[str] = []
    monkeypatch.setattr(
        "app.email.send_notification_email",
        lambda to_email, *_args, **_kwargs: sent.append(to_email),
    )

    await notification_jobs._deliver_notification_email_v2(
        uuid.UUID(job.args[0]), *job.args[1:]
    )

    assert sent == []


async def test_queued_email_without_keyed_duplicate_evidence_is_delivered(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A missing key is no evidence that an unrelated email was delivered."""
    monkeypatch.delenv("FORTYMM_DEV", raising=False)
    monkeypatch.delenv("NOTIFICATION_EMAIL_DEDUP_SECRET", raising=False)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
    user = await make_user(db_session, "queued-email-no-dedup-key")
    user.email = "notification@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    sent: list[str] = []
    monkeypatch.setattr(
        "app.email.send_notification_email",
        lambda to_email, *_args, **_kwargs: sent.append(to_email),
    )

    # Deployed payment-disabled configurations may intentionally omit the
    # dedup secret.  ``None`` in the queued envelope means "no evidence", not
    # "the current address already received this notification".
    await notification_jobs._deliver_notification_email_v2(
        user.id,
        "Tournament update",
        "Registration opens tomorrow.",
        None,
        NotificationCategory.TOURNAMENT.value,
        None,
    )

    assert sent == ["notification@example.com"]


async def test_queued_email_honors_preference_changed_before_final_delivery(
    db_session: AsyncSession,
    versioned_email_queues,
    monkeypatch,
) -> None:
    old_queue, new_queue = versioned_email_queues
    user = await make_user(db_session, "queued-email-muted")
    user.email = "muted-later@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    result = await NotificationService(db_session, FakeSender()).notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="Registration confirmed",
        body="Your entry is confirmed.",
        channels=[NotificationChannel.EMAIL],
    )
    assert result.emailed is True
    assert old_queue.get_jobs() == []
    [job] = new_queue.get_jobs()
    assert job.func_name == DELIVER_NOTIFICATION_EMAIL_V2_JOB

    db_session.add(
        NotificationPreference(
            user_id=user.id,
            category=NotificationCategory.TOURNAMENT.value,
            channel=NotificationChannel.EMAIL.value,
            enabled=False,
        )
    )
    await db_session.commit()
    sent: list[str] = []
    monkeypatch.setattr(
        "app.email.send_notification_email",
        lambda to_email, *_args, **_kwargs: sent.append(to_email),
    )

    await notification_jobs._deliver_notification_email_v2(
        uuid.UUID(job.args[0]), *job.args[1:]
    )

    assert sent == []


@pytest.mark.parametrize("category", list(NotificationCategory))
async def test_legacy_notification_email_jobs_remain_consumable_for_every_category(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    category: NotificationCategory,
) -> None:
    """A new worker must drain every old producer's exact five-argument job.

    The legacy payload has no category, so compatibility cannot classify or
    preference-gate it.  Its safe rolling-deploy contract is the old one:
    require the same live confirmed account/address, then deliver.  Generic
    queued jobs must not be discarded merely because their title is unknown.
    """
    user = await make_user(
        db_session, f"legacy-{category.value}-{uuid.uuid4().hex[:6]}"
    )
    user.email = "current@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.email.send_notification_email",
        lambda to_email, subject, *_args, **_kwargs: sent.append((to_email, subject)),
    )

    title = f"Legacy {category.value} notification"
    await notification_jobs._deliver_email(
        user.id,
        "current@example.com",
        title,
        "This generic pre-deploy notification must drain.",
        f"/notifications/{category.value}",
    )

    assert sent == [("current@example.com", title)]


async def test_legacy_notification_email_handler_keeps_exact_old_contract(
    db_session: AsyncSession,
    fake_email_queue,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Old producers and already-pickled jobs retain their import path and arity."""
    signature = inspect.signature(notification_jobs.deliver_notification_email)
    assert list(signature.parameters) == [
        "account_id",
        "to_email",
        "title",
        "body",
        "link",
    ]
    assert all(
        parameter.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
        for parameter in signature.parameters.values()
    )
    assert signature.parameters["link"].default is None

    user = await make_user(db_session, "legacy-address-snapshot")
    user.email = "current@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    fake_email_queue._is_async = True
    legacy_args = (
        str(user.id),
        "stale-queued@example.com",
        "Generic old notification",
        "Body",
        None,
    )
    fake_email_queue.enqueue(
        "app.notifications.jobs.deliver_notification_email", *legacy_args
    )
    [legacy_job] = fake_email_queue.get_jobs()
    assert legacy_job.func_name == "app.notifications.jobs.deliver_notification_email"
    assert legacy_job.args == legacy_args

    sent: list[str] = []
    monkeypatch.setattr(
        "app.email.send_notification_email",
        lambda to_email, *_args, **_kwargs: sent.append(to_email),
    )

    # Old semantics validate the address snapshot. They do not silently upgrade
    # an old job to the new merge/preference/dedup contract.
    await notification_jobs._deliver_email(
        user.id,
        "stale-queued@example.com",
        "Generic old notification",
        "Body",
        None,
    )

    assert sent == []


def test_new_workers_are_configured_to_drain_new_and_legacy_email_queues() -> None:
    """New deployments drain old jobs, while old workers cannot reserve v2 jobs."""
    repo_root = Path(__file__).parents[2]
    configurations = {
        "dev compose": repo_root / "docker-compose.dev.yml",
        "qa compose": repo_root / "docker-compose.qa.yml",
        "helm": repo_root / "deploy/fortymm/values.yaml",
    }

    for label, path in configurations.items():
        contents = path.read_text()
        worker_lines = [
            line
            for line in contents.splitlines()
            if "rq worker" in line or "queues:" in line
        ]
        assert worker_lines, label
        queue_tokens = worker_lines[0].split()
        assert NOTIFICATION_EMAIL_V2_QUEUE in queue_tokens, label
        assert "email" in queue_tokens, label
        assert queue_tokens.index(NOTIFICATION_EMAIL_V2_QUEUE) < queue_tokens.index(
            "email"
        ), label


def test_notification_email_duplicate_token_is_versioned_keyed_evidence(
    monkeypatch,
) -> None:
    monkeypatch.setenv("NOTIFICATION_EMAIL_DEDUP_SECRET", "deployment-secret")

    job = NotificationJob(
        user_id=uuid.UUID("00000000-0000-0000-0000-000000000177"),
        category=NotificationCategory.TOURNAMENT,
        title="Registration confirmed",
        body="Your entry is confirmed.",
        email_already_delivered_to=" Person@Example.com ",
    )
    serialized = job.model_dump_json()

    # Independent known HMAC-SHA256 vector over the normalized address. The
    # version prefix permits key/algorithm rotation without ambiguous Redis
    # payloads; the address itself must never be dictionary-recoverable SHA256.
    assert job.email_already_delivered_key == (
        "v1:2d2eee6cb76b35d5d691af9556577fecf0b2fe5e23b91423b5957dac6695081d"
    )
    assert "person@example.com" not in serialized.casefold()


async def test_notify_skips_muted_email(db_session: AsyncSession):
    user = await make_user(db_session, "muted-email")
    user.email = "m@example.com"
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()
    service = NotificationService(db_session, FakeSender())
    await service.update_preferences(
        user,
        NotificationPreferencesUpdate(
            channels=[
                NotificationChannelUpdate(
                    channel=NotificationChannel.EMAIL, enabled=False
                )
            ]
        ),
    )

    result = await service.notify(
        user_id=user.id,
        category=NotificationCategory.TOURNAMENT,
        title="t",
        body="b",
    )
    assert result.emailed is False
