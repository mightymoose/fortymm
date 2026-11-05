"""The session and login cookies, and the dependency that reads the
session's account."""

from typing import Annotated, Any

from fastapi import Cookie, Depends, Response
from fastapi.security import APIKeyCookie

from fortymm_api.accounts import CurrentAccount
from fortymm_api.database import DatabaseSession
from fortymm_api.permissions import Permission
from fortymm_api.services.authorization import authorize
from fortymm_api.services.sessions import SESSION_LIFETIME, authenticate
from fortymm_api.services.sign_in import LOGIN_ATTEMPT_LIFETIME

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


# A sign-in from a browser with no session: the cookie holds the login
# attempt's state, so the callback must come from the browser that started it.
LOGIN_COOKIE = "__Host-fortymm_login"
LOGIN_MAX_AGE = int(LOGIN_ATTEMPT_LIFETIME.total_seconds())

LoginState = Annotated[str | None, Cookie(alias=LOGIN_COOKIE)]


def set_login_cookie(response: Response, state: str) -> None:
    response.set_cookie(
        LOGIN_COOKIE,
        state,
        max_age=LOGIN_MAX_AGE,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


def delete_login_cookie(response: Response) -> None:
    response.delete_cookie(
        LOGIN_COOKIE, path="/", secure=True, httponly=True, samesite="lax"
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


def require_permission(permission: Permission) -> Any:
    """A dependency for a route that needs the permission. It gives the
    request's account, or raises MissingPermission, which `create_app()`
    answers with 403."""

    def check(session: DatabaseSession, account: RequestAccount) -> CurrentAccount:
        authorize(session, account, permission)
        return account

    return Depends(check)
