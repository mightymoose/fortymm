import hashlib
from collections.abc import AsyncIterator
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import User, UserToken
from app.sessions import EMAIL_CHANGE_CONTEXT_PREFIX
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
    "fmm_hp_token": "",
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
    assert user["pending_email"] is None


async def test_set_email_is_pending_only(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """``set_email`` issues a token and enqueues delivery but does not
    mutate ``user.email`` or ``user.confirmed_at`` — the new address lives
    only on the token until ``confirm_email`` consumes it."""
    user = await start_session(api_client, db_session)
    response = await _set_email(api_client)
    assert response.status_code == 202

    body_user = response.json()["data"]["user"]
    assert body_user["email"] is None
    assert body_user["confirmed_at"] is None
    assert body_user["pending_email"] == "rita@example.com"

    await db_session.refresh(user)
    assert user.email is None
    assert user.confirmed_at is None

    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
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
    await start_session(api_client, db_session)
    response = await _set_email(api_client, email="MixedCase@Example.COM")
    assert response.status_code == 202
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    assert token.sent_to == "mixedcase@example.com"
    assert response.json()["data"]["user"]["pending_email"] == "mixedcase@example.com"


async def test_set_email_rejects_invalid_format(api_client: AsyncClient, db_session):
    await start_session(api_client, db_session)
    response = await _set_email(api_client, email="not-an-email")
    assert response.status_code == 422


async def test_set_email_honeypot_silently_succeeds(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    user = await start_session(api_client, db_session)
    response = await _set_email(
        api_client, fmm_hp_token="https://spammer.example"
    )
    # Same shape as a real success — gives the bot no signal.
    assert response.status_code == 202

    await db_session.refresh(user)
    assert user.email is None  # nothing persisted

    tokens = (
        await db_session.execute(select(UserToken).where(
            UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
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


async def test_set_email_with_taken_address_is_enumeration_safe(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Submitting an address belonging to someone else must look identical
    to a no-op success — same 202, same session response shape, no token
    issued, no email enqueued. Returning 409 would let an attacker cycle
    fresh `/v1/session` cookies to enumerate the user base."""
    db_session.add(User(username="other", email="taken@example.com"))
    await db_session.commit()
    me = await start_session(api_client, db_session)

    response = await _set_email(api_client, email="taken@example.com")
    assert response.status_code == 202

    await db_session.refresh(me)
    # Caller's own row is untouched.
    assert me.email is None
    assert me.confirmed_at is None

    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX),
                UserToken.user_id == me.id,
            )
        )
    ).scalars().all()
    assert tokens == []
    assert fake_email_queue.finished_job_registry.count == 0


async def test_token_context_records_confirmed_prior_email(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Tokens carry the user's *confirmed* prior address in their context
    so we have an audit trail of what each token was changing FROM.
    Unconfirmed re-submits keep context=``change:`` because nothing was
    ever verified to change FROM."""
    user = await start_session(api_client, db_session)

    # First-time set — no prior confirmed address.
    await _set_email(api_client, email="first@example.com")
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    assert token.context == "change:"
    assert token.sent_to == "first@example.com"

    # Re-submit before confirming — the first address was never confirmed
    # so the context still records no prior address.
    await _set_email(api_client, email="second@example.com")
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    assert token.context == "change:"
    assert token.sent_to == "second@example.com"

    # Simulate confirmation, then change again — now the context picks up
    # the newly-confirmed prior address.
    user.email = "second@example.com"
    user.confirmed_at = datetime.now(timezone.utc)
    await db_session.commit()
    await _set_email(api_client, email="third@example.com")
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    assert token.context == "change:second@example.com"
    assert token.sent_to == "third@example.com"


async def test_resend_preserves_original_change_context(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Resend should keep the original 'change:OLD' context so the audit
    trail still reflects what the user was changing away from."""
    user = await start_session(api_client, db_session)
    # Establish a confirmed prior email so the next set has something to
    # change FROM.
    user.email = "prior@example.com"
    user.confirmed_at = datetime.now(timezone.utc)
    await db_session.commit()

    await _set_email(api_client, email="next@example.com")
    first = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    assert first.context == "change:prior@example.com"

    await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "fmm_hp_token": ""},
    )
    after = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    assert after.context == "change:prior@example.com"
    assert after.sent_to == "next@example.com"
    # Token rotated.
    assert after.token != first.token


async def test_set_email_replaces_existing_unconfirmed_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await _set_email(api_client)
    await _set_email(api_client, email="rita2@example.com")

    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].sent_to == "rita2@example.com"


async def test_resubmitting_same_email_when_verified_is_a_noop(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Resubmitting the address the user is already verified for has
    nothing to confirm — no token issued, no email sent, no state change."""
    user = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)
    await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    await db_session.refresh(user)
    assert user.confirmed_at is not None
    sent_count = fake_email_queue.finished_job_registry.count

    response = await _set_email(api_client)  # same email as VALID_BODY
    assert response.status_code == 202
    body_user = response.json()["data"]["user"]
    assert body_user["pending_email"] is None
    assert body_user["confirmed_at"] is not None

    await db_session.refresh(user)
    assert user.confirmed_at is not None
    assert user.email == "rita@example.com"
    # No second email enqueued for the no-op resubmit.
    assert fake_email_queue.finished_job_registry.count == sent_count
    # No pending token left behind either.
    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalars().all()
    assert tokens == []


async def test_changing_email_preserves_prior_verification(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Requesting a change to a NEW address must not un-verify the user —
    they keep their verified state for the prior address until they click
    the link from the new inbox."""
    user = await start_session(api_client, db_session)
    user.email = "prior@example.com"
    user.confirmed_at = datetime.now(timezone.utc)
    await db_session.commit()

    response = await _set_email(api_client, email="changed@example.com")
    assert response.status_code == 202
    body_user = response.json()["data"]["user"]
    assert body_user["email"] == "prior@example.com"
    assert body_user["confirmed_at"] is not None
    assert body_user["pending_email"] == "changed@example.com"

    await db_session.refresh(user)
    assert user.email == "prior@example.com"
    assert user.confirmed_at is not None
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    assert token.context == "change:prior@example.com"
    assert token.sent_to == "changed@example.com"


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
    assert body_user["email"] == "rita@example.com"
    assert body_user["confirmed_at"] is not None
    assert body_user["pending_email"] is None

    await db_session.refresh(user)
    assert user.email == "rita@example.com"
    assert user.confirmed_at is not None

    # Token consumed.
    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
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


async def test_confirm_email_works_from_a_different_browser(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The token is itself a bearer credential — clicking the link in any
    browser must confirm the change. The endpoint rotates the caller's
    session cookie to the token's owner so they end up signed in as the
    right user."""
    from tests._helpers import make_client

    user_a = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue
    )

    async with make_client() as other_client:
        # User B opens the link in a separate browser with no session cookie.
        response = await other_client.post(
            "/v1/me/email/confirm", json={"token": raw_token}
        )
        assert response.status_code == 200
        body_user = response.json()["data"]["user"]
        assert body_user["username"] == user_a.username
        assert body_user["confirmed_at"] is not None
        # Session cookie was minted/rotated to user A on the new browser.
        assert other_client.cookies.get("session")

    await db_session.refresh(user_a)
    assert user_a.confirmed_at is not None


async def test_confirm_email_rejects_when_user_email_no_longer_matches_token_context(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The token's context records the user's confirmed prior address at
    issue time. If the user's current ``email`` no longer matches that
    (admin reset, stale token, etc.), the token is no longer trustworthy —
    confirm must burn it and return the opaque "invalid or expired"."""
    user = await start_session(api_client, db_session)
    user.email = "prior@example.com"
    user.confirmed_at = datetime.now(timezone.utc)
    await db_session.commit()

    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email="next@example.com"
    )

    # Out-of-band reset of the user's email — context was cut against
    # "prior@example.com" but now points elsewhere.
    user.email = "different@example.com"
    await db_session.commit()

    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    assert response.status_code == 400
    # Token burned.
    tokens = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalars().all()
    assert tokens == []


async def test_confirm_email_handles_address_race(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """If a second user grabs the same address between this user's token
    being issued and the click, the commit hits the ``users.email`` unique
    constraint. Surface the same opaque error as any other invalid link —
    "that address is now taken" would leak who owns it."""
    me = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email="contested@example.com"
    )

    # A different user confirms the same address first.
    db_session.add(
        User(
            username="other",
            email="contested@example.com",
            confirmed_at=datetime.now(timezone.utc),
        )
    )
    await db_session.commit()

    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    assert response.status_code == 400
    await db_session.refresh(me)
    # Caller's row is untouched — the rollback preserved their prior state.
    assert me.email is None
    assert me.confirmed_at is None


async def test_confirm_email_does_not_require_session(api_client: AsyncClient):
    """Cookieless POST to /confirm-email is the cross-device mobile-mail
    case — it should return 400 (invalid token) not 401 (no session)."""
    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": "anything"}
    )
    assert response.status_code == 400


async def test_token_is_stored_hashed_not_plaintext(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    token_row = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
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
        json={"captcha_token": "x", "fmm_hp_token": ""},
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


async def test_resend_requires_pending_change(
    api_client: AsyncClient, db_session: AsyncSession
):
    """No pending token → nothing to resend. Covers both the never-set and
    the already-verified-with-no-change-in-flight cases."""
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "fmm_hp_token": ""},
    )
    assert response.status_code == 400


async def test_resend_400s_after_confirm_consumes_the_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Once the user confirms, the pending token is gone — resend has
    nothing left to send and returns 400 (not 409 like the old flow)."""
    user = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)
    await api_client.post(
        "/v1/me/email/confirm", json={"token": raw_token}
    )
    await db_session.refresh(user)
    assert user.confirmed_at is not None

    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "fmm_hp_token": ""},
    )
    assert response.status_code == 400


async def test_resend_honeypot_short_circuits(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await start_session(api_client, db_session)
    await _set_email(api_client)
    job_count_before = fake_email_queue.finished_job_registry.count

    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "fmm_hp_token": "spam"},
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
                "fmm_hp_token": "",
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
            json={"captcha_token": "x", "fmm_hp_token": ""},
        )
        assert response.status_code == 202, (i, response.text)

    over = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "fmm_hp_token": ""},
    )
    assert over.status_code == 429


async def test_set_email_ip_limit_catches_session_cycling(
    api_client: AsyncClient, db_session: AsyncSession
):
    """An attacker who cycles `/v1/session` for fresh per-session buckets
    is still caught by the looser per-IP ceiling."""
    from tests._helpers import make_client

    # Burn through the per-session cap on the primary client.
    await start_session(api_client, db_session)
    for _ in range(5):
        assert (await _set_email(api_client)).status_code == 202

    # Rotate through fresh sessions; each gets its own 5/hr session bucket,
    # but the per-IP bucket is shared. After 20 total IP hits, the next 429s.
    total = 5
    for _ in range(20):
        if total >= 20:
            break
        async with make_client() as fresh:
            await start_session(fresh, db_session)
            resp = await _set_email(fresh, email=f"r{total}@example.com")
            assert resp.status_code == 202, (total, resp.text)
            total += 1

    async with make_client() as fresh:
        await start_session(fresh, db_session)
        resp = await _set_email(fresh, email="overflow@example.com")
        assert resp.status_code == 429


async def test_rate_limit_key_hashes_session_cookie(
    api_client: AsyncClient, db_session: AsyncSession, rate_limiter_fakeredis
):
    """The session cookie is a bearer credential — it must never land in
    Redis verbatim, where read-only access would let anyone impersonate
    the user."""
    await start_session(api_client, db_session)
    raw_cookie = api_client.cookies.get("session")
    assert raw_cookie

    await _set_email(api_client)

    keys = await rate_limiter_fakeredis.keys("*")
    decoded = [k.decode() if isinstance(k, bytes) else k for k in keys]
    for key in decoded:
        assert raw_cookie not in key, (
            f"raw session cookie leaked into Redis key: {key!r}"
        )


# ---- captcha + email config guards ---------------------------------------


def test_captcha_secret_default_only_in_dev(monkeypatch):
    from app import captcha as captcha_module

    monkeypatch.delenv("TURNSTILE_SECRET_KEY", raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="TURNSTILE_SECRET_KEY"):
        captcha_module._secret_key()

    monkeypatch.setenv("APP_ENV", "dev")
    assert captcha_module._secret_key() == captcha_module.TURNSTILE_TEST_SECRET_ALWAYS_PASSES


async def test_captcha_fails_closed_when_misconfigured_in_prod(monkeypatch):
    # Restore the real verifier (autouse `stub_captcha` swaps it out).
    import importlib

    from app import captcha as captcha_module

    importlib.reload(captcha_module)

    monkeypatch.delenv("TURNSTILE_SECRET_KEY", raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    # Even with a non-empty token, verification refuses rather than
    # silently passing via the test secret.
    assert await captcha_module.verify_captcha("any-token") is False


def test_email_refuses_to_send_without_app_base_url(monkeypatch):
    from app import email as email_module

    monkeypatch.delenv("APP_BASE_URL", raising=False)
    monkeypatch.delenv("FORTYMM_DEV", raising=False)
    with pytest.raises(RuntimeError, match="APP_BASE_URL"):
        email_module._confirm_url("token")


def test_email_refuses_to_send_when_smtp_unset_outside_dev(monkeypatch):
    from app import email as email_module

    monkeypatch.delenv("SMTP_HOST", raising=False)
    monkeypatch.delenv("FORTYMM_DEV", raising=False)
    monkeypatch.setenv("APP_BASE_URL", "https://example.com")
    with pytest.raises(RuntimeError, match="SMTP"):
        email_module.send_confirmation_email("a@b.com", "tok", "user")
