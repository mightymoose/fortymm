from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from fortymm_api.main import create_app


@pytest.fixture(autouse=True)
def no_deploy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every test as in local dev, whatever the shell has set."""
    monkeypatch.delenv("WORKER_SECRET", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as client:
        yield client
