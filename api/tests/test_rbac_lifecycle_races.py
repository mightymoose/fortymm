"""Privileged role writes serialize with suspension of the acting Account."""

import asyncio

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import rbac
from app.identity_lifecycle import deactivate_account
from app.main import app
from app.models import Account, Permission, Role, RolePermission, UserRole
from app.roles import converge_default_role
from tests._helpers import make_user
from tests.test_proposal_history import wait_for_blocked
from tests.test_rbac_authz import _build_client


@pytest.mark.parametrize("first", ["role_change", "deactivation"])
async def test_role_change_serializes_with_suspension_of_its_actor(
    db_session, engine, monkeypatch, first
):
    await converge_default_role(db_session)
    actor = await make_user(db_session, "rbac-suspension-actor")
    target = await make_user(db_session, "rbac-suspension-target")
    role = Role(name="Suspension test administrator")
    permission = Permission(name=rbac.RBAC_PERMISSION)
    db_session.add_all([role, permission])
    await db_session.flush()
    db_session.add_all(
        [
            RolePermission(role_id=role.id, permission_id=permission.id),
            UserRole(user_id=actor.id, role_id=role.id),
        ]
    )
    await db_session.commit()
    actor_id, target_id, role_id = actor.id, target.id, role.id
    checked, proceed = asyncio.Event(), asyncio.Event()
    original = rbac._validate_role_ids

    async def pause_before_role_write(*args, **kwargs):
        checked.set()
        await proceed.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(rbac, "_validate_role_ids", pause_before_role_write)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as writer, factory() as lifecycle:
        stale_actor = await writer.get(Account, actor_id)
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        try:
            async with _build_client(writer, stale_actor) as client:
                if first == "deactivation":
                    await deactivate_account(lifecycle, actor_id)
                    proceed.set()
                    pending = asyncio.create_task(
                        client.put(
                            f"/v1/users/{target_id}/roles",
                            json={"role_ids": [str(role_id)]},
                        )
                    )
                    try:
                        await wait_for_blocked(lifecycle, writer_pid, pending)
                        await lifecycle.commit()
                        response = await pending
                        assert response.status_code == 403, response.text
                    finally:
                        await lifecycle.rollback()
                        await asyncio.gather(pending, return_exceptions=True)
                else:
                    writing = asyncio.create_task(
                        client.put(
                            f"/v1/users/{target_id}/roles",
                            json={"role_ids": [str(role_id)]},
                        )
                    )
                    await asyncio.wait_for(checked.wait(), 5)
                    pending = asyncio.create_task(
                        deactivate_account(lifecycle, actor_id)
                    )
                    try:
                        await wait_for_blocked(writer, lifecycle_pid, pending)
                        proceed.set()
                        response = await writing
                        assert response.status_code == 200, response.text
                        await pending
                        await lifecycle.commit()
                    finally:
                        proceed.set()
                        await asyncio.gather(writing, return_exceptions=True)
                        await asyncio.gather(pending, return_exceptions=True)
                        await lifecycle.rollback()
        finally:
            app.dependency_overrides.clear()
    target_role = await db_session.scalar(
        select(UserRole.role_id).where(
            UserRole.user_id == target_id,
            UserRole.role_id == role_id,
        )
    )
    assert (target_role is not None) == (first == "role_change")
