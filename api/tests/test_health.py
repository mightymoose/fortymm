import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app import main as main_module
from app import queue as queue_module
from app.main import ComponentHealth, app

client = TestClient(app)


@pytest.fixture
def healthy_database(monkeypatch):
    """Stub `_check_database` to report healthy without touching a real DB."""

    async def fake_db_check():
        return ComponentHealth(healthy=True, latency_ms=1.0)

    monkeypatch.setattr(main_module, "_check_database", fake_db_check)


@pytest.fixture
def broken_database(monkeypatch):
    """Make `_check_database` report unhealthy via a `get_engine` that raises."""

    class BrokenEngine:
        def connect(self):
            raise RuntimeError("postgres unreachable")

    monkeypatch.setattr(db_module, "get_engine", BrokenEngine)


@pytest.fixture
def broken_redis(monkeypatch):
    """Make `_check_redis` (and the solver check, which shares the queue
    connection) report unhealthy via a `get_queue` that raises."""

    def boom():
        raise RuntimeError("redis unreachable")

    monkeypatch.setattr(queue_module, "get_queue", boom)


def test_health_reports_all_components_healthy(healthy_database):
    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()

    assert set(body.keys()) == {"redis", "database", "solver"}
    for component in body.values():
        assert component["healthy"] is True
        assert component.get("error") is None
        assert component.get("latency_ms") is not None
    assert response.headers["content-type"] == "application/json"


def test_health_reports_redis_and_solver_unhealthy_when_queue_unavailable(
    healthy_database, broken_redis
):
    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()

    assert body["redis"]["healthy"] is False
    assert "redis unreachable" in body["redis"]["error"]
    assert body["solver"]["healthy"] is False
    assert "redis unreachable" in body["solver"]["error"]
    assert body["database"]["healthy"] is True


def test_health_awaits_solver_check_via_to_thread(healthy_database, monkeypatch):
    """The solver probe is blocking (RQ polling with time.sleep), so `health()`
    must hand it to `asyncio.to_thread` rather than calling it inline."""
    import asyncio

    def fake_solver_check():
        return ComponentHealth(healthy=True, latency_ms=5.0)

    monkeypatch.setattr(main_module, "_check_solver_sync", fake_solver_check)

    to_thread_calls = []
    real_to_thread = asyncio.to_thread

    async def spying_to_thread(func, /, *args, **kwargs):
        to_thread_calls.append(func)
        return await real_to_thread(func, *args, **kwargs)

    monkeypatch.setattr(main_module.asyncio, "to_thread", spying_to_thread)

    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()

    assert body["solver"] == {"healthy": True, "latency_ms": 5.0, "error": None}
    assert to_thread_calls == [fake_solver_check]


def test_health_reports_database_unhealthy_when_engine_broken(broken_database):
    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()

    assert body["database"]["healthy"] is False
    assert "postgres unreachable" in body["database"]["error"]


def test_readyz_returns_200_when_redis_and_database_healthy(healthy_database):
    response = client.get("/v1/readyz")
    assert response.status_code == 200
    body = response.json()

    assert set(body.keys()) == {"redis", "database"}
    assert body["redis"]["healthy"] is True
    assert body["database"]["healthy"] is True


def test_readyz_returns_503_when_database_unhealthy(broken_database):
    response = client.get("/v1/readyz")
    assert response.status_code == 503
    body = response.json()

    assert body["database"]["healthy"] is False
    assert "postgres unreachable" in body["database"]["error"]


def test_readyz_returns_503_when_redis_unhealthy(healthy_database, broken_redis):
    response = client.get("/v1/readyz")
    assert response.status_code == 503
    body = response.json()

    assert body["redis"]["healthy"] is False


def test_readyz_does_not_check_solver(healthy_database, monkeypatch):
    """A down solver worker must not fail readiness — it's an async RQ worker
    off the request path, not something the API needs to serve traffic."""

    def fail_if_called():
        raise AssertionError("readyz must not invoke the solver check")

    monkeypatch.setattr(main_module, "_check_solver_sync", fail_if_called)

    response = client.get("/v1/readyz")
    assert response.status_code == 200
