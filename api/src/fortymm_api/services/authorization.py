"""What an account may do: the permissions its roles grant."""

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, CurrentAccount
from fortymm_api.models import AccountRole, Role, RolePermission
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
    """Raise MissingPermission unless the account holds the permission."""
    if permission not in permissions_of(session, account.id):
        raise MissingPermission


def grant_default_roles(session: Session, account: AccountId) -> None:
    """Give a new account every default role. Whatever creates an account,
    a guest or a verified one, calls it once, right after.

    KEY SHARE on each role keeps a role delete from slipping between the read
    and the insert.
    """
    roles = session.scalars(
        select(Role.id).where(Role.is_default).with_for_update(key_share=True)
    ).all()
    if roles:
        session.execute(
            insert(AccountRole).values(
                [{"account_id": account, "role_id": role} for role in roles]
            )
        )
