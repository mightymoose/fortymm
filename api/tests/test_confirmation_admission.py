"""Recoverable merge credentials cannot repeatedly queue expensive confirmations."""

import hashlib

import pytest
from sqlalchemy import select

from app.models import EmailPurpose, EmailToken
from tests._helpers import start_session
from tests.test_account_merge import (
    _cut,
    _enter,
    _make_rr_event,
    _make_verified,
    _record_match,
)


async def _conflicting_confirmation(api_client, db_session, purpose=EmailPurpose.merge):
    guest = await start_session(api_client, db_session)
    survivor = await _make_verified(db_session, "confirmation-conflict@example.com")
    event = await _make_rr_event(db_session, survivor)
    guest_entry = await _enter(db_session, event, guest)
    survivor_entry = await _enter(db_session, event, survivor)
    (fixture,) = await _cut(db_session, event)
    accounts = {guest_entry.id: guest, survivor_entry.id: survivor}
    match = await _record_match(
        db_session, survivor, accounts[fixture.entry_a_id], accounts[fixture.entry_b_id]
    )
    fixture.match_id = match.id
    raw = "recoverable-confirmation-conflict"
    token = EmailToken(
        user_id=guest.id if purpose is EmailPurpose.merge else survivor.id,
        target_account_id=survivor.id if purpose is EmailPurpose.merge else None,
        purpose=purpose,
        token=hashlib.sha256(raw.encode()).digest(),
        sent_to=(
            survivor.email
            if purpose is EmailPurpose.merge
            else "changed-confirmation@example.com"
        ),
        prior_email=survivor.email if purpose is EmailPurpose.change else None,
    )
    db_session.add(token)
    await db_session.commit()
    return raw, token.id


@pytest.mark.parametrize("purpose", [EmailPurpose.merge, EmailPurpose.change])
async def test_merge_conflict_retry_budget_preserves_credential(
    api_client, db_session, purpose
):
    raw, token_id = await _conflicting_confirmation(api_client, db_session, purpose)
    for _ in range(5):
        response = await api_client.post("/v1/me/email/confirm", json={"token": raw})
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "entry_merge_conflict"
    refused = await api_client.post("/v1/me/email/confirm", json={"token": raw})
    assert refused.status_code == 429, refused.text
    assert "Retry" in refused.json()["detail"]
    assert await db_session.scalar(
        select(EmailToken.id).where(EmailToken.id == token_id)
    )


@pytest.mark.parametrize("purpose", [EmailPurpose.merge, EmailPurpose.change])
async def test_parallel_confirmation_refuses_before_account_locks(
    api_client, db_session, engine, purpose
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.db import get_session
    from app.email_merge_admission import admit_credential_merge
    from app.main import app
    from app.models import User
    from app.sessions import SESSION_COOKIE_NAME

    raw, token_id = await _conflicting_confirmation(api_client, db_session, purpose)
    token_hash = hashlib.sha256(raw.encode()).digest()
    sessions = async_sessionmaker(engine)

    async def independent_session():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = independent_session
    async with sessions() as gate:
        await admit_credential_merge(
            gate,
            token_hash,
            hashlib.sha256(api_client.cookies[SESSION_COOKIE_NAME].encode()).digest(),
        )
        await gate.execute(select(User.id).with_for_update())
        async with asyncio.timeout(1):
            responses = await asyncio.gather(
                *(
                    api_client.post("/v1/me/email/confirm", json={"token": raw})
                    for _ in range(4)
                )
            )
        assert all(response.status_code == 429 for response in responses)
        assert all("already in progress" in response.text for response in responses)
        await gate.rollback()
    retried = await api_client.post("/v1/me/email/confirm", json={"token": raw})
    assert retried.status_code == 409, retried.text
    assert "entry_merge_conflict" in retried.text
    assert await db_session.get(EmailToken, token_id) is not None


async def test_merge_confirmation_fails_closed_when_budget_is_unavailable(
    api_client, db_session, monkeypatch
):
    from app import rate_limiting

    raw, token_id = await _conflicting_confirmation(api_client, db_session)
    monkeypatch.setattr(rate_limiting, "_redis", None)
    response = await api_client.post("/v1/me/email/confirm", json={"token": raw})
    assert response.status_code == 503, response.text
    assert "Retry" in response.json()["detail"]
    assert await db_session.get(EmailToken, token_id) is not None


async def test_invalid_confirmations_allocate_no_retry_buckets(
    api_client, rate_limiter_fakeredis
):
    for index in range(8):
        response = await api_client.post(
            "/v1/me/email/confirm", json={"token": f"invalid-{index}"}
        )
        assert response.status_code == 400
    assert await rate_limiter_fakeredis.keys("email-merge-confirm:*") == []


async def test_merge_confirmation_budget_expires_and_allows_recovery(
    api_client, db_session, rate_limiter_fakeredis
):
    raw, token_id = await _conflicting_confirmation(api_client, db_session)
    response = await api_client.post("/v1/me/email/confirm", json={"token": raw})
    assert response.status_code == 409
    key = f"email-merge-confirm:{hashlib.sha256(raw.encode()).hexdigest()}"
    assert 0 < await rate_limiter_fakeredis.ttl(key) <= 3600
    await rate_limiter_fakeredis.expire(key, 0)
    retried = await api_client.post("/v1/me/email/confirm", json={"token": raw})
    assert retried.status_code == 409
    assert "entry_merge_conflict" in retried.text
    assert await db_session.get(EmailToken, token_id) is not None


async def test_ordinary_confirmation_still_works_without_retry_storage(
    api_client, db_session, fake_email_queue, monkeypatch
):
    from app import rate_limiting
    from tests.test_email import _capture_raw_token

    await start_session(api_client, db_session)
    raw = await _capture_raw_token(api_client, db_session, fake_email_queue)
    monkeypatch.setattr(rate_limiting, "_redis", None)
    response = await api_client.post("/v1/me/email/confirm", json={"token": raw})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("purpose", [EmailPurpose.merge, EmailPurpose.change])
async def test_confirmation_skip_merge_remains_available_without_retry_store(
    api_client, db_session, monkeypatch, purpose
):
    from app import rate_limiting

    raw, _ = await _conflicting_confirmation(api_client, db_session, purpose)
    monkeypatch.setattr(rate_limiting, "_redis", None)
    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": raw, "skip_merge": True}
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["user"]["email"] == (
        "changed-confirmation@example.com"
        if purpose is EmailPurpose.change
        else "confirmation-conflict@example.com"
    )


@pytest.mark.parametrize("blocked_by", ["budget", "busy"])
async def test_merge_token_skip_bypasses_admission_without_merging_guest(
    api_client, db_session, engine, blocked_by
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.email_merge_admission import admit_credential_merge
    from app.models import User

    raw, token_id = await _conflicting_confirmation(api_client, db_session)
    token = await db_session.get(EmailToken, token_id)
    guest_id = token.user_id
    if blocked_by == "budget":
        for _ in range(5):
            response = await api_client.post(
                "/v1/me/email/confirm", json={"token": raw}
            )
            assert response.status_code == 409, response.text
        refused = await api_client.post("/v1/me/email/confirm", json={"token": raw})
        assert refused.status_code == 429, refused.text
        await db_session.rollback()

    sessions = async_sessionmaker(engine)
    async with sessions() as gate:
        if blocked_by == "busy":
            await admit_credential_merge(gate, hashlib.sha256(raw.encode()).digest())
        async with asyncio.timeout(1):
            response = await api_client.post(
                "/v1/me/email/confirm", json={"token": raw, "skip_merge": True}
            )
        assert response.status_code == 200, response.text
        await gate.rollback()
    guest = await db_session.get(User, guest_id, populate_existing=True)
    assert guest.merged_into_user_id is None
    assert (
        response.json()["data"]["user"]["email"] == "confirmation-conflict@example.com"
    )
