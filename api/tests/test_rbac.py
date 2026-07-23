import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import (
    League,
    Permission,
    Role,
    RolePermission,
    Tournament,
    User,
    UserRole,
)
from app.rbac import _require_rbac
from app.roles import DEFAULT_ROLE_NAME, converge_default_role
from app.sessions import get_current_user
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_ENTER, TOURNAMENT_VIEW
from scripts import seed_rbac
from tests._helpers import CSRF_EVENT_HOOKS

BETA_TESTER = "Beta tester"
MCP_ACCESS = "mcp.access"


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
        transport=transport,
        base_url="https://testserver",
        event_hooks=CSRF_EVENT_HOOKS,
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
    # The seeded default role (ADR-0016) is always present; ignore it here.
    assert [r["name"] for r in rows if r["name"] != DEFAULT_ROLE_NAME] == [
        "alpha",
        "bravo",
    ]
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
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    role = (await api_client.post("/v1/roles", json={"name": "doomed"})).json()
    user = (await api_client.post("/v1/users", json={"username": "alice"})).json()
    await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [role["id"]]}
    )

    deleted = await api_client.delete(f"/v1/roles/{role['id']}")
    assert deleted.status_code == 204

    # Deleting the doomed role cascades away its grant; the default `User` role
    # the PUT retained (ADR-0016) is all that remains.
    remaining = (await db_session.execute(select(UserRole))).scalars().all()
    assert [r.role_id for r in remaining] == [default_role.id]


async def test_delete_default_role_is_refused(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """Deleting the default role would cascade its grants away (ADR-0016)."""
    # A real user, so there is a real `user_roles` grant to lose.
    await api_client.post("/v1/users", json={"username": "alice"})
    grants_before = len((await db_session.execute(select(UserRole))).scalars().all())
    assert grants_before == 1

    refused = await api_client.delete(f"/v1/roles/{default_role.id}")
    assert refused.status_code == 400
    assert refused.json()["detail"] == (
        f'The "{DEFAULT_ROLE_NAME}" role is held by everyone on the platform '
        "and cannot be deleted. You can change the permissions it grants "
        "instead."
    )

    # The role survives …
    listed = (await api_client.get("/v1/roles")).json()
    assert [r["name"] for r in listed] == [DEFAULT_ROLE_NAME]
    # … and so does every grant of it.
    grants_after = (await db_session.execute(select(UserRole))).scalars().all()
    assert len(grants_after) == grants_before
    assert grants_after[0].role_id == default_role.id


async def test_update_default_role_permissions_is_allowed(
    api_client: AsyncClient, default_role: Role
):
    """The whole point of the default role: hang a permission off it."""
    perm = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()

    patched = await api_client.patch(
        f"/v1/roles/{default_role.id}",
        json={"permission_ids": [perm["id"]], "description": "now grants perm.a"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["permission_ids"] == [perm["id"]]
    assert body["description"] == "now grants perm.a"


async def test_update_default_role_allows_an_unchanged_name_in_the_body(
    api_client: AsyncClient, default_role: Role
):
    """The admin UI PATCHes the whole role — a no-op name is not a rename."""
    perm = (await api_client.post("/v1/permissions", json={"name": "perm.a"})).json()

    patched = await api_client.patch(
        f"/v1/roles/{default_role.id}",
        json={
            "name": DEFAULT_ROLE_NAME,
            "description": "still the default",
            "permission_ids": [perm["id"]],
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == DEFAULT_ROLE_NAME
    assert body["description"] == "still the default"
    assert body["permission_ids"] == [perm["id"]]


async def test_rename_default_role_is_refused(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """Renaming the default role would break guest-mint's lookup (ADR-0016)."""
    refused = await api_client.patch(
        f"/v1/roles/{default_role.id}", json={"name": "Peasant"}
    )
    assert refused.status_code == 400
    assert refused.json()["detail"] == (
        f'The "{DEFAULT_ROLE_NAME}" role is held by everyone on the platform '
        "and cannot be renamed. You can change the permissions it grants and "
        "its description."
    )

    await db_session.refresh(default_role)
    assert default_role.name == DEFAULT_ROLE_NAME
    fetched = (await api_client.get(f"/v1/roles/{default_role.id}")).json()
    assert fetched["name"] == DEFAULT_ROLE_NAME


async def test_list_roles_flags_only_the_default_role(
    api_client: AsyncClient, default_role: Role
):
    """`is_default` is derived from the name, so exactly one role carries it."""
    await api_client.post("/v1/roles", json={"name": "Beta tester"})
    await api_client.post("/v1/roles", json={"name": "Administrator"})

    rows = (await api_client.get("/v1/roles")).json()
    assert {r["name"]: r["is_default"] for r in rows} == {
        DEFAULT_ROLE_NAME: True,
        "Beta tester": False,
        "Administrator": False,
    }


async def test_get_role_flags_the_default_role(
    api_client: AsyncClient, default_role: Role
):
    other = (await api_client.post("/v1/roles", json={"name": "Beta tester"})).json()

    fetched_default = (await api_client.get(f"/v1/roles/{default_role.id}")).json()
    assert fetched_default["is_default"] is True

    fetched_other = (await api_client.get(f"/v1/roles/{other['id']}")).json()
    assert fetched_other["is_default"] is False


async def test_create_and_update_responses_carry_is_default(
    api_client: AsyncClient, default_role: Role
):
    """The client never sees a role payload without the flag — write paths too."""
    created = await api_client.post("/v1/roles", json={"name": "Beta tester"})
    assert created.status_code == 201
    assert created.json()["is_default"] is False

    patched = await api_client.patch(
        f"/v1/roles/{default_role.id}", json={"description": "still the default"}
    )
    assert patched.status_code == 200
    assert patched.json()["is_default"] is True


# ----- users ---------------------------------------------------------------


async def test_create_and_list_users(api_client: AsyncClient, default_role: Role):
    created = await api_client.post("/v1/users", json={"username": "ada"})
    assert created.status_code == 201
    body = created.json()
    assert body["username"] == "ada"
    # A user minted through the admin door holds the default role, like every
    # other user (ADR-0016) — and the response says so.
    assert body["role_ids"] == [str(default_role.id)]

    rows = (await api_client.get("/v1/users")).json()
    assert any(u["username"] == "ada" for u in rows)


async def test_create_user_grants_the_default_role_and_nothing_else(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    created = (await api_client.post("/v1/users", json={"username": "ada"})).json()

    role_ids = (
        await db_session.execute(
            select(UserRole.role_id).where(UserRole.user_id == uuid.UUID(created["id"]))
        )
    ).scalars()
    assert list(role_ids) == [default_role.id]


async def test_create_user_raises_when_the_default_role_is_missing(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """A missing seed row is a broken deployment: mint loudly fails (500) rather
    than quietly producing a role-less user (ADR-0016)."""
    await db_session.delete(default_role)
    await db_session.commit()

    with pytest.raises(RuntimeError, match=DEFAULT_ROLE_NAME):
        await api_client.post("/v1/users", json={"username": "ada"})

    # The mint raised before committing, so no role-less user was left behind.
    await db_session.rollback()
    orphan = (
        await db_session.execute(select(User).where(User.username == "ada"))
    ).scalar_one_or_none()
    assert orphan is None


async def test_create_user_rejects_duplicate(api_client: AsyncClient):
    await api_client.post("/v1/users", json={"username": "dup"})
    second = await api_client.post("/v1/users", json={"username": "dup"})
    assert second.status_code == 409


async def test_set_user_roles_replaces_assignments(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    user = (await api_client.post("/v1/users", json={"username": "alex"})).json()
    r1 = (await api_client.post("/v1/roles", json={"name": "one"})).json()
    r2 = (await api_client.post("/v1/roles", json={"name": "two"})).json()

    response = await api_client.put(
        f"/v1/users/{user['id']}/roles",
        json={"role_ids": [r1["id"], r2["id"]]},
    )
    assert response.status_code == 200
    # r1 and r2 are set exactly; the default role is retained alongside them.
    assert set(response.json()["role_ids"]) == {
        r1["id"],
        r2["id"],
        str(default_role.id),
    }

    # r2 is genuinely removed — the default role is the only extra that survives.
    response = await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [r1["id"]]}
    )
    assert set(response.json()["role_ids"]) == {r1["id"], str(default_role.id)}
    rows = (await db_session.execute(select(UserRole))).scalars().all()
    assert {r.role_id for r in rows} == {uuid.UUID(r1["id"]), default_role.id}


async def test_set_user_roles_rejects_unknown_role(api_client: AsyncClient):
    user = (await api_client.post("/v1/users", json={"username": "u"})).json()
    response = await api_client.put(
        f"/v1/users/{user['id']}/roles",
        json={"role_ids": ["00000000-0000-0000-0000-000000000000"]},
    )
    assert response.status_code == 400


async def test_set_user_roles_empty_body_retains_the_default_role(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """A full-replace PUT that omits the default role must not strip it: everyone
    holds `User` (ADR-0016), and the endpoint is the backstop behind the disabled
    UI checkbox. Silently retained, not a 4xx."""
    user = (await api_client.post("/v1/users", json={"username": "alex"})).json()
    other = (await api_client.post("/v1/roles", json={"name": "other"})).json()
    await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [other["id"]]}
    )

    response = await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": []}
    )
    assert response.status_code == 200
    # The response reflects the retained role …
    assert response.json()["role_ids"] == [str(default_role.id)]
    # … and so does the database.
    rows = (
        (
            await db_session.execute(
                select(UserRole).where(UserRole.user_id == uuid.UUID(user["id"]))
            )
        )
        .scalars()
        .all()
    )
    assert [r.role_id for r in rows] == [default_role.id]


async def test_set_user_roles_retains_default_alongside_a_partial_body(
    api_client: AsyncClient, default_role: Role
):
    """A body naming only some non-default roles still leaves the user holding
    `User` — and the other role is set exactly as asked."""
    user = (await api_client.post("/v1/users", json={"username": "alex"})).json()
    other = (await api_client.post("/v1/roles", json={"name": "other"})).json()

    response = await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [other["id"]]}
    )
    assert response.status_code == 200
    assert set(response.json()["role_ids"]) == {other["id"], str(default_role.id)}


async def test_set_user_roles_does_not_duplicate_an_explicit_default_role(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """A caller that *does* include the default role gets one grant, not two."""
    user = (await api_client.post("/v1/users", json={"username": "alex"})).json()

    response = await api_client.put(
        f"/v1/users/{user['id']}/roles",
        json={"role_ids": [str(default_role.id)]},
    )
    assert response.status_code == 200
    assert response.json()["role_ids"] == [str(default_role.id)]
    rows = (
        (
            await db_session.execute(
                select(UserRole).where(UserRole.user_id == uuid.UUID(user["id"]))
            )
        )
        .scalars()
        .all()
    )
    assert [r.role_id for r in rows] == [default_role.id]


async def test_set_user_roles_raises_when_the_default_role_is_missing(
    api_client: AsyncClient, db_session: AsyncSession, default_role: Role
):
    """A missing seed row is a broken deployment: the endpoint hard-fails (500)
    rather than quietly producing a user without `User` (ADR-0016), mirroring
    `grant_default_role` / admin user-mint."""
    user = (await api_client.post("/v1/users", json={"username": "alex"})).json()
    # Drop the grant then the role so the delete isn't blocked by the FK.
    await db_session.execute(
        delete(UserRole).where(UserRole.role_id == default_role.id)
    )
    await db_session.delete(default_role)
    await db_session.commit()

    with pytest.raises(RuntimeError, match=DEFAULT_ROLE_NAME):
        await api_client.put(f"/v1/users/{user['id']}/roles", json={"role_ids": []})


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


async def test_delete_user_with_activity_returns_409(
    api_client: AsyncClient, db_session: AsyncSession, default_league: League
):
    """A user referenced by an ON DELETE RESTRICT FK (e.g. a tournament they
    created) can't be hard-deleted — the route must turn the IntegrityError
    into a clean 409 instead of a raw 500 (#751)."""
    user = (await api_client.post("/v1/users", json={"username": "doomed"})).json()
    db_session.add(
        Tournament(
            name="Doomed Open",
            address={},
            # NOT NULL since ADR-0783: a tournament names the ladder it is judged
            # on. Which one is immaterial here, so it is the default.
            league_id=default_league.id,
            created_by_user_id=uuid.UUID(user["id"]),
        )
    )
    await db_session.commit()

    response = await api_client.delete(f"/v1/users/{user['id']}")
    assert response.status_code == 409
    assert "activity" in response.json()["detail"]

    remaining = (
        await db_session.execute(select(User).where(User.username == "doomed"))
    ).scalar_one_or_none()
    assert remaining is not None


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
    api_client: AsyncClient, default_role: Role
):
    rz = (await api_client.post("/v1/roles", json={"name": "zeta"})).json()
    ra = (await api_client.post("/v1/roles", json={"name": "alpha"})).json()
    user = (await api_client.post("/v1/users", json={"username": "ordered"})).json()
    await api_client.put(
        f"/v1/users/{user['id']}/roles", json={"role_ids": [rz["id"], ra["id"]]}
    )
    listing = (await api_client.get("/v1/users")).json()
    fetched = next(u for u in listing if u["id"] == user["id"])
    # The user also holds the retained default role (ADR-0016); filter it out so
    # this stays a test of the ORDER BY Role.name sort, not of collation.
    non_default = [rid for rid in fetched["role_ids"] if rid != str(default_role.id)]
    assert non_default == [ra["id"], rz["id"]]


# ----- the RBAC seed script (scripts/seed_rbac.py) -------------------------
#
# The seed runs on every container boot (see the api command in the compose
# files), so "grants what it should" and "inserts nothing on a re-run" are both
# load-bearing.


async def _role_permission_names(db: AsyncSession, role_name: str) -> list[str]:
    names = (
        (
            await db.execute(
                select(Permission.name)
                .join(RolePermission, RolePermission.permission_id == Permission.id)
                .join(Role, Role.id == RolePermission.role_id)
                .where(Role.name == role_name)
            )
        )
        .scalars()
        .all()
    )
    return sorted(names)


async def test_seed_grants_beta_tester_the_tournament_permissions(
    db_session: AsyncSession,
):
    """A freshly seeded database lets a Beta tester enter a tournament as well
    as view and create one — self-registration is gated on its own permission
    (#781), since a player entering themselves is not the tournament's owner.
    The bundle also carries `mcp.access` so early-access testers can connect an
    agent to the MCP server."""
    counts = await seed_rbac.upsert_rbac(db_session)
    await db_session.commit()
    assert counts.permissions == len(seed_rbac.PERMISSIONS)
    assert counts.roles == len(seed_rbac.ROLES)

    granted = await _role_permission_names(db_session, BETA_TESTER)
    assert granted == sorted(
        [TOURNAMENT_VIEW, TOURNAMENT_CREATE, TOURNAMENT_ENTER, MCP_ACCESS]
    )


async def test_seed_is_idempotent(db_session: AsyncSession):
    """Re-running the seed (every boot does) inserts nothing the second time."""
    await seed_rbac.upsert_rbac(db_session)
    await db_session.commit()

    second = await seed_rbac.upsert_rbac(db_session)
    await db_session.commit()
    assert second == seed_rbac.SeedCounts(permissions=0, roles=0, links=0)

    perms = (
        (
            await db_session.execute(
                select(Permission).where(Permission.name == TOURNAMENT_ENTER)
            )
        )
        .scalars()
        .all()
    )
    assert len(perms) == 1

    links = (
        (
            await db_session.execute(
                select(RolePermission).where(
                    RolePermission.permission_id == perms[0].id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(links) == 1
    assert await _role_permission_names(db_session, BETA_TESTER) == sorted(
        [TOURNAMENT_VIEW, TOURNAMENT_CREATE, TOURNAMENT_ENTER, MCP_ACCESS]
    )


async def test_seed_does_not_grant_tournament_permissions_to_the_default_role(
    db_session: AsyncSession,
):
    """Every user holds the default `User` role (ADR-0016), so it must stay a
    zero-permission lever — seeding `tournament.enter` must not hand tournament
    access to the entire population. Beta tester is the opt-in bundle."""
    await seed_rbac.upsert_rbac(db_session)
    await converge_default_role(db_session)
    await db_session.commit()

    assert await _role_permission_names(db_session, DEFAULT_ROLE_NAME) == []
