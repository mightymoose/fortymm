import hashlib
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

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
    LOGIN_TOKEN_CONTEXT,
    SESSION_COOKIE_NAME,
    SESSION_TOKEN_CONTEXT,
)
from tests._helpers import (
    CSRF_EVENT_HOOKS,
    make_client,
    make_raw_client,
    make_user,
    start_session,
)


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


REQUEST_BODY = {
    "email": "rita@example.com",
    "captcha_token": "test-token",
    "fmm_hp_token": "",
}


async def _make_confirmed_user(db_session: AsyncSession, email: str) -> User:
    user = User(
        username=email.split("@")[0],
        email=email,
        confirmed_at=datetime.now(UTC),
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
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
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
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
    assert len(tokens) == 1
    assert tokens[0].user_id == user.id
    assert tokens[0].sent_to == "rita@example.com"


async def test_request_for_unknown_email_sends_no_account_email_without_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """An unknown address mints no login token (no account to sign into) but
    still gets a tokenless 'no account yet' email, so it's indistinguishable
    from a known address from the outside — same 202, and a piece of mail
    either way."""
    response = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert response.status_code == 202
    assert response.json() == {"email": "rita@example.com"}

    tokens = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
    assert tokens == []

    assert fake_email_queue.finished_job_registry.count == 1
    job = fake_email_queue.fetch_job(
        fake_email_queue.finished_job_registry.get_job_ids()[0]
    )
    assert job is not None
    assert job.func_name == "app.email.send_no_account_email"
    assert job.args == ("rita@example.com",)


async def test_request_for_unconfirmed_account_resends_confirmation(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """An account whose email isn't confirmed yet gets the confirmation
    link re-sent instead of a sign-in link, so the user has a path
    forward. Response shape stays identical for enumeration safety."""
    user = User(username="pending", email="rita@example.com", confirmed_at=None)
    db_session.add(user)
    await db_session.commit()

    response = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert response.status_code == 202
    assert response.json() == {"email": "rita@example.com"}

    login_tokens = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
    assert login_tokens == []

    change_tokens = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context.startswith("change:"))
            )
        )
        .scalars()
        .all()
    )
    assert len(change_tokens) == 1
    assert change_tokens[0].sent_to == "rita@example.com"
    assert change_tokens[0].user_id == user.id

    assert fake_email_queue.finished_job_registry.count == 1


async def test_request_replaces_prior_login_token_for_same_user(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await _make_confirmed_user(db_session, "rita@example.com")

    first = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    second = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert first.status_code == 202
    assert second.status_code == 202

    tokens = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
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
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
    assert tokens == []


async def test_request_honeypot_response_matches_success_path(api_client: AsyncClient):
    """Honeypot 202 must echo the lowercased email so bots can't diff
    honeypot vs success responses to detect the trap."""
    honeypot = await api_client.post(
        "/v1/login/request",
        json={
            **REQUEST_BODY,
            "email": "Rita@Example.COM",
            "fmm_hp_token": "https://spammer.example",
        },
    )
    success = await api_client.post(
        "/v1/login/request",
        json={**REQUEST_BODY, "email": "Rita@Example.COM"},
    )
    assert honeypot.status_code == success.status_code == 202
    assert honeypot.json() == success.json()


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

    response = await api_client.post("/v1/login/consume", json={"token": raw})
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
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.context == SESSION_TOKEN_CONTEXT,
                    UserToken.user_id == user.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert any(
        t.token == hashlib.sha256(new_cookie.encode("utf-8")).digest() for t in sessions
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
    second = await second_client.post("/v1/login/consume", json={"token": raw})
    assert second.status_code == 400
    await second_client.aclose()

    leftover = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
    assert leftover == []


async def test_consume_rejects_expired_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-expired"
    token = await _issue_login_token(db_session, user, raw)
    # Backdate past the 15-minute TTL.
    token.created_at = datetime.now(UTC) - timedelta(minutes=20)
    await db_session.commit()

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 400

    leftover = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
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

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["data"]["user"]["username"] == "rita"

    new_cookie = response.cookies.get(SESSION_COOKIE_NAME)
    me = await api_client.get("/v1/session", cookies={SESSION_COOKIE_NAME: new_cookie})
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

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 400


async def test_consume_rejects_link_after_user_changed_email(
    api_client: AsyncClient, db_session: AsyncSession
):
    """An in-flight login link to address X must not sign the user in if
    they've since pointed their account at address Y."""
    user = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-stale"
    await _issue_login_token(db_session, user, raw)

    user.email = "rita-new@example.com"
    await db_session.commit()

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 400

    leftover = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context == LOGIN_TOKEN_CONTEXT)
            )
        )
        .scalars()
        .all()
    )
    assert leftover == []


# ---- merge of ephemeral session on consume -------------------------------


async def _record_singles_match(db_session: AsyncSession, *players: User) -> Match:
    league = await get_default_league(db_session)
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=False)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=players[0].id,
        status=MatchStatus.completed,
    )
    for side_number, player in enumerate(players, start=1):
        side = MatchSide(match=match, side_number=side_number)
        side.players.append(MatchSidePlayer(match=match, user=player))
    db_session.add(match)
    await db_session.commit()
    return match


async def test_consume_merges_ephemeral_matches_into_verified_account(
    api_client: AsyncClient, db_session: AsyncSession
):
    """When the consuming browser arrived with an ephemeral session that
    already played a match, that match should follow the user into their
    verified account and the response should report the merge."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-merge"
    await _issue_login_token(db_session, rita, raw)

    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opponent-jay")
    match = await _record_singles_match(db_session, guest, opponent)

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200

    body = response.json()
    assert body["merged"] == {"matches_moved": 1}

    players = (
        (
            await db_session.execute(
                select(MatchSidePlayer).where(MatchSidePlayer.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert {p.user_id for p in players} == {rita.id, opponent.id}

    creator_id = (
        await db_session.execute(
            select(Match.created_by_user_id).where(Match.id == match.id)
        )
    ).scalar_one()
    assert creator_id == rita.id

    # The guest is tombstoned (soft-delete), not dropped.
    tombstoned = (
        await db_session.execute(select(User).where(User.id == guest.id))
    ).scalar_one_or_none()
    assert tombstoned is not None
    assert tombstoned.merged_into_user_id == rita.id


async def test_consume_omits_merge_when_no_prior_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Cookieless consume — there's no ephemeral session to merge from."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-fresh-browser"
    await _issue_login_token(db_session, rita, raw)

    async with make_client() as fresh:
        response = await fresh.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json().get("merged") is None


async def test_consume_omits_merge_when_prior_session_is_verified(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Two verified accounts sharing a browser — silently siphoning one
    user's data into the other would be data loss. The merge must skip."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    sam = await _make_confirmed_user(db_session, "sam@example.com")
    raw_rita = "raw-login-rita"
    raw_sam = "raw-login-sam"
    await _issue_login_token(db_session, rita, raw_rita)
    await _issue_login_token(db_session, sam, raw_sam)

    # Sign in as Sam first to establish a verified session, then "log in" as Rita.
    sign_in_sam = await api_client.post("/v1/login/consume", json={"token": raw_sam})
    assert sign_in_sam.status_code == 200

    opponent = await make_user(db_session, "opponent-jay")
    sam_match = await _record_singles_match(db_session, sam, opponent)

    response = await api_client.post("/v1/login/consume", json={"token": raw_rita})
    assert response.status_code == 200
    assert response.json().get("merged") is None

    # Sam still owns the match.
    creator_id = (
        await db_session.execute(
            select(Match.created_by_user_id).where(Match.id == sam_match.id)
        )
    ).scalar_one()
    assert creator_id == sam.id
    assert (
        await db_session.execute(select(User).where(User.id == sam.id))
    ).scalar_one() is not None


# ---- rating recompute enqueue on merge -----------------------------------


async def test_consume_enqueues_rating_recompute_when_matches_moved(
    api_client: AsyncClient, db_session: AsyncSession, fake_ratings_queue
):
    """The merge moved a match — kick off the background rating recompute so
    the surviving user's ratings catch up to their new match history."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-recompute"
    await _issue_login_token(db_session, rita, raw)

    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opponent-jay")
    await _record_singles_match(db_session, guest, opponent)

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["merged"] == {"matches_moved": 1}

    jobs = fake_ratings_queue.get_jobs()
    assert len(jobs) == 1
    job = jobs[0]
    assert job.func_name == RECOMPUTE_AFTER_MERGE_JOB
    assert job.args == (str(rita.id),)


async def test_consume_skips_recompute_when_no_matches_moved(
    api_client: AsyncClient, db_session: AsyncSession, fake_ratings_queue
):
    """No matches → no work to do. Don't burn an RQ slot."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-no-matches"
    await _issue_login_token(db_session, rita, raw)

    # Ephemeral session exists but never played anything.
    await start_session(api_client, db_session)

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["merged"] == {"matches_moved": 0}
    assert fake_ratings_queue.get_jobs() == []


async def test_consume_skips_recompute_when_no_prior_session(
    api_client: AsyncClient, db_session: AsyncSession, fake_ratings_queue
):
    """Cookieless consume — no merge happens, so no recompute either."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-cookieless"
    await _issue_login_token(db_session, rita, raw)

    async with make_client() as fresh:
        response = await fresh.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json().get("merged") is None
    assert fake_ratings_queue.get_jobs() == []


# ---- token-bound (cross-device) merge + preview --------------------------


def _login_email_tokens(fake_email_queue) -> list[str]:
    """Raw tokens handed to finished login-email jobs, oldest first."""
    jobs = [
        fake_email_queue.fetch_job(job_id)
        for job_id in fake_email_queue.finished_job_registry.get_job_ids()
    ]
    jobs = [j for j in jobs if j is not None]
    jobs.sort(key=lambda j: j.enqueued_at)
    return [j.args[1] for j in jobs]


async def _login_token_for(db_session: AsyncSession, user: User) -> UserToken:
    return (
        await db_session.execute(
            select(UserToken).where(
                UserToken.user_id == user.id,
                UserToken.context.startswith(LOGIN_TOKEN_CONTEXT),
            )
        )
    ).scalar_one()


async def test_request_records_requesting_guest_on_login_token(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """A guest who requests a sign-in link for their existing email has their
    id stamped on the token context, so the merge is token-bound."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    guest = await start_session(api_client, db_session)

    response = await api_client.post("/v1/login/request", json=REQUEST_BODY)
    assert response.status_code == 202

    token = await _login_token_for(db_session, rita)
    assert token.context == f"{LOGIN_TOKEN_CONTEXT}:{guest.id}"


async def test_token_bound_login_merges_cross_device(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The guest requests on browser A (with matches); the link is opened on a
    cookieless browser B. The guest's matches still follow into the account —
    the merge is bound to the recorded guest, not B's (absent) session."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opp-crossdev")
    match = await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=REQUEST_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
        assert response.status_code == 200
        assert response.json()["data"]["user"]["username"] == "rita"
        assert response.json()["merged"] == {"matches_moved": 1}

    players = (
        (
            await db_session.execute(
                select(MatchSidePlayer).where(MatchSidePlayer.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert {p.user_id for p in players} == {rita.id, opponent.id}


async def test_merge_preview_for_login_token_does_not_consume(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await _make_confirmed_user(db_session, "rita@example.com")
    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opp-preview")
    await _record_singles_match(db_session, guest, opponent)
    await api_client.post("/v1/login/request", json=REQUEST_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        preview = await cookieless.post("/v1/merge/preview", json={"token": raw})
        assert preview.status_code == 200
        body = preview.json()
        assert body["is_merge"] is True
        assert body["owner_username"] == "rita"
        assert body["guest_username"] == guest.username
        assert body["guest_matches_count"] == 1

        # Preview is side-effect-free: the token still signs in afterwards.
        consume = await cookieless.post("/v1/login/consume", json={"token": raw})
        assert consume.status_code == 200


async def test_merge_preview_bare_login_is_not_a_merge(
    api_client: AsyncClient, db_session: AsyncSession
):
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-bare-login-preview"
    await _issue_login_token(db_session, rita, raw)  # bare "login" context

    response = await api_client.post("/v1/merge/preview", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["is_merge"] is False


async def test_merge_preview_unknown_token_is_not_a_merge(api_client: AsyncClient):
    response = await api_client.post("/v1/merge/preview", json={"token": "nope"})
    assert response.status_code == 200
    assert response.json()["is_merge"] is False


async def test_consume_skip_merge_signs_in_without_folding(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The gate's "not now": sign in as the owner but leave the guest's matches
    behind (guest stays a live, un-tombstoned session)."""
    await _make_confirmed_user(db_session, "rita@example.com")
    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opp-skip")
    match = await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=REQUEST_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post(
            "/v1/login/consume", json={"token": raw, "skip_merge": True}
        )
        assert response.status_code == 200
        assert response.json()["data"]["user"]["username"] == "rita"
        assert response.json().get("merged") is None

    # Match stayed on the guest; the guest is not tombstoned.
    players = (
        (
            await db_session.execute(
                select(MatchSidePlayer).where(MatchSidePlayer.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert guest.id in {p.user_id for p in players}
    survivor = (
        await db_session.execute(select(User).where(User.id == guest.id))
    ).scalar_one()
    assert survivor.merged_into_user_id is None


# ----- Cold, cookieless sign-in (regression for the direct-to-/login bug) ----


@pytest_asyncio.fixture
async def cold_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """A client with no session cookie and *without* the CSRF auto-attach hook,
    standing in for a browser that landed straight on ``/login`` (or opened a
    magic link on a device that never loaded the app), so it was never issued
    session/csrf cookies."""

    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    async with make_raw_client() as client:
        yield client
    app.dependency_overrides.clear()


async def test_request_login_succeeds_without_session_or_csrf_cookie(
    cold_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Landing cold on ``/login`` and requesting a link must not 403: the
    request carries no session cookie, so the CSRF double-submit guard doesn't
    engage (there is no ambient authority to forge), and captcha + rate limiting
    still gate the endpoint."""
    await _make_confirmed_user(db_session, "rita@example.com")

    response = await cold_client.post("/v1/login/request", json=REQUEST_BODY)

    assert response.status_code == 202
    assert response.json() == {"email": "rita@example.com"}
    assert cold_client.cookies.get(SESSION_COOKIE_NAME) is None
