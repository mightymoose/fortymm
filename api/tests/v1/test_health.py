from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.health import HealthService

client = TestClient(app)


class UnhealthyCore(HealthService):
    @property
    def core_healthy(self) -> bool:
        return False


@pytest.fixture
def unhealthy_core() -> Iterator[None]:
    app.dependency_overrides[HealthService] = UnhealthyCore
    yield
    app.dependency_overrides.clear()


def test_health_responds_ok() -> None:
    assert client.get("/api/v1/health").status_code == 200


def test_health_reports_the_server_and_core() -> None:
    assert client.get("/api/v1/health").json() == {"data": {"server": "ok", "coreHealthy": True}}


@pytest.mark.usefixtures("unhealthy_core")
def test_health_reports_the_core_unhealthy_when_the_service_says_so() -> None:
    assert client.get("/api/v1/health").json()["data"]["coreHealthy"] is False
