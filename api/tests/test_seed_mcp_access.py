"""The RBAC seed grants `mcp.access` to Beta testers and nobody else by default.

Proves the ADR-decided default (20260722 — "The MCP server is an OAuth Resource
Server trusting Auth0"): a fresh or re-seeded deploy hands MCP access to the
opt-in "Beta tester" bundle only, and the seed stays idempotent.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Permission, Role, RolePermission
from scripts import seed_rbac

MCP_ACCESS = "mcp.access"
BETA_TESTER = "Beta tester"


async def _role_permission_names(db: AsyncSession, role_name: str) -> set[str]:
    names = (
        (
            await db.execute(
                select(Permission.name)
                .join(RolePermission, RolePermission.permission_id == Permission.id)
                .join(Role, Role.id == RolePermission.role_id)
                .where(Role.name == role_name)
            )
        )
        .scalars()
        .all()
    )
    return set(names)


async def test_seed_creates_the_mcp_access_permission(db_session: AsyncSession):
    """The `mcp.access` permission row exists after a seed run."""
    await seed_rbac.upsert_rbac(db_session)
    await db_session.commit()

    perm = (
        await db_session.execute(
            select(Permission).where(Permission.name == MCP_ACCESS)
        )
    ).scalar_one_or_none()
    assert perm is not None
    assert perm.description == "Connect an agent to the MCP server over Auth0 OAuth."


async def test_seed_grants_mcp_access_to_beta_tester_only(db_session: AsyncSession):
    """The Beta tester bundle holds `mcp.access` (via a `RolePermission` link);
    no other seeded role does — MCP stays deliberately gated, not open to all."""
    await seed_rbac.upsert_rbac(db_session)
    await db_session.commit()

    assert MCP_ACCESS in await _role_permission_names(db_session, BETA_TESTER)

    for role_name, _, _ in seed_rbac.ROLES:
        if role_name == BETA_TESTER:
            continue
        assert MCP_ACCESS not in await _role_permission_names(db_session, role_name)


async def test_seed_mcp_access_is_idempotent(db_session: AsyncSession):
    """A second seed run inserts nothing: the permission, the role, and the grant
    are all left untouched (every boot re-runs the seed)."""
    await seed_rbac.upsert_rbac(db_session)
    await db_session.commit()

    second = await seed_rbac.upsert_rbac(db_session)
    await db_session.commit()
    assert second == seed_rbac.SeedCounts(permissions=0, roles=0, links=0)

    perms = (
        (
            await db_session.execute(
                select(Permission).where(Permission.name == MCP_ACCESS)
            )
        )
        .scalars()
        .all()
    )
    assert len(perms) == 1

    links = (
        (
            await db_session.execute(
                select(RolePermission).where(
                    RolePermission.permission_id == perms[0].id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(links) == 1
    assert MCP_ACCESS in await _role_permission_names(db_session, BETA_TESTER)
