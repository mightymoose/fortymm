"""Account suspension cannot be overtaken by stale agent-access mutations."""

import asyncio
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.identity_lifecycle import reactivate_account
from app.main import app
from app.models import Account
from tests._helpers import make_user
from tests.test_proposal_history import wait_for_blocked
from tests.test_rbac_authz import _build_client


@pytest.mark.parametrize("action", ["allow", "disconnect"])
async def test_suspension_preserves_agent_access_choice_after_reactivation(
    db_session, engine, action
):
    actor = await make_user(db_session, "agent-choice")
    revoked_at = datetime.now(UTC) if action == "allow" else None
    actor.agent_access_revoked_at = revoked_at
    await db_session.commit()
    actor_id = actor.id
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as writer, sessions() as lifecycle:
        stale_actor = await writer.get(Account, actor_id)
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        await lifecycle.execute(
            text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
            {"id": actor_id},
        )
        try:
            async with _build_client(writer, stale_actor) as client:
                pending = asyncio.create_task(
                    client.post(f"/v1/settings/agent-access/{action}")
                )
                try:
                    await wait_for_blocked(lifecycle, writer_pid, pending)
                    await lifecycle.commit()
                    response = await pending
                    assert response.status_code == 401, response.text
                finally:
                    await lifecycle.rollback()
                    await asyncio.gather(pending, return_exceptions=True)
                    await writer.rollback()
        finally:
            app.dependency_overrides.clear()
    await reactivate_account(db_session, actor_id)
    await db_session.commit()
    await db_session.refresh(actor)
    assert actor.agent_access_revoked_at == revoked_at
