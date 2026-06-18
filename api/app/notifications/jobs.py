"""Background delivery for notifications. Invoked by RQ workers.

``notify`` is async (async SQLAlchemy + APNs), but RQ workers are sync
processes, so the entry point is a thin ``asyncio.run`` wrapper that opens its
own ``async_sessionmaker`` from ``app.db.get_engine`` and constructs a
process-local ``PushSender`` — mirroring ``app.ratings.jobs``.
"""

import asyncio
import logging

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.db import get_engine
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
        )
