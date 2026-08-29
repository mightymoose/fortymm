"""The five authentication rate-limit ceilings (issue #1590).

Each ceiling is independently configurable through ``Settings`` (the
default/override/rejection matrix lives in ``test_config.py``); this module
proves what the configuration does at the enforcement boundary:

- the construction seam builds each limiter from its matching setting,
- the configured number of requests is admitted through the real endpoints
  and the next one receives the existing 429 response,
- each pair of endpoints sharing a limiter draws from one shared budget,
- exhausting (or overriding) one ceiling leaves the other four untouched.

A low configured ceiling is tested through a fresh limiter set built by
``build_auth_rate_limiters`` and swapped in with ``app.dependency_overrides``
— the routes captured the module-level instances at import, so overrides are
the only way to exercise a configured boundary without 1,001 requests or an
import-reload leaking cached limiter state between cases.
"""

import pytest
from httpx import ASGITransport, AsyncClient
from pyrate_limiter import Duration
from sqlalchemy.ext.asyncio import AsyncSession

from app import sessions as sessions_module
from app.config import GeocoderChoice, Settings
from app.main import app as fastapi_app
from app.rate_limiting import RedisRateLimiter
from app.sessions import (
    AuthRateLimiters,
    build_auth_rate_limiters,
    email_resend_ip_rate_limit,
    email_resend_rate_limit,
    email_send_ip_rate_limit,
    email_send_rate_limit,
    login_consume_ip_rate_limit,
)
from tests._helpers import CSRF_EVENT_HOOKS, start_session

#: Both send endpoints accept the same shape (captcha + honeypot + email).
SEND_BODY = {
    "email": "rita@example.com",
    "captcha_token": "test-token",
    "fmm_hp_token": "",
}
RESEND_BODY = {"captcha_token": "test-token", "fmm_hp_token": ""}
CONSUME_BODY = {"token": "no-such-token"}

#: Every ceiling raised well out of the way — a test overrides only the
#: limiter it is stressing and leaves the rest effectively unlimited. Passed
#: as explicit keyword arguments so the process environment cannot interfere.
ALL_HIGH: dict[str, int] = {
    "email_send_session_limit_per_hour": 50,
    "email_send_ip_limit_per_hour": 50,
    "email_resend_session_limit_per_hour": 50,
    "email_resend_ip_limit_per_hour": 50,
    "login_consume_ip_limit_per_hour": 50,
}

#: Each ``AuthRateLimiters`` field paired with the Settings field it is built
#: from — the wiring the seam-fidelity tests pin.
LIMITER_FIELDS: list[tuple[str, str]] = [
    ("send_session", "email_send_session_limit_per_hour"),
    ("send_ip", "email_send_ip_limit_per_hour"),
    ("resend_session", "email_resend_session_limit_per_hour"),
    ("resend_ip", "email_resend_ip_limit_per_hour"),
    ("login_consume_ip", "login_consume_ip_limit_per_hour"),
]

#: The module-level dependencies, paired with the production ceiling each
#: must carry when the environment says nothing.
MODULE_CEILINGS: list[tuple[str, int]] = [
    ("email_send_rate_limit", 5),
    ("email_send_ip_rate_limit", 20),
    ("email_resend_rate_limit", 3),
    ("email_resend_ip_rate_limit", 10),
    ("login_consume_ip_rate_limit", 60),
]


def _limiters(**overrides: int) -> AuthRateLimiters:
    """A fresh limiter set with every ceiling high except the named ones.

    ``geocoder=FAKE`` keeps ``Settings._require_google_key`` from demanding a
    real key — the suite always runs the fake geocoder anyway
    (``tests/__init__.py``).
    """
    settings = Settings(geocoder=GeocoderChoice.FAKE, **{**ALL_HIGH, **overrides})
    return build_auth_rate_limiters(settings)


def _swap_in(limiters: AuthRateLimiters) -> None:
    """Substitute the fresh set for the module-level dependencies the routes
    captured at import. ``api_client`` clears the overrides afterwards."""
    for field, module_limiter in (
        ("send_session", email_send_rate_limit),
        ("send_ip", email_send_ip_rate_limit),
        ("resend_session", email_resend_rate_limit),
        ("resend_ip", email_resend_ip_rate_limit),
        ("login_consume_ip", login_consume_ip_rate_limit),
    ):
        limiter: RedisRateLimiter = getattr(limiters, field)
        fastapi_app.dependency_overrides[module_limiter] = limiter


# ---- the construction seam -------------------------------------------------


@pytest.mark.parametrize("field, settings_field", LIMITER_FIELDS)
def test_each_limiter_is_built_from_its_matching_setting(
    field: str, settings_field: str
) -> None:
    """Overriding one ceiling changes only its own limiter's rate; the other
    four keep the values they were given."""
    settings_field_of = dict(LIMITER_FIELDS)
    limiters = _limiters(**{settings_field: 7})
    for name, _ in LIMITER_FIELDS:
        expected = 7 if name == field else ALL_HIGH[settings_field_of[name]]
        limiter: RedisRateLimiter = getattr(limiters, name)
        assert limiter._rates[0].limit == expected, (field, name)


def test_module_limiters_keep_the_production_ceilings_and_one_hour_windows():
    """The process's own dependencies are built once at import from one
    Settings snapshot: with no environment override they carry the tight
    production tiers 5/20/3/10/60, each over a one-hour window."""
    for attr, limit in MODULE_CEILINGS:
        limiter: RedisRateLimiter = getattr(sessions_module, attr)
        assert limiter._rates[0].limit == limit, attr
        assert limiter._rates[0].interval == Duration.HOUR, attr


# ---- session-keyed boundaries ----------------------------------------------


async def test_send_session_ceiling_is_one_shared_budget_across_both_send_endpoints(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The send-session limiter protects both POST /v1/me/email and POST
    /v1/login/request: a request through either consumes the same configured
    budget, and the request over the ceiling gets the existing 429."""
    _swap_in(_limiters(email_send_session_limit_per_hour=1))
    await start_session(api_client, db_session)

    admitted = await api_client.post("/v1/me/email", json=SEND_BODY)
    assert admitted.status_code == 202

    over = await api_client.post("/v1/login/request", json=SEND_BODY)
    assert over.status_code == 429


async def test_resend_session_ceiling_admits_the_configured_count_then_429s(
    api_client: AsyncClient, db_session: AsyncSession
):
    _swap_in(_limiters(email_resend_session_limit_per_hour=1))
    await start_session(api_client, db_session)
    established = await api_client.post("/v1/me/email", json=SEND_BODY)
    assert established.status_code == 202

    admitted = await api_client.post("/v1/me/email/resend", json=RESEND_BODY)
    assert admitted.status_code == 202

    over = await api_client.post("/v1/me/email/resend", json=RESEND_BODY)
    assert over.status_code == 429


# ---- IP-keyed boundaries ----------------------------------------------------


async def test_send_ip_ceiling_admits_the_configured_count_then_429s(
    api_client: AsyncClient,
):
    """The send-IP limiter also protects POST /v1/login/request: from one
    address, the configured number of requests is admitted and the next one
    429s."""
    _swap_in(_limiters(email_send_ip_limit_per_hour=1))

    admitted = await api_client.post("/v1/login/request", json=SEND_BODY)
    assert admitted.status_code == 202

    over = await api_client.post("/v1/login/request", json=SEND_BODY)
    assert over.status_code == 429


async def test_send_ip_budgets_stay_independent_across_client_ips(
    api_client: AsyncClient,
):
    """Several callers from one IP share that IP's budget; a different IP
    retains its own."""
    _swap_in(_limiters(email_send_ip_limit_per_hour=1))
    other_ip = AsyncClient(
        transport=ASGITransport(app=fastapi_app, client=("203.0.113.9", 12345)),
        base_url="https://testserver",
        event_hooks=CSRF_EVENT_HOOKS,
    )
    try:
        mine = await api_client.post("/v1/login/request", json=SEND_BODY)
        assert mine.status_code == 202
        theirs = await other_ip.post("/v1/login/request", json=SEND_BODY)
        assert theirs.status_code == 202
    finally:
        await other_ip.aclose()


async def test_resend_ip_ceiling_admits_the_configured_count_then_429s(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The resend endpoint's per-IP boundary — distinct from its per-session
    one — also follows its configured ceiling."""
    _swap_in(_limiters(email_resend_ip_limit_per_hour=1))
    await start_session(api_client, db_session)
    established = await api_client.post("/v1/me/email", json=SEND_BODY)
    assert established.status_code == 202

    admitted = await api_client.post("/v1/me/email/resend", json=RESEND_BODY)
    assert admitted.status_code == 202

    over = await api_client.post("/v1/me/email/resend", json=RESEND_BODY)
    assert over.status_code == 429


async def test_consume_ip_ceiling_is_one_shared_budget_across_both_attached_endpoints(
    api_client: AsyncClient,
):
    """The consume-IP limiter protects both POST /v1/login/consume and POST
    /v1/merge/preview: the pair draws from one budget, so the request over
    the configured ceiling 429s no matter which endpoint it arrives on."""
    _swap_in(_limiters(login_consume_ip_limit_per_hour=2))

    first = await api_client.post("/v1/login/consume", json=CONSUME_BODY)
    assert first.status_code == 400  # refused on its own merits, still counted

    second = await api_client.post("/v1/merge/preview", json=CONSUME_BODY)
    assert second.status_code == 200  # admitted: 2 of 2 consumed

    over = await api_client.post("/v1/login/consume", json=CONSUME_BODY)
    assert over.status_code == 429


# ---- limiter independence ---------------------------------------------------


async def test_exhausting_the_send_ceiling_leaves_resend_and_consume_intact(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Exhausting one authentication ceiling must not change or consume
    another limiter's budget: resend and consume still serve their own
    configured requests afterwards."""
    _swap_in(_limiters(email_send_session_limit_per_hour=1))
    await start_session(api_client, db_session)

    admitted = await api_client.post("/v1/me/email", json=SEND_BODY)
    assert admitted.status_code == 202
    over = await api_client.post("/v1/me/email", json=SEND_BODY)
    assert over.status_code == 429  # send-session budget spent

    resend = await api_client.post("/v1/me/email/resend", json=RESEND_BODY)
    assert resend.status_code == 202  # resend budget untouched
    consume = await api_client.post("/v1/login/consume", json=CONSUME_BODY)
    assert consume.status_code == 400  # consume budget untouched (not 429)
