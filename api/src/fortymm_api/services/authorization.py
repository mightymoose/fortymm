"""What an account may do: the permissions its roles grant.

Every account holds the default role, guests too, with no account_roles
row. Only a verified account holds the roles in account_roles.
"""

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, CurrentAccount
from fortymm_api.models import Account, AccountRole, Role, RolePermission
from fortymm_api.permissions import Permission


class MissingPermission(Exception):
    """The account's roles don't grant the permission. `create_app()` answers
    403."""


def permissions_of(session: Session, account: AccountId) -> frozenset[str]:
    """The key of every permission that the default role or one of the
    account's roles grants, built-in or not. A guest's account_roles rows
    grant nothing."""
    held = (
        select(AccountRole.role_id)
        .join(Account, Account.id == AccountRole.account_id)
        .where(AccountRole.account_id == account, Account.email.is_not(None))
    )
    keys = session.scalars(
        select(RolePermission.permission_key)
        .join(Role, Role.id == RolePermission.role_id)
        .where(or_(Role.is_default, RolePermission.role_id.in_(held)))
        .distinct()
    )
    return frozenset(keys)


def authorize(
    session: Session, account: CurrentAccount, permission: Permission
) -> None:
    """Raise MissingPermission unless the account holds the permission."""
    if permission not in permissions_of(session, account.id):
        raise MissingPermission
