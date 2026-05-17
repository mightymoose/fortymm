import hashlib
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import User, UserToken
from app.sessions import EMAIL_CONFIRMATION_TOKEN_CONTEXT
from tests._helpers import start_session


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


VALID_BODY = {
    "email": "rita@example.com",
    "captcha_token": "test-token",
    "website": "",
}


async def _set_email(
    client: AsyncClient, **overrides
) -> "httpx.Response":  # noqa: F821
    body = {**VALID_BODY, **overrides}
    return await client.post("/v1/me/email", json=body)


# ---- set email ------------------------------------------------------------


async def test_session_response_includes_email_fields(
    api_client: AsyncClient, db_session: AsyncSession
):
    response = await api_client.get("/v1/session")
    user = response.json()["data"]["user"]
    assert user["email"] is None
    assert user["confirmed_at"] is None


async def test_set_email_persists_and_enqueues_send(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    user = await start_session(api_client, db_session)
    response = await _set_email(api_client)
    assert response.status_code == 202

    body_user = response.json()["data"]["user"]
    assert body_user["email"] == "rita@example.com"
    assert body_user["confirmed_at"] is None

    await db_session.refresh(user)
    assert user.email == "rita@example.com"
    assert user.confirmed_at is None

    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT
            )
        )
    ).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].sent_to == "rita@example.com"
    assert tokens[0].user_id == user.id
    # Token stored hashed.
    assert tokens[0].token != b"rita@example.com"

    finished = fake_email_queue.finished_job_registry
    assert finished.count == 1


async def test_set_email_requires_session(api_client: AsyncClient):
    response = await _set_email(api_client)
    assert response.status_code == 401


async def test_set_email_normalizes_to_lowercase(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    response = await _set_email(api_client, email="MixedCase@Example.COM")
    assert response.status_code == 202
    await db_session.refresh(user)
    assert user.email == "mixedcase@example.com"


async def test_set_email_rejects_invalid_format(api_client: AsyncClient, db_session):
    await start_session(api_client, db_session)
    response = await _set_email(api_client, email="not-an-email")
    assert response.status_code == 422


async def test_set_email_honeypot_silently_succeeds(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    user = await start_session(api_client, db_session)
    response = await _set_email(api_client, website="https://spammer.example")
    # Same shape as a real success — gives the bot no signal.
    assert response.status_code == 202

    await db_session.refresh(user)
    assert user.email is None  # nothing persisted

    tokens = (
        await db_session.execute(select(UserToken).where(
            UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT
        ))
    ).scalars().all()
    assert tokens == []
    assert fake_email_queue.finished_job_registry.count == 0


async def test_set_email_rejects_failed_captcha(
    api_client: AsyncClient, db_session: AsyncSession, monkeypatch
):
    await start_session(api_client, db_session)

    async def _fail(token):  # noqa: ARG001
        return False

    from app import captcha as captcha_module

    monkeypatch.setattr(captcha_module, "verify_captcha", _fail)
    response = await _set_email(api_client)
    assert response.status_code == 400
    assert "Captcha" in response.json()["detail"]


async def test_set_email_rejects_duplicate(
    api_client: AsyncClient, db_session: AsyncSession
):
    db_session.add(User(username="other", email="taken@example.com"))
    await db_session.commit()
    await start_session(api_client, db_session)

    response = await _set_email(api_client, email="taken@example.com")
    assert response.status_code == 409


async def test_set_email_replaces_existing_unconfirmed_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await _set_email(api_client)
    await _set_email(api_client, email="rita2@example.com")

    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT
            )
        )
    ).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].sent_to == "rita2@example.com"


async def test_resubmitting_same_email_clears_confirmation(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Even when the address didn't change, calling set_email un-confirms
    the user — they must click the fresh link to re-prove ownership."""
    user = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)
    await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    await db_session.refresh(user)
    assert user.confirmed_at is not None

    await _set_email(api_client)  # same email as VALID_BODY
    await db_session.refresh(user)
    assert user.confirmed_at is None
    assert user.email == "rita@example.com"


async def test_changing_email_clears_confirmation(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    await _set_email(api_client)

    # Confirm out-of-band to set confirmed_at.
    token_row = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT
            )
        )
    ).scalar_one()
    # We don't know the raw token in this test, so simulate by changing email
    # while user is confirmed.
    from datetime import datetime, timezone
    user.confirmed_at = datetime.now(timezone.utc)
    await db_session.delete(token_row)
    await db_session.commit()
    await db_session.refresh(user)
    assert user.confirmed_at is not None

    await _set_email(api_client, email="changed@example.com")
    await db_session.refresh(user)
    assert user.confirmed_at is None
    assert user.email == "changed@example.com"


# ---- confirm email --------------------------------------------------------


def _all_send_tokens(fake_email_queue) -> list[str]:
    """Return every raw token handed to a finished email send job, ordered
    by enqueue time (oldest first)."""
    jobs = [
        fake_email_queue.fetch_job(job_id)
        for job_id in fake_email_queue.finished_job_registry.get_job_ids()
    ]
    jobs = [j for j in jobs if j is not None]
    jobs.sort(key=lambda j: j.enqueued_at)
    return [j.args[1] for j in jobs]


async def _capture_raw_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue, **overrides
) -> str:
    """Set an email and pull the raw token out of the enqueued job args."""
    await _set_email(api_client, **overrides)
    tokens = _all_send_tokens(fake_email_queue)
    assert tokens, "expected at least one finished email job"
    return tokens[-1]


async def test_confirm_email_sets_confirmed_at_and_invalidates_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    user = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    assert response.status_code == 200
    body_user = response.json()["data"]["user"]
    assert body_user["confirmed_at"] is not None

    await db_session.refresh(user)
    assert user.confirmed_at is not None

    # Token consumed.
    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT
            )
        )
    ).scalars().all()
    assert tokens == []

    # Replaying the same token is rejected.
    replay = await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    assert replay.status_code == 400


async def test_confirm_email_rejects_unknown_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": "totally-bogus"}
    )
    assert response.status_code == 400


async def test_confirm_email_rejects_other_users_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """A confirmation link issued to user A must not confirm user B."""
    from tests._helpers import make_client

    # User A sets an email and we capture their token.
    await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    # User B has a fresh session — submitting A's token must 400.
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        response = await other_client.post(
            "/v1/me/email/confirm", json={"token": raw_token}
        )
        assert response.status_code == 400


async def test_confirm_email_requires_session(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": "anything"}
    )
    assert response.status_code == 401


async def test_token_is_stored_hashed_not_plaintext(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    token_row = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT
            )
        )
    ).scalar_one()
    assert token_row.token == hashlib.sha256(raw_token.encode("utf-8")).digest()
    assert token_row.token != raw_token.encode("utf-8")


# ---- resend ---------------------------------------------------------------


async def test_resend_issues_new_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await start_session(api_client, db_session)
    first_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue
    )

    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "website": ""},
    )
    assert response.status_code == 202

    # Old token must be gone; new token must be different.
    tokens = _all_send_tokens(fake_email_queue)
    new_token = tokens[-1]
    assert new_token != first_token

    confirm = await api_client.post(
        "/v1/me/email/confirm", json={"token": first_token}
    )
    assert confirm.status_code == 400


async def test_resend_requires_email_set(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "website": ""},
    )
    assert response.status_code == 400


async def test_resend_rejects_if_already_confirmed(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    user = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)
    await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    await db_session.refresh(user)
    assert user.confirmed_at is not None

    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "website": ""},
    )
    assert response.status_code == 409


async def test_resend_honeypot_short_circuits(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await start_session(api_client, db_session)
    await _set_email(api_client)
    job_count_before = fake_email_queue.finished_job_registry.count

    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "website": "spam"},
    )
    assert response.status_code == 202
    assert fake_email_queue.finished_job_registry.count == job_count_before


# ---- rate limiting --------------------------------------------------------


async def test_set_email_rate_limited(
    api_client: AsyncClient, db_session: AsyncSession
):
    """After 5 successful submits in the same session window, a 6th 429s."""
    await start_session(api_client, db_session)
    for i in range(5):
        response = await _set_email(api_client, email=f"rita{i}@example.com")
        assert response.status_code == 202, (i, response.text)

    over = await _set_email(api_client, email="rita-final@example.com")
    assert over.status_code == 429


async def test_set_email_rate_limit_is_per_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Another user with a fresh session isn't penalised by the first's burst."""
    from tests._helpers import make_client

    await start_session(api_client, db_session)
    for _ in range(5):
        assert (await _set_email(api_client)).status_code == 202
    assert (await _set_email(api_client)).status_code == 429

    async with make_client() as other_client:
        await start_session(other_client, db_session)
        response = await other_client.post(
            "/v1/me/email",
            json={
                "email": "other@example.com",
                "captcha_token": "x",
                "website": "",
            },
        )
        assert response.status_code == 202


async def test_resend_rate_limited(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The resend endpoint allows 3 sends per session window; the 4th 429s."""
    await start_session(api_client, db_session)
    await _set_email(api_client)  # establishes an unconfirmed email

    for i in range(3):
        response = await api_client.post(
            "/v1/me/email/resend",
            json={"captcha_token": "x", "website": ""},
        )
        assert response.status_code == 202, (i, response.text)

    over = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "website": ""},
    )
    assert over.status_code == 429
