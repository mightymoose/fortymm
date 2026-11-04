"""The built-in permissions, which the code checks, and the ids of roles.

Admins add other permissions as rows of the `permissions` table. A built-in
one is a row with `built_in` set, which no admin can delete.
tests/services/test_roles.py fails if the built-in rows and `Permission`
differ, so a new check in code needs a migration that adds its row.
"""

from enum import Enum, StrEnum
from typing import NewType
from uuid import UUID

RoleId = NewType("RoleId", UUID)


class Permission(StrEnum):
    ADMIN_VIEW = "admin.view"
    ROLES_MANAGE = "roles.manage"
    ACCOUNT_ROLES_MANAGE = "account_roles.manage"
    SIGNING_KEYS_REVOKE = "signing_keys.revoke"
    MATCHES_CREATE = "matches.create"


class Reach(Enum):
    """What a permission lets an account do. The default role, which every
    account holds, guests too, may grant only features."""

    ADMINISTRATION = "administration"
    FEATURE = "feature"


# Every built-in permission, so a new one fails a test until someone decides
# whether every guest may hold it. A custom permission is a feature.
REACH: dict[Permission, Reach] = {
    Permission.ADMIN_VIEW: Reach.ADMINISTRATION,
    Permission.ROLES_MANAGE: Reach.ADMINISTRATION,
    Permission.ACCOUNT_ROLES_MANAGE: Reach.ADMINISTRATION,
    Permission.SIGNING_KEYS_REVOKE: Reach.ADMINISTRATION,
    Permission.MATCHES_CREATE: Reach.FEATURE,
}

ADMINISTRATIVE = frozenset(
    permission for permission, reach in REACH.items() if reach is Reach.ADMINISTRATION
)
