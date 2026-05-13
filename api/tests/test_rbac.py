from collections.abc import AsyncIterator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import Permission, Role, RolePermission, User, UserRole


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="https://testserver"
    ) as client:
        yield client
    app.dependency_overrides.clear()


# ----- permissions ---------------------------------------------------------


async def test_create_and_list_permissions(
    api_client: AsyncClient, db_session: AsyncSession
):
    response = await api_client.post(
        "/v1/permissions",
        json={"name": "tournament.view", "description": "see them"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "tournament.view"
    assert body["description"] == "see them"
    assert body["id"]

    listing = await api_client.get("/v1/permissions")
    assert listing.status_code == 200
    rows = listing.json()
    assert len(rows) == 1
    assert rows[0]["name"] == "tournament.view"


async def test_create_permission_rejects_duplicate_name(api_client: AsyncClient):
    await api_client.post("/v1/permissions", json={"name": "dup"})
    second = await api_client.post("/v1/permissions", json={"name": "dup"})
    assert second.status_code == 409


async def test_update_permission(
    api_client: AsyncClient, db_session: AsyncSession
):
    created = (
        await api_client.post(
            "/v1/permissions", json={"name": "before", "description": "old"}
        )
    ).json()

    patched = await api_client.patch(
        f"/v1/permissions/{created['id']}",
        json={"name": "after", "description": "new"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == "after"
    assert body["description"] == "new"


async def test_delete_permission(
    api_client: AsyncClient, db_session: AsyncSession
):
    created = (
        await api_client.post("/v1/permissions", json={"name": "doomed"})
    ).json()
    deleted = await api_client.delete(f"/v1/permissions/{created['id']}")
    assert deleted.status_code == 204
    rows = (await db_session.execute(select(Permission))).scalars().all()
    assert rows == []


async def test_get_permission_not_found(api_client: AsyncClient):
    missing = await api_client.get(
        "/v1/permissions/00000000-0000-0000-0000-000000000000"
    )
    assert missing.status_code == 404


# ----- roles ---------------------------------------------------------------


async def test_create_role_with_explicit_permissions(
    api_client: AsyncClient, db_session: AsyncSession
):
    p1 = (await api_client.post("/v1/permissions", json={"name": "a"})).json()
    p2 = (await api_client.post("/v1/permissions", json={"name": "b"})).json()

    role_resp = await api_client.post(
        "/v1/roles",
        json={
            "name": "scorer",
            "description": "scores matches",
            "permission_ids": [p1["id"], p2["id"]],
        },
    )
    assert role_resp.status_code == 201
    body = role_resp.json()
    assert set(body["permission_ids"]) == {p1["id"], p2["id"]}

    rp = (
        await db_session.execute(select(RolePermission))
    ).scalars().all()
    assert len(rp) == 2


async def test_create_role_from_template_copies_permissions(
    api_client: AsyncClient,
):
    p1 = (await api_client.post("/v1/permissions", json={"name": "a"})).json()
    p2 = (await api_client.post("/v1/permissions", json={"name": "b"})).json()
    tmpl = (
        await api_client.post(
            "/v1/roles",
            json={"name": "template", "permission_ids": [p1["id"], p2["id"]]},
        )
    ).json()

    copy = await api_client.post(
        "/v1/roles", json={"name": "copy", "template_id": tmpl["id"]}
    )
    assert copy.status_code == 201
    assert set(copy.json()["permission_ids"]) == {p1["id"], p2["id"]}


async def test_create_role_rejects_template_and_permissions_together(
    api_client: AsyncClient,
):
    tmpl = (
        await api_client.post("/v1/roles", json={"name": "template"})
    ).json()
    response = await api_client.post(
        "/v1/roles",
        json={
            "name": "x",
            "template_id": tmpl["id"],
            "permission_ids": [],
        },
    )
    assert response.status_code == 400


async def test_create_role_rejects_unknown_permission(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/roles",
        json={
            "name": "x",
            "permission_ids": ["00000000-0000-0000-0000-000000000000"],
        },
    )
    assert response.status_code == 400


async def test_list_roles_returns_permission_ids(
    api_client: AsyncClient, db_session: AsyncSession
):
    p = (await api_client.post("/v1/permissions", json={"name": "a"})).json()
    await api_client.post(
        "/v1/roles", json={"name": "alpha", "permission_ids": [p["id"]]}
    )
    await api_client.post("/v1/roles", json={"name": "bravo"})

    rows = (await api_client.get("/v1/roles")).json()
    assert [r["name"] for r in rows] == ["alpha", "bravo"]
    by_name = {r["name"]: r for r in rows}
    assert by_name["alpha"]["permission_ids"] == [p["id"]]
    assert by_name["bravo"]["permission_ids"] == []


async def test_update_role_replaces_permissions(api_client: AsyncClient):
    p1 = (await api_client.post("/v1/permissions", json={"name": "a"})).json()
    p2 = (await api_client.post("/v1/permissions", json={"name": "b"})).json()
    p3 = (await api_client.post("/v1/permissions", json={"name": "c"})).json()
    role = (
        await api_client.post(
            "/v1/roles",
            json={"name": "r", "permission_ids": [p1["id"], p2["id"]]},
        )
    ).json()

    patched = await api_client.patch(
        f"/v1/roles/{role['id']}",
        json={"permission_ids": [p3["id"]]},
    )
    assert patched.status_code == 200
    assert patched.json()["permission_ids"] == [p3["id"]]


async def test_update_role_clears_permissions(api_client: AsyncClient):
    p = (await api_client.post("/v1/permissions", json={"name": "a"})).json()
    role = (
        await api_client.post(
            "/v1/roles", json={"name": "r", "permission_ids": [p["id"]]}
        )
    ).json()
    patched = await api_client.patch(
        f"/v1/roles/{role['id']}", json={"permission_ids": []}
    )
    assert patched.status_code == 200
    assert patched.json()["permission_ids"] == []


async def test_update_role_partial_keeps_permissions(api_client: AsyncClient):
    p = (await api_client.post("/v1/permissions", json={"name": "a"})).json()
    role = (
        await api_client.post(
            "/v1/roles", json={"name": "r", "permission_ids": [p["id"]]}
        )
    ).json()
    patched = await api_client.patch(
        f"/v1/roles/{role['id']}", json={"description": "renamed reason"}
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["description"] == "renamed reason"
    assert body["permission_ids"] == [p["id"]]


async def test_delete_role_cascades_user_assignments(
    api_client: AsyncClient, db_session: AsyncSession
):
    role = (await api_client.post("/v1/roles", json={"name": "doomed"})).json()
    user = (
        await api_client.post("/v1/users", json={"username": "alice"})
    ).json()
    await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [role["id"]]}
    )

    deleted = await api_client.delete(f"/v1/roles/{role['id']}")
    assert deleted.status_code == 204

    remaining = (
        await db_session.execute(select(UserRole))
    ).scalars().all()
    assert remaining == []


# ----- users ---------------------------------------------------------------


async def test_create_and_list_users(api_client: AsyncClient):
    created = await api_client.post("/v1/users", json={"username": "ada"})
    assert created.status_code == 201
    body = created.json()
    assert body["username"] == "ada"
    assert body["role_ids"] == []

    rows = (await api_client.get("/v1/users")).json()
    assert any(u["username"] == "ada" for u in rows)


async def test_create_user_rejects_duplicate(api_client: AsyncClient):
    await api_client.post("/v1/users", json={"username": "dup"})
    second = await api_client.post("/v1/users", json={"username": "dup"})
    assert second.status_code == 409


async def test_set_user_roles_replaces_assignments(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = (
        await api_client.post("/v1/users", json={"username": "alex"})
    ).json()
    r1 = (await api_client.post("/v1/roles", json={"name": "one"})).json()
    r2 = (await api_client.post("/v1/roles", json={"name": "two"})).json()

    response = await api_client.put(
        f"/v1/users/{user['id']}/roles",
        json={"role_ids": [r1["id"], r2["id"]]},
    )
    assert response.status_code == 200
    assert set(response.json()["role_ids"]) == {r1["id"], r2["id"]}

    response = await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [r1["id"]]}
    )
    assert response.json()["role_ids"] == [r1["id"]]
    rows = (await db_session.execute(select(UserRole))).scalars().all()
    assert len(rows) == 1


async def test_set_user_roles_rejects_unknown_role(api_client: AsyncClient):
    user = (await api_client.post("/v1/users", json={"username": "u"})).json()
    response = await api_client.put(
        f"/v1/users/{user['id']}/roles",
        json={"role_ids": ["00000000-0000-0000-0000-000000000000"]},
    )
    assert response.status_code == 400


async def test_list_users_includes_role_ids(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = User(username="seeded")
    role = Role(name="seeded-role")
    db_session.add_all([user, role])
    await db_session.flush()
    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()

    rows = (await api_client.get("/v1/users")).json()
    target = next(u for u in rows if u["username"] == "seeded")
    assert target["role_ids"] == [str(role.id)]


async def test_delete_user(api_client: AsyncClient, db_session: AsyncSession):
    user = (
        await api_client.post("/v1/users", json={"username": "doomed"})
    ).json()
    deleted = await api_client.delete(f"/v1/users/{user['id']}")
    assert deleted.status_code == 204
    remaining = (
        await db_session.execute(
            select(User).where(User.username == "doomed")
        )
    ).scalar_one_or_none()
    assert remaining is None
