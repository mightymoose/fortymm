import os

from redis import Redis
from rq import Queue

SOLVER_QUEUE = "solver"
#: The dedicated queue an ephemeral **schedule preview** solve runs on (ADR "a
#: schedule preview is a non-persistent solve over a synthetic field"). The
#: worker lists it *ahead of* ``solver`` (``rq worker preview solver``) so a
#: preview is dequeued before pending real solves but never preempts one already
#: in flight; its job persists nothing and its result lives only in Redis.
PREVIEW_QUEUE = "preview"
EMAIL_QUEUE = "email"
RATINGS_QUEUE = "ratings"
NOTIFICATIONS_QUEUE = "notifications"
# Reserved for a future enqueue-based retirement trigger. The current periodic
# trigger (task #9 / ADR 0007 O8) runs the sweep *inline* via
# ``python -m app.retirement_sweep`` on a schedule (Helm CronJob in UAT, a small
# looping compose service in dev/qa/uat), so nothing is currently enqueued here
# and no rq worker processes this queue.
RETIREMENT_QUEUE = "retirement"


def _connection() -> Redis:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    return Redis.from_url(redis_url)


def get_queue() -> Queue:
    return Queue(SOLVER_QUEUE, connection=_connection())


def get_preview_queue() -> Queue:
    return Queue(PREVIEW_QUEUE, connection=_connection())


def get_email_queue() -> Queue:
    return Queue(EMAIL_QUEUE, connection=_connection())


def get_ratings_queue() -> Queue:
    return Queue(RATINGS_QUEUE, connection=_connection())


def get_notifications_queue() -> Queue:
    return Queue(NOTIFICATIONS_QUEUE, connection=_connection())


def get_retirement_queue() -> Queue:
    return Queue(RETIREMENT_QUEUE, connection=_connection())
