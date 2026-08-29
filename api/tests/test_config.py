"""``app.config.Settings`` — the shared pydantic-settings object.

``get_settings()`` builds a fresh ``Settings`` on every call (never cached at
import time), so tests can override an env var with ``monkeypatch.setenv``
per test and see it take effect immediately — mirroring
``app.db.get_database_url()``.
"""

import pytest
from pydantic import ValidationError

from app.config import McpConnectorConfig, get_settings


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


#: The Auth0 / MCP OAuth settings, paired with the env var pydantic-settings
#: maps each from. Empty (unset) means unconfigured = fail-closed per the Auth0
#: Resource-Server ADR.
AUTH0_SETTINGS: list[tuple[str, str]] = [
    ("auth0_domain", "AUTH0_DOMAIN"),
    ("auth0_audience", "AUTH0_AUDIENCE"),
    ("mcp_public_base_url", "MCP_PUBLIC_BASE_URL"),
    ("mcp_public_resource_url", "MCP_PUBLIC_RESOURCE_URL"),
    ("mcp_oauth_client_id", "MCP_OAUTH_CLIENT_ID"),
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


def _set_connector_env(
    monkeypatch: pytest.MonkeyPatch, *, resource_url: str, client_id: str
) -> None:
    for env_var, value in (
        ("MCP_PUBLIC_RESOURCE_URL", resource_url),
        ("MCP_OAUTH_CLIENT_ID", client_id),
    ):
        if value:
            monkeypatch.setenv(env_var, value)
        else:
            monkeypatch.delenv(env_var, raising=False)


def test_mcp_connector_resolves_when_both_settings_are_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_connector_env(
        monkeypatch,
        resource_url="https://uat.fortymm.com/api/mcp/",
        client_id="client-abc",
    )
    connector = get_settings().mcp_connector
    assert connector == McpConnectorConfig(
        url="https://uat.fortymm.com/api/mcp/", client_id="client-abc"
    )


@pytest.mark.parametrize(
    "configured, expected",
    [
        # deploy/uat/values.yaml currently sets it WITHOUT the trailing slash;
        # a connector URL missing it makes nginx 307 and breaks MCP discovery.
        ("https://uat.fortymm.com/api/mcp", "https://uat.fortymm.com/api/mcp/"),
        # Already-slashed config must not grow a second one.
        ("https://uat.fortymm.com/api/mcp/", "https://uat.fortymm.com/api/mcp/"),
    ],
)
def test_mcp_connector_url_carries_exactly_one_trailing_slash(
    monkeypatch: pytest.MonkeyPatch, configured: str, expected: str
) -> None:
    _set_connector_env(monkeypatch, resource_url=configured, client_id="client-abc")
    connector = get_settings().mcp_connector
    assert connector is not None
    assert connector.url == expected
    assert not connector.url.endswith("//")


@pytest.mark.parametrize(
    "resource_url, client_id",
    [
        ("", "client-abc"),
        ("https://uat.fortymm.com/api/mcp/", ""),
        ("", ""),
    ],
)
def test_mcp_connector_is_absent_unless_both_settings_are_set(
    monkeypatch: pytest.MonkeyPatch, resource_url: str, client_id: str
) -> None:
    """All-or-nothing, like ``_build_mcp_auth``: half a connector is worse than
    none — an empty client-id box makes a player paste nothing into Claude."""
    _set_connector_env(monkeypatch, resource_url=resource_url, client_id=client_id)
    assert get_settings().mcp_connector is None


@pytest.mark.parametrize(
    "resource_url, client_id",
    [
        ("   ", "client-abc"),
        ("https://uat.fortymm.com/api/mcp/", "  "),
        ("\n", "\t"),
    ],
    ids=["blank-url", "blank-client-id", "both-blank"],
)
def test_mcp_connector_treats_a_whitespace_only_setting_as_unset(
    monkeypatch: pytest.MonkeyPatch, resource_url: str, client_id: str
) -> None:
    """A variable set to whitespace is an unset variable that looks set — a
    blank line in a compose ``.env``, a heredoc'd secret carrying a newline.

    Guarding on bare truthiness let ``MCP_OAUTH_CLIENT_ID='  '`` resolve as a
    *complete* connector, so the settings page advertised a client id made of
    spaces. That is the failure the all-or-nothing rule above exists to prevent,
    arriving through the back door."""
    _set_connector_env(monkeypatch, resource_url=resource_url, client_id=client_id)
    assert get_settings().mcp_connector is None


def test_mcp_connector_strips_surrounding_whitespace_from_both_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Padding never reaches the player: an invisible character in the pasted
    client id fails at Auth0 with nothing on screen to explain it."""
    _set_connector_env(
        monkeypatch,
        resource_url="  https://uat.fortymm.com/api/mcp  ",
        client_id="\tclient-abc\n",
    )
    assert get_settings().mcp_connector == McpConnectorConfig(
        url="https://uat.fortymm.com/api/mcp/", client_id="client-abc"
    )


#: The five authentication rate-limit ceilings (issue #1590), each paired
#: with the env var pydantic-settings maps it from and the production default
#: it keeps when the variable is unset. Development/QA Compose raise these to
#: 1,000; production and UAT deliberately supply no override.
AUTH_RATE_LIMIT_SETTINGS: list[tuple[str, str, int]] = [
    ("email_send_session_limit_per_hour", "EMAIL_SEND_SESSION_LIMIT_PER_HOUR", 5),
    ("email_send_ip_limit_per_hour", "EMAIL_SEND_IP_LIMIT_PER_HOUR", 20),
    ("email_resend_session_limit_per_hour", "EMAIL_RESEND_SESSION_LIMIT_PER_HOUR", 3),
    ("email_resend_ip_limit_per_hour", "EMAIL_RESEND_IP_LIMIT_PER_HOUR", 10),
    ("login_consume_ip_limit_per_hour", "LOGIN_CONSUME_IP_LIMIT_PER_HOUR", 60),
]

#: Environment values that are NOT a usable ceiling. Zero/negative violate
#: the ``gt=0`` constraint; a fractional or non-numeric string is not an
#: integer at all. Each must fail Settings construction rather than be
#: coerced to some other ceiling or replaced with a fallback.
INVALID_AUTH_RATE_LIMIT_VALUES = ["0", "-1", "5.5", "abc"]


@pytest.mark.parametrize("attr, env_var, default", AUTH_RATE_LIMIT_SETTINGS)
def test_auth_rate_limit_defaults_are_the_production_ceilings(
    monkeypatch: pytest.MonkeyPatch, attr: str, env_var: str, default: int
) -> None:
    """With every ceiling variable unset, the app keeps 5/20/3/10/60 — the
    tight production abuse tiers."""
    for _, other_env_var, _ in AUTH_RATE_LIMIT_SETTINGS:
        monkeypatch.delenv(other_env_var, raising=False)
    assert getattr(get_settings(), attr) == default


@pytest.mark.parametrize("attr, env_var, default", AUTH_RATE_LIMIT_SETTINGS)
def test_auth_rate_limit_reads_from_env(
    monkeypatch: pytest.MonkeyPatch, attr: str, env_var: str, default: int
) -> None:
    monkeypatch.delenv(env_var, raising=False)
    monkeypatch.setenv(env_var, "42")
    assert getattr(get_settings(), attr) == 42


@pytest.mark.parametrize("selected_attr, selected_env_var, _", AUTH_RATE_LIMIT_SETTINGS)
def test_auth_rate_limit_partial_override_changes_only_the_selected_ceiling(
    monkeypatch: pytest.MonkeyPatch,
    selected_attr: str,
    selected_env_var: str,
    _: int,
) -> None:
    """The five ceilings stay independent under a partial override: the named
    setting changes, the other four retain their production defaults."""
    for attr, env_var, default in AUTH_RATE_LIMIT_SETTINGS:
        expected = 7 if attr == selected_attr else default
        if attr == selected_attr:
            monkeypatch.setenv(env_var, "7")
        else:
            monkeypatch.delenv(env_var, raising=False)
        assert getattr(get_settings(), attr) == expected


@pytest.mark.parametrize("attr, env_var, default", AUTH_RATE_LIMIT_SETTINGS)
@pytest.mark.parametrize("bad_value", INVALID_AUTH_RATE_LIMIT_VALUES)
def test_auth_rate_limit_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch,
    attr: str,
    env_var: str,
    default: int,
    bad_value: str,
) -> None:
    """Invalid configuration must fail during settings construction — the
    process refuses to boot — never start with an unintended limit."""
    monkeypatch.setenv(env_var, bad_value)
    with pytest.raises(ValidationError):
        get_settings()
