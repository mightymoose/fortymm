"""Realtime dashboard invalidation: envelope, publisher, outbox, broker.

See ``events`` for the wire shape and the per-user topic rule, ``publisher`` for
the fire-and-forget write side, ``outbox`` for the session-staged, commit-gated
way write paths reach that publisher, and ``broker`` for the multiplexed read
side. The HTTP stream route and the write-path staging call sites live outside
this package.

Importing this package registers the outbox's SQLAlchemy ``after_commit`` /
``after_soft_rollback`` listeners — see ``outbox``.
"""

from app.realtime.broker import (
    RealtimeBroker,
    TooManyRealtimeConnections,
    get_broker,
    init_broker,
    shutdown_broker,
)
from app.realtime.events import CHANNEL_PREFIX, EventKind, RealtimeEvent, user_channel
from app.realtime.outbox import stage_event
from app.realtime.publisher import publish_event, publish_events

__all__ = [
    "CHANNEL_PREFIX",
    "EventKind",
    "RealtimeBroker",
    "RealtimeEvent",
    "TooManyRealtimeConnections",
    "get_broker",
    "init_broker",
    "publish_event",
    "publish_events",
    "shutdown_broker",
    "stage_event",
    "user_channel",
]
