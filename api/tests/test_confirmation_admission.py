"""Recoverable merge credentials cannot repeatedly queue expensive confirmations."""

import hashlib

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


async def _conflicting_confirmation(api_client, db_session):
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
        user_id=guest.id,
        target_account_id=survivor.id,
        purpose=EmailPurpose.merge,
        token=hashlib.sha256(raw.encode()).digest(),
        sent_to=survivor.email,
    )
    db_session.add(token)
    await db_session.commit()
    return raw, token.id


async def test_merge_conflict_retry_budget_preserves_credential(api_client, db_session):
    raw, token_id = await _conflicting_confirmation(api_client, db_session)
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


async def test_parallel_confirmation_refuses_before_account_locks(
    api_client, db_session, engine
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.db import get_session
    from app.email_confirmation_admission import admit_merge_confirmation
    from app.main import app
    from app.models import User

    raw, token_id = await _conflicting_confirmation(api_client, db_session)
    token_hash = hashlib.sha256(raw.encode()).digest()
    sessions = async_sessionmaker(engine)

    async def independent_session():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = independent_session
    async with sessions() as gate:
        await admit_merge_confirmation(gate, token_hash)
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
