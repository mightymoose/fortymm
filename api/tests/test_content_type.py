from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fortymm_api.main import create_app

UNSUPPORTED = {
    "errors": [
        {"status": "415", "title": "Requests must send Content-Type: application/json"}
    ]
}
WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]


def add_routes(app: FastAPI) -> None:
    @app.api_route("/notes", methods=["GET", *WRITE_METHODS])
    def notes() -> None:
        pass


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app()
    add_routes(app)
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize("method", WRITE_METHODS)
def test_rejects_a_write_without_a_content_type(
    client: TestClient, method: str
) -> None:
    response = client.request(method, "/notes")

    assert response.status_code == 415
    assert response.json() == UNSUPPORTED


@pytest.mark.parametrize(
    "content_type", ["text/plain", "application/x-www-form-urlencoded"]
)
def test_rejects_a_write_with_another_content_type(
    client: TestClient, content_type: str
) -> None:
    response = client.post("/notes", headers={"Content-Type": content_type})

    assert response.status_code == 415
    assert response.json() == UNSUPPORTED


@pytest.mark.parametrize("method", WRITE_METHODS)
@pytest.mark.parametrize(
    "content_type",
    ["application/json", "application/json; charset=utf-8", "Application/JSON"],
)
def test_accepts_a_write_that_sends_json(
    client: TestClient, method: str, content_type: str
) -> None:
    response = client.request(method, "/notes", headers={"Content-Type": content_type})

    assert response.status_code == 200


def test_accepts_a_read_without_a_content_type(client: TestClient) -> None:
    assert client.get("/notes").status_code == 200


def test_checks_the_worker_secret_first(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_SECRET", "s3cret")

    with TestClient(create_app()) as client:
        response = client.post("/v1/health")

    assert response.status_code == 403
