from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from fortymm_api.auth import SessionToken, delete_session_cookie, set_session_cookie
from fortymm_api.database import DatabaseSession
from fortymm_api.identity_provider import IdentityProvider, IdToken
from fortymm_api.services import sessions, sign_in
from fortymm_api.v1.session import client_address

router = APIRouter(prefix="/auth", tags=["auth"])

REDIRECT: dict[int | str, dict[str, Any]] = {302: {"description": "A redirect"}}


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
    "/login", status_code=302, response_class=RedirectResponse, responses=REDIRECT
)
def login(
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    provider: Provider,
    return_to: str | None = None,
) -> RedirectResponse:
    """Send the visitor to the identity provider's sign-in page.

    A request with no valid session gets a guest account first. After
    sign-in, the callback sends the visitor to `return_to`. It must be a path
    on this site, or the callback uses `/`.
    """
    started = sign_in.begin_sign_in(
        session, token, client_address(request), sign_in.safe_return_to(return_to)
    )
    response = redirect(
        provider.authorize_url(
            state=started.state,
            nonce=started.nonce,
            code_verifier=started.code_verifier,
            redirect_uri=callback_url(request),
            prompt_login=started.prompt_login,
        )
    )
    set_session_cookie(response, started.token)
    return response


@router.get(
    "/callback", status_code=302, response_class=RedirectResponse, responses=REDIRECT
)
def callback(
    session: DatabaseSession,
    token: SessionToken,
    request: Request,
    provider: Provider,
    state: str | None = None,
    code: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    """Finish a sign-in, then send the visitor back to its `return_to`.

    A successful sign-in adds `signed_in=1` to that path's query. A failed
    sign-in adds `sign_in_error` instead: `cancelled`, `email_not_verified`,
    `expired` or `failed`. A callback whose `state` matches no login attempt,
    such as a replay, goes to `/`.
    """
    redirect_uri = callback_url(request)

    def exchange(code: str, code_verifier: str, nonce: str) -> IdToken:
        return provider.exchange(code, code_verifier, redirect_uri, nonce)

    result = sign_in.finish_sign_in(
        session, token, sign_in.Callback(state, code, error), exchange
    )
    match result:
        case sign_in.SignedIn(return_to, new_token):
            response = redirect(with_query(return_to, "signed_in", "1"))
            set_session_cookie(response, new_token)
            return response
        case sign_in.SignInFailed(return_to, sign_in_error):
            return redirect(with_query(return_to, "sign_in_error", sign_in_error))
        case sign_in.Replayed():
            return redirect("/")


class LogoutData(BaseModel):
    logout_url: str


class LogoutResponse(BaseModel):
    data: LogoutData


@router.post("/logout")
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
