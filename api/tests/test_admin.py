"""The HTTP layer of the admin routes. tests/services/test_roles.py covers the
rules."""

import hashlib
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from fortymm_api.accounts import AccountId
from fortymm_api.main import create_app
from fortymm_api.signing_keys import SigningPrivateKey

JSON = {"Content-Type": "application/json"}
FORBIDDEN = {
    "errors": [{"status": "403", "title": "You don't have permission to do this"}]
}


@pytest.fixture
def client(
    migrated_database: Engine,
    throwaway_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    # The session cookie is Secure, so the client sends it only over https.
    with TestClient(
        create_app(), base_url="https://testserver", client=("203.0.113.7", 50000)
    ) as client:
        yield client


def administrator(database: Engine) -> str:
    with database.connect() as connection:
        return str(
            connection.scalar(text("SELECT id FROM roles WHERE name = 'Administrator'"))
        )


def user_role(database: Engine) -> str:
    with database.connect() as connection:
        return str(connection.scalar(text("SELECT id FROM roles WHERE is_default")))


@pytest.fixture
def admin(client: TestClient, migrated_database: Engine) -> dict[str, Any]:
    """The session's account, verified and holding Administrator."""
    account: dict[str, Any] = client.post("/v1/session", headers=JSON).json()["data"][
        "account"
    ]
    with migrated_database.begin() as connection:
        connection.execute(
            text("UPDATE accounts SET email = 'ann@example.com' WHERE id = :id"),
            {"id": account["id"]},
        )
        connection.execute(
            text(
                "INSERT INTO account_roles (account_id, role_id)"
                " SELECT :id, id FROM roles WHERE name = 'Administrator'"
            ),
            {"id": account["id"]},
        )
    return account


def test_needs_a_session(client: TestClient) -> None:
    response = client.get("/v1/admin/roles")

    assert response.status_code == 401


def test_a_guest_is_forbidden(client: TestClient) -> None:
    client.post("/v1/session", headers=JSON)

    response = client.get("/v1/admin/roles")

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_lists_the_permissions(client: TestClient, admin: dict[str, Any]) -> None:
    response = client.get("/v1/admin/permissions")

    assert response.status_code == 200
    assert response.json()["data"][0] == {
        "key": "account_roles.manage",
        "description": "Grant and revoke roles on accounts.",
        "built_in": True,
        "role_count": 1,
    }


def test_creates_a_permission(client: TestClient, admin: dict[str, Any]) -> None:
    response = client.post(
        "/v1/admin/permissions",
        json={"key": "games.record", "description": " Records a game. "},
    )

    assert response.status_code == 201
    assert response.json() == {
        "data": {
            "key": "games.record",
            "description": "Records a game.",
            "built_in": False,
            "role_count": 0,
        }
    }


@pytest.mark.parametrize("key", ["Games", "games.", "g" * 65])
def test_refuses_a_malformed_permission_key(
    client: TestClient, admin: dict[str, Any], key: str
) -> None:
    response = client.post("/v1/admin/permissions", json={"key": key})

    assert response.status_code == 422


def test_a_taken_permission_key_conflicts(
    client: TestClient, admin: dict[str, Any]
) -> None:
    response = client.post("/v1/admin/permissions", json={"key": "admin.view"})

    assert response.status_code == 409
    assert response.json() == {
        "errors": [{"status": "409", "title": "Another permission has this key"}]
    }


def test_updates_a_permission(client: TestClient, admin: dict[str, Any]) -> None:
    response = client.put(
        "/v1/admin/permissions/admin.view", json={"description": "Look around."}
    )

    assert response.status_code == 200
    assert response.json()["data"]["description"] == "Look around."


def test_a_built_in_permission_stays(client: TestClient, admin: dict[str, Any]) -> None:
    response = client.delete("/v1/admin/permissions/admin.view", headers=JSON)

    assert response.status_code == 409
    assert response.json() == {
        "errors": [
            {"status": "409", "title": "The code checks this permission, so it stays"}
        ]
    }


def test_deletes_a_permission(client: TestClient, admin: dict[str, Any]) -> None:
    client.post("/v1/admin/permissions", json={"key": "games.record"})

    response = client.delete("/v1/admin/permissions/games.record", headers=JSON)

    assert response.status_code == 204


def test_an_unknown_permission_in_a_role_is_unprocessable(
    client: TestClient, admin: dict[str, Any]
) -> None:
    response = client.post(
        "/v1/admin/roles", json={"name": "Coach", "permissions": ["games.record"]}
    )

    assert response.status_code == 422
    assert response.json() == {
        "errors": [{"status": "422", "title": "A permission in the role doesn't exist"}]
    }


def test_lists_the_roles(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.get("/v1/admin/roles")

    assert response.json() == {
        "data": [
            {
                "id": administrator(migrated_database),
                "name": "Administrator",
                "description": "Manages roles, permissions and who holds them.",
                "permissions": [
                    "account_roles.manage",
                    "admin.view",
                    "matches.create",
                    "roles.manage",
                    "signing_keys.revoke",
                ],
                "account_count": 1,
                "default": False,
            },
            {
                "id": user_role(migrated_database),
                "name": "User",
                "description": "Every account holds this role, guests too.",
                "permissions": [],
                "account_count": 0,
                "default": True,
            },
        ]
    }


def test_creates_a_role(client: TestClient, admin: dict[str, Any]) -> None:
    response = client.post(
        "/v1/admin/roles",
        headers=JSON,
        json={"name": "  Coach ", "permissions": ["admin.view"]},
    )

    assert response.status_code == 201
    assert response.json() == {
        "data": {
            "id": response.json()["data"]["id"],
            "name": "Coach",
            "description": "",
            "permissions": ["admin.view"],
            "account_count": 0,
            "default": False,
        }
    }


@pytest.mark.parametrize(
    "body",
    [
        {"name": "   ", "permissions": []},
        {"name": "x" * 51, "permissions": []},
    ],
)
def test_refuses_an_invalid_role(
    client: TestClient, admin: dict[str, Any], body: dict[str, object]
) -> None:
    response = client.post("/v1/admin/roles", headers=JSON, json=body)

    assert response.status_code == 422


def test_a_taken_name_conflicts(client: TestClient, admin: dict[str, Any]) -> None:
    response = client.post(
        "/v1/admin/roles",
        headers=JSON,
        json={"name": "administrator", "permissions": []},
    )

    assert response.status_code == 409
    assert response.json() == {
        "errors": [{"status": "409", "title": "Another role has this name"}]
    }


def test_updates_a_role(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    role = administrator(migrated_database)

    response = client.put(
        f"/v1/admin/roles/{role}",
        json={
            "name": "Admin",
            "description": "Runs it.",
            "permissions": ["account_roles.manage"],
        },
    )

    assert response.status_code == 200
    assert response.json()["data"] == {
        "id": role,
        "name": "Admin",
        "description": "Runs it.",
        "permissions": ["account_roles.manage"],
        "account_count": 1,
        "default": False,
    }


def test_the_default_role_granting_an_administrative_permission_is_unprocessable(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.put(
        f"/v1/admin/roles/{user_role(migrated_database)}",
        json={"name": "User", "permissions": ["admin.view"]},
    )

    assert response.status_code == 422
    assert response.json() == {
        "errors": [
            {
                "status": "422",
                "title": "Every account holds the default role, guests too, so it"
                " can't grant a permission that administers FortyMM",
            }
        ]
    }


def test_deleting_the_default_role_conflicts(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.delete(
        f"/v1/admin/roles/{user_role(migrated_database)}", headers=JSON
    )

    assert response.status_code == 409
    assert response.json() == {
        "errors": [
            {
                "status": "409",
                "title": "Every account holds the default role, so it stays",
            }
        ]
    }


def test_deleting_the_last_administrator_role_conflicts(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.delete(
        f"/v1/admin/roles/{administrator(migrated_database)}", headers=JSON
    )

    assert response.status_code == 409
    assert response.json() == {
        "errors": [
            {
                "status": "409",
                "title": "At least one account must keep the permission to grant roles",
            }
        ]
    }


def test_deletes_a_role(client: TestClient, admin: dict[str, Any]) -> None:
    created = client.post(
        "/v1/admin/roles", headers=JSON, json={"name": "Coach", "permissions": []}
    ).json()["data"]

    response = client.delete(f"/v1/admin/roles/{created['id']}", headers=JSON)

    assert response.status_code == 204
    assert response.content == b""


def test_an_unknown_role_is_not_found(
    client: TestClient, admin: dict[str, Any]
) -> None:
    response = client.delete(
        "/v1/admin/roles/00000000-0000-0000-0000-000000000000", headers=JSON
    )

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "The role doesn't exist"}]
    }


def test_lists_the_accounts(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.get("/v1/admin/accounts", params={"email": "ANN"})

    assert response.json() == {
        "data": [
            {
                "id": admin["id"],
                "email": "ann@example.com",
                "display_name": admin["player"]["display_name"],
                "role_ids": [administrator(migrated_database)],
            }
        ],
        "meta": {"has_more": False},
    }


def test_gets_an_account(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.get(f"/v1/admin/accounts/{admin['id']}")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["email"] == "ann@example.com"
    assert data["display_name"] == admin["player"]["display_name"]
    assert {"created_at", "last_seen_at"} <= data.keys()
    assert data["roles"] == [
        {
            "id": administrator(migrated_database),
            "name": "Administrator",
            "description": data["roles"][0]["description"],
            "held": True,
        }
    ]


def test_sets_an_accounts_roles(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    role = administrator(migrated_database)

    response = client.put(
        f"/v1/admin/accounts/{admin['id']}/roles", json={"role_ids": [role]}
    )

    assert response.status_code == 200
    assert response.json()["data"]["role_ids"] == [role]


def test_granting_the_default_role_is_unprocessable(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.put(
        f"/v1/admin/accounts/{admin['id']}/roles",
        json={"role_ids": [user_role(migrated_database)]},
    )

    assert response.status_code == 422
    assert response.json() == {
        "errors": [
            {
                "status": "422",
                "title": "Every account holds the default role, so nobody grants it",
            }
        ]
    }


def test_a_guest_account_is_not_found(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    with migrated_database.begin() as connection:
        guest = connection.scalar(
            text("INSERT INTO accounts DEFAULT VALUES RETURNING id")
        )

    response = client.put(f"/v1/admin/accounts/{guest}/roles", json={"role_ids": []})

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "No verified account has this id"}]
    }


KEY = SigningPrivateKey(hashlib.sha256(b"admin route test key").digest())
KID = KEY.public_key.kid.hex()


def register_key(client: TestClient, account: dict[str, Any]) -> None:
    response = client.post(
        "/v1/account/signing-keys",
        json={
            "public_key": KEY.public_key.to_cose_key().hex(),
            "proof": KEY.registration_proof(AccountId(UUID(account["id"]))).hex(),
            "label": "Ann's phone",
        },
    )
    assert response.status_code == 200


@pytest.fixture
def viewer(client: TestClient, migrated_database: Engine) -> dict[str, Any]:
    account: dict[str, Any] = client.post("/v1/session", headers=JSON).json()["data"][
        "account"
    ]
    with migrated_database.begin() as connection:
        connection.execute(
            text("UPDATE accounts SET email = 'vic@example.com' WHERE id = :id"),
            {"id": account["id"]},
        )
        role = connection.scalar(
            text("INSERT INTO roles (name) VALUES ('Viewer') RETURNING id")
        )
        connection.execute(
            text(
                "INSERT INTO role_permissions (role_id, permission_key)"
                " VALUES (:role, 'admin.view')"
            ),
            {"role": role},
        )
        connection.execute(
            text("INSERT INTO account_roles (account_id, role_id) VALUES (:id, :role)"),
            {"id": account["id"], "role": role},
        )
    return account


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/v1/admin/signing-keys"),
        ("POST", f"/v1/admin/signing-keys/{KID}/revoke"),
    ],
)
def test_the_signing_key_routes_need_a_session(
    client: TestClient, method: str, path: str
) -> None:
    response = client.request(method, path, headers=JSON)

    assert response.status_code == 401


def test_lists_the_signing_keys(client: TestClient, admin: dict[str, Any]) -> None:
    register_key(client, admin)

    response = client.get("/v1/admin/signing-keys", params={"search": "ANN@"})

    assert response.status_code == 200
    [key] = response.json()["data"]
    assert key == {
        "id": KID,
        "label": "Ann's phone",
        "created_at": key["created_at"],
        "state": "live",
        "signed_out_at": None,
        "revoked_at": None,
        "revoked_by": None,
        "revoked_by_email": None,
        "account": {
            "id": admin["id"],
            "email": "ann@example.com",
            "display_name": admin["player"]["display_name"],
        },
    }
    assert response.json()["meta"] == {"has_more": False}
    assert (
        client.get("/v1/admin/signing-keys", params={"search": "bob@"}).json()["data"]
        == []
    )


def test_listing_signing_keys_needs_admin_view(client: TestClient) -> None:
    client.post("/v1/session", headers=JSON)

    response = client.get("/v1/admin/signing-keys")

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_revokes_any_signing_key(client: TestClient, admin: dict[str, Any]) -> None:
    register_key(client, admin)

    response = client.post(f"/v1/admin/signing-keys/{KID}/revoke", headers=JSON)

    assert response.status_code == 200
    key = response.json()["data"]
    assert key["id"] == KID
    assert key["state"] == "revoked"
    assert key["revoked_at"] is not None
    assert key["revoked_by"] == admin["id"]
    assert key["revoked_by_email"] == "ann@example.com"


def test_revoking_needs_signing_keys_revoke(
    client: TestClient, viewer: dict[str, Any]
) -> None:
    register_key(client, viewer)

    assert client.get("/v1/admin/signing-keys").status_code == 200
    response = client.post(f"/v1/admin/signing-keys/{KID}/revoke", headers=JSON)

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_revoking_an_unknown_key_is_not_found(
    client: TestClient, admin: dict[str, Any]
) -> None:
    response = client.post(f"/v1/admin/signing-keys/{KID}/revoke", headers=JSON)

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "No key has this id"}]
    }


@pytest.mark.parametrize("key_id", [KID.upper(), KID[:-1]])
def test_a_revoke_path_that_is_not_a_kid_is_unprocessable(
    client: TestClient, admin: dict[str, Any], key_id: str
) -> None:
    response = client.post(f"/v1/admin/signing-keys/{key_id}/revoke", headers=JSON)

    assert response.status_code == 422


def test_a_revoke_without_json_is_unsupported(
    client: TestClient, admin: dict[str, Any]
) -> None:
    response = client.post(f"/v1/admin/signing-keys/{KID}/revoke")

    assert response.status_code == 415
