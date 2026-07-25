"""Fire-and-forget publication of a realtime hint.

Deliberately **synchronous**, on a fresh connection per call, mirroring
``app.queue._connection``. Two reasons, both load-bearing:

* The same function has to work from the API process *and* from the RQ worker
  process (a worker-side solve is one of the write sites that invalidates a
  dashboard), and the worker has no event loop to await into.
* This codebase already calls sync Redis from async request paths — every
  ``enqueue_*`` does — so a sync ``PUBLISH`` introduces no new hazard, and
  ``PUBLISH`` is sub-millisecond and never blocks on a subscriber.

Failure is swallowed on purpose. A hint is an optimization over the client's
existing refetch-on-navigation freshness, so a Redis hiccup must degrade the
dashboard to its pre-realtime behaviour rather than fail the write that
triggered it — the contract ``app.notifications.service.enqueue_notification_job``
already establishes. Callers get a ``bool`` if they want to assert on it in a
test; nothing in a request path should branch on it.

``REDIS_URL`` is read here rather than added to ``app.config.Settings``,
matching ``app/queue.py``'s grandfathered status: the publisher must be
constructible in a worker process that builds no ``Settings``. The realtime
*tunables* (coalesce window, caps, retry hints) do live on ``Settings``.
"""

import logging
import os
import uuid

from redis import Redis

from app.realtime.events import EventKind, RealtimeEvent, user_channel

log = logging.getLogger("uvicorn.error")


def _connection() -> Redis:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    return Redis.from_url(redis_url)


def publish_event(user_id: uuid.UUID, kind: EventKind) -> bool:
    """Publish one hint to ``user_id``'s topic. ``False`` if it did not go out.

    Every write path resolves its own affected user set and calls this once per
    affected user (ADR "realtime topics are per-user"), so a 32-entrant draw
    advance is 32 calls — cheap, but O(affected users), not O(1).
    """
    event = RealtimeEvent(kind=kind)
    try:
        _connection().publish(user_channel(user_id), event.model_dump_json())
    except Exception:  # noqa: BLE001 -- fire-and-forget: a hint must never fail its write
        log.exception("Failed to publish realtime %s hint for user %s", kind, user_id)
        return False
    return True
