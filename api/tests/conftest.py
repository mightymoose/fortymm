import fakeredis
import pytest
from rq import Queue

from app import queue as queue_module


@pytest.fixture(autouse=True)
def fake_solver_queue(monkeypatch):
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.SOLVER_QUEUE, connection=connection, is_async=False)
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q
