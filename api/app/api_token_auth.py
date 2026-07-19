"""Shared bearer-token → user resolver for personal API tokens (issue #1130).

The single place that turns a raw ``api``-context bearer token into the live
``User`` behind it: ``hash_token(raw)`` → ``User`` joined to its ``UserToken``
where ``context == API_TOKEN_CONTEXT`` and the user is not tombstoned. Router-free
(no FastAPI imports) so both the HTTP bearer path (``app.sessions`` — the
``Authorization: Bearer`` header) and the FastMCP ``TokenVerifier`` (the ``/mcp``
transport, see the shared-services ADR) resolve tokens through exactly this
function and can never drift.

Lives alongside ``app/token_hashing.py`` (the router-free home for the hasher it
calls) rather than in either router.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserToken
from app.token_hashing import hash_token

# Context for personal, opaque API bearer tokens a user mints for external
# tooling (issue #1130). Namespaced like every other credential type so the
# api-tokens flow can rotate/resolve its own rows without touching a user's
# session / login / email-change / merge tokens. Owned here so the mint endpoint
# (app/api_tokens.py), the bearer-auth path (app/sessions.py), and the MCP
# verifier all import one definition. ``app.sessions`` re-exports it for callers
# that historically imported it from there.
API_TOKEN_CONTEXT = "api"


async def find_api_token_user(db: AsyncSession, raw_token: str) -> User | None:
    """Resolve the live ``api``-context ``User`` behind a raw bearer token, or
    ``None`` when the token matches no ``api``-context row or that row's user is
    tombstoned.

    ``raw_token`` is the credential already parsed out of any transport framing
    (the ``Bearer <token>`` header for HTTP, the token the MCP verifier is
    handed) — this function owns only the ``hash_token`` → lookup step. The token
    is compared by sha256 hash, never in plaintext. Tombstoned (merged-away)
    users are excluded in the query — ``merged_into_user_id IS NOT NULL`` — so a
    bearer token for a folded-in guest simply doesn't resolve, the same way the
    auth-layer session queries keep ghosts from surfacing.
    """
    result = await db.execute(
        select(User)
        .join(UserToken, UserToken.user_id == User.id)
        .where(
            UserToken.token == hash_token(raw_token),
            UserToken.context == API_TOKEN_CONTEXT,
            User.merged_into_user_id.is_(None),
        )
    )
    return result.scalar_one_or_none()
