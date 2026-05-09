from fastapi.testclient import TestClient

from app import queue as queue_module
from app.main import app

client = TestClient(app)


def test_health_reports_solver_healthy():
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {"solver": {"healthy": True}}
    assert response.headers["content-type"] == "application/json"


def test_health_reports_solver_unhealthy_when_queue_unavailable(monkeypatch):
    def boom():
        raise RuntimeError("redis unreachable")

    monkeypatch.setattr(queue_module, "get_queue", boom)

    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {"solver": {"healthy": False}}
