from fastapi.testclient import TestClient


def test_ping_responds_with_pong(client: TestClient) -> None:
    response = client.get("/v1/ping")

    assert response.status_code == 200
    assert response.json() == {"message": "pong"}
