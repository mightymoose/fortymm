"""The default role every user holds.

`User` is a lever, not a capability: it ships with zero permissions so that
granting something to the entire population later is one row in the admin UI
(add the permission to this role) rather than a migration or a code change.
See `docs/adr/0016-every-user-holds-the-default-user-role.md`.

The name is load-bearing — guest-mint looks the role up by it, and the
delete/rename guard defends it — so it lives here, in one constant, rather than
in the seed script.
"""

import uuid
from typing import NamedTuple

from sqlalchemy import literal, select
from sqlalchemy.dialects.postgresql import UUID, insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Role, User, UserRole

DEFAULT_ROLE_NAME = "User"
DEFAULT_ROLE_DESCRIPTION = (
    "Held by every user. Carries no permissions by default — add one here to "
    "grant it to the whole population, including anonymous visitors."
)


class DefaultRoleConvergence(NamedTuple):
    """What `converge_default_role` had to change to reach the invariant."""

    role_created: bool
    grants_added: int


async def get_default_role(db: AsyncSession) -> Role | None:
    result = await db.execute(select(Role).where(Role.name == DEFAULT_ROLE_NAME))
    return result.scalar_one_or_none()


async def grant_default_role(db: AsyncSession, user_id: uuid.UUID) -> Role:
    """Grant the default role to a freshly-minted user, returning the role.

    Called from the two places a ``users`` row is born — guest-mint
    (``app.sessions._create_session``) and admin create (``app.rbac.create_user``)
    — so "every user holds the default role" is true from the first instant of
    their existence. Purely additive: it adds one ``user_roles`` row and touches
    no other grant.

    **Raises** ``RuntimeError`` when the role row is missing, rather than
    soft-skipping. A missing seed row is a broken deployment: soft-skipping would
    mint a cohort of role-less users that nobody notices until a permission is
    hung off the role months later. Surfaces as a 500 — mirrors
    ``add_user_to_default_league``'s hard failure on a missing default league.

    Does not commit; the caller owns the surrounding transaction.
    """
    role = await get_default_role(db)
    if role is None:
        raise RuntimeError(
            f"No {DEFAULT_ROLE_NAME!r} role to grant. Run scripts/seed_rbac.py."
        )
    db.add(UserRole(user_id=user_id, role_id=role.id))
    return role


async def converge_default_role(db: AsyncSession) -> DefaultRoleConvergence:
    """Make two things true of `db`: the default role exists, and every user
    holds it.

    Idempotent — the role is located by name, and the backfill is a set-based
    `INSERT … SELECT … ON CONFLICT DO NOTHING`, so a second run adds no rows. It
    only ever *adds*: a user's other roles are left alone, and permissions an
    admin has since hung off the default role are not stripped (that would
    defeat the point of the lever).

    Does not commit; the caller owns the surrounding transaction.
    """
    role = await get_default_role(db)
    role_created = role is None
    if role is None:
        role = Role(name=DEFAULT_ROLE_NAME, description=DEFAULT_ROLE_DESCRIPTION)
        db.add(role)
        # The id is a Python-side default applied at flush; we read it below.
        await db.flush()

    role_id: uuid.UUID = role.id
    granted = await db.execute(
        insert(UserRole)
        .from_select(
            ["user_id", "role_id"],
            select(User.id, literal(role_id, type_=UUID(as_uuid=True))),
        )
        .on_conflict_do_nothing()
        .returning(UserRole.user_id)
    )
    return DefaultRoleConvergence(
        role_created=role_created,
        grants_added=len(granted.scalars().all()),
    )
