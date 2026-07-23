"""Both-directions convergence guard for the ADR's Decision-2 (ADR
``20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email``,
"The reverse-order convergence reuses existing merge machinery, not new code").

For one verified email, whichever surface a human touches first — the MCP agent
(``resolve_or_provision_user``) or the website magic-link — the *other* surface
must fold onto the SAME single FortyMM account, never spawn a second one:

- **Direction A — agent first, then website.** The agent provisions account A on
  the email; a later website guest who enters that (now-confirmed) address is
  offered the existing account-**merge** token — so the guest is tombstoned into
  A rather than a duplicate being made.
- **Direction B — website first, then agent.** A guest confirms the address the
  normal magic-link way (no ``auth0_sub``); the agent's later verified token
  *matches* that account and binds its ``sub`` — no new row.

The discriminating invariant asserted in both directions: exactly **one live**
(non-tombstoned) user holds the email, and it is A. A regression that created a
second account for the address instead of folding/binding turns these red.

Direction A drives the real HTTP merge-confirm flow (``POST /v1/me/email`` →
merge token → ``POST /v1/me/email/confirm``), reusing ``test_email``'s helpers so
this exercises the exact machinery the ADR points at, not a shortcut.
"""

from collections.abc import AsyncIterator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth0_provisioning import resolve_or_provision_user
from app.db import get_session
from app.main import app
from app.models import User
from tests._helpers import CSRF_EVENT_HOOKS, start_session
from tests.test_email import _capture_raw_token, _finished_send_jobs

CONVERGE_EMAIL = "converge@example.com"


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


async def _live_users_for_email(db: AsyncSession, email: str) -> list[User]:
    """Every non-tombstoned user holding ``email`` — the convergence invariant is
    that this list is exactly one entry long."""
    return list(
        (
            await db.execute(
                select(User).where(
                    User.email == email,
                    User.merged_into_user_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )


async def _user_count(db: AsyncSession) -> int:
    return (await db.execute(select(func.count()).select_from(User))).scalar_one()


async def test_direction_a_agent_then_website_converges_on_one_account(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
) -> None:
    """Agent provisions A; a later website guest folds into A via the merge
    token. Ends with one live account (A) holding the email."""
    # 1. Agent-first: the MCP resolve/provision path mints a confirmed account A
    #    bound to auth0|A.
    account_a = await resolve_or_provision_user(
        db_session, "auth0|A", CONVERGE_EMAIL, True
    )
    assert account_a is not None
    assert account_a.confirmed_at is not None
    assert account_a.auth0_sub == "auth0|A"
    a_id = account_a.id

    # 2. A *separate* website guest signs in and enters the same address.
    guest = await start_session(api_client, db_session)
    assert guest.id != a_id
    # ``set_email`` sees the address is owned by a confirmed account and, because
    # the guest holds no confirmed email of their own, issues a MERGE token (to
    # A) rather than an email-change token. Capture it out of the enqueued email.
    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email=CONVERGE_EMAIL
    )
    # It must be the merge email — proves we're on the fold-together path, not a
    # plain email-change confirm.
    assert _finished_send_jobs(fake_email_queue)[-1].func_name == (
        "app.email.send_merge_email"
    )

    # 3. Consume the merge token: folds the guest into A and signs the browser in
    #    as A (the exact end-to-end machinery test_email's merge tests drive).
    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["user"]["email"] == CONVERGE_EMAIL

    # Convergence: the guest is tombstoned INTO A...
    await db_session.refresh(guest)
    assert guest.merged_into_user_id == a_id
    # ...exactly one live user holds the email, and it is A, still bound to
    # auth0|A. A regression that made a duplicate would push this count to 2.
    live = await _live_users_for_email(db_session, CONVERGE_EMAIL)
    assert len(live) == 1
    assert live[0].id == a_id
    assert live[0].email == CONVERGE_EMAIL
    assert live[0].auth0_sub == "auth0|A"


async def test_direction_b_website_then_agent_binds_to_one_account(
    api_client: AsyncClient, db_session: AsyncSession, fake_email_queue
) -> None:
    """A website guest confirms the address the normal way (no auth0_sub); a
    later agent token matches that account and binds its sub — no duplicate."""
    # 1. Website-first: a guest confirms the address via the magic-link flow,
    #    producing a confirmed account A that holds no auth0_sub.
    guest = await start_session(api_client, db_session)
    raw_token = await _capture_raw_token(
        api_client, db_session, fake_email_queue, email=CONVERGE_EMAIL
    )
    response = await api_client.post("/v1/me/email/confirm", json={"token": raw_token})
    assert response.status_code == 200, response.text
    await db_session.refresh(guest)
    account_a = guest
    assert account_a.email == CONVERGE_EMAIL
    assert account_a.confirmed_at is not None
    assert account_a.auth0_sub is None
    a_id = account_a.id

    live_before = await _live_users_for_email(db_session, CONVERGE_EMAIL)
    assert len(live_before) == 1
    users_before = await _user_count(db_session)

    # 2. Agent connects: a verified Auth0 token for the same address.
    resolved = await resolve_or_provision_user(
        db_session, "auth0|B", CONVERGE_EMAIL, True
    )

    # 3. It MATCHES A (same id) and binds the sub — no new row is inserted.
    assert resolved is not None
    assert resolved.id == a_id
    await db_session.refresh(account_a)
    assert account_a.auth0_sub == "auth0|B"
    # No account was duplicated: the total row count is unchanged and exactly one
    # live user still holds the email — A. A regression that provisioned a second
    # account would grow both counts.
    assert await _user_count(db_session) == users_before
    live_after = await _live_users_for_email(db_session, CONVERGE_EMAIL)
    assert len(live_after) == 1
    assert live_after[0].id == a_id
