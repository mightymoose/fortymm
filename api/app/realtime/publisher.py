"""Fire-and-forget publication of realtime hints.

Deliberately **synchronous**, mirroring ``app.queue._connection``. Two reasons,
both load-bearing:

* The same function has to work from the API process *and* from the RQ worker
  process (a worker-side solve is one of the write sites that invalidates a
  dashboard), and the worker has no event loop to await into.
* This codebase already calls sync Redis from async request paths — every
  ``enqueue_*`` does — so a sync ``PUBLISH`` introduces no new hazard, and
  ``PUBLISH`` is sub-millisecond and never blocks on a subscriber.

Sync from an async caller is only cheap if it is *actually* cheap, though, and
the dominant cost here is not the ``PUBLISH``. The outbox flushes inside
SQLAlchemy's greenlet during ``await db.commit()`` — i.e. on the event-loop
thread, on blocking sockets — so both of the costs a naive implementation pays
are paid as contiguous loop stalls:

* **Per-call connection setup.** Measured over the loopback hop the stacks use,
  a fresh ``Redis.from_url`` per publish costs ~1.9ms against ~0.18ms on a
  reused client. Hence :func:`_connection` hands back a process-wide client
  (:func:`_client`, memoized) instead of building one per hint.
* **Per-hint round trips.** A hint is per-user (ADR "realtime topics are
  per-user"), so a 32-entrant go-live is 32 publishes; one at a time that is
  ~6ms of blocked loop even on a reused connection. Hence
  :func:`publish_events`, which pipelines the whole batch into a single round
  trip (~0.3ms for 32).

The memo is keyed by pid as well as URL because the RQ worker forks per job: a
client inherited across ``fork`` would share a socket with the parent. Publishes
happen in the child, which therefore builds its own on first use.

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
from collections.abc import Sequence
from functools import lru_cache

from redis import Redis

from app.realtime.events import EventKind, RealtimeEvent, user_channel

log = logging.getLogger("uvicorn.error")

#: One pending publish: the affected user and what kind of staleness they have.
Hint = tuple[uuid.UUID, EventKind]


@lru_cache(maxsize=8)
def _client(redis_url: str, pid: int) -> Redis:
    """The process's Redis client for ``redis_url``, built once.

    ``pid`` is a cache key, not an argument: it is what makes a forked RQ
    worker child build its own client rather than inherit — and share the
    socket of — its parent's. ``Redis.from_url`` is lazy (no socket until the
    first command), so the memo costs nothing at import.
    """
    return Redis.from_url(redis_url)


def _connection() -> Redis:
    """The client to publish on. Patched wholesale by the test suite.

    The memoization lives *inside* here rather than around it on purpose: tests
    (``tests/conftest.py``'s ``realtime_publisher_redis``) replace this whole
    function with one returning their fake, so a cache at the call site would
    hand a stale client to a test that had just installed a fresh one.
    """
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    return _client(redis_url, os.getpid())


def publish_event(user_id: uuid.UUID, kind: EventKind) -> bool:
    """Publish one hint to ``user_id``'s topic. ``False`` if it did not go out.

    For the write paths that resolve an affected *set* — a draw advance, a
    tournament going live — prefer :func:`publish_events`, which spends one
    round trip on the whole set instead of one each.
    """
    return publish_events([(user_id, kind)])


def publish_events(hints: Sequence[Hint]) -> bool:
    """Publish every hint in ``hints`` in a single round trip. ``False`` on failure.

    Every write path resolves its own affected user set (ADR "realtime topics
    are per-user"), so a 32-entrant draw advance is 32 ``PUBLISH`` commands —
    but they are pipelined, so it is one network round trip, not 32. That
    matters because the caller is usually ``app.realtime.outbox``'s
    ``after_commit`` listener, whose cost is a stall on the event-loop thread.

    ``transaction=False``: the commands are independent idempotent
    invalidations, so wrapping them in MULTI/EXEC would buy atomicity nobody
    needs and cost two extra commands.
    """
    if not hints:
        return True
    try:
        pipeline = _connection().pipeline(transaction=False)
        for user_id, kind in hints:
            event = RealtimeEvent(kind=kind)
            pipeline.publish(user_channel(user_id), event.model_dump_json())
        pipeline.execute()
    except Exception:  # noqa: BLE001 -- fire-and-forget: a hint must never fail its write
        log.exception(
            "Failed to publish realtime hints (%d) for %d user(s)",
            len(hints),
            len({user_id for user_id, _ in hints}),
        )
        return False
    return True
