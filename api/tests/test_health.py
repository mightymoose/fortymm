from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_empty_json():
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {}
    assert response.headers["content-type"] == "application/json"
