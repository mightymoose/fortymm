from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_responds_ok() -> None:
    assert client.get("/api/v1/health").status_code == 200


def test_health_reports_the_server_ok() -> None:
    assert client.get("/api/v1/health").json() == {"data": {"server": "ok"}}
