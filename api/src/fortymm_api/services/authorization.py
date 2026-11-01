"""What an account may do: the permissions its roles grant."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, CurrentAccount, GuestAccount
from fortymm_api.models import AccountRole, RolePermission
from fortymm_api.permissions import Permission


class MissingPermission(Exception):
    """The account's roles don't grant the permission. `create_app()` answers
    403."""


def permissions_of(session: Session, account: AccountId) -> frozenset[str]:
    """The key of every permission that one of the account's roles grants,
    built-in or not."""
    keys = session.scalars(
        select(RolePermission.permission_key)
        .join(AccountRole, AccountRole.role_id == RolePermission.role_id)
        .where(AccountRole.account_id == account)
        .distinct()
    )
    return frozenset(keys)


def authorize(
    session: Session, account: CurrentAccount, permission: Permission
) -> None:
    """Raise MissingPermission unless the account holds the permission. A
    guest account holds none."""
    if isinstance(account, GuestAccount) or permission not in permissions_of(
        session, account.id
    ):
        raise MissingPermission
