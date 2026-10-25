"""The session cookie, and the dependency that reads its account."""

from typing import Annotated

from fastapi import Depends, Response
from fastapi.security import APIKeyCookie

from fortymm_api.accounts import CurrentAccount
from fortymm_api.database import DatabaseSession
from fortymm_api.services.sessions import SESSION_LIFETIME, authenticate

SESSION_COOKIE = "__Host-fortymm_session"
SESSION_MAX_AGE = int(SESSION_LIFETIME.total_seconds())

session_cookie = APIKeyCookie(
    name=SESSION_COOKIE, scheme_name="session", auto_error=False
)
SessionToken = Annotated[str | None, Depends(session_cookie)]


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_MAX_AGE,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


def delete_session_cookie(response: Response) -> None:
    """Expire the cookie. A browser keeps a __Host- cookie unless the expired
    one has the same attributes."""
    response.delete_cookie(
        SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax"
    )


class NoValidSession(Exception):
    """The request has no valid session. `create_app()` answers 401."""


def require_account(session: DatabaseSession, token: SessionToken) -> CurrentAccount:
    account = authenticate(session, token)
    if account is None:
        raise NoValidSession
    return account


# The account of the request's session, for a route that needs one.
RequestAccount = Annotated[CurrentAccount, Depends(require_account)]
