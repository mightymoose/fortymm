from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Response
from pydantic import BaseModel

from fortymm_api.accounts import GuestAccount
from fortymm_api.auth import SESSION_COOKIE, SESSION_MAX_AGE, SessionToken
from fortymm_api.database import DatabaseSession
from fortymm_api.services import sessions

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
    started = sessions.start_session(session, token)
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        SESSION_COOKIE,
        started.token,
        max_age=SESSION_MAX_AGE,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )
    kind: Literal["guest", "verified"] = (
        "guest" if isinstance(started.account, GuestAccount) else "verified"
    )
    return SessionResponse(
        data=SessionData(account=SessionAccount(id=started.account.id, kind=kind))
    )
