"""The RBAC seed converges any database onto the default `User` role.

`scripts/seed_rbac.py` builds its own engine from settings, so the logic under
test lives in `app.roles.converge_default_role` and is exercised here directly
against the test session — the same call the script makes.
"""

import uuid

import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import Base
from app.models import Permission, Role, RolePermission, User, UserRole
from app.roles import DEFAULT_ROLE_NAME, converge_default_role, get_default_role


@pytest_asyncio.fixture(autouse=True)
async def unseeded(db_session: AsyncSession, default_role: Role) -> None:
    """Start from a database the seed has never touched.

    ``conftest``'s autouse ``default_role`` fixture pre-seeds the role (the
    user-minting paths raise without it). These tests are about the seed *itself*
    converging an arbitrary database, so drop it back out first — depending on
    the fixture guarantees it ran, and therefore that we delete it after it was
    created, not before.
    """
    await db_session.delete(default_role)
    await db_session.commit()


async def _count(db: AsyncSession, model: type[Base]) -> int:
    result = await db.execute(select(func.count()).select_from(model))
    return result.scalar_one()


async def _role_ids_of(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    result = await db.execute(
        select(UserRole.role_id).where(UserRole.user_id == user_id)
    )
    return set(result.scalars().all())


async def _make_users(db: AsyncSession, *usernames: str) -> list[User]:
    users = [User(username=name) for name in usernames]
    db.add_all(users)
    await db.flush()
    return users


async def test_creates_the_role_and_grants_it_to_every_existing_user(
    db_session: AsyncSession,
) -> None:
    users = await _make_users(db_session, "ada", "grace", "alan")

    outcome = await converge_default_role(db_session)
    await db_session.commit()

    assert outcome.role_created is True
    assert outcome.grants_added == 3

    role = await get_default_role(db_session)
    assert role is not None
    assert role.name == DEFAULT_ROLE_NAME

    assert await _count(db_session, UserRole) == 3
    for user in users:
        assert await _role_ids_of(db_session, user.id) == {role.id}


async def test_the_default_role_carries_zero_permissions(
    db_session: AsyncSession,
) -> None:
    # A permission exists in the database — the role must still pick up none.
    db_session.add(Permission(name="tournament.view", description="See tournaments."))
    await _make_users(db_session, "ada")

    await converge_default_role(db_session)
    await db_session.commit()

    role = await get_default_role(db_session)
    assert role is not None
    links = (
        await db_session.execute(
            select(func.count())
            .select_from(RolePermission)
            .where(RolePermission.role_id == role.id)
        )
    ).scalar_one()
    assert links == 0


async def test_a_second_run_adds_no_rows(db_session: AsyncSession) -> None:
    await _make_users(db_session, "ada", "grace")
    await converge_default_role(db_session)
    await db_session.commit()

    roles_before = await _count(db_session, Role)
    grants_before = await _count(db_session, UserRole)

    outcome = await converge_default_role(db_session)
    await db_session.commit()

    assert outcome == (False, 0)
    assert await _count(db_session, Role) == roles_before
    assert await _count(db_session, UserRole) == grants_before


async def test_a_user_with_another_role_ends_up_holding_both(
    db_session: AsyncSession,
) -> None:
    (admin,) = await _make_users(db_session, "ada")
    administrator = Role(name="Administrator", description="Runs the place.")
    db_session.add(administrator)
    await db_session.flush()
    db_session.add(UserRole(user_id=admin.id, role_id=administrator.id))
    await db_session.commit()

    outcome = await converge_default_role(db_session)
    await db_session.commit()

    assert outcome.grants_added == 1
    default = await get_default_role(db_session)
    assert default is not None
    assert await _role_ids_of(db_session, admin.id) == {administrator.id, default.id}


async def test_users_minted_since_the_last_run_are_backfilled(
    db_session: AsyncSession,
) -> None:
    await _make_users(db_session, "ada")
    await converge_default_role(db_session)
    await db_session.commit()

    (latecomer,) = await _make_users(db_session, "grace")
    outcome = await converge_default_role(db_session)
    await db_session.commit()

    assert outcome == (False, 1)
    default = await get_default_role(db_session)
    assert default is not None
    assert await _role_ids_of(db_session, latecomer.id) == {default.id}
    assert await _count(db_session, UserRole) == 2


async def test_permissions_hung_off_the_role_survive_a_re_run(
    db_session: AsyncSession,
) -> None:
    """The role is a lever: an admin adds a permission to it to grant that
    capability to everyone. A later seed run must not strip it back to empty."""
    await _make_users(db_session, "ada")
    await converge_default_role(db_session)
    await db_session.commit()

    role = await get_default_role(db_session)
    assert role is not None
    perm = Permission(name="tournament.view", description="See tournaments.")
    db_session.add(perm)
    await db_session.flush()
    db_session.add(RolePermission(role_id=role.id, permission_id=perm.id))
    await db_session.commit()

    await converge_default_role(db_session)
    await db_session.commit()

    result = await db_session.execute(
        select(RolePermission.permission_id).where(RolePermission.role_id == role.id)
    )
    assert list(result.scalars().all()) == [perm.id]
