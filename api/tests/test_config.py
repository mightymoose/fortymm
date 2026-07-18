"""``app.config.Settings`` — the shared pydantic-settings object.

``get_settings()`` builds a fresh ``Settings`` on every call (never cached at
import time), so tests can override an env var with ``monkeypatch.setenv``
per test and see it take effect immediately — mirroring
``app.db.get_database_url()``.
"""

import pytest

from app.config import get_settings


def test_solver_time_cap_defaults_to_ten_seconds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOLVER_TIME_CAP_S", raising=False)
    assert get_settings().solver_time_cap_s == 10.0


@pytest.mark.parametrize(
    "env_value, expected",
    [
        ("45.5", 45.5),
        # A one-off big solve may need up to 1200s (20 min) per the issue;
        # a large value must pass through untouched — no upper clamp.
        ("1200", 1200.0),
    ],
)
def test_solver_time_cap_reads_from_env(
    monkeypatch: pytest.MonkeyPatch, env_value: str, expected: float
) -> None:
    monkeypatch.setenv("SOLVER_TIME_CAP_S", env_value)
    assert get_settings().solver_time_cap_s == expected


def test_get_settings_rereads_env_on_every_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Not a module-level constant computed once at import time — each call
    picks up the current environment."""
    monkeypatch.delenv("SOLVER_TIME_CAP_S", raising=False)
    assert get_settings().solver_time_cap_s == 10.0

    monkeypatch.setenv("SOLVER_TIME_CAP_S", "99")
    assert get_settings().solver_time_cap_s == 99.0
