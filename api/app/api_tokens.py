"""Personal, opaque API bearer tokens (issue #1130).

A user with ``api_token.manage`` mints a single long-lived token to paste into
external tooling. The raw token is shown exactly once at creation and only its
sha256 hash is stored, so it can never be recovered from the database — the same
handling every other credential in ``app/sessions.py`` gets.

Kept off ``app/rbac.py`` deliberately: that router is gated on
``authorization.manage``; this endpoint needs ``api_token.manage``. The mint
logic lives in ``rotate_api_token`` so the HTTP handler stays a thin
parse/call/shape layer (see ``api/CLAUDE.md`` — module layout).
"""

import secrets
import uuid

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User, UserToken
from app.rbac import require_permission
from app.sessions import API_TOKEN_CONTEXT
from app.token_hashing import hash_token

API_TOKEN_PERMISSION = "api_token.manage"

# Module-level so tests can bypass the gate via ``dependency_overrides`` if they
# need to, mirroring ``app.rbac._require_rbac``.
_require_api_token_manage = require_permission(API_TOKEN_PERMISSION)

router = APIRouter(prefix="/v1")


class ApiTokenCreated(BaseModel):
    """The freshly minted raw token. Returned exactly once."""

    token: str


async def rotate_api_token(db: AsyncSession, user_id: uuid.UUID) -> str:
    """Rotate ``user_id``'s API token: hard-delete their existing ``api``-context
    ``UserToken`` rows, mint a fresh opaque token, and store its hash.

    The delete is scoped to ``context == API_TOKEN_CONTEXT`` so it never touches
    the user's session / login / email-change / merge tokens — those live under
    their own contexts. Enforces single-active-token by construction.

    Returns the raw token (only ever held in memory here); the caller hands it
    straight to the response and nothing persists it in plaintext.
    """
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user_id,
            UserToken.context == API_TOKEN_CONTEXT,
        )
    )
    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user_id,
            context=API_TOKEN_CONTEXT,
            token=hash_token(raw_token),
        )
    )
    await db.commit()
    return raw_token


@router.post(
    "/api-tokens",
    response_model=ApiTokenCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_api_token(
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(_require_api_token_manage),
) -> ApiTokenCreated:
    """Mint a personal API token for the caller and return it once.

    The response carries the raw token a single time — it is never shown again
    and cannot be recovered, so treat it like a password: copy it immediately
    and store it somewhere safe. Creating a token **rotates**: any existing API
    token for this user is revoked, so a user has at most one active token at a
    time. Requires the ``api_token.manage`` permission.
    """
    raw_token = await rotate_api_token(db, current_user.id)
    return ApiTokenCreated(token=raw_token)
