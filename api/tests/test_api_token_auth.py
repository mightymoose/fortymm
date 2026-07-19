"""Unit tests for the shared ``find_api_token_user`` resolver.

The bare ``hash_token(raw)`` → live ``api``-context ``User`` lookup that both the
HTTP bearer path (``app.sessions._find_api_token_user``) and a future FastMCP
``TokenVerifier`` call, so the two can't drift. Exercised directly against a real
``db_session`` — no HTTP framing — since that framing lives in the callers.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.api_token_auth import API_TOKEN_CONTEXT, find_api_token_user
from app.models import User, UserToken
from app.token_hashing import hash_token
from tests._helpers import make_user


async def _mint(db_session: AsyncSession, user: User) -> str:
    """Store an ``api``-context token for ``user`` the way production does (only
    the sha256 hash lands in the DB) and return the raw token."""
    raw = "api-raw-" + uuid.uuid4().hex
    db_session.add(
        UserToken(user_id=user.id, context=API_TOKEN_CONTEXT, token=hash_token(raw))
    )
    await db_session.commit()
    return raw


async def test_valid_token_resolves_to_its_user(db_session: AsyncSession) -> None:
    user = await make_user(db_session, "token-owner")
    raw = await _mint(db_session, user)

    resolved = await find_api_token_user(db_session, raw)

    assert resolved is not None
    assert resolved.id == user.id


async def test_unknown_token_resolves_to_none(db_session: AsyncSession) -> None:
    # A well-formed but never-minted token matches no api-context row.
    resolved = await find_api_token_user(db_session, "api-raw-" + uuid.uuid4().hex)

    assert resolved is None


async def test_wrong_context_token_resolves_to_none(db_session: AsyncSession) -> None:
    """A token stored under a different context (e.g. a session token) must not
    resolve through the api-token lookup, even for a live user."""
    user = await make_user(db_session, "session-token-owner")
    raw = "sess-raw-" + uuid.uuid4().hex
    db_session.add(UserToken(user_id=user.id, context="session", token=hash_token(raw)))
    await db_session.commit()

    resolved = await find_api_token_user(db_session, raw)

    assert resolved is None


async def test_tombstoned_users_token_resolves_to_none(
    db_session: AsyncSession,
) -> None:
    """A valid api token whose user was merged away (``merged_into_user_id`` set)
    does not resolve — the folded-in ghost never authenticates."""
    owner = await make_user(db_session, "merge-owner")
    guest = await make_user(db_session, "merged-guest")
    raw = await _mint(db_session, guest)

    guest.merged_into_user_id = owner.id
    guest.merged_at = datetime.now(UTC)
    await db_session.commit()

    resolved = await find_api_token_user(db_session, raw)

    assert resolved is None
