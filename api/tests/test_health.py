from fastapi.testclient import TestClient


def test_health_reaches_the_database(client: TestClient) -> None:
    response = client.get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {"data": {"database": "ok"}}
