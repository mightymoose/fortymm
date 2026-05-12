from fastapi.testclient import TestClient

from app import main as main_module
from app import queue as queue_module
from app.main import ComponentHealth, app

client = TestClient(app)


def test_health_reports_all_components_healthy(monkeypatch):
    async def fake_db_check():
        return ComponentHealth(healthy=True, latency_ms=2.3)

    monkeypatch.setattr(main_module, "_check_database", fake_db_check)

    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()

    assert set(body.keys()) == {"redis", "database", "solver"}
    for component in body.values():
        assert component["healthy"] is True
        assert component.get("error") is None
        assert component.get("latency_ms") is not None
    assert response.headers["content-type"] == "application/json"


def test_health_reports_redis_and_solver_unhealthy_when_queue_unavailable(monkeypatch):
    async def fake_db_check():
        return ComponentHealth(healthy=True, latency_ms=1.0)

    monkeypatch.setattr(main_module, "_check_database", fake_db_check)

    def boom():
        raise RuntimeError("redis unreachable")

    monkeypatch.setattr(queue_module, "get_queue", boom)

    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()

    assert body["redis"]["healthy"] is False
    assert "redis unreachable" in body["redis"]["error"]
    assert body["solver"]["healthy"] is False
    assert "redis unreachable" in body["solver"]["error"]
    assert body["database"]["healthy"] is True


def test_health_reports_database_unhealthy_when_engine_broken(monkeypatch):
    class BrokenEngine:
        def connect(self):
            raise RuntimeError("postgres unreachable")

    from app import db as db_module

    monkeypatch.setattr(db_module, "get_engine", BrokenEngine)

    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()

    assert body["database"]["healthy"] is False
    assert "postgres unreachable" in body["database"]["error"]
