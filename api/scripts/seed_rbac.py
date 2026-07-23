"""Seed the RBAC bootstrap data this change introduces.

Idempotent: re-runs insert only the rows that aren't already present. Safe to
run against UAT/prod on every container boot — the dev and UAT compose files
chain it into the api command after `alembic upgrade head`.
"""

import asyncio
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_engine
from app.models import Permission, Role, RolePermission
from app.roles import converge_default_role

PERMISSIONS = [
    ("administration.view", "Open the Administration area and see the overview."),
    ("authorization.manage", "Manage roles, permissions, and user role assignments."),
    ("tournament.view", "See the tournament list and tournament details."),
    ("tournament.create", "Create a new tournament."),
    ("tournament.enter", "Enter a tournament event as a player."),
    ("notifications.broadcast", "Send broadcast notifications to players."),
    ("scheduling.view", "See the schedule-solve ledger in the Administration area."),
    ("mcp.access", "Connect an agent to the MCP server over Auth0 OAuth."),
]

# The default `User` role is *not* listed here: it carries no permissions and
# every user holds it, so `app.roles.converge_default_role` owns both its row
# and the grants. Roles below are opt-in bundles an admin assigns by hand.
ROLES = [
    (
        "Administrator",
        "Sees the Administration area and manages roles, permissions, and user assignments.",
        [
            "administration.view",
            "authorization.manage",
            "notifications.broadcast",
            "scheduling.view",
        ],
    ),
    (
        "Beta tester",
        "Early-access testers who can view, create, and enter tournaments. Editing,"
        " publishing, and deleting a tournament is reserved for its creator.",
        ["tournament.view", "tournament.create", "tournament.enter", "mcp.access"],
    ),
]


class SeedCounts(NamedTuple):
    """How many rows a seed run actually inserted. All zero on a re-run."""

    permissions: int
    roles: int
    links: int


async def upsert_rbac(db: AsyncSession) -> SeedCounts:
    """Insert the permissions, roles, and grants above that ``db`` lacks.

    Idempotent: rows already present are left untouched, so a re-run inserts
    nothing and returns all-zero counts. Caller commits.

    Scoped to the opt-in bundles in ``ROLES``. The default ``User`` role every
    user holds is *not* one of them — ``seed()`` converges that separately, via
    ``app.roles.converge_default_role``.
    """
    perms_by_name: dict[str, Permission] = {
        p.name: p
        for p in (
            await db.execute(
                select(Permission).where(
                    Permission.name.in_([n for n, _ in PERMISSIONS])
                )
            )
        )
        .scalars()
        .all()
    }

    created_perms = 0
    for name, desc in PERMISSIONS:
        if name in perms_by_name:
            continue
        p = Permission(name=name, description=desc)
        db.add(p)
        perms_by_name[name] = p
        created_perms += 1

    roles_by_name: dict[str, Role] = {
        r.name: r
        for r in (
            await db.execute(
                select(Role).where(Role.name.in_([n for n, _, _ in ROLES]))
            )
        )
        .scalars()
        .all()
    }

    created_roles = 0
    for name, desc, _ in ROLES:
        if name in roles_by_name:
            continue
        r = Role(name=name, description=desc)
        db.add(r)
        roles_by_name[name] = r
        created_roles += 1

    await db.flush()

    existing_links = {
        (row.role_id, row.permission_id)
        for row in (
            await db.execute(
                select(RolePermission).where(
                    RolePermission.role_id.in_([r.id for r in roles_by_name.values()])
                )
            )
        )
        .scalars()
        .all()
    }

    added_links = 0
    for name, _, perm_names in ROLES:
        role = roles_by_name[name]
        for pn in perm_names:
            perm = perms_by_name[pn]
            if (role.id, perm.id) in existing_links:
                continue
            db.add(RolePermission(role_id=role.id, permission_id=perm.id))
            added_links += 1

    return SeedCounts(permissions=created_perms, roles=created_roles, links=added_links)


async def seed() -> None:
    engine = get_engine()
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as db:
        counts = await upsert_rbac(db)
        convergence = await converge_default_role(db)
        await db.commit()
        print(
            f"Seed complete: +{counts.permissions} permissions, "
            f"+{counts.roles + int(convergence.role_created)} roles, "
            f"+{counts.links} role/permission links, "
            f"+{convergence.grants_added} default-role grants."
        )


if __name__ == "__main__":
    asyncio.run(seed())
