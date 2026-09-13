"""Fresh guest bootstrap consumes bounded, expiring admission budgets."""

import pytest
from sqlalchemy import text

from app import sessions
from tests._helpers import make_raw_client


@pytest.mark.parametrize("budget", ["hour", "day"])
async def test_guest_creation_budget_precedes_writes_and_ignores_spoofed_headers(
    api_client, db_session, rate_limiter_fakeredis, monkeypatch, budget
):
    settings = sessions.get_settings().model_copy(
        update={
            "guest_creation_ip_limit_per_hour": 2 if budget == "hour" else 10,
            "guest_creation_ip_limit_per_day": 2 if budget == "day" else 10,
        }
    )
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    tables = ("accounts", "players", "account_players", "account_session_tokens")
    before = {
        table: await db_session.scalar(text(f"SELECT count(*) FROM {table}"))
        for table in tables
    }
    existing = await api_client.get("/v1/session")
    assert existing.status_code == 200
    async with make_raw_client() as fresh:
        admitted = await fresh.get(
            "/v1/session", headers={"X-Forwarded-For": "198.51.100.1"}
        )
        assert admitted.status_code == 200
        fresh.cookies.clear()
        refused = await fresh.get(
            "/v1/session",
            headers={"X-Forwarded-For": "203.0.113.5", "X-Real-IP": "203.0.113.6"},
        )
        assert refused.status_code == 429, refused.text
    for table in tables:
        assert (
            await db_session.scalar(text(f"SELECT count(*) FROM {table}"))
            == before[table] + 2
        )
    returning = await api_client.get("/v1/session")
    assert returning.status_code == 200
    assert (
        returning.json()["data"]["user"]["username"]
        == existing.json()["data"]["user"]["username"]
    )
    keys = await rate_limiter_fakeredis.keys("guest-create:*")
    assert len(keys) == 2
    for key in keys:
        assert 0 < await rate_limiter_fakeredis.ttl(key) <= 86400


@pytest.mark.parametrize("failure", ["unpublished", "connection_error"])
async def test_guest_creation_fails_closed_without_breaking_existing_sessions(
    api_client, db_session, monkeypatch, rate_limiter_fakeredis, failure
):
    from app import rate_limiting

    assert (await api_client.get("/v1/session")).status_code == 200
    before = await db_session.scalar(text("SELECT count(*) FROM accounts"))
    if failure == "unpublished":
        monkeypatch.setattr(rate_limiting, "_redis", None)
    else:
        from redis.exceptions import ConnectionError

        async def unavailable(*args, **kwargs):
            raise ConnectionError("Redis unavailable")

        monkeypatch.setattr(rate_limiter_fakeredis, "eval", unavailable)
    assert (await api_client.get("/v1/session")).status_code == 200
    async with make_raw_client() as fresh:
        response = await fresh.get("/v1/session")
        assert response.status_code == 503, response.text
    assert await db_session.scalar(text("SELECT count(*) FROM accounts")) == before


async def test_concurrent_cookie_less_requests_share_one_guest_budget(
    api_client, db_session, monkeypatch
):
    import asyncio

    settings = sessions.get_settings().model_copy(
        update={
            "guest_creation_ip_limit_per_hour": 1,
            "guest_creation_ip_limit_per_day": 1,
        }
    )
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    before = await db_session.scalar(text("SELECT count(*) FROM accounts"))

    async def bootstrap():
        async with make_raw_client() as client:
            return (await client.get("/v1/session")).status_code

    statuses = await asyncio.gather(*(bootstrap() for _ in range(8)))
    assert statuses.count(200) == 1
    assert statuses.count(429) == 7
    assert await db_session.scalar(text("SELECT count(*) FROM accounts")) == before + 1


@pytest.mark.parametrize(
    "cookie", [sessions.SESSION_COOKIE_NAME, sessions.CSRF_COOKIE_NAME]
)
async def test_session_recovery_refusal_does_not_depend_on_guest_admission(
    api_client, db_session, monkeypatch, cookie
):
    from app import rate_limiting

    before = await db_session.scalar(text("SELECT count(*) FROM accounts"))
    monkeypatch.setattr(rate_limiting, "_redis", None)
    async with make_raw_client() as client:
        client.cookies.set(cookie, "expired-marker")
        response = await client.get("/v1/session")
        assert response.status_code == 401, response.text
    assert await db_session.scalar(text("SELECT count(*) FROM accounts")) == before


async def test_trusted_proxy_uses_actual_client_not_spoofed_forwarded_prefix(
    api_client, monkeypatch
):
    from httpx import ASGITransport, AsyncClient
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    from app.main import app

    settings = sessions.get_settings().model_copy(
        update={
            "guest_creation_ip_limit_per_hour": 1,
            "guest_creation_ip_limit_per_day": 5,
        }
    )
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    transport = ASGITransport(
        app=ProxyHeadersMiddleware(app, trusted_hosts=["10.0.0.0/8"]),
        client=("10.0.0.9", 1234),
    )
    async with AsyncClient(
        transport=transport, base_url="https://testserver"
    ) as client:
        first = await client.get(
            "/v1/session", headers={"X-Forwarded-For": "198.51.100.1, 203.0.113.4"}
        )
        assert first.status_code == 200
        client.cookies.clear()
        forged = await client.get(
            "/v1/session", headers={"X-Forwarded-For": "198.51.100.2, 203.0.113.4"}
        )
        assert forged.status_code == 429
        client.cookies.clear()
        independent = await client.get(
            "/v1/session", headers={"X-Forwarded-For": "203.0.113.5"}
        )
        assert independent.status_code == 200


async def test_login_requests_share_guest_creation_budget_before_allocating(
    api_client, db_session, monkeypatch, fake_email_queue, stub_captcha
):
    settings = sessions.get_settings().model_copy(
        update={"guest_creation_ip_limit_per_hour": 1}
    )
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    assert (await api_client.get("/v1/session")).status_code == 200
    before = await db_session.scalar(text("SELECT count(*) FROM accounts"))
    response = await api_client.post(
        "/v1/login/request",
        json={"email": "new@example.com", "captcha_token": "test-token"},
    )
    assert response.status_code == 202
    assert await db_session.scalar(text("SELECT count(*) FROM accounts")) == before


@pytest.mark.parametrize("unavailable", [False, True])
async def test_login_reserve_preserves_sign_in_without_an_allocation_oracle(
    api_client, db_session, monkeypatch, fake_email_queue, stub_captcha, unavailable
):
    from app import rate_limiting
    from tests._helpers import make_user

    owner = await make_user(db_session, "known-admission")
    owner.email = "known@example.com"
    await db_session.commit()
    settings = sessions.get_settings().model_copy(
        update={"guest_creation_ip_limit_per_hour": 1}
    )
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    assert (await api_client.get("/v1/session")).status_code == 200
    if unavailable:
        monkeypatch.setattr(rate_limiting, "_redis", None)
    before = await db_session.scalar(text("SELECT count(*) FROM accounts"))
    responses = []
    for email in (owner.email, "unknown@example.com"):
        response = await api_client.post(
            "/v1/login/request", json={"email": email, "captcha_token": "test-token"}
        )
        responses.append(response)
    assert [r.status_code for r in responses] == [503 if unavailable else 202] * 2
    if unavailable:
        assert responses[0].json() == responses[1].json()
    else:
        assert responses[0].json() == {"email": owner.email}
        assert responses[1].json() == {"email": "unknown@example.com"}
    assert fake_email_queue.finished_job_registry.count == (0 if unavailable else 1)
    assert await db_session.scalar(text("SELECT count(*) FROM accounts")) == before
    assert (await api_client.get("/v1/session")).status_code == 200


async def test_exhausted_creation_budget_still_resends_existing_pending_login(
    api_client, db_session, monkeypatch, fake_email_queue
):
    from sqlalchemy import select

    from app.models import FirstSignInIntent

    settings = sessions.get_settings().model_copy(
        update={"guest_creation_ip_limit_per_hour": 1}
    )
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    payload = {"email": "pending-reserve@example.com", "captcha_token": "test-token"}
    first = await api_client.post("/v1/login/request", json=payload)
    assert first.status_code == 202
    original_id = await db_session.scalar(select(FirstSignInIntent.user_id))
    before = await db_session.scalar(text("SELECT count(*) FROM accounts"))
    second = await api_client.post("/v1/login/request", json=payload)
    assert second.status_code == 202
    assert second.json() == first.json()
    assert await db_session.scalar(select(FirstSignInIntent.user_id)) == original_id
    assert await db_session.scalar(text("SELECT count(*) FROM accounts")) == before
    assert fake_email_queue.finished_job_registry.count == 2


async def test_exhausted_creation_reserve_masks_queue_failure_without_an_oracle(
    api_client, db_session, monkeypatch
):
    from tests._helpers import make_user

    owner = await make_user(db_session, "queue-reserve-owner")
    owner.email = "queue-reserve@example.com"
    await db_session.commit()
    settings = sessions.get_settings().model_copy(
        update={"guest_creation_ip_limit_per_hour": 1}
    )
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    assert (await api_client.get("/v1/session")).status_code == 200
    before = await db_session.scalar(text("SELECT count(*) FROM accounts"))

    def unavailable(*args, **kwargs):
        raise ConnectionError("Email queue unavailable")

    monkeypatch.setattr(sessions, "_enqueue_login_email", unavailable)
    for email in (owner.email, "unknown-queue-reserve@example.com"):
        response = await api_client.post(
            "/v1/login/request", json={"email": email, "captcha_token": "test-token"}
        )
        assert response.status_code == 202
        assert response.json() == {"email": email}
    assert await db_session.scalar(text("SELECT count(*) FROM accounts")) == before
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_tokens")) == 0
    )
