"""Shared Auth0 ``sub`` → linked ``User`` resolver.

The single place that turns an Auth0 subject identifier (the ``sub`` claim of a
verified token) into the live ``User`` that explicitly linked it: ``User`` where
``auth0_sub == sub`` and the user is not tombstoned. Router-free (no FastAPI
imports) so the MCP OAuth Resource-Server verifier (the ``/mcp`` transport, see
``docs/adr/20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0.md``)
resolves every subject through exactly this function and can never drift.

Mirrors ``app/api_token_auth.py::find_api_token_user`` — the same router-free,
importable shape and the same tombstone exclusion — since both are shared
identity resolvers behind the MCP surface.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User


async def resolve_linked_user(db: AsyncSession, sub: str) -> User | None:
    """Resolve the live ``User`` whose ``auth0_sub`` matches ``sub``, or ``None``
    when no live user linked that subject.

    ``sub`` is the subject identifier already parsed out of a verified Auth0
    token — this function owns only the ``auth0_sub`` → user lookup. Tombstoned
    (merged-away) users are excluded in the query — ``merged_into_user_id IS
    NULL`` — so a subject linked to a folded-in guest simply doesn't resolve,
    the same way the auth-layer session queries keep ghosts from surfacing.

    The one-to-one link invariant (``users.auth0_sub`` is unique) means at most
    one row can match, so this returns exactly the one live user that linked
    ``sub`` and nobody otherwise.
    """
    result = await db.execute(
        select(User).where(
            User.auth0_sub == sub,
            User.merged_into_user_id.is_(None),
        )
    )
    return result.scalar_one_or_none()
