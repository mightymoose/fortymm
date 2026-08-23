import hashlib
import re
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import sessions
from app.db import get_session
from app.leagues import get_default_league
from app.main import app
from app.models import (
    LeagueMembership,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
    UserRole,
    UserToken,
)
from app.ratings.jobs import RECOMPUTE_AFTER_MERGE_JOB
from app.schemas.session import USERNAME_MAX_LENGTH, USERNAME_PATTERN
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


async def test_request_for_emailed_account_always_issues_login_link(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """``users.email`` is only ever set by ``confirm_email`` (alongside
    ``confirmed_at``), so an address lookup can only match a confirmed
    account — there is no unconfirmed-resend branch. A found account always
    gets a sign-in link, never a confirmation re-send. (#278)"""
    await _make_confirmed_user(db_session, "rita@example.com")

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
    assert len(login_tokens) == 1
    assert login_tokens[0].sent_to == "rita@example.com"

    change_tokens = (
        (
            await db_session.execute(
                select(UserToken).where(UserToken.context.startswith("change:"))
            )
        )
        .scalars()
        .all()
    )
    assert change_tokens == []

    assert fake_email_queue.finished_job_registry.count == 1
    job = fake_email_queue.fetch_job(
        fake_email_queue.finished_job_registry.get_job_ids()[0]
    )
    assert job is not None
    assert job.func_name == "app.email.send_login_email"


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


async def test_request_rejects_oversize_local_part(
    api_client: AsyncClient, fake_email_queue
):
    """RFC 5321 caps the local part at 64 chars; a longer one is rejected
    before any mail is enqueued (#615)."""
    oversize = "a" * 65 + "@example.com"
    response = await api_client.post(
        "/v1/login/request",
        json={**REQUEST_BODY, "email": oversize},
    )
    assert response.status_code == 422
    assert fake_email_queue.finished_job_registry.count == 0


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


async def _record_singles_match(
    db_session: AsyncSession, *players: User, affects_rating: bool = False
) -> Match:
    league = await get_default_league(db_session)
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=affects_rating)
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


async def test_consume_returns_400_when_merge_raises_integrity_error(
    api_client: AsyncClient, db_session: AsyncSession, monkeypatch
):
    """If the email/merge race surfaces an IntegrityError mid-block (the merge
    autoflushes the staged rows before commit), the endpoint must convert it
    into the opaque 400 rather than letting a 500 leak out — mirroring the
    guard on confirm_email."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-race"
    await _issue_login_token(db_session, rita, raw)

    # Arrive with an ephemeral guest so the merge path runs.
    await start_session(api_client, db_session)

    async def _boom(*args: object, **kwargs: object) -> None:
        raise IntegrityError("merge", {}, Exception("duplicate key"))

    monkeypatch.setattr(sessions, "_maybe_merge_prior_session", _boom)

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 400
    assert response.json()["detail"] == "That sign-in link is invalid or expired."


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


async def test_consume_enqueues_recompute_even_when_no_matches_moved(
    api_client: AsyncClient, db_session: AsyncSession, fake_ratings_queue
):
    """A merge with zero matches moved STILL has rating work to reconcile: the
    survivor may hold a stale rating that the empty-timeline reset resets to the
    strategy's initial state (ADR-0013). The enqueue gate fires on any merge,
    not only when matches_moved > 0 — that old gate was too narrow."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-no-matches"
    await _issue_login_token(db_session, rita, raw)

    # Ephemeral session exists but never played anything.
    await start_session(api_client, db_session)

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["merged"] == {"matches_moved": 0}

    jobs = fake_ratings_queue.get_jobs()
    assert len(jobs) == 1
    assert jobs[0].func_name == RECOMPUTE_AFTER_MERGE_JOB
    assert jobs[0].args == (str(rita.id),)


async def test_consume_enqueues_recompute_for_voided_self_play_collision(
    api_client: AsyncClient, db_session: AsyncSession, fake_ratings_queue
):
    """A guest whose ONLY rated match is a self-play collision against the
    account they sign into (ADR-0013): the merge VOIDS that match, so
    matches_moved reports 0 (the toast must not claim a match that was just
    voided) — but the survivor's rating was inflated by that voided match, so
    the recompute MUST still be enqueued to strip it. This is the regression the
    old ``matches_moved > 0`` gate silently dropped."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw = "raw-login-token-collision"
    await _issue_login_token(db_session, rita, raw)

    guest = await start_session(api_client, db_session)
    # A RATED match the guest played against rita herself — after the merge the
    # guest and rita sit on opposite sides of the same match: a self-play
    # collision the merge voids.
    match = await _record_singles_match(db_session, guest, rita, affects_rating=True)

    response = await api_client.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    # The voided collision is NOT reported as a moved match.
    assert response.json()["merged"] == {"matches_moved": 0}

    # The match was voided, confirming this exercised the collision path.
    voided_status = (
        await db_session.execute(select(Match.status).where(Match.id == match.id))
    ).scalar_one()
    assert voided_status == MatchStatus.voided

    # The recompute is STILL enqueued despite matches_moved == 0.
    jobs = fake_ratings_queue.get_jobs()
    assert len(jobs) == 1
    assert jobs[0].func_name == RECOMPUTE_AFTER_MERGE_JOB
    assert jobs[0].args == (str(rita.id),)


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


# ---- first sign-in: an unknown address gets a real link ------------------


UNKNOWN_BODY = {
    "email": "brand.new.quinn@example.com",
    "captcha_token": "test-token",
    "fmm_hp_token": "",
}


def _login_email_jobs(fake_email_queue) -> list:
    jobs = [
        fake_email_queue.fetch_job(job_id)
        for job_id in fake_email_queue.finished_job_registry.get_job_ids()
    ]
    jobs = [j for j in jobs if j is not None]
    jobs.sort(key=lambda j: j.enqueued_at)
    return jobs


async def test_request_for_unknown_email_mints_a_user_and_a_real_login_link(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The reported defect (#1292): an unknown address used to get a tokenless
    'no account yet' notice while the screen promised a sign-in link. It now
    mints a user and sends the very same sign-in email the known-account branch
    sends — same job, same subject-bearing function, a real token in the args."""
    response = await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    assert response.status_code == 202
    assert response.json() == {"email": "brand.new.quinn@example.com"}

    jobs = _login_email_jobs(fake_email_queue)
    assert len(jobs) == 1
    # Assert the arguments, not just the job name: a link the email cannot
    # render is the defect being fixed.
    assert jobs[0].func_name == "app.email.send_login_email"
    to_email, raw_token, username = jobs[0].args
    assert to_email == "brand.new.quinn@example.com"
    assert raw_token

    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.token == hashlib.sha256(raw_token.encode("utf-8")).digest()
            )
        )
    ).scalar_one()
    assert token.sent_to == "brand.new.quinn@example.com"
    assert sessions._is_first_sign_in_context(token.context)

    minted = (
        await db_session.execute(select(User).where(User.id == token.user_id))
    ).scalar_one()
    assert minted.username == username
    # Unclaimed until the link is clicked.
    assert minted.email is None
    assert minted.confirmed_at is None


async def test_first_sign_in_link_signs_the_person_in(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The other half of the repro: the mailed link works. Opening it stamps the
    address on the minted user and signs them in."""
    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
        assert response.status_code == 200
        body_user = response.json()["data"]["user"]
        assert body_user["email"] == "brand.new.quinn@example.com"
        assert cookieless.cookies.get(SESSION_COOKIE_NAME)

    signed_in = (
        await db_session.execute(
            select(User).where(User.email == "brand.new.quinn@example.com")
        )
    ).scalar_one()
    assert signed_in.confirmed_at is not None
    assert signed_in.confirmed_at.tzinfo is not None


async def test_requesting_an_unknown_address_does_not_move_the_roster(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """THE ORACLE TEST (#1438). ``POST /v1/login/request`` mints a row for an
    unknown address; if that row were listed, an attacker could read the roster,
    submit an address, and read it again — a new player means no account there,
    no new player means one. That answers the question #1292's
    indistinguishability constraint forbids answering. So the mint must happen
    (the link really works) AND never surface in a public listing: same roster,
    same ``total``, before and after."""
    attacker = await start_session(api_client, db_session)

    before = await api_client.get("/v1/players", params={"page_size": 100})
    assert before.status_code == 200
    assert [p["username"] for p in before.json()["items"]] == [attacker.username]
    total_before = before.json()["total"]

    response = await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    assert response.status_code == 202

    # The unknown-address branch really did mint: the row exists, unclaimed.
    # The oracle closes because the listings omit the row, not because nothing
    # was written.
    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 2

    after = await api_client.get("/v1/players", params={"page_size": 100})
    assert after.status_code == 200
    assert [p["username"] for p in after.json()["items"]] == [attacker.username]
    assert after.json()["total"] == total_before


async def test_first_sign_in_then_browse_lists_the_user(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The person behind the mint becomes listable by BROWSING (#1438): the
    consume stamps no visit, but their first authenticated request resolves the
    cookie through ``get_current_user``, which stamps ``last_seen_at``."""
    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        consumed = await cookieless.post("/v1/login/consume", json={"token": raw})
        assert consumed.status_code == 200
        username = consumed.json()["data"]["user"]["username"]

        signed_in = (
            await db_session.execute(
                select(User).where(User.email == "brand.new.quinn@example.com")
            )
        ).scalar_one()
        # Claiming the link alone is not browsing — they are not listed yet.
        assert signed_in.last_seen_at is None

        browsed = await cookieless.get("/v1/players", params={"page_size": 100})
        assert browsed.status_code == 200
        assert username in [p["username"] for p in browsed.json()["items"]]


async def test_minted_user_joins_the_default_league_and_holds_the_default_role(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """A minted user is a full member, exactly as a guest is (ADR-0016)."""
    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.token == hashlib.sha256(raw.encode("utf-8")).digest()
            )
        )
    ).scalar_one()

    league = await get_default_league(db_session)
    memberships = (
        (
            await db_session.execute(
                select(LeagueMembership).where(
                    LeagueMembership.user_id == token.user_id,
                    LeagueMembership.league_id == league.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(memberships) == 1

    roles = (
        (
            await db_session.execute(
                select(UserRole).where(UserRole.user_id == token.user_id)
            )
        )
        .scalars()
        .all()
    )
    assert len(roles) == 1


async def test_first_sign_in_link_uses_the_ordinary_15_minute_lifetime(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.token == hashlib.sha256(raw.encode("utf-8")).digest()
            )
        )
    ).scalar_one()
    token.created_at = (
        datetime.now(UTC) - sessions.LOGIN_TOKEN_LIFETIME - timedelta(seconds=1)
    )
    await db_session.commit()

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 400
    assert response.json()["detail"] == "That sign-in link is invalid or expired."


async def test_repeat_request_for_the_same_unknown_email_reuses_the_pending_user(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Resend replaces the token instead of minting a second account, so one
    live link exists per address at a time."""
    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)

    tokens = (
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.sent_to == "brand.new.quinn@example.com"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(tokens) == 1

    pending = (
        (await db_session.execute(select(User).where(User.email.is_(None))))
        .scalars()
        .all()
    )
    assert len(pending) == 1
    assert tokens[0].user_id == pending[0].id

    raws = _login_email_tokens(fake_email_queue)
    assert len(raws) == 2
    # The newest link wins; the first is dead.
    async with make_client() as stale:
        assert (
            await stale.post("/v1/login/consume", json={"token": raws[0]})
        ).status_code == 400
    async with make_client() as fresh:
        assert (
            await fresh.post("/v1/login/consume", json={"token": raws[-1]})
        ).status_code == 200


async def test_first_sign_in_rejected_when_the_address_was_claimed_meanwhile(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Another flow confirms the address between request and click. Return the
    opaque error, never a 500, and burn the token so the person isn't trapped in
    a resend loop."""
    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]
    await _make_confirmed_user(db_session, "brand.new.quinn@example.com")

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 400
    assert response.json()["detail"] == "That sign-in link is invalid or expired."

    burned = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.token == hashlib.sha256(raw.encode("utf-8")).digest()
            )
        )
    ).scalar_one_or_none()
    assert burned is None


async def test_first_sign_in_records_the_requesting_guest_and_merges_it(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The merge follows the person across devices, matching the known-account
    branch: request on browser A, click on cookieless browser B."""
    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opp-firstsignin")
    match = await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["merged"] == {"matches_moved": 1}

    signed_in = (
        await db_session.execute(
            select(User).where(User.email == "brand.new.quinn@example.com")
        )
    ).scalar_one()
    players = (
        (
            await db_session.execute(
                select(MatchSidePlayer).where(MatchSidePlayer.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert {p.user_id for p in players} == {signed_in.id, opponent.id}


async def test_accepted_first_sign_in_merge_takes_the_guest_username(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """G1: the new account keeps the name the person has been playing under."""
    guest = await start_session(api_client, db_session)
    guest_name = guest.username
    opponent = await make_user(db_session, "opp-adopt")
    await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["data"]["user"]["username"] == guest_name

    signed_in = (
        await db_session.execute(
            select(User).where(User.email == "brand.new.quinn@example.com")
        )
    ).scalar_one()
    assert signed_in.username == guest_name
    # The tombstone gave the name up rather than holding the unique index.
    await db_session.refresh(guest)
    assert guest.username != guest_name
    assert guest.merged_into_user_id == signed_in.id
    # The dead name is still a name the product would accept. The dashed uuid
    # form is 43 characters and breaks USERNAME_MAX_LENGTH silently, because no
    # response model constrains `username`.
    assert len(guest.username) <= USERNAME_MAX_LENGTH
    assert re.fullmatch(USERNAME_PATTERN, guest.username)


async def test_declined_first_sign_in_merge_leaves_the_generated_username(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    guest = await start_session(api_client, db_session)
    guest_name = guest.username
    opponent = await make_user(db_session, "opp-decline")
    await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post(
            "/v1/login/consume", json={"token": raw, "skip_merge": True}
        )
    assert response.status_code == 200
    assert response.json()["merged"] is None
    assert response.json()["data"]["user"]["username"] != guest_name

    await db_session.refresh(guest)
    assert guest.username == guest_name
    assert guest.merged_into_user_id is None


async def test_known_account_merge_does_not_take_the_guest_username(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Username adoption is gated on the first-sign-in mint. An established
    account keeps its own name when a guest is folded into it."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opp-noadopt")
    await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=REQUEST_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["data"]["user"]["username"] == "rita"
    await db_session.refresh(rita)
    assert rita.username == "rita"


async def test_merge_preview_marks_a_first_sign_in_as_adopting_the_guest_name(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opp-previewfirst")
    await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        preview = await cookieless.post("/v1/merge/preview", json={"token": raw})
    assert preview.status_code == 200
    body = preview.json()
    assert body["is_merge"] is True
    assert body["guest_username"] == guest.username
    assert body["guest_matches_count"] == 1
    assert body["adopts_guest_username"] is True


async def test_merge_preview_does_not_promise_the_name_on_a_known_account(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    await _make_confirmed_user(db_session, "rita@example.com")
    guest = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opp-previewknown")
    await _record_singles_match(db_session, guest, opponent)

    await api_client.post("/v1/login/request", json=REQUEST_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        preview = await cookieless.post("/v1/merge/preview", json={"token": raw})
    assert preview.status_code == 200
    assert preview.json()["adopts_guest_username"] is False


async def test_a_verified_requester_still_mints_a_separate_new_account(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """Typing an unknown address while already signed in must never merge the
    verified requester away."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw_login = "raw-login-token-verified-requester"
    await _issue_login_token(db_session, rita, raw_login)
    assert (
        await api_client.post("/v1/login/consume", json={"token": raw_login})
    ).status_code == 200

    await api_client.post("/v1/login/request", json=UNKNOWN_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]

    async with make_client() as cookieless:
        response = await cookieless.post("/v1/login/consume", json={"token": raw})
    assert response.status_code == 200
    assert response.json()["merged"] is None

    await db_session.refresh(rita)
    assert rita.merged_into_user_id is None
    assert rita.email == "rita@example.com"


# ---- mailed-link confirmation revokes other sessions ---------------------


async def test_confirming_a_mailed_link_revokes_the_requesting_browsers_session(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The falsification for the session-revocation hole. Browser A asks for a
    link for an address it does not own; browser B confirms it. A's cookie must
    stop authenticating as that account.

    Asserting only that B's new cookie works proves nothing — the defect is an
    old credential surviving. So this holds A's cookie and re-uses it. A revoked
    cookie resolves no user, so ``GET /v1/session`` mints a *fresh guest*
    (200) rather than 401ing; the discriminating assertion is therefore that the
    identity A gets back is not the confirmed account."""
    rita = await _make_confirmed_user(db_session, "rita@example.com")
    raw_login = "raw-login-token-revocation"
    await _issue_login_token(db_session, rita, raw_login)

    # Browser A signs in as rita and holds the cookie.
    signed_in = await api_client.post("/v1/login/consume", json={"token": raw_login})
    assert signed_in.status_code == 200
    held_cookie = api_client.cookies.get(SESSION_COOKIE_NAME)
    assert held_cookie
    still_rita = await api_client.get("/v1/session")
    assert still_rita.json()["data"]["user"]["username"] == "rita"

    # Browser A asks for another link; browser B confirms it.
    await api_client.post("/v1/login/request", json=REQUEST_BODY)
    raw = _login_email_tokens(fake_email_queue)[-1]
    async with make_client() as browser_b:
        confirmed = await browser_b.post("/v1/login/consume", json={"token": raw})
        assert confirmed.status_code == 200
        assert confirmed.json()["data"]["user"]["username"] == "rita"

    # A's held cookie no longer authenticates as rita.
    surviving = (
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.user_id == rita.id,
                    UserToken.context == SESSION_TOKEN_CONTEXT,
                    UserToken.token
                    == hashlib.sha256(held_cookie.encode("utf-8")).digest(),
                )
            )
        )
        .scalars()
        .all()
    )
    assert surviving == []

    async with make_client() as browser_a:
        browser_a.cookies.set(SESSION_COOKIE_NAME, held_cookie)
        after = await browser_a.get("/v1/session")
        assert after.status_code == 200
        assert after.json()["data"]["user"]["username"] != "rita"


async def test_confirming_an_email_change_revokes_the_users_other_sessions(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
):
    """The same hole in the Settings claim flow (#1294 shares it). The browser
    that requested the claim must not keep a live session for the account once
    the mailed link is confirmed elsewhere."""
    guest = await start_session(api_client, db_session)
    held_cookie = api_client.cookies.get(SESSION_COOKIE_NAME)
    assert held_cookie

    change = await api_client.post(
        "/v1/me/email",
        json={
            "email": "claimed.by.quinn@example.com",
            "captcha_token": "test-token",
            "fmm_hp_token": "",
        },
    )
    assert change.status_code == 202

    token_row = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.user_id == guest.id,
                UserToken.context.startswith(sessions.EMAIL_CHANGE_CONTEXT_PREFIX),
            )
        )
    ).scalar_one()
    raw = _login_email_jobs(fake_email_queue)[-1].args[1]
    assert hashlib.sha256(raw.encode("utf-8")).digest() == token_row.token

    async with make_client() as browser_b:
        confirmed = await browser_b.post("/v1/me/email/confirm", json={"token": raw})
        assert confirmed.status_code == 200

    surviving = (
        (
            await db_session.execute(
                select(UserToken).where(
                    UserToken.user_id == guest.id,
                    UserToken.context == SESSION_TOKEN_CONTEXT,
                    UserToken.token
                    == hashlib.sha256(held_cookie.encode("utf-8")).digest(),
                )
            )
        )
        .scalars()
        .all()
    )
    assert surviving == []
