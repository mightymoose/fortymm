"""Exercises the `_require_rbac` gate on every endpoint in app.rbac.

The shared `api_client` fixture in test_rbac.py overrides `get_current_user`
to return an admin; this file builds clients for users who *don't* have
`authorization.manage` to confirm they are blocked.
"""

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import Permission, Role, RolePermission, User, UserRole
from app.sessions import get_current_user
from tests._helpers import CSRF_EVENT_HOOKS


@pytest_asyncio.fixture
async def plain_user(db_session: AsyncSession) -> User:
    """A real user with zero permissions."""
    user = User(username="no-perms")
    db_session.add(user)
    await db_session.commit()
    return user


@pytest_asyncio.fixture
async def viewer_user(db_session: AsyncSession) -> User:
    """A user with `administration.view` but NOT `authorization.manage`."""
    user = User(username="viewer-only")
    role = Role(name="viewer-role")
    perm = Permission(name="administration.view")
    db_session.add_all([user, role, perm])
    await db_session.flush()
    db_session.add_all(
        [
            UserRole(user_id=user.id, role_id=role.id),
            RolePermission(role_id=role.id, permission_id=perm.id),
        ]
    )
    await db_session.commit()
    return user


def _build_client(db_session: AsyncSession, user: User | None) -> AsyncClient:
    async def _override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_user() -> User:
        if user is None:
            from fastapi import HTTPException, status

            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="authentication required",
            )
        return user

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_current_user] = _override_user
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="https://testserver",
        event_hooks=CSRF_EVENT_HOOKS,
    )


@pytest_asyncio.fixture
async def anon_client(
    db_session: AsyncSession,
) -> AsyncIterator[AsyncClient]:
    async with _build_client(db_session, None) as client:
        yield client
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def viewer_client(
    db_session: AsyncSession, viewer_user: User
) -> AsyncIterator[AsyncClient]:
    async with _build_client(db_session, viewer_user) as client:
        yield client
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def plain_client(
    db_session: AsyncSession, plain_user: User
) -> AsyncIterator[AsyncClient]:
    async with _build_client(db_session, plain_user) as client:
        yield client
    app.dependency_overrides.clear()


# Every path-method pair the rbac router exposes. UUIDs are fine because the
# auth gate runs before path-param validation.
ENDPOINTS = [
    ("GET", "/v1/permissions"),
    ("POST", "/v1/permissions"),
    ("GET", "/v1/permissions/00000000-0000-0000-0000-000000000000"),
    ("PATCH", "/v1/permissions/00000000-0000-0000-0000-000000000000"),
    ("DELETE", "/v1/permissions/00000000-0000-0000-0000-000000000000"),
    ("GET", "/v1/roles"),
    ("POST", "/v1/roles"),
    ("GET", "/v1/roles/00000000-0000-0000-0000-000000000000"),
    ("PATCH", "/v1/roles/00000000-0000-0000-0000-000000000000"),
    ("DELETE", "/v1/roles/00000000-0000-0000-0000-000000000000"),
    ("GET", "/v1/users"),
    ("POST", "/v1/users"),
    ("GET", "/v1/users/00000000-0000-0000-0000-000000000000"),
    ("DELETE", "/v1/users/00000000-0000-0000-0000-000000000000"),
    ("PUT", "/v1/users/00000000-0000-0000-0000-000000000000/roles"),
]


@pytest.mark.parametrize("method,path", ENDPOINTS)
async def test_unauthenticated_blocked(
    anon_client: AsyncClient, method: str, path: str
):
    response = await anon_client.request(method, path, json={})
    assert response.status_code == 401, (method, path, response.text)


@pytest.mark.parametrize("method,path", ENDPOINTS)
async def test_user_without_authorization_manage_blocked(
    plain_client: AsyncClient, method: str, path: str
):
    response = await plain_client.request(method, path, json={})
    assert response.status_code == 403, (method, path, response.text)


@pytest.mark.parametrize("method,path", ENDPOINTS)
async def test_administration_view_alone_is_not_enough(
    viewer_client: AsyncClient, method: str, path: str
):
    response = await viewer_client.request(method, path, json={})
    assert response.status_code == 403, (method, path, response.text)
