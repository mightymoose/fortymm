"""The admin page's routes: permissions, the roles that grant them, the
accounts that hold the roles, every player, every account's signing keys,
and overriding a match's result."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Path, Request
from pydantic import BaseModel, Field, StringConstraints, model_validator

from fortymm_api.accounts import AccountId, CurrentAccount, PlayerId
from fortymm_api.auth import require_permission
from fortymm_api.database import DatabaseSession
from fortymm_api.matches import MatchId
from fortymm_api.permissions import Permission, RoleId
from fortymm_api.services import match_results, player_admin, roles, signing_keys
from fortymm_api.services.sessions import client_network
from fortymm_api.services.signing_keys import KeyState
from fortymm_api.signed_results import Completed, Ending, Retired
from fortymm_api.signing_keys import KeyId
from fortymm_api.v1.errors import (
    FORBIDDEN,
    NO_SESSION,
    UNSUPPORTED_MEDIA_TYPE,
    Responses,
    errors,
)
from fortymm_api.v1.session import client_address
from fortymm_api.v1.signing_keys import KEY_ID_PATTERN
from fortymm_api.v1.types import HexBytes

router = APIRouter(prefix="/admin", tags=["admin"])

AdminViewer = Annotated[CurrentAccount, require_permission(Permission.ADMIN_VIEW)]
RoleManager = Annotated[CurrentAccount, require_permission(Permission.ROLES_MANAGE)]
AccountRoleManager = Annotated[
    CurrentAccount, require_permission(Permission.ACCOUNT_ROLES_MANAGE)
]
SigningKeyRevoker = Annotated[
    CurrentAccount, require_permission(Permission.SIGNING_KEYS_REVOKE)
]
MatchOverrider = Annotated[
    CurrentAccount, require_permission(Permission.MATCHES_OVERRIDE)
]

READ_ERRORS: Responses = {**NO_SESSION, **FORBIDDEN}
WRITE_ERRORS: Responses = {**NO_SESSION, **FORBIDDEN, **UNSUPPORTED_MEDIA_TYPE}
NO_ROLE = errors(404, "No role has this id")
NAME_TAKEN = errors(409, "Another role has this name, whatever its case")
NO_PERMISSION = errors(404, "No permission has this key")


def invalid(description: str) -> Responses:
    """A 422 that replaces FastAPI's own, so it repeats its body. The
    refusals that `description` names are in the `errors` shape instead."""
    return {
        422: {
            "description": description,
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
                }
            },
        }
    }


INVALID_ROLE = invalid(
    "The body is invalid. If a permission key names no permission, the body is"
    " in the `errors` shape instead"
)
NO_ACCOUNT = errors(404, "No account has this id")
NO_KEY = errors(404, "No key has this id")
# This entry replaces FastAPI's own 422, so it repeats its body.
INVALID_OVERRIDE: Responses = {
    422: {
        "description": (
            "The body is invalid. If the reason is blank or the scores aren't a"
            " legal ending to the match, the body is in the `errors` shape"
            " instead"
        ),
        "content": {
            "application/json": {
                "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
            }
        },
    }
}
LAST_ADMINISTRATOR = errors(
    409,
    "The change would leave no account with `account_roles.manage`, so nobody"
    " could grant a role again",
)


class AdminPermission(BaseModel):
    key: str
    description: str
    # The code checks it, so it can't be deleted.
    built_in: bool
    # How many roles grant it.
    role_count: int


class AdminPermissionResponse(BaseModel):
    data: AdminPermission


Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class NewPermissionRequest(BaseModel):
    # Lowercase words of letters, digits and `_`, joined by dots, such as
    # `games.record`. It never changes.
    key: Annotated[
        str,
        StringConstraints(
            max_length=64, pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$"
        ),
    ]
    description: Description = ""


class PermissionRequest(BaseModel):
    description: Description = ""


class AdminPermissionsResponse(BaseModel):
    data: list[AdminPermission]


class AdminRole(BaseModel):
    id: UUID
    name: str
    description: str
    # The keys of the permissions it grants, sorted.
    permissions: list[str]
    # How many accounts hold it.
    account_count: int
    # A new account gets it, a guest too.
    default: bool


class AdminRolesResponse(BaseModel):
    data: list[AdminRole]


class AdminRoleResponse(BaseModel):
    data: AdminRole


class RoleRequest(BaseModel):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)
    ]
    description: Description = ""
    # The keys of the role's exact set of permissions.
    permissions: list[str]

    def draft(self) -> roles.RoleDraft:
        return roles.RoleDraft(self.name, self.description, frozenset(self.permissions))


class AdminAccountFields(BaseModel):
    id: UUID
    kind: Literal["guest", "verified"]
    # Null for a guest.
    email: str | None
    # The account's own player's name. Null for a moment after a sign-in
    # makes the account, until its first POST /v1/session.
    display_name: str | None
    created_at: datetime
    last_seen_at: datetime
    # The matches its own player played, with those of the players merged
    # into it. 0 with no player.
    match_count: int


class AdminAccount(AdminAccountFields):
    # The ids of the roles it holds, sorted.
    role_ids: list[UUID]


class AdminAccountsMeta(BaseModel):
    # More accounts match than `data` holds. Narrow `search` to see them.
    has_more: bool


class AdminAccountsResponse(BaseModel):
    data: list[AdminAccount]
    meta: AdminAccountsMeta


class AdminAccountResponse(BaseModel):
    data: AdminAccount


class AdminAccountRole(BaseModel):
    id: UUID
    name: str
    description: str
    # The account holds it.
    held: bool


class AdminAccountDetail(AdminAccountFields):
    # Every role, by name, with whether the account holds it.
    roles: list[AdminAccountRole]


class AdminAccountDetailResponse(BaseModel):
    data: AdminAccountDetail


class AccountRolesRequest(BaseModel):
    # The account's exact set of roles.
    role_ids: list[UUID]


class AdminKeyAccount(BaseModel):
    id: UUID
    email: str | None
    display_name: str | None


class AdminSigningKey(BaseModel):
    id: HexBytes
    label: str
    created_at: datetime
    state: KeyState
    signed_out_at: datetime | None
    revoked_at: datetime | None
    # Flat rather than a nullable object, because the schema has no `anyOf`
    # with null (tests/test_openapi.py).
    revoked_by: UUID | None
    revoked_by_email: str | None
    account: AdminKeyAccount


class AdminSigningKeysMeta(BaseModel):
    has_more: bool


class AdminSigningKeysResponse(BaseModel):
    data: list[AdminSigningKey]
    meta: AdminSigningKeysMeta


class AdminSigningKeyResponse(BaseModel):
    data: AdminSigningKey


def permission_model(permission: roles.PermissionSummary) -> AdminPermission:
    return AdminPermission(
        key=permission.key,
        description=permission.description,
        built_in=permission.built_in,
        role_count=permission.role_count,
    )


def role_model(role: roles.RoleSummary) -> AdminRole:
    return AdminRole(
        id=role.id,
        name=role.name,
        description=role.description,
        permissions=list(role.permissions),
        account_count=role.account_count,
        default=role.default,
    )


def account_fields(account: roles.AdminAccount) -> dict[str, Any]:
    return {
        "id": account.account.id,
        "kind": account.account.kind,
        "email": account.account.email,
        "display_name": account.display_name,
        "created_at": account.created_at,
        "last_seen_at": account.last_seen_at,
        "match_count": account.match_count,
    }


def account_model(account: roles.AdminAccount) -> AdminAccount:
    return AdminAccount(**account_fields(account), role_ids=list(account.role_ids))


def signing_key_model(key: signing_keys.AdminSigningKey) -> AdminSigningKey:
    revocation = key.revocation
    return AdminSigningKey(
        id=key.id,
        label=key.label,
        created_at=key.created_at,
        state=key.state,
        signed_out_at=key.signed_out_at,
        revoked_at=revocation.at if revocation else None,
        revoked_by=revocation.by if revocation else None,
        revoked_by_email=revocation.by_email if revocation else None,
        account=AdminKeyAccount(
            id=key.account.id,
            email=key.account.email,
            display_name=key.account.display_name,
        ),
    )


@router.get("/permissions", responses=READ_ERRORS)
def admin_permissions(
    session: DatabaseSession, account: AdminViewer
) -> AdminPermissionsResponse:
    """List every permission by key, with how many roles grant it. Needs
    `admin.view`.

    A `built_in` permission is one the code checks, such as `admin.view`.
    """
    return AdminPermissionsResponse(
        data=[permission_model(found) for found in roles.list_permissions(session)]
    )


@router.post(
    "/permissions",
    status_code=201,
    responses={**WRITE_ERRORS, **errors(409, "Another permission has this key")},
)
def create_permission(
    session: DatabaseSession, account: RoleManager, body: NewPermissionRequest
) -> AdminPermissionResponse:
    """Add a permission that roles can grant. Needs `roles.manage`.

    Code that checks its key can come later. The key never changes.
    """
    created = roles.create_permission(session, account.id, body.key, body.description)
    return AdminPermissionResponse(data=permission_model(created))


@router.put("/permissions/{key}", responses={**WRITE_ERRORS, **NO_PERMISSION})
def update_permission(
    session: DatabaseSession, account: RoleManager, key: str, body: PermissionRequest
) -> AdminPermissionResponse:
    """Set the permission's description. Needs `roles.manage`."""
    updated = roles.update_permission(session, account.id, key, body.description)
    return AdminPermissionResponse(data=permission_model(updated))


@router.delete(
    "/permissions/{key}",
    status_code=204,
    responses={
        **WRITE_ERRORS,
        **NO_PERMISSION,
        **errors(409, "The permission is built in, because the code checks it"),
    },
)
def delete_permission(session: DatabaseSession, account: RoleManager, key: str) -> None:
    """Delete a permission. Every role that granted it loses it. Needs
    `roles.manage`. A built-in permission can't be deleted."""
    roles.delete_permission(session, account.id, key)


@router.get("/roles", responses=READ_ERRORS)
def admin_roles(session: DatabaseSession, account: AdminViewer) -> AdminRolesResponse:
    """List every role by name, with its permissions and how many accounts
    hold it. Needs `admin.view`."""
    return AdminRolesResponse(
        data=[role_model(role) for role in roles.list_roles(session)]
    )


@router.post(
    "/roles",
    status_code=201,
    responses={**WRITE_ERRORS, **NAME_TAKEN, **INVALID_ROLE},
)
def create_role(
    session: DatabaseSession, account: RoleManager, body: RoleRequest
) -> AdminRoleResponse:
    """Create a role with these permissions. Needs `roles.manage`.

    The name is trimmed, and two roles can't share one, whatever its case.
    A permission key that names no permission answers 422.
    """
    role = roles.create_role(session, account.id, body.draft())
    return AdminRoleResponse(data=role_model(role))


@router.put(
    "/roles/{role_id}",
    responses={
        **WRITE_ERRORS,
        **NO_ROLE,
        **INVALID_ROLE,
        **errors(
            409,
            "Another role has this name, or the change would leave no account"
            " with `account_roles.manage`",
        ),
    },
)
def update_role(
    session: DatabaseSession, account: RoleManager, role_id: UUID, body: RoleRequest
) -> AdminRoleResponse:
    """Set the role's name, description and exact set of permissions. Needs
    `roles.manage`.

    The API answers 409 if another role has the name, or if the change
    would leave no account with `account_roles.manage`.
    """
    role = roles.update_role(session, account.id, RoleId(role_id), body.draft())
    return AdminRoleResponse(data=role_model(role))


@router.delete(
    "/roles/{role_id}",
    status_code=204,
    responses={**WRITE_ERRORS, **NO_ROLE, **LAST_ADMINISTRATOR},
)
def delete_role(session: DatabaseSession, account: RoleManager, role_id: UUID) -> None:
    """Delete the role. Every account that held it loses it. Needs
    `roles.manage`.

    The API answers 409 if no account would keep `account_roles.manage`.
    """
    roles.delete_role(session, account.id, RoleId(role_id))


@router.get("/accounts", responses=READ_ERRORS)
def admin_accounts(
    session: DatabaseSession,
    account: AdminViewer,
    view: roles.AccountView = roles.AccountView.VERIFIED,
    search: str = "",
) -> AdminAccountsResponse:
    """List the accounts, with the roles each holds. Needs `admin.view`. An
    adopted account isn't listed.

    `view` picks the verified accounts, by email, the guests, or both, the
    longest unseen first. `search` keeps the accounts whose email or player
    name contains it, whatever its case. The list holds at most 50.
    `meta.has_more` says that more match.
    """
    page = roles.list_accounts(session, view, search)
    return AdminAccountsResponse(
        data=[account_model(found) for found in page.accounts],
        meta=AdminAccountsMeta(has_more=page.has_more),
    )


@router.get("/accounts/{account_id}", responses={**READ_ERRORS, **NO_ACCOUNT})
def admin_account(
    session: DatabaseSession, account: AdminViewer, account_id: UUID
) -> AdminAccountDetailResponse:
    """The account, a guest's too, with every role and whether it holds
    each, for its admin page. Needs `admin.view`."""
    found = roles.get_account(session, AccountId(account_id))
    return AdminAccountDetailResponse(
        data=AdminAccountDetail(
            **account_fields(found.account),
            roles=[
                AdminAccountRole(
                    id=role.id,
                    name=role.name,
                    description=role.description,
                    held=role.held,
                )
                for role in found.roles
            ],
        )
    )


@router.put(
    "/accounts/{account_id}/roles",
    responses={
        **WRITE_ERRORS,
        **errors(
            404,
            "No account has this id, it's a guest's, or a role doesn't exist",
        ),
        **LAST_ADMINISTRATOR,
    },
)
def set_account_roles(
    session: DatabaseSession,
    account: AccountRoleManager,
    account_id: UUID,
    body: AccountRolesRequest,
) -> AdminAccountResponse:
    """Give the account exactly these roles. Needs `account_roles.manage`.

    The account must be verified. The API answers 409 if no account would
    keep `account_roles.manage`, such as when the last administrator revokes
    their own role.
    """
    updated = roles.set_account_roles(
        session,
        account.id,
        AccountId(account_id),
        frozenset(RoleId(role) for role in body.role_ids),
    )
    return AdminAccountResponse(data=account_model(updated))


@router.get("/signing-keys", responses=READ_ERRORS)
def admin_signing_keys(
    session: DatabaseSession, account: AdminViewer, search: str = ""
) -> AdminSigningKeysResponse:
    """List every account's signing keys, guests' too, newest first, with
    each key's account and who revoked it. Needs `admin.view`.

    `search` keeps the keys whose account's email or player name contains
    it, whatever its case. The list holds at most 50. `meta.has_more` says
    that more match.
    """
    page = signing_keys.find_keys(session, search)
    return AdminSigningKeysResponse(
        data=[signing_key_model(key) for key in page.keys],
        meta=AdminSigningKeysMeta(has_more=page.has_more),
    )


@router.post("/signing-keys/{key_id}/revoke", responses={**WRITE_ERRORS, **NO_KEY})
def revoke_any_signing_key(
    session: DatabaseSession,
    account: SigningKeyRevoker,
    key_id: Annotated[str, Path(pattern=KEY_ID_PATTERN)],
) -> AdminSigningKeyResponse:
    """Revoke any account's signing key. Needs `signing_keys.revoke`.

    The key verifies nothing from now on, not even what it signed before.
    Results already accepted stay. The key's account stays signed in, and
    its device makes a new key at its next registration. Revoking a revoked
    key changes nothing.
    """
    key = signing_keys.revoke_any_key(session, account.id, KeyId(bytes.fromhex(key_id)))
    return AdminSigningKeyResponse(data=signing_key_model(key))


class AdminPlayer(BaseModel):
    id: UUID
    display_name: str
    # The account that plays as the player, if any. Its email is null for a
    # guest.
    account_id: UUID | None
    account_email: str | None
    # How many accounts manage it, the one that plays as it included.
    manager_count: int


class AdminPlayersMeta(BaseModel):
    # More players match than `data` holds. Narrow `name` to see them.
    has_more: bool


class AdminPlayersResponse(BaseModel):
    data: list[AdminPlayer]
    meta: AdminPlayersMeta


class AdminPlayerManager(BaseModel):
    id: UUID
    # Null for a guest.
    email: str | None
    # `self` plays as the player. `managed` manages it for someone else.
    relationship: Literal["self", "managed"]
    # The account hasn't answered "Is this you?" for the player yet.
    open_question: bool


class AdminPlayerDetail(BaseModel):
    id: UUID
    display_name: str
    created_at: datetime
    # The player it merged into, or null. Flat rather than a nullable
    # object, because the schema has no `anyOf` with null
    # (tests/test_openapi.py).
    merged_into: UUID | None
    merged_into_display_name: str | None
    # The matches it was named in, with a result or not, a player merged
    # into it's too.
    match_count: int
    # The account that plays as it first, then verified accounts by email,
    # then guests.
    managers: list[AdminPlayerManager]
    # The names of its leagues, sorted.
    leagues: list[str]


class AdminPlayerDetailResponse(BaseModel):
    data: AdminPlayerDetail


@router.get("/players", responses=READ_ERRORS)
def admin_players(
    session: DatabaseSession, account: AdminViewer, name: str | None = None
) -> AdminPlayersResponse:
    """List the players by display name, with the account that plays as
    each and how many accounts manage it. Needs `admin.view`. A merged
    player isn't listed.

    `name` keeps the players whose display name contains it, whatever its
    case. The list holds at most 50. `meta.has_more` says that more match.
    """
    page = player_admin.list_players(session, name)
    return AdminPlayersResponse(
        data=[
            AdminPlayer(
                id=player.id,
                display_name=player.display_name,
                account_id=player.account,
                account_email=player.account_email,
                manager_count=player.manager_count,
            )
            for player in page.players
        ],
        meta=AdminPlayersMeta(has_more=page.has_more),
    )


@router.get(
    "/players/{player_id}",
    responses={**READ_ERRORS, **errors(404, "No player has this id")},
)
def admin_player(
    session: DatabaseSession, account: AdminViewer, player_id: UUID
) -> AdminPlayerDetailResponse:
    """The player, merged or not, for its admin page: the accounts that
    manage it, its leagues and how many matches it was in. Needs
    `admin.view`."""
    found = player_admin.get_player(session, PlayerId(player_id))
    survivor = found.merged_into
    return AdminPlayerDetailResponse(
        data=AdminPlayerDetail(
            id=found.id,
            display_name=found.display_name,
            created_at=found.created_at,
            merged_into=survivor.id if survivor else None,
            merged_into_display_name=survivor.display_name if survivor else None,
            match_count=found.match_count,
            managers=[
                AdminPlayerManager(
                    id=manager.id,
                    email=manager.email,
                    relationship=manager.relationship,
                    open_question=manager.open_question,
                )
                for manager in found.managers
            ],
            leagues=list(found.leagues),
        )
    )


class OverrideRequest(BaseModel):
    # Each game's points, side 0's then side 1's, in the order played.
    games: Annotated[
        list[
            Annotated[
                list[Annotated[int, Field(ge=0)]], Field(min_length=2, max_length=2)
            ]
        ],
        Field(max_length=7),
    ]
    ending: Literal["completed", "retired"]
    # The side that retired, with a retirement only.
    retired_by: Literal[0, 1] | None = None
    # Why the administrator imposes the result. Trimmed, and not blank.
    reason: str

    @model_validator(mode="after")
    def retired_by_with_retired(self) -> OverrideRequest:
        if (self.ending == "retired") != (self.retired_by is not None):
            raise ValueError("retired_by comes with a retirement, and only then")
        return self

    def parsed_ending(self) -> Ending:
        return Completed() if self.retired_by is None else Retired(self.retired_by)


class OverriddenResult(BaseModel):
    # The SHA-256 of the payload the server encoded, the result's identity.
    hash: HexBytes
    match_id: UUID
    accepted_at: datetime | None


class OverrideResponse(BaseModel):
    data: OverriddenResult


@router.post(
    "/matches/{match_id}/override",
    status_code=201,
    responses={
        **WRITE_ERRORS,
        **errors(404, "No match has this id"),
        **INVALID_OVERRIDE,
    },
)
def override_match_result(
    session: DatabaseSession,
    request: Request,
    account: MatchOverrider,
    match_id: UUID,
    body: OverrideRequest,
) -> OverrideResponse:
    """Impose a result on the match, with a reason. Needs `matches.override`.

    The server encodes the scores as a result that replaces the match's
    newest one and counts at once, with no approvals. The match is final
    with it. A device still holding a result it replaced gets a 409, and
    players can still correct it the normal way.
    """
    recorded = match_results.override_result(
        session,
        MatchId(match_id),
        account.id,
        client_network(client_address(request)),
        tuple((first, second) for first, second in body.games),
        body.parsed_ending(),
        body.reason,
    )
    return OverrideResponse(
        data=OverriddenResult(
            hash=recorded.hash,
            match_id=recorded.match_id,
            accepted_at=recorded.accepted_at,
        )
    )
