"""Background delivery for notifications. Invoked by RQ workers.

``notify`` is async (async SQLAlchemy + APNs), but RQ workers are sync
processes, so the entry point is a thin ``asyncio.run`` wrapper that opens its
own ``async_sessionmaker`` from ``app.db.get_engine`` and constructs a
process-local ``PushSender`` — mirroring ``app.ratings.jobs``.
"""

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import email
from app.db import get_engine
from app.models import Account
from app.notifications.apns import push_sender_from_env
from app.notifications.email_dedup import email_delivery_key
from app.notifications.service import NotificationService, effective_channels
from app.notifications.taxonomy import NotificationCategory, NotificationChannel
from app.schemas.notification import NotificationJob, NotificationJobV2

log = logging.getLogger(__name__)

DELIVER_NOTIFICATION_JOB = "app.notifications.jobs.deliver_notification"
DELIVER_NOTIFICATION_V2_JOB = "app.notifications.jobs.deliver_notification_v2"


def deliver_notification(payload_json: str) -> None:
    """RQ entry point. Deliver one notification to one recipient on whichever
    channels that user's preferences allow for the notification's category."""
    asyncio.run(_deliver(NotificationJob.model_validate_json(payload_json)))


def deliver_notification_v2(payload_json: str) -> None:
    """Deliver the versioned PII-free notification envelope."""
    envelope = NotificationJobV2.model_validate_json(payload_json)
    asyncio.run(_deliver(envelope.notification))


async def _deliver(job: NotificationJob) -> None:
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as db:
        service = NotificationService(db, push_sender_from_env())
        await service.notify(
            user_id=job.user_id,
            category=job.category,
            title=job.title,
            body=job.body,
            link=job.link,
            action_label=job.action_label,
            delta=job.delta,
            push_category=job.push_category,
            push_data=job.push_data,
            collapse_id=job.collapse_id,
            channels=job.channels,
            result_id=job.result_id,
            email_already_delivered_to=job.email_already_delivered_to,
            email_already_delivered_key=job.email_already_delivered_key,
        )


def deliver_notification_email(
    account_id: str, to_email: str, title: str, body: str, link: str | None = None
) -> None:
    """Deliver a legacy queued email using its original address-snapshot contract."""
    asyncio.run(_deliver_email(uuid.UUID(account_id), to_email, title, body, link))


async def _deliver_email(
    account_id: uuid.UUID,
    to_email: str,
    title: str,
    body: str,
    link: str | None,
) -> None:
    sessions = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessions() as db:
        recipient = await db.scalar(
            select(Account.id)
            .where(
                Account.id == account_id,
                Account.is_active,
                Account.email == to_email,
                Account.confirmed_at.is_not(None),
            )
            .with_for_update(read=True)
        )
        if recipient is not None:
            # Preserve the deployed handler's behavior while old jobs drain.
            email.send_notification_email(to_email, title, body, link)


def deliver_notification_email_v2(
    account_id: str,
    title: str,
    body: str,
    link: str | None,
    category: str,
    already_delivered_key: str | None,
) -> None:
    """Deliver a PII-free v2 job against current identity and preferences."""
    asyncio.run(
        _deliver_notification_email_v2(
            uuid.UUID(account_id),
            title,
            body,
            link,
            category,
            already_delivered_key,
        )
    )


async def _deliver_notification_email_v2(
    account_id: uuid.UUID,
    title: str,
    body: str,
    link: str | None,
    category: str,
    already_delivered_key: str | None,
) -> None:
    sessions = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessions() as db:
        account = await db.scalar(
            select(Account)
            .where(Account.id == account_id)
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        visited: set[uuid.UUID] = set()
        while account is not None and account.merged_into_user_id is not None:
            if account.id in visited:
                return
            visited.add(account.id)
            account = await db.scalar(
                select(Account)
                .where(Account.id == account.merged_into_user_id)
                .with_for_update(read=True)
                .execution_options(populate_existing=True)
            )
        if (
            account is None
            or not account.is_active
            or account.email is None
            or account.confirmed_at is None
        ):
            return
        try:
            parsed_category = NotificationCategory(category)
        except ValueError:
            log.warning(
                "Skipping notification email with unknown category %s", category
            )
            return
        enabled = await effective_channels(
            db,
            account.id,
            parsed_category,
            [NotificationChannel.EMAIL],
        )
        if NotificationChannel.EMAIL not in enabled:
            return
        current_email = account.email
        if (
            already_delivered_key is not None
            and already_delivered_key == email_delivery_key(current_email)
        ):
            return
        # The read locks keep activity and the address stable through the send.
        email.send_notification_email(current_email, title, body, link)
