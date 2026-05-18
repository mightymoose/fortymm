import hashlib
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import User, UserToken
from app.sessions import (
    LOGIN_TOKEN_CONTEXT,
    SESSION_COOKIE_NAME,
    SESSION_TOKEN_CONTEXT,
)
from tests._helpers import make_client, start_session


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="https://testserver"
    ) as client:
        yield client
    app.dependency_overrides.clear()


REQUEST_BODY = {
    "email": "rita@example.com",
    "captcha_token": "test-token",
    "fmm_hp_token": "",
}


async def _make_confirmed_user(db_session: AsyncSession, email: str) -> User:
    user = User(
        username=email.split("@")[0],
        email=email,
        confirmed_at=datetime.now(timezone.utc),
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


# ---- request endpoint ----------------------------------------------------


async def test_request_enqueues_email_and_persists_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    user = await _make_confirmed_user(db_session, "rita@example.com")

    response = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert response.status_code == 202
    assert response.json() == {"email": "rita@example.com"}

    tokens = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].user_id == user.id
    assert tokens[0].sent_to == "rita@example.com"

    assert fake_email_queue.finished_job_registry.count == 1


async def test_request_normalizes_email_to_lowercase(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    user = await _make_confirmed_user(db_session, "rita@example.com")

    response = await api_client.post(
        "/v1/login/request",
        json={**REQUEST_BODY, "email": "Rita@Example.COM"},
    )
    assert response.status_code == 202

    tokens = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].user_id == user.id
    assert tokens[0].sent_to == "rita@example.com"


async def test_request_for_unknown_email_returns_202_without_sending(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    response = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert response.status_code == 202

    tokens = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert tokens == []
    assert fake_email_queue.finished_job_registry.count == 0


async def test_request_for_unconfirmed_account_returns_202_without_sending(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    db_session.add(
        User(
            username="pending",
            email="rita@example.com",
            confirmed_at=None,
        )
    )
    await db_session.commit()

    response = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert response.status_code == 202

    tokens = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert tokens == []
    assert fake_email_queue.finished_job_registry.count == 0


async def test_request_replaces_prior_login_token_for_same_user(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await _make_confirmed_user(db_session, "rita@example.com")

    first = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    second = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert first.status_code == 202
    assert second.status_code == 202

    tokens = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert len(tokens) == 1


async def test_request_honeypot_silently_succeeds(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await _make_confirmed_user(db_session, "rita@example.com")

    response = await api_client.post(
        "/v1/login/request",
        json={**REQUEST_BODY, "fmm_hp_token": "https://spammer.example"},
    )
    assert response.status_code == 202

    tokens = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert tokens == []


async def test_request_rejects_bad_captcha(
    api_client: AsyncClient, db_session: AsyncSession, monkeypatch
):
    await _make_confirmed_user(db_session, "rita@example.com")

    async def _always_fail(token):  # noqa: ARG001
        return False

    from app import captcha as captcha_module

    monkeypatch.setattr(captcha_module, "verify_captcha", _always_fail)

    response = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert response.status_code == 400


async def test_request_rejects_invalid_email_format(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/login/request",
        json={**REQUEST_BODY, "email": "not-an-email"},
    )
    assert response.status_code == 422


# ---- consume endpoint ----------------------------------------------------


async def _issue_login_token(
    db_session: AsyncSession, user: User, raw_token: str
) -> UserToken:
    token = UserToken(
        user_id=user.id,
        context=LOGIN_TOKEN_CONTEXT,
        token=hashlib.sha256(raw_token.encode("utf-8")).digest(),
        sent_to=user.email,
    )
    db_session.add(token)
    await db_session.commit()
    await db_session.refresh(token)
    return token


async def test_consume_rotates_cookie_and_returns_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-rita"
    await _issue_login_token(db_session, user, raw)

    response = await api_client.post(
        "/v1/login/consume", json={"token": raw}
    )
    assert response.status_code == 200

    body_user = response.json()["data"]["user"]
    assert body_user["username"] == "rita"
    assert body_user["email"] == "rita@example.com"

    cookie_header = response.headers.get("set-cookie", "").lower()
    assert "httponly" in cookie_header
    assert "samesite=lax" in cookie_header
    new_cookie = response.cookies.get(SESSION_COOKIE_NAME)
    assert new_cookie

    sessions = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context == SESSION_TOKEN_CONTEXT,
                UserToken.user_id == user.id,
            )
        )
    ).scalars().all()
    assert any(
        t.token == hashlib.sha256(new_cookie.encode("utf-8")).digest()
        for t in sessions
    )


async def test_consume_deletes_token_so_it_cannot_be_reused(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-once"
    await _issue_login_token(db_session, user, raw)

    first = await api_client.post("/v1/login/consume", json={"token": raw})
    assert first.status_code == 200

    second_client = make_client()
    second = await second_client.post(
        "/v1/login/consume", json={"token": raw}
    )
    assert second.status_code == 400
    await second_client.aclose()

    leftover = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert leftover == []


async def test_consume_rejects_expired_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-expired"
    token = await _issue_login_token(db_session, user, raw)
    # Backdate past the 15-minute TTL.
    token.created_at = datetime.now(timezone.utc) - timedelta(minutes=20)
    await db_session.commit()

    response = await api_client.post(
        "/v1/login/consume", json={"token": raw}
    )
    assert response.status_code == 400

    leftover = (
        await db_session.execute(
            select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
        )
    ).scalars().all()
    assert leftover == []


async def test_consume_rejects_unknown_token(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/login/consume", json={"token": "not-a-real-token"}
    )
    assert response.status_code == 400


async def test_consume_replaces_guest_session_with_owner_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-rotate"
    await _issue_login_token(db_session, user, raw)

    # Establish a guest session first — the consuming browser starts as
    # someone else.
    guest = await start_session(api_client, db_session)
    assert guest.id != user.id

    response = await api_client.post(
        "/v1/login/consume", json={"token": raw}
    )
    assert response.status_code == 200
    assert response.json()["data"]["user"]["username"] == "rita"

    new_cookie = response.cookies.get(SESSION_COOKIE_NAME)
    me = await api_client.get(
        "/v1/session", cookies={SESSION_COOKIE_NAME: new_cookie}
    )
    assert me.json()["data"]["user"]["username"] == "rita"


async def test_consume_does_not_accept_email_change_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await _make_confirmed_user(db_session, "rita@example.com")
    # Mint a change token rather than a login token.
    raw = "raw-change-token"
    db_session.add(
        UserToken(
            user_id=user.id,
            context="change:",
            token=hashlib.sha256(raw.encode("utf-8")).digest(),
            sent_to=user.email,
        )
    )
    await db_session.commit()

    response = await api_client.post(
        "/v1/login/consume", json={"token": raw}
    )
    assert response.status_code == 400
