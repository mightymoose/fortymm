from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Response
from pydantic import BaseModel

from fortymm_api.auth import SessionToken, set_session_cookie
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
    set_session_cookie(response, started.token)
    account = SessionAccount(id=started.account.id, kind=started.account.kind)
    return SessionResponse(data=SessionData(account=account))
