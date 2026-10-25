"""Sign-in: send the visitor to the identity provider, then decide what the
identity it returns means for the visitor's account.
"""

import secrets
from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from typing import Protocol

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import (
    AccountId,
    CurrentAccount,
    Email,
    GuestAccount,
    VerifiedAccount,
)
from fortymm_api.identity_provider import ExchangeFailed, IdToken
from fortymm_api.models import (
    Account,
    AuthSession,
    Identity,
    LoginAttempt,
    PlayerManager,
)
from fortymm_api.services.sessions import (
    ClientAddress,
    ValidSession,
    convert_guest,
    find_session,
    new_session,
    start_session,
)

LOGIN_ATTEMPT_LIFETIME = timedelta(minutes=10)


@dataclass(frozen=True)
class VerifyInPlace:
    """A guest account signs in with a new identity."""

    account: AccountId


@dataclass(frozen=True)
class AlreadySignedIn:
    """The identity already belongs to the current account."""

    account: AccountId


@dataclass(frozen=True)
class AdoptGuest:
    """A guest account signs in with another account's identity."""

    guest: AccountId
    into: AccountId


@dataclass(frozen=True)
class SwitchAccount:
    """A verified account signs in with another account's identity."""

    to: AccountId


@dataclass(frozen=True)
class CreateAccount:
    """A verified account signs in with a new identity."""


type LoginOutcome = (
    VerifyInPlace | AlreadySignedIn | AdoptGuest | SwitchAccount | CreateAccount
)


def resolve_login(current: CurrentAccount, owner: AccountId | None) -> LoginOutcome:
    """What a sign-in does, from the current account and the identity's owner."""
    if owner == current.id:
        return AlreadySignedIn(current.id)
    match current:
        case GuestAccount():
            if owner is None:
                return VerifyInPlace(current.id)
            return AdoptGuest(current.id, owner)
        case VerifiedAccount():
            if owner is None:
                return CreateAccount()
            return SwitchAccount(owner)


def safe_return_to(value: str | None) -> str:
    """The path to send the visitor back to, or `/` for anything unsafe.

    Browsers read `//` and `/\\` as the start of another host. They also drop
    tabs and newlines from a URL, so a control character could hide either.
    """
    if (
        value is None
        or not value.startswith("/")
        or value[1:2] in ("/", "\\")
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
    ):
        return "/"
    return value


@dataclass(frozen=True)
class LoginStarted:
    """A login attempt, for the identity provider's sign-in page."""

    token: str
    state: str
    nonce: str
    code_verifier: str
    # A verified account must see the sign-in page. Otherwise the provider's
    # own session signs the same person in again with no page.
    prompt_login: bool


def begin_sign_in(
    session: Session, token: str | None, address: ClientAddress, return_to: str
) -> LoginStarted:
    """Start a login attempt for the token's session.

    A request with no valid session gets a guest account first, as
    `start_session()` gives one. The attempt lasts LOGIN_ATTEMPT_LIFETIME.
    """
    started = start_session(session, token, address)
    attempt = LoginAttempt(
        state=secrets.token_urlsafe(32),
        session_id=started.session_id,
        code_verifier=secrets.token_urlsafe(64),
        nonce=secrets.token_urlsafe(32),
        return_to=return_to,
        expires_at=func.now() + LOGIN_ATTEMPT_LIFETIME,
    )
    session.add(attempt)
    return LoginStarted(
        token=started.token,
        state=attempt.state,
        nonce=attempt.nonce,
        code_verifier=attempt.code_verifier,
        prompt_login=isinstance(started.account, VerifiedAccount),
    )


class SignInError(StrEnum):
    CANCELLED = "cancelled"
    EMAIL_NOT_VERIFIED = "email_not_verified"
    EXPIRED = "expired"
    FAILED = "failed"


@dataclass(frozen=True)
class Callback:
    """The query the identity provider redirects back with."""

    state: str | None
    code: str | None
    error: str | None


class ExchangeCode(Protocol):
    """Exchange a callback's code for its verified ID token, or raise
    ExchangeFailed."""

    def __call__(self, code: str, code_verifier: str, nonce: str) -> IdToken: ...


@dataclass(frozen=True)
class SignedIn:
    return_to: str
    token: str


@dataclass(frozen=True)
class SignInFailed:
    return_to: str
    error: SignInError


@dataclass(frozen=True)
class Replayed:
    """The callback's state matches no login attempt, such as a second run of
    a callback that already finished."""


def finish_sign_in(
    session: Session, token: str | None, callback: Callback, exchange: ExchangeCode
) -> SignedIn | SignInFailed | Replayed:
    """Finish the login attempt that the callback's state names.

    Deletes the attempt, whatever the result. A failure changes no account and
    no session, and never raises, so the caller commits the delete. Each
    success gives the browser a new session and token.
    """
    if callback.state is None:
        return Replayed()
    found = session.execute(
        delete(LoginAttempt)
        .where(LoginAttempt.state == callback.state)
        .returning(LoginAttempt, LoginAttempt.expires_at > func.now())
    ).one_or_none()
    if found is None:
        return Replayed()
    attempt, unexpired = found

    def failed(error: SignInError) -> SignInFailed:
        return SignInFailed(attempt.return_to, error)

    current = find_session(session, token, lock=True)
    if not isinstance(current, ValidSession) or current.row.id != attempt.session_id:
        return failed(SignInError.FAILED)
    if not unexpired:
        return failed(SignInError.EXPIRED)
    if callback.error == "access_denied":
        return failed(SignInError.CANCELLED)
    if callback.error is not None or callback.code is None:
        return failed(SignInError.FAILED)
    try:
        id_token = exchange(callback.code, attempt.code_verifier, attempt.nonce)
    except ExchangeFailed:
        return failed(SignInError.FAILED)
    if not id_token.email_verified or id_token.email is None:
        return failed(SignInError.EMAIL_NOT_VERIFIED)

    signed_in_token = _sign_in(session, current, id_token.sub, id_token.email)
    if signed_in_token is None:
        return failed(SignInError.FAILED)
    return SignedIn(attempt.return_to, signed_in_token)


def _sign_in(
    session: Session, current: ValidSession, sub: str, email: Email
) -> str | None:
    """Apply the login's outcome. Returns the new session's token, or None for
    an outcome the API can't apply yet.

    The advisory lock makes sign-ins with one email take turns. So when two
    browsers verify one new email at once, the second finds the account the
    first made, rather than failing on accounts.email's unique constraint.
    """
    session.execute(select(func.pg_advisory_xact_lock(func.hashtext(email))))
    owner = session.scalar(select(Identity.account_id).where(Identity.auth0_sub == sub))
    sub_is_new = owner is None
    if owner is None:
        # A second identity for an email, such as Google after an email code,
        # reaches the account that has the email.
        owner = session.scalar(select(Account.id).where(Account.email == email))

    match resolve_login(current.account, owner):
        case VerifyInPlace(account):
            session.execute(
                update(Account).where(Account.id == account).values(email=email)
            )
            # Sets up "Is this you?": a guest's self player could be a child
            # who played on a parent's computer.
            session.execute(
                update(PlayerManager)
                .where(PlayerManager.account_id == account)
                .values(relationship="managed", adopted_from=account)
            )
            destination = account
            new_token = convert_guest(session, account, account)
        case AlreadySignedIn(account):
            destination = account
            new_token = _replace_session(session, current.row, account)
        case SwitchAccount(to):
            destination = to
            new_token = _replace_session(session, current.row, to)
        case CreateAccount():
            created = Account(email=email)
            session.add(created)
            session.flush()
            destination = created.id
            new_token = _replace_session(session, current.row, created.id)
        case AdoptGuest():
            # Waits for adoption (#60).
            return None

    if sub_is_new:
        session.add(Identity(auth0_sub=sub, account_id=destination))
    return new_token


def _replace_session(session: Session, row: AuthSession, account: AccountId) -> str:
    """Swap the browser's session for a new one on the account. The API never
    changes a token in place."""
    session.delete(row)
    _, token = new_session(session, account)
    return token
