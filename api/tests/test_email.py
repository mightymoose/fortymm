import hashlib
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.leagues import get_default_league
from app.main import app
from app.models import (
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
    UserToken,
)
from app.ratings.jobs import RECOMPUTE_AFTER_MERGE_JOB
from app.sessions import (
    EMAIL_CHANGE_CONTEXT_PREFIX,
    EMAIL_MERGE_CONTEXT_PREFIX,
    _pending_email_token_clause,
)
from tests._helpers import CSRF_EVENT_HOOKS, make_client, start_session


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="https://testserver",
        event_hooks=CSRF_EVENT_HOOKS,
    ) as client:
        yield client
    app.dependency_overrides.clear()


VALID_BODY = {
    "email": "rita@example.com",
    "captcha_token": "test-token",
    "fmm_hp_token": "",
}


async def _set_email(client: AsyncClient, **overrides) -> "httpx.Response":  # noqa: F821
    body = {**VALID_BODY, **overrides}
    return await client.post("/v1/me/email", json=body)


def _finished_send_jobs(fake_email_queue) -> list:
    """Every finished email-send job, oldest first."""
    jobs = [
        fake_email_queue.fetch_job(job_id)
        for job_id in fake_email_queue.finished_job_registry.get_job_ids()
    ]
    jobs = [j for j in jobs if j is not None]
    jobs.sort(key=lambda j: j.enqueued_at)
    return jobs


async def _record_match(
    db: AsyncSession,
    creator: User,
    *players: User,
    affects_rating: bool = False,
) -> Match:
    """Minimal completed match so a merge has something to move."""
    league = await get_default_league(db)
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=affects_rating)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=creator.id,
        status=MatchStatus.completed,
    )
    for side_number, player in enumerate(players, start=1):
        side = MatchSide(match=match, side_number=side_number)
        side.players.append(MatchSidePlayer(match=match, user=player))
    db.add(match)
    await db.commit()
    await db.refresh(match)
    return match


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
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(tokens) == 1
    assert tokens[0].sent_to == "rita@example.com"
    assert tokens[0].user_id == user.id
    # Token stored hashed.
    assert tokens[0].token != b"rita@example.com"

    finished = fake_email_queue.finished_job_registry
    assert finished.count == 1


async def test_pending_email_reflects_most_recent_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Defensive determinism (issue #277): ``set_email`` rotates change tokens
    so only one is ever pending, but if more than one is present the session's
    ``pending_email`` must reflect the *most recent* by ``created_at`` — not an
    arbitrary row, since ``UserToken.id`` is a random UUID, not a sequence."""
    user = await start_session(api_client, db_session)
    older = datetime(2026, 1, 1, tzinfo=UTC)
    db_session.add_all(
        [
            UserToken(
                user_id=user.id,
                context=EMAIL_CHANGE_CONTEXT_PREFIX,
                token=b"older-token",
                sent_to="older@example.com",
                created_at=older,
            ),
            UserToken(
                user_id=user.id,
                context=EMAIL_CHANGE_CONTEXT_PREFIX,
                token=b"newer-token",
                sent_to="newer@example.com",
                created_at=older + timedelta(hours=1),
            ),
        ]
    )
    await db_session.commit()

    response = await api_client.get("/v1/session")
    assert response.status_code == 200
    assert response.json()["data"]["user"]["pending_email"] == "newer@example.com"


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
    response = await _set_email(api_client, fmm_hp_token="https://spammer.example")
    # Same shape as a real success — gives the bot no signal.
    assert response.status_code == 202

    await db_session.refresh(user)
    assert user.email is None  # nothing persisted

    tokens = (
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
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


async def test_set_email_taken_address_starts_merge_for_guest(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """A guest who enters an address owned by an existing account is offered a
    merge: we email the owner a sign-in link (a ``merge:<owner-id>`` token) and
    return the *same* 202 + ``pending_email`` shape as a first-time set. The
    HTTP response is identical to a free-address submit, so an attacker still
    can't enumerate accounts by cycling fresh `/v1/session` cookies."""
    owner = User(
        username="other", email="taken@example.com", confirmed_at=datetime.now(UTC)
    )
    db_session.add(owner)
    await db_session.commit()
    await db_session.refresh(owner)
    me = await start_session(api_client, db_session)

    response = await _set_email(api_client, email="taken@example.com")
    assert response.status_code == 202
    # Same outward shape as a normal pending set.
    assert response.json()["data"]["user"]["pending_email"] == "taken@example.com"

    await db_session.refresh(me)
    # The guest's own row is untouched until they click the link.
    assert me.email is None
    assert me.confirmed_at is None

    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX),
                UserToken.user_id == me.id,
            )
        )
    ).scalar_one()
    assert token.context == f"{EMAIL_MERGE_CONTEXT_PREFIX}{owner.id}"
    assert token.sent_to == "taken@example.com"

    # The owner got the "sign in to your account" email, addressed to them.
    jobs = _finished_send_jobs(fake_email_queue)
    assert len(jobs) == 1
    assert jobs[0].func_name == "app.email.send_merge_email"
    assert jobs[0].args[0] == "taken@example.com"
    assert jobs[0].args[2] == owner.username


async def test_set_email_taken_address_is_noop_for_verified_caller(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """A caller who already has a confirmed email is *changing* addresses, not
    merging. Folding their established account into someone else's would be
    data loss — so a taken address stays the enumeration-safe no-op: no token,
    no email."""
    db_session.add(
        User(
            username="other", email="taken@example.com", confirmed_at=datetime.now(UTC)
        )
    )
    me = await start_session(api_client, db_session)
    me.email = "mine@example.com"
    me.confirmed_at = datetime.now(UTC)
    await db_session.commit()

    response = await _set_email(api_client, email="taken@example.com")
    assert response.status_code == 202

    await db_session.refresh(me)
    assert me.email == "mine@example.com"

    tokens = (
        (
            await db_session.execute(
                select(UserToken).where(
                    _pending_email_token_clause(),
                    UserToken.user_id == me.id,
                )
            )
        )
        .scalars()
        .all()
    )
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
    user.confirmed_at = datetime.now(UTC)
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
    user.confirmed_at = datetime.now(UTC)
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
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(tokens) == 1
    assert tokens[0].sent_to == "rita2@example.com"


async def test_resubmitting_same_email_when_verified_is_a_noop(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Resubmitting the address the user is already verified for has
    nothing to confirm — no token issued, no email sent, no state change."""
    user = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)
    await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
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
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
    assert tokens == []


async def test_changing_email_preserves_prior_verification(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Requesting a change to a NEW address must not un-verify the user —
    they keep their verified state for the prior address until they click
    the link from the new inbox."""
    user = await start_session(api_client, db_session)
    user.email = "prior@example.com"
    user.confirmed_at = datetime.now(UTC)
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
    return [j.args[1] for j in _finished_send_jobs(fake_email_queue)]


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

    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
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
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
    assert tokens == []

    # Replaying the same token is rejected.
    replay = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert replay.status_code == 400


async def test_confirm_email_rejects_unknown_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": "totally-bogus"}
    )
    assert response.status_code == 400


async def test_confirm_email_rejects_an_expired_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """An email-change link past its lifetime is rejected and burned, so a
    leaked or forwarded link can't be redeemed indefinitely."""
    user = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    # Age the token past its 24h lifetime.
    token_row = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
            )
        )
    ).scalar_one()
    token_row.created_at = datetime.now(UTC) - timedelta(hours=25)
    await db_session.commit()

    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert response.status_code == 400

    # The address change did not take effect...
    await db_session.refresh(user)
    assert user.email != "rita@example.com"
    assert user.confirmed_at is None

    # ...and the stale token is burned.
    remaining = (
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
    assert remaining == []


async def test_confirm_email_works_from_a_different_browser(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The token is itself a bearer credential — clicking the link in any
    browser must confirm the change. The endpoint rotates the caller's
    session cookie to the token's owner so they end up signed in as the
    right user."""
    from tests._helpers import make_client

    user_a = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

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
    user.confirmed_at = datetime.now(UTC)
    await db_session.commit()

    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email="next@example.com"
    )

    # Out-of-band reset of the user's email — context was cut against
    # "prior@example.com" but now points elsewhere.
    user.email = "different@example.com"
    await db_session.commit()

    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert response.status_code == 400
    # Token burned.
    tokens = (
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
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
            confirmed_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert response.status_code == 400
    await db_session.refresh(me)
    # Caller's row is untouched — the rollback preserved their prior state.
    assert me.email is None
    assert me.confirmed_at is None
    # The pending-change token must be burned so the user isn't trapped in a
    # resend loop where every click hits the same IntegrityError.
    remaining = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.user_id == me.id,
                _pending_email_token_clause(),
            )
        )
    ).scalar_one_or_none()
    assert remaining is None


async def test_confirm_email_does_not_require_session(api_client: AsyncClient):
    """Cookieless POST to /confirm-email is the cross-device mobile-mail
    case — it should return 400 (invalid token) not 401 (no session)."""
    response = await api_client.post("/v1/me/email/confirm", json={"token": "anything"})
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


# ---- confirm: rating recompute enqueue on prior-session fold --------------


async def test_confirm_email_enqueues_recompute_for_voided_self_play_collision(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_email_queue,
    fake_ratings_queue,
):
    """Confirming an email folds the clicking browser's ephemeral guest into the
    token owner (``_maybe_merge_prior_session``). When the guest's ONLY rated
    match is a self-play collision against that owner (ADR-0013), the merge VOIDS
    it, so ``matches_moved`` reports 0 — yet the owner's rating was inflated by
    that voided match and the recompute MUST still be enqueued to strip it. This
    is the confirm-path twin of ``test_login`` 's collision regression: the old
    ``matches_moved > 0`` gate silently dropped this enqueue."""
    # The token owner (survivor) sets a first-time email on their own browser.
    owner = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    # A DIFFERENT browser holds an ephemeral guest that played a RATED match
    # against the owner — a self-play collision the confirm-time fold will void.
    guest_client = make_client()
    async with guest_client:
        guest = await start_session(guest_client, db_session)
        match = await _record_match(
            db_session, guest, guest, owner, affects_rating=True
        )

        response = await guest_client.post(
            "/v1/me/email/confirm", json={"token": raw_token}
        )
    assert response.status_code == 200
    # The voided collision is NOT reported as a moved match.
    assert response.json()["merged"] == {"matches_moved": 0}

    # The match was voided, confirming this exercised the collision path.
    voided_status = (
        await db_session.execute(select(Match.status).where(Match.id == match.id))
    ).scalar_one()
    assert voided_status == MatchStatus.voided

    # The recompute is STILL enqueued despite matches_moved == 0, carrying the
    # survivor (token owner) id.
    jobs = fake_ratings_queue.get_jobs()
    assert len(jobs) == 1
    assert jobs[0].func_name == RECOMPUTE_AFTER_MERGE_JOB
    assert jobs[0].args == (str(owner.id),)


async def test_confirm_email_enqueues_recompute_even_when_no_matches_moved(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_email_queue,
    fake_ratings_queue,
):
    """A confirm-time fold with zero matches moved STILL enqueues the recompute:
    the survivor may hold a stale rating the empty-timeline reset must rewrite
    (ADR-0013). The gate fires on any merge, not only ``matches_moved > 0``."""
    owner = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    # A DIFFERENT browser with an ephemeral guest that never played anything.
    guest_client = make_client()
    async with guest_client:
        await start_session(guest_client, db_session)
        response = await guest_client.post(
            "/v1/me/email/confirm", json={"token": raw_token}
        )
    assert response.status_code == 200
    assert response.json()["merged"] == {"matches_moved": 0}

    jobs = fake_ratings_queue.get_jobs()
    assert len(jobs) == 1
    assert jobs[0].func_name == RECOMPUTE_AFTER_MERGE_JOB
    assert jobs[0].args == (str(owner.id),)


# ---- confirm: merge into an existing account ------------------------------


async def test_confirm_merge_signs_in_as_owner_and_moves_matches(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Clicking a merge link folds the requesting guest into the account that
    owns the address, carries their matches over, and signs the browser in as
    that account."""
    owner = User(
        username="owner", email="taken@example.com", confirmed_at=datetime.now(UTC)
    )
    opponent = User(username="opponent")
    db_session.add_all([owner, opponent])
    await db_session.commit()
    await db_session.refresh(owner)

    guest = await start_session(api_client, db_session)
    match = await _record_match(db_session, guest, guest, opponent)

    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email="taken@example.com"
    )
    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert response.status_code == 200
    body = response.json()
    assert body["data"]["user"]["username"] == "owner"
    assert body["data"]["user"]["email"] == "taken@example.com"
    assert body["merged"]["matches_moved"] == 1

    # The guest row is tombstoned — folded into the owner (soft-delete).
    tombstoned = (
        await db_session.execute(select(User).where(User.id == guest.id))
    ).scalar_one_or_none()
    assert tombstoned is not None
    assert tombstoned.merged_into_user_id == owner.id

    # The match's player now points at the owner.
    player_ids = {
        p.user_id
        for p in (
            await db_session.execute(
                select(MatchSidePlayer).where(MatchSidePlayer.match_id == match.id)
            )
        )
        .scalars()
        .all()
    }
    assert owner.id in player_ids
    assert guest.id not in player_ids

    # The browser's cookie now resolves to the owner.
    whoami = await api_client.get("/v1/session")
    assert whoami.json()["data"]["user"]["username"] == "owner"


async def test_confirm_merge_works_cross_device_via_token_binding(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The merge follows the *requesting* guest recorded on the token, not the
    session that clicks the link — so a desktop request confirmed on a fresh
    (cookieless) browser still merges the right guest."""
    from tests._helpers import make_client

    owner = User(
        username="owner", email="taken@example.com", confirmed_at=datetime.now(UTC)
    )
    db_session.add(owner)
    await db_session.commit()
    await db_session.refresh(owner)

    guest = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email="taken@example.com"
    )

    async with make_client() as other:
        response = await other.post("/v1/me/email/confirm", json={"token": raw_token})
        assert response.status_code == 200
        assert response.json()["data"]["user"]["username"] == "owner"
        assert other.cookies.get("session")

    tombstoned = (
        await db_session.execute(select(User).where(User.id == guest.id))
    ).scalar_one_or_none()
    assert tombstoned is not None
    assert tombstoned.merged_into_user_id == owner.id


async def test_confirm_merge_rejected_when_owner_changed_email(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The token is only good while the owner still holds the address it was
    cut against. If they move off it, the merge link is burned and refused —
    no guess about who owns what leaks."""
    owner = User(
        username="owner", email="taken@example.com", confirmed_at=datetime.now(UTC)
    )
    db_session.add(owner)
    await db_session.commit()

    guest = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email="taken@example.com"
    )

    owner.email = "moved@example.com"
    await db_session.commit()

    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert response.status_code == 400

    # Guest survives un-tombstoned (nothing merged) and the token is gone.
    survivor = (
        await db_session.execute(select(User).where(User.id == guest.id))
    ).scalar_one_or_none()
    assert survivor is not None
    assert survivor.merged_into_user_id is None
    tokens = (
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX)
                )
            )
        )
        .scalars()
        .all()
    )
    assert tokens == []


async def test_resend_merge_token_resends_the_merge_email(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Resending a pending merge re-sends the 'sign in to your account' email
    to the owner — not the plain confirmation copy."""
    owner = User(
        username="owner", email="taken@example.com", confirmed_at=datetime.now(UTC)
    )
    db_session.add(owner)
    await db_session.commit()
    await db_session.refresh(owner)

    await start_session(api_client, db_session)
    await _set_email(api_client, email="taken@example.com")

    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "fmm_hp_token": ""},
    )
    assert response.status_code == 202

    last = _finished_send_jobs(fake_email_queue)[-1]
    assert last.func_name == "app.email.send_merge_email"
    assert last.args[0] == "taken@example.com"
    assert last.args[2] == owner.username


# ---- resend ---------------------------------------------------------------


async def test_resend_issues_new_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await start_session(api_client, db_session)
    first_token = await _capture_raw_token(api_client, db_session, fake_email_queue)

    response = await api_client.post(
        "/v1/me/email/resend",
        json={"captcha_token": "x", "fmm_hp_token": ""},
    )
    assert response.status_code == 202

    # Old token must be gone; new token must be different.
    tokens = _all_send_tokens(fake_email_queue)
    new_token = tokens[-1]
    assert new_token != first_token

    confirm = await api_client.post("/v1/me/email/confirm", json={"token": first_token})
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
    await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
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

    def _decode(value: object) -> str:
        return value.decode() if isinstance(value, bytes) else str(value)

    # pyrate-limiter stores per-identifier state as ZSET members under the
    # bucket_key. Scan both the keys themselves and every ZSET member so
    # a cookie that landed in either surface fails the test.
    keys = [_decode(k) for k in await rate_limiter_fakeredis.keys("*")]
    members: list[str] = []
    for key in keys:
        for member in await rate_limiter_fakeredis.zrange(key, 0, -1):
            members.append(_decode(member))

    for token in keys + members:
        assert raw_cookie not in token, (
            f"raw session cookie leaked into Redis: {token!r}"
        )


# ---- captcha + email config guards ---------------------------------------


def test_captcha_secret_default_only_in_dev(monkeypatch):
    from app import captcha as captcha_module

    monkeypatch.delenv("TURNSTILE_SECRET_KEY", raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="TURNSTILE_SECRET_KEY"):
        captcha_module._secret_key()

    monkeypatch.setenv("APP_ENV", "dev")
    assert (
        captcha_module._secret_key()
        == captcha_module.TURNSTILE_TEST_SECRET_ALWAYS_PASSES
    )


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


# ---- notification email ---------------------------------------------------


def test_absolute_link_is_none_without_a_link(monkeypatch):
    from app import email as email_module

    monkeypatch.setenv("APP_BASE_URL", "https://fortymm.test")
    assert email_module._absolute_link(None) is None
    assert email_module._absolute_link("") is None


def test_absolute_link_joins_a_relative_path(monkeypatch):
    from app import email as email_module

    monkeypatch.setenv("APP_BASE_URL", "https://fortymm.test")
    assert (
        email_module._absolute_link("/matches/abc")
        == "https://fortymm.test/matches/abc"
    )
    # A missing leading slash is normalised, not doubled.
    assert (
        email_module._absolute_link("matches/abc") == "https://fortymm.test/matches/abc"
    )


def test_absolute_link_passes_through_an_absolute_url(monkeypatch):
    from app import email as email_module

    monkeypatch.setenv("APP_BASE_URL", "https://fortymm.test")
    assert (
        email_module._absolute_link("https://elsewhere.test/x")
        == "https://elsewhere.test/x"
    )


def test_absolute_link_is_none_without_a_base(monkeypatch):
    from app import email as email_module

    monkeypatch.delenv("APP_BASE_URL", raising=False)
    monkeypatch.delenv("FORTYMM_DEV", raising=False)
    assert email_module._absolute_link("/matches/abc") is None


def test_send_notification_email_builds_subject_body_and_link(monkeypatch):
    from app import email as email_module

    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    monkeypatch.setenv("APP_BASE_URL", "https://fortymm.test")
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        email_module, "_send_via_smtp", lambda message: captured.update(msg=message)
    )

    email_module.send_notification_email(
        "player@example.com",
        "Spring Open · R16 posted",
        "You play the winner of Tran / Chen.",
        "/matches/m-1",
    )

    message = captured["msg"]
    assert message["Subject"] == "FortyMM · Spring Open · R16 posted"  # type: ignore[index]
    assert message["To"] == "player@example.com"  # type: ignore[index]
    body = message.get_content()  # type: ignore[attr-defined]
    assert "Spring Open · R16 posted" in body
    assert "You play the winner of Tran / Chen." in body
    assert "https://fortymm.test/matches/m-1" in body


def test_send_no_account_email_builds_subject_and_body(monkeypatch):
    from app import email as email_module

    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    monkeypatch.setenv("APP_BASE_URL", "https://fortymm.test")
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        email_module, "_send_via_smtp", lambda message: captured.update(msg=message)
    )

    email_module.send_no_account_email("stranger@example.com")

    message = captured["msg"]
    assert message["Subject"] == "About your FortyMM sign-in request"  # type: ignore[index]
    assert message["To"] == "stranger@example.com"  # type: ignore[index]
    body = message.get_content()  # type: ignore[attr-defined]
    assert "no FortyMM account" in body
    assert "https://fortymm.test" in body
    # Tokenless — it must never carry a sign-in/confirm bearer link.
    assert "/login/verifying" not in body
    assert "/confirm-email" not in body


def test_send_notification_email_omits_the_link_when_absent(monkeypatch):
    from app import email as email_module

    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    monkeypatch.setenv("APP_BASE_URL", "https://fortymm.test")
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        email_module, "_send_via_smtp", lambda message: captured.update(msg=message)
    )

    email_module.send_notification_email("player@example.com", "Heads up", "No link.")

    body = captured["msg"].get_content()  # type: ignore[attr-defined]
    assert "Heads up" in body
    assert "https://" not in body
