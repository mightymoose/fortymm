"""FastAPI wiring for the notifications domain — the single place that knows how
to construct the push sender and service (api/CLAUDE.md service-layer rules).

The sender is a process-wide singleton (it holds an HTTP/2 connection pool and a
cached provider JWT, no request state) — unlike session-holding services, which
must stay request-scoped.
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.notifications.apns import PushSender, push_sender_from_env
from app.notifications.service import NotificationService

_sender: PushSender = push_sender_from_env()


def get_push_sender() -> PushSender:
    return _sender


def get_notification_service(
    db: AsyncSession = Depends(get_session),
    sender: PushSender = Depends(get_push_sender),
) -> NotificationService:
    return NotificationService(db, sender)
