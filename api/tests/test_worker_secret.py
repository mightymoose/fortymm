import pytest
from fastapi.testclient import TestClient

from fortymm_api.main import create_app

SECRET = "s3cret"
FORBIDDEN = {
    "errors": [{"status": "403", "title": "Requests must come through the Worker"}]
}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("WORKER_SECRET", SECRET)
    return TestClient(create_app())


def test_rejects_a_request_without_the_worker_secret(client: TestClient) -> None:
    response = client.get("/v1/ping")

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_rejects_a_request_with_the_wrong_worker_secret(client: TestClient) -> None:
    response = client.get("/v1/ping", headers={"X-FortyMM-Worker-Secret": "wrong"})

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_rejects_the_docs_without_the_worker_secret(client: TestClient) -> None:
    assert client.get("/openapi.json").status_code == 403
    assert client.get("/docs").status_code == 403


def test_accepts_a_request_with_the_worker_secret(client: TestClient) -> None:
    response = client.get("/v1/ping", headers={"X-FortyMM-Worker-Secret": SECRET})

    assert response.status_code == 200
    assert response.json() == {"data": "pong"}


def test_refuses_to_start_on_cloud_run_without_the_worker_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("K_SERVICE", "api")

    with pytest.raises(RuntimeError, match="WORKER_SECRET"):
        create_app()
