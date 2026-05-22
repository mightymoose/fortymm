from collections.abc import AsyncIterator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import Permission, Role, RolePermission, User, UserRole
from app.rbac import _require_rbac
from app.sessions import get_current_user


@pytest_asyncio.fixture
async def admin_user(db_session: AsyncSession) -> User:
    """A real DB user the rbac routes will see as `current_user`.

    The router's authz gate is bypassed via dependency_overrides[_require_rbac]
    so this user does NOT need a permission row attached — that keeps existing
    list-endpoint tests with their "this DB starts empty" assumptions.
    """
    user = User(username="rbac-admin")
    db_session.add(user)
    await db_session.commit()
    return user


@pytest_asyncio.fixture
async def api_client(
    db_session: AsyncSession, admin_user: User
) -> AsyncIterator[AsyncClient]:
    async def _override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_user() -> User:
        return admin_user

    async def _bypass_rbac() -> User:
        return admin_user

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_current_user] = _override_user
    app.dependency_overrides[_require_rbac] = _bypass_rbac
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
    await api_client.post("/v1/permissions", json={"name": "perm.dup"})
    second = await api_client.post("/v1/permissions", json={"name": "perm.dup"})
    assert second.status_code == 409


async def test_create_permission_rejects_undotted_name(api_client: AsyncClient):
    response = await api_client.post("/v1/permissions", json={"name": "invalidname"})
    assert response.status_code == 422


async def test_create_permission_rejects_malformed_name(api_client: AsyncClient):
    response = await api_client.post("/v1/permissions", json={"name": "Has Spaces!"})
    assert response.status_code == 422


async def test_create_permission_rejects_empty_name(api_client: AsyncClient):
    response = await api_client.post("/v1/permissions", json={"name": ""})
    assert response.status_code == 422


async def test_update_permission(api_client: AsyncClient, db_session: AsyncSession):
    created = (
        await api_client.post(
            "/v1/permissions",
            json={"name": "perm.before", "description": "old"},
        )
    ).json()

    patched = await api_client.patch(
        f"/v1/permissions/{created['id']}",
        json={"name": "perm.after", "description": "new"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == "perm.after"
    assert body["description"] == "new"


async def test_update_permission_rejects_undotted_name(api_client: AsyncClient):
    created = (
        await api_client.post("/v1/permissions", json={"name": "perm.start"})
    ).json()
    response = await api_client.patch(
        f"/v1/permissions/{created['id']}", json={"name": "invalidname"}
    )
    assert response.status_code == 422


async def test_delete_permission(api_client: AsyncClient, db_session: AsyncSession):
    created = (
        await api_client.post("/v1/permissions", json={"name": "perm.doomed"})
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
    p1 = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
    p2 = (await api_client.post("/v1/permissions", json={"name": "perm.b"})).json()

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

    rp = (await db_session.execute(select(RolePermission))).scalars().all()
    assert len(rp) == 2


async def test_create_role_from_template_copies_permissions(
    api_client: AsyncClient,
):
    p1 = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
    p2 = (await api_client.post("/v1/permissions", json={"name": "perm.b"})).json()
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
    tmpl = (await api_client.post("/v1/roles", json={"name": "template"})).json()
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
    p = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
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
    p1 = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
    p2 = (await api_client.post("/v1/permissions", json={"name": "perm.b"})).json()
    p3 = (await api_client.post("/v1/permissions", json={"name": "perm.c"})).json()
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
    p = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
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
    p = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
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
    user = (await api_client.post("/v1/users", json={"username": "alice"})).json()
    await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [role["id"]]}
    )

    deleted = await api_client.delete(f"/v1/roles/{role['id']}")
    assert deleted.status_code == 204

    remaining = (await db_session.execute(select(UserRole))).scalars().all()
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
    user = (await api_client.post("/v1/users", json={"username": "alex"})).json()
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
    user = (await api_client.post("/v1/users", json={"username": "doomed"})).json()
    deleted = await api_client.delete(f"/v1/users/{user['id']}")
    assert deleted.status_code == 204
    remaining = (
        await db_session.execute(select(User).where(User.username == "doomed"))
    ).scalar_one_or_none()
    assert remaining is None


async def test_delete_user_refuses_self(api_client: AsyncClient, admin_user: User):
    response = await api_client.delete(f"/v1/users/{admin_user.id}")
    assert response.status_code == 400
    assert "your own" in response.json()["detail"]


# ----- regression: case-insensitive uniqueness ----------------------------
#
# Permission names are forced lowercase by PERMISSION_NAME_PATTERN, so the
# case-insensitive _name_taken check is dead code for that model (it stays
# in place for symmetry). Roles and usernames have no shape constraint and
# are the realistic collision surfaces.


async def test_role_name_collision_is_case_insensitive(api_client: AsyncClient):
    await api_client.post("/v1/roles", json={"name": "Owner"})
    second = await api_client.post("/v1/roles", json={"name": "owner"})
    assert second.status_code == 409


async def test_role_rename_collision_returns_409(api_client: AsyncClient):
    a = (await api_client.post("/v1/roles", json={"name": "alpha"})).json()
    (await api_client.post("/v1/roles", json={"name": "bravo"})).json()
    patched = await api_client.patch(f"/v1/roles/{a['id']}", json={"name": "Bravo"})
    assert patched.status_code == 409


async def test_username_collision_is_case_insensitive(api_client: AsyncClient):
    await api_client.post("/v1/users", json={"username": "Dup"})
    second = await api_client.post("/v1/users", json={"username": "DUP"})
    assert second.status_code == 409


# ----- regression: updated_at + null/[] semantics --------------------------


async def test_update_role_permissions_only_bumps_updated_at(
    api_client: AsyncClient,
):
    p = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
    role = (await api_client.post("/v1/roles", json={"name": "alpha"})).json()
    before = role["updated_at"]

    patched = await api_client.patch(
        f"/v1/roles/{role['id']}", json={"permission_ids": [p["id"]]}
    )
    after = patched.json()["updated_at"]
    assert after > before


async def test_update_role_null_permission_ids_keeps_existing(
    api_client: AsyncClient,
):
    p = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
    role = (
        await api_client.post(
            "/v1/roles", json={"name": "alpha", "permission_ids": [p["id"]]}
        )
    ).json()

    patched = await api_client.patch(
        f"/v1/roles/{role['id']}", json={"permission_ids": None}
    )
    assert patched.status_code == 200
    assert patched.json()["permission_ids"] == [p["id"]]


# ----- regression: stable ordering ----------------------------------------


async def test_list_roles_permission_ids_sorted_by_name(
    api_client: AsyncClient,
):
    pb = (await api_client.post("/v1/permissions", json={"name": "perm.b"})).json()
    pa = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()
    pc = (await api_client.post("/v1/permissions", json={"name": "perm.c"})).json()

    role = (
        await api_client.post(
            "/v1/roles",
            json={
                "name": "r",
                # Intentionally out-of-order on the wire.
                "permission_ids": [pb["id"], pa["id"], pc["id"]],
            },
        )
    ).json()

    listing = (await api_client.get("/v1/roles")).json()
    fetched = next(r for r in listing if r["id"] == role["id"])
    assert fetched["permission_ids"] == [pa["id"], pb["id"], pc["id"]]


async def test_list_users_role_ids_sorted_by_role_name(
    api_client: AsyncClient,
):
    rz = (await api_client.post("/v1/roles", json={"name": "zeta"})).json()
    ra = (await api_client.post("/v1/roles", json={"name": "alpha"})).json()
    user = (await api_client.post("/v1/users", json={"username": "ordered"})).json()
    await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [rz["id"], ra["id"]]}
    )
    listing = (await api_client.get("/v1/users")).json()
    fetched = next(u for u in listing if u["id"] == user["id"])
    assert fetched["role_ids"] == [ra["id"], rz["id"]]
