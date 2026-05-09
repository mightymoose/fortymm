import os

from redis import Redis
from rq import Queue

SOLVER_QUEUE = "solver"


def get_queue() -> Queue:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    return Queue(SOLVER_QUEUE, connection=Redis.from_url(redis_url))
