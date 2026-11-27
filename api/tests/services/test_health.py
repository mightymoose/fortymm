import fortymm_core
import pytest

from app.services.health import HealthService


def test_the_core_is_healthy() -> None:
    assert HealthService().core_healthy is True


def test_the_core_is_unhealthy_when_it_misbehaves(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fortymm_core, "hello_world", lambda: "Goodbye")
    assert HealthService().core_healthy is False
