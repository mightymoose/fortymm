import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Permission, Role, RolePermission, User, UserRole


async def test_create_role_assigns_uuid_and_timestamps(db_session: AsyncSession):
    role = Role(name="admin", description="full access")
    db_session.add(role)
    await db_session.commit()
    await db_session.refresh(role)
    assert isinstance(role.id, uuid.UUID)
    assert role.created_at is not None
    assert role.updated_at is not None


async def test_role_name_is_unique(db_session: AsyncSession):
    db_session.add(Role(name="admin"))
    await db_session.commit()
    db_session.add(Role(name="admin"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_create_permission_assigns_uuid_and_timestamps(
    db_session: AsyncSession,
):
    perm = Permission(name="solver:run")
    db_session.add(perm)
    await db_session.commit()
    await db_session.refresh(perm)
    assert isinstance(perm.id, uuid.UUID)
    assert perm.created_at is not None
    assert perm.updated_at is not None


async def test_permission_name_is_unique(db_session: AsyncSession):
    db_session.add(Permission(name="solver:run"))
    await db_session.commit()
    db_session.add(Permission(name="solver:run"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_role_permission_links_role_and_permission(
    db_session: AsyncSession,
):
    role = Role(name="editor")
    perm = Permission(name="puzzle:write")
    db_session.add_all([role, perm])
    await db_session.commit()

    db_session.add(RolePermission(role_id=role.id, permission_id=perm.id))
    await db_session.commit()

    fetched = (
        await db_session.execute(
            select(RolePermission).where(
                RolePermission.role_id == role.id,
                RolePermission.permission_id == perm.id,
            )
        )
    ).scalar_one()
    assert fetched.created_at is not None


async def test_role_permission_cascades_when_role_deleted(
    db_session: AsyncSession,
):
    role = Role(name="viewer")
    perm = Permission(name="puzzle:read")
    db_session.add_all([role, perm])
    await db_session.commit()

    db_session.add(RolePermission(role_id=role.id, permission_id=perm.id))
    await db_session.commit()

    await db_session.delete(role)
    await db_session.commit()
    db_session.expunge_all()

    remaining = (await db_session.execute(select(RolePermission))).scalars().all()
    assert remaining == []


async def test_user_role_links_user_and_role(db_session: AsyncSession):
    user = User(username="alice")
    role = Role(name="member")
    db_session.add_all([user, role])
    await db_session.commit()

    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()

    fetched = (
        await db_session.execute(
            select(UserRole).where(
                UserRole.user_id == user.id, UserRole.role_id == role.id
            )
        )
    ).scalar_one()
    assert fetched.created_at is not None


async def test_user_role_cascades_when_user_deleted(db_session: AsyncSession):
    user = User(username="bob")
    role = Role(name="member")
    db_session.add_all([user, role])
    await db_session.commit()

    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()

    await db_session.delete(user)
    await db_session.commit()
    db_session.expunge_all()

    remaining = (await db_session.execute(select(UserRole))).scalars().all()
    assert remaining == []
