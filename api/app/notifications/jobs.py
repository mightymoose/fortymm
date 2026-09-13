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
from app.notifications.service import NotificationService
from app.schemas.notification import NotificationJob

log = logging.getLogger(__name__)

DELIVER_NOTIFICATION_JOB = "app.notifications.jobs.deliver_notification"


def deliver_notification(payload_json: str) -> None:
    """RQ entry point. Deliver one notification to one recipient on whichever
    channels that user's preferences allow for the notification's category."""
    asyncio.run(_deliver(NotificationJob.model_validate_json(payload_json)))


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
        )


def deliver_notification_email(
    account_id: str, to_email: str, title: str, body: str, link: str | None = None
) -> None:
    """Deliver queued notification email only while its original recipient is live."""
    asyncio.run(_deliver_email(uuid.UUID(account_id), to_email, title, body, link))


async def _deliver_email(
    account_id: uuid.UUID, to_email: str, title: str, body: str, link: str | None
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
            # Hold activity and address stable through the external send.
            email.send_notification_email(to_email, title, body, link)
