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
    Identity,
    LoginAttempt,
)
from fortymm_api.services.adoption import adopt_guest, hand_over_players
from fortymm_api.services.sessions import (
    ClientAddress,
    ValidSession,
    convert_guest,
    count_start_without_session,
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
    """A verified account, or a browser with no session, signs in with another
    account's identity."""

    to: AccountId


@dataclass(frozen=True)
class CreateAccount:
    """A verified account, or a browser with no session, signs in with a new
    identity."""


type LoginOutcome = (
    VerifyInPlace | AlreadySignedIn | AdoptGuest | SwitchAccount | CreateAccount
)


def resolve_login(
    current: CurrentAccount | None, owner: AccountId | None
) -> LoginOutcome:
    """What a sign-in does, from the current account and the identity's owner.

    `current` is None for a browser with no session.
    """
    if current is not None and owner == current.id:
        return AlreadySignedIn(current.id)
    match current:
        case GuestAccount():
            if owner is None:
                return VerifyInPlace(current.id)
            return AdoptGuest(current.id, owner)
        case VerifiedAccount() | None:
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
    """A login attempt, for the identity provider's sign-in page.

    A browser with a session gets its session `token` again. A browser
    without one gets `login_state` for the login cookie instead, which is the
    attempt's state.
    """

    token: str | None
    login_state: str | None
    state: str
    nonce: str
    code_verifier: str
    # A verified account must see the sign-in page. Otherwise the provider's
    # own session signs the same person in again with no page.
    prompt_login: bool


def begin_sign_in(
    session: Session, token: str | None, address: ClientAddress, return_to: str
) -> LoginStarted:
    """Start a login attempt for the token's session, or for a browser with
    no valid session.

    A browser with no valid session gets no guest account. Such as after a
    sign-out, it would hold nothing, and adoption would merge its new player
    away at once. The attempt counts toward the guest account limit
    instead. The attempt lasts LOGIN_ATTEMPT_LIFETIME.
    """
    attempt = LoginAttempt(
        state=secrets.token_urlsafe(32),
        code_verifier=secrets.token_urlsafe(64),
        nonce=secrets.token_urlsafe(32),
        return_to=return_to,
        expires_at=func.now() + LOGIN_ATTEMPT_LIFETIME,
    )
    if isinstance(find_session(session, token), ValidSession):
        started = start_session(session, token, address)
        attempt.started_with_session = True
        attempt.session_id = started.session_id
        session_token, login_state = started.token, None
        prompt_login = isinstance(started.account, VerifiedAccount)
    else:
        count_start_without_session(session, address)
        attempt.started_with_session = False
        session_token, login_state = None, attempt.state
        prompt_login = False
    session.add(attempt)
    return LoginStarted(
        token=session_token,
        login_state=login_state,
        state=attempt.state,
        nonce=attempt.nonce,
        code_verifier=attempt.code_verifier,
        prompt_login=prompt_login,
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
    session: Session,
    token: str | None,
    login_state: str | None,
    callback: Callback,
    exchange: ExchangeCode,
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

    browser_session = find_session(session, token, lock=True)
    current = browser_session if isinstance(browser_session, ValidSession) else None
    if not attempt.started_with_session:
        # The browser had no session. It may have one now, such as a guest
        # account that another tab started, and the sign-in uses it.
        # Another browser can open the callback's URL, but it can't set this
        # browser's login cookie.
        if login_state is None or not secrets.compare_digest(
            login_state, attempt.state
        ):
            return failed(SignInError.FAILED)
    elif current is None or current.row.id != attempt.session_id:
        # Includes a session that ended after the attempt began, such as when
        # another tab's sign-in replaced it. The browser may be signed in as
        # someone else now, so the sign-in must say it failed.
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

    return SignedIn(
        attempt.return_to, _sign_in(session, current, id_token.sub, id_token.email)
    )


def _sign_in(
    session: Session, current: ValidSession | None, sub: str, email: Email
) -> str:
    """Apply the login's outcome. Returns the new session's token.

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

    match resolve_login(None if current is None else current.account, owner):
        case VerifyInPlace(account):
            session.execute(
                update(Account).where(Account.id == account).values(email=email)
            )
            hand_over_players(session, account, account)
            destination = account
            new_token = convert_guest(session, account, account)
        case AlreadySignedIn(account):
            destination = account
            new_token = _replace_session(session, current, account)
        case SwitchAccount(to):
            destination = to
            new_token = _replace_session(session, current, to)
        case CreateAccount():
            created = Account(email=email)
            session.add(created)
            session.flush()
            destination = created.id
            new_token = _replace_session(session, current, created.id)
        case AdoptGuest(guest, into):
            destination = into
            new_token = adopt_guest(session, guest, into)

    if sub_is_new:
        session.add(Identity(auth0_sub=sub, account_id=destination))
    return new_token


def _replace_session(
    session: Session, current: ValidSession | None, account: AccountId
) -> str:
    """Swap the browser's session, if any, for a new one on the account. The
    API never changes a token in place."""
    if current is not None:
        session.delete(current.row)
    _, token = new_session(session, account)
    return token
