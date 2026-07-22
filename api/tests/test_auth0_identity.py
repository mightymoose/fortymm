"""Unit tests for the shared ``resolve_linked_user`` Auth0-subject resolver.

The bare ``auth0_sub`` → live ``User`` lookup the MCP OAuth verifier calls to map
a verified token's ``sub`` to the one fortymm user that linked it. Exercised
directly against a real ``db_session`` — no HTTP/token framing — since that
framing lives in the caller (the verifier).
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth0_identity import resolve_linked_user
from app.models import User
from tests._helpers import make_user


async def _link(db_session: AsyncSession, user: User, sub: str) -> None:
    """Bind ``sub`` to ``user`` the way the link callback does."""
    user.auth0_sub = sub
    await db_session.commit()


async def test_linked_user_resolves_by_sub(db_session: AsyncSession) -> None:
    user = await make_user(db_session, "auth0-linked")
    sub = "auth0|" + uuid.uuid4().hex
    await _link(db_session, user, sub)

    resolved = await resolve_linked_user(db_session, sub)

    assert resolved is not None
    assert resolved.id == user.id


async def test_unknown_sub_resolves_to_none(db_session: AsyncSession) -> None:
    # A well-formed but never-linked subject matches no user.
    resolved = await resolve_linked_user(db_session, "auth0|" + uuid.uuid4().hex)

    assert resolved is None


async def test_tombstoned_linked_user_resolves_to_none(
    db_session: AsyncSession,
) -> None:
    """A linked user who was merged away (``merged_into_user_id`` set) does not
    resolve — the folded-in ghost never authenticates."""
    owner = await make_user(db_session, "auth0-merge-owner")
    guest = await make_user(db_session, "auth0-merged-guest")
    sub = "auth0|" + uuid.uuid4().hex
    await _link(db_session, guest, sub)

    guest.merged_into_user_id = owner.id
    guest.merged_at = datetime.now(UTC)
    await db_session.commit()

    resolved = await resolve_linked_user(db_session, sub)

    assert resolved is None


async def test_blank_sub_does_not_match_null_auth0_sub_user(
    db_session: AsyncSession,
) -> None:
    """An empty/blank subject must not resolve a user who never linked (whose
    ``auth0_sub`` is NULL) — an unlinked user's NULL column is not an empty
    string to match against."""
    await make_user(db_session, "auth0-never-linked")

    resolved = await resolve_linked_user(db_session, "")

    assert resolved is None
