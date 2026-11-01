from enum import StrEnum
from typing import Annotated
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from fortymm_api.auth import (
    LoginState,
    SessionToken,
    delete_login_cookie,
    delete_session_cookie,
    set_login_cookie,
    set_session_cookie,
)
from fortymm_api.database import DatabaseSession
from fortymm_api.identity_provider import IdentityProvider, IdToken
from fortymm_api.services import sessions, sign_in
from fortymm_api.services.sessions import GuestAccountLimitReached
from fortymm_api.v1.errors import (
    GUEST_LIMIT,
    NO_PROVIDER,
    UNSUPPORTED_MEDIA_TYPE,
    Responses,
    retry_after_seconds,
)
from fortymm_api.v1.session import client_address

router = APIRouter(prefix="/auth", tags=["auth"])

# Where a rate-limited web login sends the browser. It has no session, so `/`
# would start a guest account and get the same limit. `/signed-out` starts
# none, and it is where such a browser usually clicked Sign in.
RATE_LIMITED_LOGIN = "/signed-out?sign_in_error=rate_limited"

REDIRECT: Responses = {302: {"description": "A redirect"}}


class SignInUnavailable(Exception):
    """The API has no identity provider configured. `create_app()` answers 503."""


def identity_provider(request: Request) -> IdentityProvider:
    provider: IdentityProvider | None = request.app.state.identity_provider
    if provider is None:
        raise SignInUnavailable
    return provider


Provider = Annotated[IdentityProvider, Depends(identity_provider)]


def public_origin(request: Request) -> str:
    """The origin the browser sees: the Worker's host in production, the dev
    server's in dev. The Worker sets the X-Forwarded headers."""
    host = request.headers.get("X-Forwarded-Host") or request.headers["Host"]
    scheme = request.headers.get("X-Forwarded-Proto") or request.url.scheme
    return f"{scheme}://{host}"


def callback_url(request: Request) -> str:
    root_path = request.scope.get("root_path", "")
    return f"{public_origin(request)}{root_path}/v1/auth/callback"


def app_callback_url(request: Request) -> str:
    root_path = request.scope.get("root_path", "")
    return f"{public_origin(request)}{root_path}/v1/auth/app-callback"


def redirect(location: str) -> RedirectResponse:
    response = RedirectResponse(location, status_code=302)
    response.headers["Cache-Control"] = "no-store"
    return response


def with_query(return_to: str, name: str, value: str) -> str:
    """`return_to` with `name=value` added to its query, which it keeps."""
    parts = urlsplit(return_to)
    query = f"{parts.query}&" if parts.query else ""
    return urlunsplit(parts._replace(query=f"{query}{name}={value}"))


@router.get(
    "/login",
    status_code=302,
    response_class=RedirectResponse,
    responses={**REDIRECT, **NO_PROVIDER},
)
def login(
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    provider: Provider,
    return_to: str | None = None,
) -> RedirectResponse:
    """Send the visitor to the identity provider's sign-in page.

    A request with no valid session gets no guest account. It gets a login
    cookie instead, which the callback checks. After sign-in, the callback
    sends the visitor to `return_to`. It must be a path
    on this site, or the callback uses `/`.

    Such a login counts toward the guest account limit. Past it, the visitor
    goes to `/signed-out` with `sign_in_error=rate_limited` and
    `retry_after`, the seconds until the network can sign in again.
    """
    try:
        started = sign_in.begin_sign_in(
            session, token, client_address(request), sign_in.safe_return_to(return_to)
        )
    except GuestAccountLimitReached as error:
        return redirect(
            f"{RATE_LIMITED_LOGIN}&retry_after={retry_after_seconds(error)}"
        )
    response = redirect(
        provider.authorize_url(
            state=started.state,
            nonce=started.nonce,
            code_verifier=started.code_verifier,
            redirect_uri=callback_url(request),
        )
    )
    if started.token is not None:
        set_session_cookie(response, started.token)
    if started.login_state is not None:
        set_login_cookie(response, started.login_state)
    return response


@router.get(
    "/callback",
    status_code=302,
    response_class=RedirectResponse,
    responses={**REDIRECT, **NO_PROVIDER},
)
def callback(
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    provider: Provider,
    login_state: LoginState = None,
    state: str | None = None,
    code: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    """Finish a sign-in, then send the visitor back to its `return_to`.

    A successful sign-in adds `signed_in=1` to that path's query. A failed
    sign-in adds `sign_in_error` instead: `cancelled`, `email_not_verified`,
    `expired` or `failed`. A callback from another browser gets `failed`, and
    keeps the login cookie, which may belong to a newer sign-in. A callback
    whose `state` matches no login attempt, such as a replay, goes to `/`
    with `sign_in_error=used`.
    """
    redirect_uri = callback_url(request)

    def exchange(code: str, code_verifier: str, nonce: str) -> IdToken:
        return provider.exchange(code, code_verifier, redirect_uri, nonce)

    result = sign_in.finish_sign_in(
        session, token, login_state, sign_in.Callback(state, code, error), exchange
    )
    match result:
        case sign_in.SignedIn(return_to, new_token):
            response = redirect(with_query(return_to, "signed_in", "1"))
            set_session_cookie(response, new_token)
        case sign_in.SignInFailed(return_to, sign_in_error):
            response = redirect(with_query(return_to, "sign_in_error", sign_in_error))
        case sign_in.WrongBrowser(return_to):
            response = redirect(
                with_query(return_to, "sign_in_error", sign_in.SignInError.FAILED)
            )
        case sign_in.Replayed():
            response = redirect("/?sign_in_error=used")
    if login_state is not None and not isinstance(result, sign_in.WrongBrowser):
        delete_login_cookie(response)
    return response


class AppLoginData(BaseModel):
    authorize_url: str


class AppLoginResponse(BaseModel):
    data: AppLoginData


@router.post(
    "/app-login",
    responses={
        **GUEST_LIMIT,
        **UNSUPPORTED_MEDIA_TYPE,
        **NO_PROVIDER,
    },
)
def app_login(
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    response: Response,
    provider: Provider,
) -> AppLoginResponse:
    """Start a sign-in from the native app.

    The app opens `authorize_url` in a browser of its own. That browser has
    none of the app's cookies, so the provider sends it to `app-callback`,
    which hands the query back to the app, and the app finishes the sign-in
    with `app-finish`. Like `login`, a request with no valid session gets no
    guest account, but a login cookie that `app-finish` checks.
    `authorize_url` can be relative to the API's origin.
    """
    started = sign_in.begin_sign_in(session, token, client_address(request), "/")
    authorize_url = provider.authorize_url(
        state=started.state,
        nonce=started.nonce,
        code_verifier=started.code_verifier,
        redirect_uri=app_callback_url(request),
    )
    if started.token is not None:
        set_session_cookie(response, started.token)
    if started.login_state is not None:
        set_login_cookie(response, started.login_state)
    response.headers["Cache-Control"] = "no-store"
    return AppLoginResponse(data=AppLoginData(authorize_url=authorize_url))


@router.get(
    "/app-callback",
    status_code=302,
    response_class=RedirectResponse,
    responses=REDIRECT,
)
def app_callback(request: Request) -> RedirectResponse:
    """Send the provider's redirect on to the native app.

    It answers 302 to `fortymm://sign-in` with this request's query, which
    the app passes to `app-finish`. Another app that claims the scheme gets
    nothing it can use, because finishing needs the app's session or login
    cookie.
    """
    query = request.url.query
    return redirect(f"fortymm://sign-in?{query}" if query else "fortymm://sign-in")


class AppFinishRequest(BaseModel):
    state: str | None = None
    code: str | None = None
    error: str | None = None


class AppSignInOutcome(StrEnum):
    SIGNED_IN = "signed_in"
    CANCELLED = "cancelled"
    EMAIL_NOT_VERIFIED = "email_not_verified"
    EXPIRED = "expired"
    FAILED = "failed"


class AppFinishData(BaseModel):
    outcome: AppSignInOutcome


class AppFinishResponse(BaseModel):
    data: AppFinishData


@router.post("/app-finish", responses={**UNSUPPORTED_MEDIA_TYPE, **NO_PROVIDER})
def app_finish(
    body: AppFinishRequest,
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    response: Response,
    provider: Provider,
    login_state: LoginState = None,
) -> AppFinishResponse:
    """Finish a sign-in that `app-login` started, with the query that
    `app-callback` handed to the app.

    `outcome` is `signed_in`, or why the sign-in failed: `cancelled`,
    `email_not_verified`, `expired` or `failed`. A sign-in sets a new session
    cookie. A `state` that matches no login attempt, such as a replay, is
    `expired`. A failed sign-in changes no account. A request from another
    browser is `failed`, and keeps the login cookie.
    """
    redirect_uri = app_callback_url(request)

    def exchange(code: str, code_verifier: str, nonce: str) -> IdToken:
        return provider.exchange(code, code_verifier, redirect_uri, nonce)

    result = sign_in.finish_sign_in(
        session,
        token,
        login_state,
        sign_in.Callback(body.state, body.code, body.error),
        exchange,
    )
    match result:
        case sign_in.SignedIn(_, new_token):
            outcome = AppSignInOutcome.SIGNED_IN
            set_session_cookie(response, new_token)
        case sign_in.SignInFailed(_, sign_in_error):
            outcome = AppSignInOutcome(sign_in_error.value)
        case sign_in.WrongBrowser():
            outcome = AppSignInOutcome.FAILED
        case sign_in.Replayed():
            outcome = AppSignInOutcome.EXPIRED
    if login_state is not None and not isinstance(result, sign_in.WrongBrowser):
        delete_login_cookie(response)
    response.headers["Cache-Control"] = "no-store"
    return AppFinishResponse(data=AppFinishData(outcome=outcome))


class LogoutData(BaseModel):
    logout_url: str


class LogoutResponse(BaseModel):
    data: LogoutData


@router.post("/logout", responses={**UNSUPPORTED_MEDIA_TYPE, **NO_PROVIDER})
def logout(
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    response: Response,
    provider: Provider,
) -> LogoutResponse:
    """End the visitor's session and expire its cookie.

    `logout_url` is the identity provider's logout page. The client follows
    it, so the provider's own session ends too. The provider then sends the
    browser to `/signed-out`, which starts no session. `/` would start a new
    guest account, and it wouldn't look like a sign-out.
    """
    sessions.end_session(session, token)
    delete_session_cookie(response)
    response.headers["Cache-Control"] = "no-store"
    logout_url = provider.logout_url(f"{public_origin(request)}/signed-out")
    return LogoutResponse(data=LogoutData(logout_url=logout_url))
