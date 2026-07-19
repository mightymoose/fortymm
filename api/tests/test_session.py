import hashlib
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import Permission, Role, RolePermission, User, UserRole, UserToken
from app.roles import DEFAULT_ROLE_NAME
from app.sessions import (
    API_TOKEN_CONTEXT,
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
    SESSION_COOKIE_NAME,
    SESSION_TOKEN_CONTEXT,
    _maybe_merge_prior_session,
)
from app.token_hashing import hash_token
from tests._helpers import CSRF_EVENT_HOOKS, make_client, make_raw_client, start_session


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


async def test_creates_session_when_no_cookie(
    api_client: AsyncClient, db_session: AsyncSession
):
    response = await api_client.get("/v1/session")
    assert response.status_code == 200

    body_user = response.json()["data"]["user"]
    username = body_user["username"]
    assert username
    assert body_user["permissions"] == []

    cookie_header = response.headers.get("set-cookie", "").lower()
    assert "httponly" in cookie_header
    assert "secure" in cookie_header
    assert "samesite=lax" in cookie_header
    assert "path=/" in cookie_header

    raw_token = response.cookies.get(SESSION_COOKIE_NAME)
    assert raw_token

    user = (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()

    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.token == hashlib.sha256(raw_token.encode("utf-8")).digest()
            )
        )
    ).scalar_one()
    assert token.user_id == user.id
    assert token.context == SESSION_TOKEN_CONTEXT


async def test_minted_guest_holds_the_default_role_and_nothing_else(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """The whole point of ADR-0016: there is no signup, so the first-ever
    ``GET /v1/session`` is the moment a person joins the site — and they leave it
    holding the default role."""
    response = await api_client.get("/v1/session")
    assert response.status_code == 200
    username = response.json()["data"]["user"]["username"]

    user = (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()
    role_ids = (
        await db_session.execute(
            select(UserRole.role_id).where(UserRole.user_id == user.id)
        )
    ).scalars()
    assert list(role_ids) == [default_role.id]

    # The role carries no permissions, so the session payload is unchanged —
    # no client sees this.
    assert response.json()["data"]["user"]["permissions"] == []


async def test_session_mint_raises_when_the_default_role_is_missing(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """A missing seed row is a broken deployment. Guest-mint fails loudly (500)
    rather than soft-skipping and minting a role-less user nobody notices until a
    permission is hung off the role months later (ADR-0016)."""
    await db_session.delete(default_role)
    await db_session.commit()

    with pytest.raises(RuntimeError, match=DEFAULT_ROLE_NAME):
        await api_client.get("/v1/session")

    # Nothing was committed, so no role-less user was left behind.
    await db_session.rollback()
    users = (await db_session.execute(select(User))).scalars().all()
    assert users == []


async def test_returns_existing_session_when_cookie_valid(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    first_username = first.json()["data"]["user"]["username"]
    first_token = first.cookies.get(SESSION_COOKIE_NAME)

    second = await api_client.get("/v1/session")
    assert second.status_code == 200
    assert second.json()["data"]["user"]["username"] == first_username
    assert "set-cookie" not in second.headers

    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 1

    tokens = (await db_session.execute(select(UserToken))).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].token == hashlib.sha256(first_token.encode("utf-8")).digest()


async def test_creates_new_session_when_cookie_invalid(
    api_client: AsyncClient, db_session: AsyncSession
):
    api_client.cookies.set(SESSION_COOKIE_NAME, "not-a-real-token", domain="testserver")
    response = await api_client.get("/v1/session")
    assert response.status_code == 200

    new_token = response.cookies.get(SESSION_COOKIE_NAME)
    assert new_token
    assert new_token != "not-a-real-token"

    tokens = (await db_session.execute(select(UserToken))).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].token == hashlib.sha256(new_token.encode("utf-8")).digest()


def _assert_session_cookie_cleared(response) -> None:
    # delete_cookie sets max-age=0 (and may also send expires=Thu, 01 Jan 1970...).
    # Either signal is sufficient.
    cookie_header = response.headers.get("set-cookie", "").lower()
    assert "max-age=0" in cookie_header or "expires=thu, 01 jan 1970" in cookie_header


async def test_delete_session_revokes_token_and_clears_cookie(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    raw_token = first.cookies.get(SESSION_COOKIE_NAME)
    assert raw_token

    response = await api_client.delete("/v1/session")
    assert response.status_code == 204
    _assert_session_cookie_cleared(response)

    tokens = (await db_session.execute(select(UserToken))).scalars().all()
    assert tokens == []


@pytest.mark.parametrize(
    "cookie_value",
    [None, "not-a-real-token"],
    ids=["no_cookie", "unknown_cookie"],
)
async def test_delete_session_is_idempotent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    cookie_value: str | None,
):
    if cookie_value is not None:
        api_client.cookies.set(SESSION_COOKIE_NAME, cookie_value, domain="testserver")
    response = await api_client.delete("/v1/session")
    assert response.status_code == 204
    _assert_session_cookie_cleared(response)

    # No prior GET — DELETE must not mint a user.
    users = (await db_session.execute(select(User))).scalars().all()
    assert users == []


async def test_token_is_stored_hashed_not_plaintext(
    api_client: AsyncClient, db_session: AsyncSession
):
    response = await api_client.get("/v1/session")
    raw_token = response.cookies.get(SESSION_COOKIE_NAME)

    tokens = (await db_session.execute(select(UserToken))).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].token != raw_token.encode("utf-8")
    assert tokens[0].token == hashlib.sha256(raw_token.encode("utf-8")).digest()


async def test_session_response_includes_user_permissions(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    username = first.json()["data"]["user"]["username"]

    user = (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()

    role = Role(name="member")
    other_role = Role(name="bystander")
    perm_a = Permission(name="puzzle:read")
    perm_b = Permission(name="puzzle:write")
    perm_unused = Permission(name="admin:all")
    db_session.add_all([role, other_role, perm_a, perm_b, perm_unused])
    await db_session.commit()

    db_session.add_all(
        [
            UserRole(user_id=user.id, role_id=role.id),
            RolePermission(role_id=role.id, permission_id=perm_a.id),
            RolePermission(role_id=role.id, permission_id=perm_b.id),
            RolePermission(role_id=other_role.id, permission_id=perm_unused.id),
        ]
    )
    await db_session.commit()

    second = await api_client.get("/v1/session")
    assert second.status_code == 200
    body_user = second.json()["data"]["user"]
    assert body_user["username"] == username
    assert body_user["permissions"] == ["puzzle:read", "puzzle:write"]


async def test_session_deduplicates_permissions_across_roles(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    username = first.json()["data"]["user"]["username"]

    user = (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()

    role_a = Role(name="reader")
    role_b = Role(name="auditor")
    perm = Permission(name="puzzle:read")
    db_session.add_all([role_a, role_b, perm])
    await db_session.commit()

    db_session.add_all(
        [
            UserRole(user_id=user.id, role_id=role_a.id),
            UserRole(user_id=user.id, role_id=role_b.id),
            RolePermission(role_id=role_a.id, permission_id=perm.id),
            RolePermission(role_id=role_b.id, permission_id=perm.id),
        ]
    )
    await db_session.commit()

    second = await api_client.get("/v1/session")
    assert second.json()["data"]["user"]["permissions"] == ["puzzle:read"]


# ---- the caller's own id --------------------------------------------------


async def _user_id_behind_cookie(db_session: AsyncSession, raw_token: str) -> uuid.UUID:
    """The user a session cookie *actually* resolves to, found by hashing the
    cookie the way the auth layer does. Deliberately not looked up by the
    username the response echoed: that would let a response reporting some
    other user's id launder itself past the assertion."""
    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.token == hashlib.sha256(raw_token.encode("utf-8")).digest()
            )
        )
    ).scalar_one()
    return token.user_id


async def test_session_returns_the_cookie_holders_own_user_id(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The session response tells the caller their own player id — the only
    place the API says who you are. A guest minted on the first hit is a real
    user with a real id, so the field is never null for anyone with a session."""
    minted = await api_client.get("/v1/session")
    assert minted.status_code == 200

    body_user = minted.json()["data"]["user"]
    assert body_user.get("id") is not None
    holder_id = await _user_id_behind_cookie(
        db_session, minted.cookies.get(SESSION_COOKIE_NAME)
    )
    assert uuid.UUID(body_user["id"]) == holder_id

    # The second hit takes the other branch — resolve an existing cookie rather
    # than mint — and must report the same id.
    resolved = await api_client.get("/v1/session")
    assert uuid.UUID(resolved.json()["data"]["user"]["id"]) == holder_id


async def test_session_id_is_the_callers_own_and_not_another_users(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Two cookie-isolated callers each get *their own* id back, not each
    other's and not one shared id."""
    async with make_client() as other_client:
        mine = await api_client.get("/v1/session")
        theirs = await other_client.get("/v1/session")

        my_id = mine.json()["data"]["user"]["id"]
        their_id = theirs.json()["data"]["user"]["id"]
        assert my_id != their_id

        assert uuid.UUID(my_id) == await _user_id_behind_cookie(
            db_session, mine.cookies.get(SESSION_COOKIE_NAME)
        )
        assert uuid.UUID(their_id) == await _user_id_behind_cookie(
            db_session, theirs.cookies.get(SESSION_COOKIE_NAME)
        )


# ---- PATCH /v1/me ---------------------------------------------------------


async def test_update_username_persists_and_returns_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    original = first.json()["data"]["user"]["username"]

    response = await api_client.patch("/v1/me", json={"username": "new-name"})
    assert response.status_code == 200
    body = response.json()
    assert body["data"]["user"]["username"] == "new-name"
    assert body["data"]["user"]["permissions"] == []

    user = (
        await db_session.execute(select(User).where(User.username == "new-name"))
    ).scalar_one()
    assert user.username == "new-name"

    # The old name is gone — no orphan row, single user updated in place.
    stale = await db_session.execute(select(User).where(User.username == original))
    assert stale.scalar_one_or_none() is None


async def test_update_username_unchanged_is_noop(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    username = first.json()["data"]["user"]["username"]

    response = await api_client.patch("/v1/me", json={"username": username})
    assert response.status_code == 200
    assert response.json()["data"]["user"]["username"] == username


async def test_update_username_requires_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    # No prior GET /v1/session — no cookie set, so PATCH must 401.
    response = await api_client.patch("/v1/me", json={"username": "hopeful"})
    assert response.status_code == 401


async def test_update_username_rejects_taken_name(
    api_client: AsyncClient, db_session: AsyncSession
):
    db_session.add(User(username="taken"))
    await db_session.commit()

    await api_client.get("/v1/session")
    response = await api_client.patch("/v1/me", json={"username": "taken"})
    assert response.status_code == 409
    assert response.json()["detail"] == "Username already taken."


async def test_update_username_rejects_taken_name_case_insensitive(
    api_client: AsyncClient, db_session: AsyncSession
):
    db_session.add(User(username="taken"))
    await db_session.commit()

    await api_client.get("/v1/session")
    # Pattern only admits lowercase, but case-insensitive uniqueness still
    # matters if the existing row was created (e.g. by an admin tool) with
    # mixed case.
    db_session.add(User(username="Mixed-Case"))
    await db_session.commit()

    response = await api_client.patch("/v1/me", json={"username": "mixed-case"})
    assert response.status_code == 409


async def test_update_username_concurrent_collision_returns_409(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Two clients claim the same name back-to-back; the loser must get 409,
    not a 500 from IntegrityError leaking through."""
    await api_client.get("/v1/session")

    async with make_client() as other_client:
        await other_client.get("/v1/session")
        ok = await api_client.patch("/v1/me", json={"username": "race-name"})
        assert ok.status_code == 200
        dup = await other_client.patch("/v1/me", json={"username": "race-name"})
        assert dup.status_code == 409


@pytest.mark.parametrize(
    "bad_username",
    [
        "",
        "ab",
        "a" * 41,
        "Capitalized",
        "-leading-dash",
        "trailing-dash-",
        ".dot-start",
        "dot-end.",
        "has space",
        "weird!chars",
        "emoji-🏓",
    ],
)
async def test_update_username_rejects_invalid_format(
    api_client: AsyncClient, bad_username: str
):
    await api_client.get("/v1/session")
    response = await api_client.patch("/v1/me", json={"username": bad_username})
    assert response.status_code == 422, (bad_username, response.text)


async def test_update_username_preserves_user_id_and_permissions(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    original = first.json()["data"]["user"]["username"]
    user = (
        await db_session.execute(select(User).where(User.username == original))
    ).scalar_one()
    original_id = user.id

    role = Role(name="player")
    perm = Permission(name="match:create")
    db_session.add_all([role, perm])
    await db_session.commit()
    db_session.add_all(
        [
            UserRole(user_id=user.id, role_id=role.id),
            RolePermission(role_id=role.id, permission_id=perm.id),
        ]
    )
    await db_session.commit()

    response = await api_client.patch("/v1/me", json={"username": "renamed"})
    assert response.status_code == 200
    assert response.json()["data"]["user"]["permissions"] == ["match:create"]
    # The id outlives the rename — which is the whole reason it beats a
    # username as a "is this me?" check.
    assert uuid.UUID(response.json()["data"]["user"]["id"]) == original_id

    refreshed = (
        await db_session.execute(select(User).where(User.username == "renamed"))
    ).scalar_one()
    assert refreshed.id == original_id


# ---- tombstoned (merged-away) sessions ------------------------------------


async def _tombstone(db_session: AsyncSession, guest: User, owner_email: str) -> User:
    """Stand up a verified owner and fold ``guest`` into it (soft-delete)."""
    owner = User(username="owner", email=owner_email, confirmed_at=datetime.now(UTC))
    db_session.add(owner)
    await db_session.commit()
    await db_session.refresh(owner)
    guest.merged_into_user_id = owner.id
    guest.merged_at = datetime.now(UTC)
    await db_session.commit()
    return owner


async def test_session_with_merged_cookie_401s_instead_of_minting(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A cookie whose guest was merged away must not silently mint a fresh
    guest — it returns the structured `session_merged` 401 (with the owner's
    email to prefill) and clears the dead cookie."""
    guest = await start_session(api_client, db_session)
    await _tombstone(db_session, guest, "owner@example.com")

    response = await api_client.get("/v1/session")
    assert response.status_code == 401
    detail = response.json()["detail"]
    assert detail["code"] == "session_merged"
    assert detail["email"] == "owner@example.com"
    # The dead cookie is cleared so the holder can start fresh.
    assert "max-age=0" in response.headers.get("set-cookie", "").lower()


async def test_authed_endpoint_with_merged_cookie_401s(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The check lives at the shared auth seam, so *any* authed request — not
    just GET /v1/session — rejects a tombstoned cookie instead of acting as the
    merged-away ghost."""
    guest = await start_session(api_client, db_session)
    await _tombstone(db_session, guest, "owner@example.com")

    response = await api_client.patch("/v1/me", json={"username": "ghost-rename"})
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "session_merged"
    # (A garbage / no-token cookie still mints — see
    # test_creates_new_session_when_cookie_invalid — only tombstones 401.)


async def test_authed_endpoint_without_session_401s_session_ended(
    api_client: AsyncClient,
):
    """An authed request whose session cookie no longer resolves to a user — the
    holder signed out (the origin-shared cookie was dropped) or the session
    expired — returns the structured `session_ended` 401 so the client redirects
    to sign-in instead of silently minting a fresh guest in their place. Unlike
    the merged case there is no owner email to prefill, and the dead cookie is
    cleared so login can start a clean guest."""
    response = await api_client.patch("/v1/me", json={"username": "nobody"})
    assert response.status_code == 401
    detail = response.json()["detail"]
    assert detail["code"] == "session_ended"
    assert "email" not in detail
    assert "max-age=0" in response.headers.get("set-cookie", "").lower()


# ----- bearer API token authentication -------------------------------------


async def _mint_api_token(db_session: AsyncSession, user: User) -> str:
    """Store an ``api``-context token for ``user`` the way production does — only
    the sha256 hash lands in the DB — and return the raw token to send as a
    bearer credential."""
    raw = "api-raw-" + uuid.uuid4().hex
    db_session.add(
        UserToken(
            user_id=user.id,
            context=API_TOKEN_CONTEXT,
            token=hash_token(raw),
        )
    )
    await db_session.commit()
    return raw


async def test_bearer_api_token_authenticates_without_cookie(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A request carrying only a valid ``api``-context bearer token (no session
    cookie) resolves to that token's user on a ``get_current_user``-protected
    route."""
    user = await start_session(api_client, db_session)
    raw = await _mint_api_token(db_session, user)
    # Drop the cookies the session mint set, so the bearer header is the only
    # authenticating credential on the wire (the CSRF hook re-injects a
    # synthetic csrf pair, which the guard skips on a cookieless session).
    api_client.cookies.clear()

    response = await api_client.patch(
        "/v1/me",
        json={"username": "bearer-renamed"},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["user"]["id"] == str(user.id)


async def test_unknown_bearer_token_without_cookie_401s(api_client: AsyncClient):
    """A garbage/unknown bearer token with no cookie falls through to the same
    ``session_ended`` 401 as no credential at all."""
    response = await api_client.patch(
        "/v1/me",
        json={"username": "nobody"},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert response.status_code == 401, response.text
    assert response.json()["detail"]["code"] == "session_ended"


async def test_valid_cookie_wins_over_bearer_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    """With BOTH a valid session cookie and a valid (different-user) bearer token
    present, the cookie's user wins — the bearer header is never consulted."""
    cookie_user = await start_session(api_client, db_session)

    # A second, distinct user who owns the bearer token.
    async with make_client() as other_client:
        bearer_user = await start_session(other_client, db_session)
    raw = await _mint_api_token(db_session, bearer_user)
    assert bearer_user.id != cookie_user.id

    response = await api_client.patch(
        "/v1/me",
        json={"username": "cookie-wins"},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert response.status_code == 200, response.text
    # The COOKIE user is the one acted upon, not the bearer token's user.
    assert response.json()["data"]["user"]["id"] == str(cookie_user.id)


async def test_bearer_token_for_tombstoned_user_401s(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A bearer token whose user was merged away (``merged_into_user_id`` set)
    does not resolve — it falls through to the ``session_ended`` 401 rather than
    authenticating as the folded-in ghost."""
    user = await start_session(api_client, db_session)
    raw = await _mint_api_token(db_session, user)
    api_client.cookies.clear()
    await _tombstone(db_session, user, "owner-tombstone@example.com")

    response = await api_client.patch(
        "/v1/me",
        json={"username": "ghost"},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert response.status_code == 401, response.text
    assert response.json()["detail"]["code"] == "session_ended"


# ----- CSRF double-submit guard ---------------------------------------------


@pytest_asyncio.fixture
async def raw_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """A client bound to the test app *without* the CSRF auto-attach hook, so
    tests can drive the double-submit guard by hand."""

    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    async with make_raw_client() as client:
        yield client
    app.dependency_overrides.clear()


async def test_session_issues_readable_csrf_cookie(raw_client: AsyncClient):
    """GET /v1/session sets a non-HttpOnly csrf_token cookie the client JS can
    read to echo back in the header."""
    response = await raw_client.get("/v1/session")
    assert response.status_code == 200

    csrf_set_cookie = next(
        h
        for h in response.headers.get_list("set-cookie")
        if h.lower().startswith(f"{CSRF_COOKIE_NAME}=")
    )
    assert "httponly" not in csrf_set_cookie.lower()
    assert "samesite=lax" in csrf_set_cookie.lower()
    assert raw_client.cookies.get(CSRF_COOKIE_NAME)


async def test_mutating_request_without_csrf_header_is_rejected(
    raw_client: AsyncClient,
):
    await raw_client.get("/v1/session")  # establishes both cookies
    response = await raw_client.delete("/v1/session")
    assert response.status_code == 403
    assert "csrf" in response.json()["detail"].lower()


async def test_mutating_request_with_mismatched_csrf_header_is_rejected(
    raw_client: AsyncClient,
):
    await raw_client.get("/v1/session")
    response = await raw_client.delete(
        "/v1/session", headers={CSRF_HEADER_NAME: "not-the-cookie-value"}
    )
    assert response.status_code == 403


async def test_mutating_request_with_matching_csrf_header_passes(
    raw_client: AsyncClient,
):
    await raw_client.get("/v1/session")
    token = raw_client.cookies.get(CSRF_COOKIE_NAME)
    assert token
    response = await raw_client.delete("/v1/session", headers={CSRF_HEADER_NAME: token})
    assert response.status_code == 204
    # Logout clears the CSRF cookie alongside the session cookie.
    cleared = [
        h
        for h in response.headers.get_list("set-cookie")
        if h.lower().startswith(f"{CSRF_COOKIE_NAME}=")
    ]
    assert cleared and "max-age=0" in cleared[0].lower()


async def test_safe_methods_never_require_a_csrf_token(raw_client: AsyncClient):
    """GET (and other safe methods) must pass even with no token at all."""
    response = await raw_client.get("/v1/session")
    assert response.status_code == 200


async def test_mutating_request_without_session_cookie_is_exempt(
    raw_client: AsyncClient,
):
    """A cookieless mutation carries no ambient authority to forge, so the
    double-submit guard doesn't engage — it must pass without a csrf token. (A
    fresh logout is idempotent, so DELETE /v1/session returns 204 here.) This is
    what lets a browser landing straight on /login, or opening a magic link on a
    device that never loaded the app, reach the auth endpoints at all."""
    assert raw_client.cookies.get(SESSION_COOKIE_NAME) is None
    response = await raw_client.delete("/v1/session")
    assert response.status_code == 204


async def test_session_reissues_csrf_cookie_when_dropped(raw_client: AsyncClient):
    """A returning session that lost its non-HttpOnly CSRF cookie gets a fresh
    one on bootstrap, so mutations don't permanently 403."""
    await raw_client.get("/v1/session")  # mints session + csrf cookies
    # Simulate the CSRF cookie being dropped while the session persists.
    raw_client.cookies.delete(CSRF_COOKIE_NAME)
    assert raw_client.cookies.get(CSRF_COOKIE_NAME) is None

    response = await raw_client.get("/v1/session")
    assert response.status_code == 200
    # The session cookie is untouched (still no re-set); only CSRF is reissued.
    set_cookies = [h.lower() for h in response.headers.get_list("set-cookie")]
    assert any(h.startswith(f"{CSRF_COOKIE_NAME}=") for h in set_cookies)
    assert not any(h.startswith(f"{SESSION_COOKIE_NAME}=") for h in set_cookies)
    assert raw_client.cookies.get(CSRF_COOKIE_NAME)


@pytest.mark.parametrize(
    "cookie",
    [
        pytest.param(None, id="absent"),
        pytest.param("", id="empty"),
        pytest.param("dGhpcy10b2tlbi13YXMtbmV2ZXItaXNzdWVk", id="unknown"),
        pytest.param("!!! not base64url $$$", id="malformed"),
    ],
)
async def test_maybe_merge_prior_session_no_merge_on_unresolvable_cookie(
    db_session: AsyncSession, cookie: str | None
):
    """Sign-in must proceed without a merge — and crucially without raising —
    when the browser's session cookie doesn't resolve to a live guest: absent,
    malformed, or a token that was never issued (`_find_session_user` returns
    None). `_maybe_merge_prior_session` is otherwise only exercised indirectly
    via the login integration tests; lock the contract in directly so a future
    change to `_find_session_user` can't start surfacing 500s on sign-in (#242).
    """
    target = User(
        username="rita.kovac",
        email="rita@example.com",
        confirmed_at=datetime.now(UTC),
    )
    db_session.add(target)
    await db_session.commit()
    await db_session.refresh(target)

    merged = await _maybe_merge_prior_session(db_session, cookie, target)
    assert merged is None
