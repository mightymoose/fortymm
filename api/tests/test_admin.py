"""The HTTP layer of the admin routes. tests/services/test_roles.py covers the
rules."""

import hashlib
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from match_setup import add_match, add_player
from sqlalchemy import Engine, text
from sqlalchemy.orm import sessionmaker

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.main import create_app
from fortymm_api.matches import MatchId
from fortymm_api.services.matches import MatchDetails
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
                    "matches.override",
                    "matches.view",
                    "players.view",
                    "roles.manage",
                    "signing_keys.revoke",
                ],
                "account_count": 1,
                "default": False,
            },
            {
                "id": user_role(migrated_database),
                "name": "User",
                "description": "Every new account gets this role, guests too.",
                "permissions": [],
                "account_count": 1,
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


def guest_with_player(database: Engine, display_name: str) -> str:
    with database.begin() as connection:
        account = connection.scalar(
            text("INSERT INTO accounts DEFAULT VALUES RETURNING id")
        )
        connection.execute(
            text(
                "WITH player AS ("
                " INSERT INTO players (display_name) VALUES (:name) RETURNING id)"
                " INSERT INTO player_managers (player_id, account_id, relationship)"
                " SELECT id, :account, 'self' FROM player"
            ),
            {"name": display_name, "account": account},
        )
    return str(account)


def without_dates(account: dict[str, Any]) -> dict[str, Any]:
    assert {"created_at", "last_seen_at"} <= account.keys()
    return {
        key: value
        for key, value in account.items()
        if key not in {"created_at", "last_seen_at"}
    }


def test_lists_the_accounts(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.get("/v1/admin/accounts", params={"search": "ANN"})

    body = response.json()
    assert [without_dates(account) for account in body["data"]] == [
        {
            "id": admin["id"],
            "kind": "verified",
            "email": "ann@example.com",
            "display_name": admin["player"]["display_name"],
            "match_count": 0,
            "role_ids": sorted(
                [administrator(migrated_database), user_role(migrated_database)]
            ),
        }
    ]
    assert body["meta"] == {"has_more": False}


def test_lists_the_guests(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    guest = guest_with_player(migrated_database, "curious crane 512")

    response = client.get(
        "/v1/admin/accounts", params={"view": "guests", "search": "CRANE"}
    )

    assert [without_dates(account) for account in response.json()["data"]] == [
        {
            "id": guest,
            "kind": "guest",
            "email": None,
            "display_name": "curious crane 512",
            "match_count": 0,
            "role_ids": [],
        }
    ]


def test_gets_an_account(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    response = client.get(f"/v1/admin/accounts/{admin['id']}")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["kind"] == "verified"
    assert data["email"] == "ann@example.com"
    assert data["display_name"] == admin["player"]["display_name"]
    assert data["match_count"] == 0
    assert {"created_at", "last_seen_at"} <= data.keys()
    assert [(role["id"], role["name"], role["held"]) for role in data["roles"]] == [
        (administrator(migrated_database), "Administrator", True),
        (user_role(migrated_database), "User", True),
    ]


def test_gets_a_guest_account(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    guest = guest_with_player(migrated_database, "curious crane 512")

    response = client.get(f"/v1/admin/accounts/{guest}")

    assert response.status_code == 200
    data = response.json()["data"]
    assert (data["kind"], data["email"]) == ("guest", None)


def test_an_adopted_account_is_not_found(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    guest = guest_with_player(migrated_database, "curious crane 512")
    with migrated_database.begin() as connection:
        connection.execute(
            text("UPDATE accounts SET adopted_into = :admin WHERE id = :guest"),
            {"admin": admin["id"], "guest": guest},
        )

    response = client.get(f"/v1/admin/accounts/{guest}")

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "No account has this id"}]
    }


def test_lists_the_players(client: TestClient, admin: dict[str, Any]) -> None:
    player = admin["player"]

    response = client.get(
        "/v1/admin/players", params={"name": player["display_name"].upper()}
    )

    assert response.json() == {
        "data": [
            {
                "id": player["id"],
                "display_name": player["display_name"],
                "account_id": admin["id"],
                "account_email": "ann@example.com",
                "manager_count": 1,
            }
        ],
        "meta": {"has_more": False},
    }


def test_gets_a_player(client: TestClient, admin: dict[str, Any]) -> None:
    player = admin["player"]

    response = client.get(f"/v1/admin/players/{player['id']}")

    assert response.status_code == 200
    data = response.json()["data"]
    assert "created_at" in data
    del data["created_at"]
    assert data == {
        "id": player["id"],
        "display_name": player["display_name"],
        "merged_into": None,
        "merged_into_display_name": None,
        "match_count": 0,
        "managers": [
            {
                "id": admin["id"],
                "email": "ann@example.com",
                "relationship": "self",
                "open_question": False,
            }
        ],
        "leagues": ["FortyMM"],
    }


def test_an_unknown_player_is_not_found(
    client: TestClient, admin: dict[str, Any]
) -> None:
    response = client.get(f"/v1/admin/players/{UUID(int=0)}")

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "No player has this id"}]
    }


def test_sets_an_accounts_roles(
    client: TestClient, admin: dict[str, Any], migrated_database: Engine
) -> None:
    role = administrator(migrated_database)

    response = client.put(
        f"/v1/admin/accounts/{admin['id']}/roles", json={"role_ids": [role]}
    )

    assert response.status_code == 200
    assert response.json()["data"]["role_ids"] == [role]


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


MATCH = "01970000-0000-7000-8000-0000000000c1"
OVERRIDE = f"/v1/admin/matches/{MATCH}/override"


@pytest.fixture
def match(admin: dict[str, Any], migrated_database: Engine) -> str:
    """A rated best of 3 between the admin's player and Bea, with no result."""
    with sessionmaker(migrated_database).begin() as session:
        ann = PlayerId(UUID(admin["player"]["id"]))
        details = MatchDetails(3, True, (ann, add_player(session)))
        add_match(session, MatchId(UUID(MATCH)), details)
    return MATCH


def test_an_override_answers_201_with_the_result(
    client: TestClient, match: str
) -> None:
    body = {"games": [[11, 3], [11, 4]], "ending": "completed", "reason": "Sheet"}

    response = client.post(OVERRIDE, headers=JSON, json=body)

    assert response.status_code == 201
    data = response.json()["data"]
    assert data == {
        "hash": data["hash"],
        "match_id": match,
        "accepted_at": data["accepted_at"],
    }


def test_overriding_needs_matches_override(
    client: TestClient, viewer: dict[str, Any]
) -> None:
    body = {"games": [[11, 3], [11, 4]], "ending": "completed", "reason": "Sheet"}

    response = client.post(OVERRIDE, headers=JSON, json=body)

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_overriding_an_unknown_match_is_not_found(
    client: TestClient, admin: dict[str, Any]
) -> None:
    body = {"games": [[11, 3], [11, 4]], "ending": "completed", "reason": "Sheet"}

    response = client.post(OVERRIDE, headers=JSON, json=body)

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "No match has this id"}]
    }


def test_an_illegal_override_answers_422_in_the_errors_shape(
    client: TestClient, match: str
) -> None:
    body = {"games": [[11, 3], [11, 10]], "ending": "completed", "reason": "Sheet"}

    response = client.post(OVERRIDE, headers=JSON, json=body)

    assert response.status_code == 422
    assert response.json() == {
        "errors": [
            {"status": "422", "title": "The scores aren't a legal ending to the match"}
        ]
    }


def test_a_retirement_names_who_retired(client: TestClient, match: str) -> None:
    body = {"games": [[11, 3]], "ending": "retired", "reason": "Sheet"}

    response = client.post(OVERRIDE, headers=JSON, json=body)

    assert response.status_code == 422
    assert "detail" in response.json()
