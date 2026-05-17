import os

from redis import Redis
from rq import Queue

SOLVER_QUEUE = "solver"
EMAIL_QUEUE = "email"


def _connection() -> Redis:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    return Redis.from_url(redis_url)


def get_queue() -> Queue:
    return Queue(SOLVER_QUEUE, connection=_connection())


def get_email_queue() -> Queue:
    return Queue(EMAIL_QUEUE, connection=_connection())
