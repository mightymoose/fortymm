from ipaddress import ip_address
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from fortymm_api.auth import SessionToken, set_session_cookie
from fortymm_api.database import DatabaseSession
from fortymm_api.services import sessions

router = APIRouter(tags=["session"])

GUEST_LIMIT_DESCRIPTION = (
    "The client's network started too many guest accounts. "
    "Retry-After gives the seconds until it can start more."
)


class SessionPlayer(BaseModel):
    id: UUID
    display_name: str


class SessionAccount(BaseModel):
    id: UUID
    kind: Literal["guest", "verified"]
    player: SessionPlayer


class SessionData(BaseModel):
    account: SessionAccount


class SessionResponse(BaseModel):
    data: SessionData


def client_address(request: Request) -> sessions.ClientAddress:
    """The client's IP address.

    In production, uvicorn's --proxy-headers sets request.client from the
    X-Forwarded-For that the Worker writes. A missing or non-IP client is a
    deployment fault. So this raises, and the request answers 500.
    """
    if request.client is None:
        raise RuntimeError("The request has no client address")
    return ip_address(request.client.host)


@router.post("/session", responses={429: {"description": GUEST_LIMIT_DESCRIPTION}})
def start_session(
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    response: Response,
) -> SessionResponse:
    """Resume the visitor's session, or start a guest account and its session.

    A valid session gets a later expiry and a fresh cookie. With no cookie, or
    a cookie for an expired, unknown or adopted session, the visitor gets a
    new guest account. The API deletes the session that cookie named. A
    client network can start 30 guest accounts a minute. Past that, the API
    answers 429.

    The account's player is the one it plays as. A new guest account's player
    gets a default display name, such as `excited egret 387`.
    """
    started = sessions.start_session(session, token, client_address(request))
    response.headers["Cache-Control"] = "no-store"
    set_session_cookie(response, started.token)
    player = SessionPlayer(
        id=started.player.id, display_name=started.player.display_name
    )
    account = SessionAccount(
        id=started.account.id, kind=started.account.kind, player=player
    )
    return SessionResponse(data=SessionData(account=account))
