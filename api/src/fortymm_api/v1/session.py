from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Response
from pydantic import BaseModel
from sqlalchemy import func, update

from fortymm_api.accounts import CurrentAccount, GuestAccount
from fortymm_api.auth import (
    SESSION_COOKIE,
    SESSION_LIFETIME,
    SESSION_MAX_AGE,
    SessionToken,
    ValidSession,
    find_session,
    hash_token,
    new_token,
)
from fortymm_api.database import DatabaseSession
from fortymm_api.models import Account, AuthSession

router = APIRouter(tags=["session"])


class SessionAccount(BaseModel):
    id: UUID
    kind: Literal["guest", "verified"]


class SessionData(BaseModel):
    account: SessionAccount


class SessionResponse(BaseModel):
    data: SessionData


@router.post("/session")
def start_session(
    session: DatabaseSession, token: SessionToken, response: Response
) -> SessionResponse:
    """Resume the visitor's session, or start a guest account and its session.

    A valid session gets a later expiry and a fresh cookie. With no cookie, or
    a cookie for an expired, unknown or adopted session, the visitor gets a
    new guest account. The API deletes the session that cookie named.
    """
    found = find_session(session, token, lock=True)
    account: CurrentAccount
    if isinstance(found, ValidSession) and token is not None:
        account = found.account
        found.row.expires_at = func.now() + SESSION_LIFETIME
        session.execute(
            update(Account)
            .where(Account.id == account.id)
            .values(last_seen_at=func.now())
        )
    else:
        if found is not None:
            session.delete(found.row)
        guest = Account()
        session.add(guest)
        session.flush()
        token = new_token()
        session.add(
            AuthSession(
                token_hash=hash_token(token),
                account_id=guest.id,
                expires_at=func.now() + SESSION_LIFETIME,
            )
        )
        account = GuestAccount(guest.id)

    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_MAX_AGE,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )
    kind: Literal["guest", "verified"] = (
        "guest" if isinstance(account, GuestAccount) else "verified"
    )
    return SessionResponse(
        data=SessionData(account=SessionAccount(id=account.id, kind=kind))
    )
