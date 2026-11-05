"""The built-in permissions, which the code checks, and the ids of roles.

Admins add other permissions as rows of the `permissions` table. A built-in
one is a row with `built_in` set, which no admin can delete.
tests/services/test_roles.py fails if the built-in rows and `Permission`
differ, so a new check in code needs a migration that adds its row.
"""

from enum import StrEnum
from typing import NewType
from uuid import UUID

RoleId = NewType("RoleId", UUID)


class Permission(StrEnum):
    ADMIN_VIEW = "admin.view"
    ROLES_MANAGE = "roles.manage"
    ACCOUNT_ROLES_MANAGE = "account_roles.manage"
    SIGNING_KEYS_REVOKE = "signing_keys.revoke"
    MATCHES_CREATE = "matches.create"
    MATCHES_VIEW = "matches.view"
    PLAYERS_VIEW = "players.view"
    MATCHES_OVERRIDE = "matches.override"
    MATCHES_SCORE = "matches.score"
