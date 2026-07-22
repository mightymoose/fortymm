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


#: The seven Auth0 / MCP OAuth settings, paired with the env var pydantic-settings
#: maps each from. Empty (unset) means unconfigured = fail-closed per the Auth0
#: Resource-Server ADR.
AUTH0_SETTINGS: list[tuple[str, str]] = [
    ("auth0_domain", "AUTH0_DOMAIN"),
    ("auth0_audience", "AUTH0_AUDIENCE"),
    ("auth0_link_client_id", "AUTH0_LINK_CLIENT_ID"),
    ("auth0_link_client_secret", "AUTH0_LINK_CLIENT_SECRET"),
    ("mcp_public_base_url", "MCP_PUBLIC_BASE_URL"),
    ("mcp_public_resource_url", "MCP_PUBLIC_RESOURCE_URL"),
    ("auth0_link_redirect_uri", "AUTH0_LINK_REDIRECT_URI"),
]


@pytest.mark.parametrize("attr, env_var", AUTH0_SETTINGS)
def test_auth0_setting_reads_from_env(
    monkeypatch: pytest.MonkeyPatch, attr: str, env_var: str
) -> None:
    monkeypatch.setenv(env_var, f"value-for-{env_var}")
    assert getattr(get_settings(), attr) == f"value-for-{env_var}"


@pytest.mark.parametrize("attr, env_var", AUTH0_SETTINGS)
def test_auth0_setting_defaults_to_empty_when_unset(
    monkeypatch: pytest.MonkeyPatch, attr: str, env_var: str
) -> None:
    """Empty (unconfigured) is the fail-closed default — MCP 401s until set."""
    monkeypatch.delenv(env_var, raising=False)
    assert getattr(get_settings(), attr) == ""
