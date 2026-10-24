"""Sessions: the cookie that carries one, and the account it signs in."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated

from fastapi import Depends
from fastapi.security import APIKeyCookie
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import CurrentAccount, GuestAccount, VerifiedAccount
from fortymm_api.database import DatabaseSession
from fortymm_api.models import Account, AuthSession

SESSION_COOKIE = "__Host-fortymm_session"
# 400 days, the longest Max-Age browsers keep. A session expires with its
# cookie.
SESSION_MAX_AGE = 34_560_000
SESSION_LIFETIME = timedelta(seconds=SESSION_MAX_AGE)

session_cookie = APIKeyCookie(
    name=SESSION_COOKIE, scheme_name="session", auto_error=False
)
SessionToken = Annotated[str | None, Depends(session_cookie)]


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


@dataclass(frozen=True)
class ValidSession:
    row: AuthSession
    account: CurrentAccount


@dataclass(frozen=True)
class InvalidSession:
    """A session that has expired, or whose account was adopted."""

    row: AuthSession


def current_account(account: Account) -> CurrentAccount | None:
    """The account's kind, or None for an adopted account."""
    if account.adopted_into is not None:
        return None
    if account.email is None:
        return GuestAccount(account.id)
    return VerifiedAccount(account.id, account.email)


def find_session(
    session: Session, token: str | None, *, lock: bool = False
) -> ValidSession | InvalidSession | None:
    """The session the token names, if any.

    `lock` takes the account row FOR UPDATE, for a caller that writes it. The
    lock comes before the adopted_into check, so an adoption that commits
    meanwhile can't slip through.
    """
    if token is None:
        return None
    query = (
        select(AuthSession, Account, AuthSession.expires_at > func.now())
        .join(Account, Account.id == AuthSession.account_id)
        .where(AuthSession.token_hash == hash_token(token))
    )
    if lock:
        query = query.with_for_update(of=Account)
    found = session.execute(query).one_or_none()
    if found is None:
        return None
    row, account, unexpired = found
    kind = current_account(account)
    if kind is None or not unexpired:
        return InvalidSession(row)
    return ValidSession(row, kind)


class NoValidSession(Exception):
    """The request has no valid session. `create_app()` answers 401."""


def require_account(session: DatabaseSession, token: SessionToken) -> CurrentAccount:
    found = find_session(session, token)
    if not isinstance(found, ValidSession):
        raise NoValidSession
    return found.account


# The account of the request's session, for a route that needs one.
RequestAccount = Annotated[CurrentAccount, Depends(require_account)]
