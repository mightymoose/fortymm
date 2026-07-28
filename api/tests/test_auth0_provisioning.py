"""Unit tests for ``resolve_or_provision_user`` — the match/provision half of
the MCP Auth0 identity resolution (ADR
``20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email``).

Every branch is exercised directly against a real ``db_session`` (no HTTP/token
framing — that lives in the MCP verifier, chore 1c):

- linked ``sub`` → the existing linked user (email irrelevant);
- match, unlinked → binds ``sub`` and returns the user;
- match is case-insensitive;
- match conflict (different ``auth0_sub``) → ``None``, no hijack;
- provision (first-seen verified email) → confirmed account with the default role;
- ``email_verified`` false / ``email`` missing → ``None``, no write;
- a concurrent-insert ``IntegrityError`` re-resolves to the winning row;
- both binding paths stamp ``agent_access_linked_at``, and the steady-state
  linked-``sub`` path leaves the stamp (and the row) untouched.

``default_role`` and ``default_league`` are autouse fixtures in ``conftest``, so
provision has both the role to grant and the league to join.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.auth0_provisioning import (
    AUTH0_EMAIL_CLAIM,
    AUTH0_EMAIL_VERIFIED_CLAIM,
    resolve_or_provision_user,
)
from app.models import Role, User, UserRole
from app.roles import DEFAULT_ROLE_NAME


def _sub() -> str:
    return "auth0|" + uuid.uuid4().hex


async def _make_user(
    db: AsyncSession,
    username: str,
    *,
    email: str | None = None,
    auth0_sub: str | None = None,
) -> User:
    user = User(username=username, email=email, auth0_sub=auth0_sub)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _user_count(db: AsyncSession) -> int:
    return (await db.execute(select(func.count()).select_from(User))).scalar_one()


async def _holds_default_role(db: AsyncSession, user_id: uuid.UUID) -> bool:
    result = await db.execute(
        select(UserRole.user_id)
        .join(Role, Role.id == UserRole.role_id)
        .where(UserRole.user_id == user_id, Role.name == DEFAULT_ROLE_NAME)
    )
    return result.scalar_one_or_none() is not None


def test_claim_key_constants_are_namespaced() -> None:
    # Chore 1c imports exactly these; they must match the Auth0 Action doc.
    assert AUTH0_EMAIL_CLAIM == "https://fortymm.com/email"
    assert AUTH0_EMAIL_VERIFIED_CLAIM == "https://fortymm.com/email_verified"


async def test_linked_sub_returns_existing_user(db_session: AsyncSession) -> None:
    sub = _sub()
    user = await _make_user(db_session, "linked", auth0_sub=sub)

    # Email args are irrelevant once the sub already resolves.
    resolved = await resolve_or_provision_user(
        db_session, sub, "someone-else@example.com", True
    )

    assert resolved is not None
    assert resolved.id == user.id


async def test_match_unlinked_binds_sub(db_session: AsyncSession) -> None:
    sub = _sub()
    user = await _make_user(db_session, "matcher", email="matcher@example.com")

    resolved = await resolve_or_provision_user(
        db_session, sub, "matcher@example.com", True
    )

    assert resolved is not None
    assert resolved.id == user.id
    assert resolved.auth0_sub == sub


async def test_match_is_case_insensitive(db_session: AsyncSession) -> None:
    sub = _sub()
    user = await _make_user(db_session, "caser", email="case@example.com")

    resolved = await resolve_or_provision_user(
        db_session, sub, "CASE@EXAMPLE.COM", True
    )

    assert resolved is not None
    assert resolved.id == user.id
    assert resolved.auth0_sub == sub


async def test_match_conflict_returns_none_and_does_not_hijack(
    db_session: AsyncSession,
) -> None:
    existing_sub = _sub()
    other_sub = _sub()
    user = await _make_user(
        db_session, "linked-email", email="taken@example.com", auth0_sub=existing_sub
    )

    resolved = await resolve_or_provision_user(
        db_session, other_sub, "taken@example.com", True
    )

    assert resolved is None
    await db_session.refresh(user)
    # The pre-existing link is left intact — no takeover.
    assert user.auth0_sub == existing_sub


async def test_provision_creates_confirmed_user_with_default_role(
    db_session: AsyncSession,
) -> None:
    sub = _sub()

    resolved = await resolve_or_provision_user(
        db_session, sub, "fresh@example.com", True
    )

    assert resolved is not None
    assert resolved.email == "fresh@example.com"
    assert resolved.auth0_sub == sub
    assert resolved.confirmed_at is not None
    # A ``DateTime(timezone=True)`` column must yield an aware datetime.
    assert resolved.confirmed_at.tzinfo is not None
    assert resolved.username  # a coolname slug, not derived from the email
    assert "fresh" not in resolved.username
    assert await _holds_default_role(db_session, resolved.id)


async def test_provision_lowercases_the_stored_email(
    db_session: AsyncSession,
) -> None:
    sub = _sub()

    resolved = await resolve_or_provision_user(
        db_session, sub, "Mixed.Case@Example.COM", True
    )

    assert resolved is not None
    assert resolved.email == "mixed.case@example.com"


async def test_email_verified_false_provisions_nothing(
    db_session: AsyncSession,
) -> None:
    before = await _user_count(db_session)

    resolved = await resolve_or_provision_user(
        db_session, _sub(), "unverified@example.com", False
    )

    assert resolved is None
    assert await _user_count(db_session) == before


async def test_email_none_returns_none(db_session: AsyncSession) -> None:
    before = await _user_count(db_session)

    resolved = await resolve_or_provision_user(db_session, _sub(), None, True)

    assert resolved is None
    assert await _user_count(db_session) == before


async def test_concurrent_insert_reresolves_to_winner(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A near-simultaneous request wins the INSERT first; the loser's flush hits
    the unique constraint (``IntegrityError``), rolls back, and re-resolves to
    the winning row instead of raising.

    The race is staged by patching ``generate_username`` — called mid-provision,
    before the flush — to commit a competing row (same email + sub) on a
    separate session first.
    """
    sub = _sub()
    email = "race@example.com"

    async def racing_generate_username(db: AsyncSession) -> str:
        # Commit the winning row on a separate connection, mid-provision, so the
        # in-flight provision's own flush collides on the unique constraints.
        sm = async_sessionmaker(engine, expire_on_commit=False)
        async with sm() as other:
            other.add(
                User(
                    username="race-winner",
                    email=email,
                    auth0_sub=sub,
                    confirmed_at=datetime.now(UTC),
                )
            )
            await other.commit()
        return "race-loser"

    # ``resolve_or_provision_user`` calls the name it imported into this module,
    # so patch it there.
    monkeypatch.setattr(
        "app.auth0_provisioning.generate_username", racing_generate_username
    )
    resolved = await resolve_or_provision_user(db_session, sub, email, True)

    assert resolved is not None
    # The winner's row, not a freshly raised error or a duplicate.
    assert resolved.username == "race-winner"
    assert resolved.auth0_sub == sub
    # Exactly one account holds the raced email.
    matches = (
        await db_session.execute(select(func.count()).where(User.email == email))
    ).scalar_one()
    assert matches == 1


async def test_match_branch_reresolves_on_concurrent_sub_bind(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The *match* branch binds ``sub`` to an email-matched account, but a
    concurrent bind (e.g. a concurrent MCP provision for the same ``sub``) binds
    the same ``sub`` to a *different* row first. The branch's commit then hits
    the unique ``users.auth0_sub`` constraint (``IntegrityError``): it must roll
    back and re-resolve to the winning row instead of letting the error propagate.

    The race is staged by patching ``_resolve_live_user_by_email`` — called at the
    top of the match branch, before its commit — to commit a competing row that
    binds the same ``sub`` to a different user on a separate session first.
    """
    sub = _sub()
    email = "match-race@example.com"
    # The email-matched account the branch will try to bind (``auth0_sub`` still
    # ``None``, so it takes the bind branch).
    matched_user = await _make_user(db_session, "match-race-target", email=email)

    import app.auth0_provisioning as prov

    real_resolve = prov._resolve_live_user_by_email
    raced = {"done": False}

    async def racing_resolve(db: AsyncSession, e: str) -> User | None:
        result = await real_resolve(db, e)
        if not raced["done"]:
            raced["done"] = True
            # A concurrent bind of the SAME ``sub`` to a DIFFERENT row wins first,
            # committed on a separate connection mid-branch.
            sm = async_sessionmaker(engine, expire_on_commit=False)
            async with sm() as other:
                other.add(User(username="sub-race-winner", auth0_sub=sub))
                await other.commit()
        return result

    monkeypatch.setattr(prov, "_resolve_live_user_by_email", racing_resolve)
    resolved = await resolve_or_provision_user(db_session, sub, email, True)

    # Re-resolved cleanly to the concurrent winner (via ``resolve_linked_user``),
    # not a raised IntegrityError.
    assert resolved is not None
    assert resolved.username == "sub-race-winner"
    assert resolved.auth0_sub == sub
    # The email-matched row's bind was rolled back — it never took the ``sub``.
    await db_session.refresh(matched_user)
    assert matched_user.auth0_sub is None


# ----- agent_access_linked_at: when the identity bound ----------------------
#
# The settings surface wants "Connected <date>", so both binding paths stamp the
# moment they bind — and the steady-state resolve path must NOT, or every MCP
# request would both rewrite history and turn a read into a write.


async def test_match_unlinked_stamps_the_link_time(db_session: AsyncSession) -> None:
    before = datetime.now(UTC)
    user = await _make_user(db_session, "stamper", email="stamper@example.com")
    assert user.agent_access_linked_at is None

    resolved = await resolve_or_provision_user(
        db_session, _sub(), "stamper@example.com", True
    )

    assert resolved is not None
    linked_at = resolved.agent_access_linked_at
    assert linked_at is not None
    # A ``DateTime(timezone=True)`` column must yield an aware datetime.
    assert linked_at.tzinfo is not None
    assert before <= linked_at <= datetime.now(UTC)


async def test_provision_stamps_the_link_time(db_session: AsyncSession) -> None:
    before = datetime.now(UTC)

    resolved = await resolve_or_provision_user(
        db_session, _sub(), "fresh-stamp@example.com", True
    )

    assert resolved is not None
    linked_at = resolved.agent_access_linked_at
    assert linked_at is not None
    assert linked_at.tzinfo is not None
    assert before <= linked_at <= datetime.now(UTC)


async def test_linked_sub_leaves_the_original_stamp_untouched(
    db_session: AsyncSession,
) -> None:
    """The hot path every steady-state MCP request takes must stay a no-op —
    it neither re-stamps the link time nor writes the row at all.

    ``updated_at`` carries ``onupdate=func.now()``, so it only moves on a real
    UPDATE: an unchanged ``updated_at`` is the evidence that nothing was written.
    """
    sub = _sub()
    original = datetime(2020, 1, 2, 3, 4, 5, tzinfo=UTC)
    user = await _make_user(db_session, "steady", email="steady@example.com")
    user.auth0_sub = sub
    user.agent_access_linked_at = original
    await db_session.commit()
    await db_session.refresh(user)
    updated_at_before = user.updated_at

    resolved = await resolve_or_provision_user(
        db_session, sub, "steady@example.com", True
    )

    assert resolved is not None
    assert resolved.id == user.id
    # Nothing pending either — the path issued no write at all.
    assert user not in db_session.dirty
    # ``refresh`` autoflushes, so a pending re-stamp would still be caught here.
    await db_session.refresh(user)
    assert user.agent_access_linked_at == original
    assert user.updated_at == updated_at_before
