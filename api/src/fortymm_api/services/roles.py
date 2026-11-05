"""Roles, the permissions they grant, and the accounts that hold them.

A permission is a row of the `permissions` table. The built-in ones are the
members of `Permission`, which the code checks, and no admin can delete
them. Admins add the others, for code that checks their keys later.

An account holds the roles its account_roles rows name. A new account
starts with the default roles (`grant_default_roles()`), and after that
they are roles like any other.

An adopted account is never listed and holds nothing that counts: its
sessions are invalid, so it can never act.

Every write takes RBAC_LOCK, so two writes take turns. Under the lock, a
write checks that the acting account still holds the permission it needs,
and after it, that some account still holds `account_roles.manage`.
Otherwise nobody could grant a role again.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, assert_never

from sqlalchemy import (
    ColumnElement,
    and_,
    delete,
    func,
    insert,
    or_,
    select,
    true,
    update,
)
from sqlalchemy.dialects.postgresql import insert as upsert
from sqlalchemy.orm import Session

from fortymm_api.accounts import (
    AccountId,
    CurrentAccount,
    GuestAccount,
    VerifiedAccount,
)
from fortymm_api.models import (
    Account,
    AccountRole,
    EmailRoleGrant,
    Player,
    PlayerManager,
    Role,
    RolePermission,
    StoredPermission,
)
from fortymm_api.permissions import Permission, RoleId
from fortymm_api.services.authorization import MissingPermission, permissions_of
from fortymm_api.services.player_matches import played_matches
from fortymm_api.services.sessions import lock_account_for_write

# An advisory lock key outside int4, so it can't meet sign-in's
# hashtext(email) keys.
RBAC_LOCK = int.from_bytes(b"FMM RBAC")
ACCOUNT_PAGE_SIZE = 50
_NOT_ADOPTED = Account.adopted_into.is_(None)


class AccountView(StrEnum):
    """Which accounts the admin's list shows, and in what order."""

    VERIFIED = "verified"
    GUESTS = "guests"
    ALL = "all"


@dataclass(frozen=True)
class RoleDraft:
    """A role's fields, as a create or an update sets them."""

    name: str
    description: str
    # Permission keys.
    permissions: frozenset[str]


@dataclass(frozen=True)
class RoleSummary:
    id: RoleId
    name: str
    description: str
    # Permission keys, sorted.
    permissions: tuple[str, ...]
    # The accounts that hold it.
    account_count: int
    # A new account gets it.
    default: bool


@dataclass(frozen=True)
class PermissionSummary:
    key: str
    description: str
    # A member of `Permission`, which the code checks.
    built_in: bool
    # The roles that grant it.
    role_count: int


@dataclass(frozen=True)
class AdminAccount:
    account: CurrentAccount
    # The self player's name. None in the moment between a sign-in that
    # makes the account and its first POST /v1/session.
    display_name: str | None
    # Sorted.
    role_ids: tuple[RoleId, ...]
    created_at: datetime
    last_seen_at: datetime
    # The self player's matches, as `played_matches()` counts them. 0 with no
    # self player.
    match_count: int


@dataclass(frozen=True)
class AccountPage:
    accounts: list[AdminAccount]
    # More accounts match than the page holds.
    has_more: bool


@dataclass(frozen=True)
class RoleChoice:
    """A role, and whether one account holds it."""

    id: RoleId
    name: str
    description: str
    held: bool


@dataclass(frozen=True)
class AccountDetail:
    """What the admin page shows about one account."""

    account: AdminAccount
    # Every role, by name.
    roles: tuple[RoleChoice, ...]


class RoleNotFound(Exception):
    """No role has the id. `create_app()` answers 404."""


class AccountNotFound(Exception):
    """No account has the id, or it was adopted. `create_app()` answers
    404."""


class NotVerified(Exception):
    """The account is a guest's, whose roles an admin can't set.
    `create_app()` answers 404."""


class RoleNameTaken(Exception):
    """Another role has the name, whatever its case. `create_app()` answers
    409."""


class PermissionNotFound(Exception):
    """No permission has the key. `create_app()` answers 404."""


class UnknownPermission(Exception):
    """A role's permissions name a key that no permission has. `create_app()`
    answers 422."""


class PermissionKeyTaken(Exception):
    """Another permission has the key. `create_app()` answers 409."""


class BuiltInPermission(Exception):
    """The code checks the permission, so it can't be deleted.
    `create_app()` answers 409."""


class LastAdministrator(Exception):
    """The write would leave no account holding `account_roles.manage`.
    `create_app()` answers 409."""


def list_permissions(session: Session) -> list[PermissionSummary]:
    """Every permission, by key."""
    return _permissions(session)


def create_permission(
    session: Session, actor: AccountId, key: str, description: str
) -> PermissionSummary:
    """Add a permission that no code checks yet. `key` is lowercase words
    joined by dots, at most 64 characters, as the column's checks say."""
    _begin_write(session, actor, Permission.ROLES_MANAGE)
    added = session.scalar(
        upsert(StoredPermission)
        .values(key=key, description=description)
        .on_conflict_do_nothing()
        .returning(StoredPermission.key)
    )
    if added is None:
        raise PermissionKeyTaken
    return _permissions(session, StoredPermission.key == key)[0]


def update_permission(
    session: Session, actor: AccountId, key: str, description: str
) -> PermissionSummary:
    """Set the permission's description. Its key never changes, because code
    checks it by key."""
    _begin_write(session, actor, Permission.ROLES_MANAGE)
    updated = session.scalar(
        update(StoredPermission)
        .where(StoredPermission.key == key)
        .values(description=description)
        .returning(StoredPermission.key)
    )
    if updated is None:
        raise PermissionNotFound
    return _permissions(session, StoredPermission.key == key)[0]


def delete_permission(session: Session, actor: AccountId, key: str) -> None:
    """Delete a permission that isn't built in. Every role loses it."""
    _begin_write(session, actor, Permission.ROLES_MANAGE)
    built_in = session.scalar(
        select(StoredPermission.built_in).where(StoredPermission.key == key)
    )
    if built_in is None:
        raise PermissionNotFound
    if built_in:
        raise BuiltInPermission
    session.execute(delete(StoredPermission).where(StoredPermission.key == key))


def list_roles(session: Session) -> list[RoleSummary]:
    """Every role, by name whatever its case."""
    return _roles(session)


def create_role(session: Session, actor: AccountId, draft: RoleDraft) -> RoleSummary:
    _begin_write(session, actor, Permission.ROLES_MANAGE)
    _require_free_name(session, draft.name)
    role = session.execute(
        insert(Role)
        .values(name=draft.name, description=draft.description)
        .returning(Role.id)
    ).scalar_one()
    _grant_permissions(session, role, draft.permissions)
    return _roles(session, Role.id == role)[0]


def update_role(
    session: Session, actor: AccountId, role: RoleId, draft: RoleDraft
) -> RoleSummary:
    """Set the role's name, description and exact set of permissions."""
    _begin_write(session, actor, Permission.ROLES_MANAGE)
    if session.scalar(select(Role.id).where(Role.id == role)) is None:
        raise RoleNotFound
    _require_free_name(session, draft.name, besides=role)
    session.execute(
        update(Role)
        .where(Role.id == role)
        .values(name=draft.name, description=draft.description)
    )
    session.execute(delete(RolePermission).where(RolePermission.role_id == role))
    _grant_permissions(session, role, draft.permissions)
    _require_an_administrator(session)
    return _roles(session, Role.id == role)[0]


def delete_role(session: Session, actor: AccountId, role: RoleId) -> None:
    """Delete the role. Its accounts lose it, and its email grants go."""
    _begin_write(session, actor, Permission.ROLES_MANAGE)
    deleted = session.scalar(delete(Role).where(Role.id == role).returning(Role.id))
    if deleted is None:
        raise RoleNotFound
    _require_an_administrator(session)


def list_accounts(session: Session, view: AccountView, search: str) -> AccountPage:
    """The view's accounts whose email or self player's name contains
    `search`, whatever its case. At most ACCOUNT_PAGE_SIZE."""
    kind, order = _view(view)
    where = [kind]
    # A blank search adds nothing: strpos(NULL, '') is NULL, which would
    # leave out a guest with no player.
    if text := search.strip().lower():
        where.append(
            or_(
                func.strpos(Account.email, text) > 0,
                func.strpos(func.lower(Player.display_name), text) > 0,
            )
        )
    found = _accounts(session, *where, order=order, limit=ACCOUNT_PAGE_SIZE + 1)
    return AccountPage(
        found[:ACCOUNT_PAGE_SIZE], has_more=len(found) > ACCOUNT_PAGE_SIZE
    )


def get_account(session: Session, account: AccountId) -> AccountDetail:
    """The account, a guest's too, with every role and whether it holds
    each."""
    found = _accounts(session, Account.id == account)
    if not found:
        raise AccountNotFound
    summary = found[0]
    held = set(summary.role_ids)
    return AccountDetail(
        summary,
        tuple(
            RoleChoice(role.id, role.name, role.description, role.id in held)
            for role in _roles(session)
        ),
    )


def set_account_roles(
    session: Session, actor: AccountId, account: AccountId, roles: frozenset[RoleId]
) -> AdminAccount:
    """Give the verified account exactly these roles. A role it keeps keeps
    its grant time and granter. `actor` grants the new ones."""
    _begin_write(session, actor, Permission.ACCOUNT_ROLES_MANAGE)
    found = _accounts(session, Account.id == account)
    if not found:
        raise AccountNotFound
    if isinstance(found[0].account, GuestAccount):
        raise NotVerified
    known = session.scalar(
        select(func.count()).select_from(Role).where(Role.id.in_(roles))
    )
    if known != len(roles):
        raise RoleNotFound
    session.execute(
        delete(AccountRole).where(
            AccountRole.account_id == account, AccountRole.role_id.not_in(roles)
        )
    )
    if roles:
        session.execute(
            upsert(AccountRole)
            .values(
                [
                    {"account_id": account, "role_id": role, "granted_by": actor}
                    for role in roles
                ]
            )
            .on_conflict_do_nothing()
        )
    _require_an_administrator(session)
    return _accounts(session, Account.id == account)[0]


def claim_email_role_grants(session: Session, account: AccountId) -> None:
    """Give the account the roles waiting for its email, and delete those
    grants. A sign-in calls it for the account it ends on.

    KEY SHARE on each role keeps a role delete from slipping between the read
    and the insert. A role that a delete removed meanwhile is skipped.
    """
    email = session.scalar(select(Account.email).where(Account.id == account))
    if email is None:
        return
    roles = session.scalars(
        select(Role.id)
        .join(EmailRoleGrant, EmailRoleGrant.role_id == Role.id)
        .where(EmailRoleGrant.email == email)
        .with_for_update(of=Role, read=True, key_share=True)
    ).all()
    if roles:
        session.execute(
            upsert(AccountRole)
            .values([{"account_id": account, "role_id": role} for role in roles])
            .on_conflict_do_nothing()
        )
    session.execute(delete(EmailRoleGrant).where(EmailRoleGrant.email == email))


def _begin_write(session: Session, actor: AccountId, permission: Permission) -> None:
    """Take RBAC_LOCK, then check the actor's permission again. The route
    checked it before the lock, when another write could still revoke it."""
    lock_account_for_write(session, actor)
    session.execute(select(func.pg_advisory_xact_lock(RBAC_LOCK)))
    if permission not in permissions_of(session, actor):
        raise MissingPermission


def _require_free_name(
    session: Session, name: str, *, besides: RoleId | None = None
) -> None:
    query = select(Role.id).where(func.lower(Role.name) == func.lower(name))
    if besides is not None:
        query = query.where(Role.id != besides)
    if session.scalar(query.exists().select()):
        raise RoleNameTaken


def _grant_permissions(
    session: Session, role: RoleId, permissions: frozenset[str]
) -> None:
    """Raises UnknownPermission if a key names no permission. RBAC_LOCK
    keeps a permission delete from slipping between the check and the
    insert."""
    known = session.scalar(
        select(func.count())
        .select_from(StoredPermission)
        .where(StoredPermission.key.in_(permissions))
    )
    if known != len(permissions):
        raise UnknownPermission
    if permissions:
        session.execute(
            insert(RolePermission).values(
                [
                    {"role_id": role, "permission_key": permission}
                    for permission in permissions
                ]
            )
        )


def _require_an_administrator(session: Session) -> None:
    held = (
        select(AccountRole.account_id)
        .join(RolePermission, RolePermission.role_id == AccountRole.role_id)
        .join(Account, Account.id == AccountRole.account_id)
        .where(RolePermission.permission_key == Permission.ACCOUNT_ROLES_MANAGE)
        .where(_NOT_ADOPTED)
        .exists()
    )
    if not session.scalar(held.select()):
        raise LastAdministrator


def _roles(
    session: Session, where: ColumnElement[bool] | None = None
) -> list[RoleSummary]:
    permissions = (
        select(func.array_agg(RolePermission.permission_key))
        .where(RolePermission.role_id == Role.id)
        .scalar_subquery()
    )
    account_count = (
        select(func.count())
        .select_from(AccountRole)
        .join(Account, Account.id == AccountRole.account_id)
        .where(AccountRole.role_id == Role.id, _NOT_ADOPTED)
        .scalar_subquery()
    )
    query = select(
        Role.id,
        Role.name,
        Role.description,
        permissions,
        account_count,
        Role.is_default,
    ).order_by(func.lower(Role.name))
    if where is not None:
        query = query.where(where)
    return [
        RoleSummary(
            id,
            name,
            description,
            tuple(sorted(keys or ())),
            count,
            is_default,
        )
        for id, name, description, keys, count, is_default in session.execute(query)
    ]


def _permissions(
    session: Session, where: ColumnElement[bool] | None = None
) -> list[PermissionSummary]:
    role_count = (
        select(func.count())
        .where(RolePermission.permission_key == StoredPermission.key)
        .scalar_subquery()
    )
    query = select(
        StoredPermission.key,
        StoredPermission.description,
        StoredPermission.built_in,
        role_count,
    ).order_by(StoredPermission.key)
    if where is not None:
        query = query.where(where)
    return [
        PermissionSummary(key, description, built_in, count)
        for key, description, built_in, count in session.execute(query)
    ]


def _view(
    view: AccountView,
) -> tuple[ColumnElement[bool], tuple[ColumnElement[Any], ...]]:
    stalest_first = (Account.last_seen_at.asc(), Account.id.asc())
    match view:
        case AccountView.VERIFIED:
            return Account.email.is_not(None), (Account.email.asc(),)
        case AccountView.GUESTS:
            return Account.email.is_(None), stalest_first
        case AccountView.ALL:
            return true(), stalest_first
        case _:
            assert_never(view)


def _accounts(
    session: Session,
    *where: ColumnElement[bool],
    order: tuple[ColumnElement[Any], ...] = (),
    limit: int | None = None,
) -> list[AdminAccount]:
    role_ids = (
        select(func.array_agg(AccountRole.role_id))
        .where(AccountRole.account_id == Account.id)
        .scalar_subquery()
    )
    query = (
        select(
            Account.id,
            Account.email,
            Account.created_at,
            Account.last_seen_at,
            Player.id.label("player"),
            Player.display_name,
            role_ids,
        )
        .outerjoin(
            PlayerManager,
            and_(
                PlayerManager.account_id == Account.id,
                PlayerManager.relationship == "self",
            ),
        )
        .outerjoin(Player, Player.id == PlayerManager.player_id)
        .where(_NOT_ADOPTED, *where)
        .order_by(*order)
        .limit(limit)
    )
    rows = session.execute(query).all()
    matches = played_matches(
        session, [row.player for row in rows if row.player is not None]
    )
    return [
        AdminAccount(
            GuestAccount(id) if email is None else VerifiedAccount(id, email),
            display_name,
            tuple(sorted(roles or ())),
            created_at,
            last_seen_at,
            matches[player].count if player is not None else 0,
        )
        for id, email, created_at, last_seen_at, player, display_name, roles in rows
    ]
