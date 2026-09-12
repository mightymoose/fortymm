"""Login links that can merge guests share recoverable credential admission."""

import pytest

from app.models import EmailPurpose, EmailToken, User
from tests.test_confirmation_admission import _conflicting_confirmation


async def _conflicting_login(api_client, db_session, recorded_guest):
    raw, token_id = await _conflicting_confirmation(api_client, db_session)
    token = await db_session.get(EmailToken, token_id)
    guest_id, target_id = token.user_id, token.target_account_id
    target = await db_session.get(User, target_id)
    token.user_id = target_id
    token.target_account_id = None
    token.guest_account_id = guest_id if recorded_guest else None
    token.purpose = EmailPurpose.login
    token.sent_to = target.email
    await db_session.commit()
    return raw, token_id


@pytest.mark.parametrize("recorded_guest", [True, False])
async def test_login_merge_retry_budget_preserves_credential(
    api_client, db_session, recorded_guest
):
    raw, token_id = await _conflicting_login(api_client, db_session, recorded_guest)
    for _ in range(5):
        response = await api_client.post("/v1/login/consume", json={"token": raw})
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "entry_merge_conflict"
    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 429, response.text
    assert "Retry" in response.json()["detail"]
    assert await db_session.get(EmailToken, token_id) is not None


@pytest.mark.parametrize("recorded_guest", [True, False])
async def test_parallel_login_merge_refuses_before_account_locks(
    api_client, db_session, engine, recorded_guest
):
    import asyncio
    import hashlib

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.db import get_session
    from app.email_merge_admission import admit_credential_merge
    from app.main import app
    from app.sessions import SESSION_COOKIE_NAME

    raw, token_id = await _conflicting_login(api_client, db_session, recorded_guest)
    sessions = async_sessionmaker(engine)

    async def independent_session():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = independent_session
    async with sessions() as gate:
        await admit_credential_merge(
            gate,
            hashlib.sha256(raw.encode()).digest(),
            hashlib.sha256(api_client.cookies[SESSION_COOKIE_NAME].encode()).digest(),
            flow="login",
        )
        await gate.execute(select(User.id).with_for_update())
        async with asyncio.timeout(1):
            responses = await asyncio.gather(
                *(
                    api_client.post("/v1/login/consume", json={"token": raw})
                    for _ in range(4)
                )
            )
        assert all(response.status_code == 429 for response in responses)
        assert all("already in progress" in response.text for response in responses)
        await gate.rollback()
    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 409, response.text
    assert "entry_merge_conflict" in response.text
    assert await db_session.get(EmailToken, token_id) is not None


@pytest.mark.parametrize("recorded_guest", [True, False])
async def test_login_merge_fails_closed_without_retry_store(
    api_client, db_session, monkeypatch, recorded_guest
):
    from app import rate_limiting

    raw, token_id = await _conflicting_login(api_client, db_session, recorded_guest)
    monkeypatch.setattr(rate_limiting, "_redis", None)
    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 503, response.text
    assert await db_session.get(EmailToken, token_id) is not None


@pytest.mark.parametrize(
    "recorded_guest,skip_merge", [(True, True), (False, True), (False, False)]
)
async def test_login_without_merge_remains_available_without_retry_store(
    api_client, db_session, monkeypatch, recorded_guest, skip_merge
):
    from app import rate_limiting
    from app.sessions import SESSION_COOKIE_NAME

    raw, _ = await _conflicting_login(api_client, db_session, recorded_guest)
    if not skip_merge:
        api_client.cookies.delete(SESSION_COOKIE_NAME)
    monkeypatch.setattr(rate_limiting, "_redis", None)
    response = await api_client.post(
        "/v1/login/consume", json={"token": raw, "skip_merge": skip_merge}
    )
    assert response.status_code == 200, response.text
