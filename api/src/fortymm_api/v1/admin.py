"""The admin page's routes: permissions, the roles that grant them, and the
accounts that hold the roles."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, StringConstraints

from fortymm_api.accounts import AccountId, CurrentAccount
from fortymm_api.auth import require_permission
from fortymm_api.database import DatabaseSession
from fortymm_api.permissions import Permission, RoleId
from fortymm_api.services import roles
from fortymm_api.v1.errors import (
    FORBIDDEN,
    NO_SESSION,
    UNSUPPORTED_MEDIA_TYPE,
    Responses,
    errors,
)

router = APIRouter(prefix="/admin", tags=["admin"])

AdminViewer = Annotated[CurrentAccount, require_permission(Permission.ADMIN_VIEW)]
RoleManager = Annotated[CurrentAccount, require_permission(Permission.ROLES_MANAGE)]
AccountRoleManager = Annotated[
    CurrentAccount, require_permission(Permission.ACCOUNT_ROLES_MANAGE)
]

READ_ERRORS: Responses = {**NO_SESSION, **FORBIDDEN}
WRITE_ERRORS: Responses = {**NO_SESSION, **FORBIDDEN, **UNSUPPORTED_MEDIA_TYPE}
NO_ROLE = errors(404, "No role has this id")
NAME_TAKEN = errors(409, "Another role has this name, whatever its case")
NO_PERMISSION = errors(404, "No permission has this key")
# This entry replaces FastAPI's own 422, so it repeats its body.
INVALID_ROLE: Responses = {
    422: {
        "description": (
            "The body is invalid. If a permission key names no permission, the"
            " body is in the `errors` shape instead"
        ),
        "content": {
            "application/json": {
                "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
            }
        },
    }
}
NO_ACCOUNT = errors(404, "No verified account has this id")
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


class AdminAccount(BaseModel):
    id: UUID
    email: str
    # The account's own player's name. Null for a moment after a sign-in
    # makes the account, until its first POST /v1/session.
    display_name: str | None
    # The ids of the roles it holds, sorted.
    role_ids: list[UUID]


class AdminAccountsMeta(BaseModel):
    # More accounts match than `data` holds. Narrow `email` to see them.
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


class AdminAccountDetail(BaseModel):
    id: UUID
    email: str
    # As in AdminAccount.
    display_name: str | None
    created_at: datetime
    last_seen_at: datetime
    # Every role, by name, with whether the account holds it.
    roles: list[AdminAccountRole]


class AdminAccountDetailResponse(BaseModel):
    data: AdminAccountDetail


class AccountRolesRequest(BaseModel):
    # The account's exact set of roles.
    role_ids: list[UUID]


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
    )


def account_model(account: roles.AdminAccount) -> AdminAccount:
    return AdminAccount(
        id=account.id,
        email=account.email,
        display_name=account.display_name,
        role_ids=list(account.role_ids),
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
    session: DatabaseSession, account: AdminViewer, email: str | None = None
) -> AdminAccountsResponse:
    """List the verified accounts by email, with the roles each holds. Needs
    `admin.view`.

    `email` keeps the accounts whose email contains it, whatever its case.
    The list holds at most 50. `meta.has_more` says that more match.
    """
    page = roles.list_accounts(session, email)
    return AdminAccountsResponse(
        data=[account_model(found) for found in page.accounts],
        meta=AdminAccountsMeta(has_more=page.has_more),
    )


@router.get("/accounts/{account_id}", responses={**READ_ERRORS, **NO_ACCOUNT})
def admin_account(
    session: DatabaseSession, account: AdminViewer, account_id: UUID
) -> AdminAccountDetailResponse:
    """The verified account, with every role and whether it holds each, for
    its admin page. Needs `admin.view`."""
    found = roles.get_account(session, AccountId(account_id))
    return AdminAccountDetailResponse(
        data=AdminAccountDetail(
            id=found.id,
            email=found.email,
            display_name=found.display_name,
            created_at=found.created_at,
            last_seen_at=found.last_seen_at,
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
        **errors(404, "No verified account has this id, or a role doesn't exist"),
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

    Only a verified account holds roles. The API answers 409 if no account
    would keep `account_roles.manage`, such as when the last administrator
    revokes their own role.
    """
    updated = roles.set_account_roles(
        session,
        account.id,
        AccountId(account_id),
        frozenset(RoleId(role) for role in body.role_ids),
    )
    return AdminAccountResponse(data=account_model(updated))
