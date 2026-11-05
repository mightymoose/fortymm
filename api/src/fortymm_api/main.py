import hmac
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.routing import APIRoute
from sqlalchemy.orm import sessionmaker

from fortymm_api import v1
from fortymm_api.auth import NoValidSession
from fortymm_api.database import create_database_engine, migrate
from fortymm_api.identity_provider import IdentityProvider
from fortymm_api.services.authorization import MissingPermission
from fortymm_api.services.match_results import IllegalEnding, WrongMatch
from fortymm_api.services.matches import MergedPlayer, SamePlayer, UnknownPlayer
from fortymm_api.services.player_admin import PlayerNotFound
from fortymm_api.services.player_merge import PlayedEachOther
from fortymm_api.services.players import (
    PlayerNotManaged,
    QuestionClosed,
    SameAsItself,
)
from fortymm_api.services.roles import (
    AccountNotFound,
    BuiltInPermission,
    LastAdministrator,
    NotVerified,
    PermissionKeyTaken,
    PermissionNotFound,
    RoleNameTaken,
    RoleNotFound,
    UnknownPermission,
)
from fortymm_api.services.sessions import AccountAdopted, GuestAccountLimitReached
from fortymm_api.services.signing_keys import (
    InvalidDeviceLabel,
    InvalidProof,
    InvalidPublicKey,
    KeyRegisteredElsewhere,
    SigningKeyNotFound,
    UnknownSigningKey,
)
from fortymm_api.signed_results import BadSignature, Malformed, UnknownKey
from fortymm_api.v1.auth import SignInUnavailable
from fortymm_api.v1.errors import error_response, retry_after_seconds

WORKER_SECRET_HEADER = "X-FortyMM-Worker-Secret"
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
NO_SESSION = "The request has no valid session"
TOO_MANY_GUEST_ACCOUNTS = "Too many new guest accounts from this network"
SIGN_IN_UNAVAILABLE = "Sign-in isn't set up on this server"
PLAYER_ERRORS: dict[type[Exception], tuple[int, str]] = {
    PlayerNotManaged: (404, "You don't manage this player"),
    QuestionClosed: (409, "This question was already answered"),
    SameAsItself: (422, "A player can't be the same as itself"),
    PlayedEachOther: (409, "These players played each other, so they are two people"),
}
ROLE_ERRORS: dict[type[Exception], tuple[int, str]] = {
    MissingPermission: (403, "You don't have permission to do this"),
    RoleNotFound: (404, "The role doesn't exist"),
    AccountNotFound: (404, "No account has this id"),
    NotVerified: (404, "No verified account has this id"),
    PlayerNotFound: (404, "No player has this id"),
    PermissionNotFound: (404, "The permission doesn't exist"),
    RoleNameTaken: (409, "Another role has this name"),
    PermissionKeyTaken: (409, "Another permission has this key"),
    BuiltInPermission: (409, "The code checks this permission, so it stays"),
    UnknownPermission: (422, "A permission in the role doesn't exist"),
    LastAdministrator: (
        409,
        "At least one account must keep the permission to grant roles",
    ),
}
SIGNING_KEY_ERRORS: dict[type[Exception], tuple[int, str]] = {
    InvalidDeviceLabel: (422, "A device label is 1 to 50 characters, after trimming"),
    InvalidPublicKey: (422, "The public key isn't a P-256 COSE_Key in the format"),
    InvalidProof: (
        422,
        "The proof doesn't show that this device holds the key for this account",
    ),
    KeyRegisteredElsewhere: (409, "Another account registered this key"),
    SigningKeyNotFound: (404, "The account has no key with this id"),
    UnknownSigningKey: (404, "No key has this id"),
}
APPROVAL_ERRORS: dict[type[Exception], tuple[int, str]] = {
    Malformed: (422, "The envelope isn't a FortyMM signed result"),
    WrongMatch: (422, "The result is for another match"),
    UnknownKey: (422, "A signature's key isn't registered, or was revoked"),
    BadSignature: (422, "A signature doesn't match the result"),
    IllegalEnding: (422, "The scores aren't a legal ending to the match"),
}
MATCH_ERRORS: dict[type[Exception], tuple[int, str]] = {
    UnknownPlayer: (422, "A player of the match doesn't exist"),
    MergedPlayer: (
        422,
        "A player of the match merged into another player. Pick them again",
    ),
    SamePlayer: (422, "Both sides of the match are the same player"),
}
AUTH0_SETTINGS = ("AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET")


def answers(status: int, title: str) -> Callable[[Request, Exception], Response]:
    """An exception handler that answers `status` in the `errors` shape."""
    return lambda _request, _error: error_response(status, title)


def too_many_guest_accounts(_request: Request, error: Exception) -> Response:
    """429 with Retry-After in whole seconds, at least 1."""
    assert isinstance(error, GuestAccountLimitReached)
    response = error_response(429, TOO_MANY_GUEST_ACCOUNTS)
    response.headers["Retry-After"] = str(retry_after_seconds(error))
    return response


def operation_id(route: APIRoute) -> str:
    """Name each OpenAPI operation after its route function (e.g. `health`).

    FastAPI's default IDs embed the path and method (`health_v1_health_get`), which
    leak into the clients generated from the schema.
    """
    return route.name


def type_array_nullables(schema: Any) -> Any:
    """`schema` with each `anyOf: [{type: X, ...}, {type: null}]` written as
    `type: [X, "null"]`, which means the same in OpenAPI 3.1.

    swift-openapi-generator drops a property in the `anyOf` form, so the
    iOS client wouldn't see it.
    """
    if isinstance(schema, list):
        return [type_array_nullables(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    schema = {key: type_array_nullables(value) for key, value in schema.items()}
    match schema.get("anyOf"):
        case [{"type": str(kind), **rest}, {"type": "null"}]:
            del schema["anyOf"]
            return {**rest, "type": [kind, "null"], **schema}
    return schema


def nullables_as_type_arrays(app: FastAPI) -> None:
    """Rewrite the nullables of the models only. oasdiff reads a parameter's
    type array as dropping `null`, a false break, and the iOS client sends
    no nullable parameter."""

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            schema = FastAPI.openapi(app)
            components = schema.get("components", {})
            if "schemas" in components:
                components["schemas"] = type_array_nullables(components["schemas"])
            app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]


def require_worker_secret(app: FastAPI, secret: str) -> None:
    """Reject every request that doesn't carry the Worker secret.

    The Cloud Run URL is public, so this is what keeps clients from going
    around the Cloudflare Worker, which adds the header (see worker/index.ts).
    """

    @app.middleware("http")
    async def check_worker_secret(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        sent = request.headers.get(WORKER_SECRET_HEADER, "")
        if not hmac.compare_digest(sent.encode(), secret.encode()):
            return error_response(403, "Requests must come through the Worker")
        return await call_next(request)


def require_json(app: FastAPI) -> None:
    """Reject a write whose body isn't declared as JSON.

    A cross-site HTML form can send a POST without CORS, but not with this
    content type. Without the check, a form on another site could make
    POST /v1/session replace the visitor's session with a new guest's.
    """

    @app.middleware("http")
    async def check_content_type(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        content_type = request.headers.get("Content-Type", "")
        media_type = content_type.partition(";")[0].strip().lower()
        if request.method in WRITE_METHODS and media_type != "application/json":
            return error_response(
                415, "Requests must send Content-Type: application/json"
            )
        return await call_next(request)


def identity_provider_from_env() -> IdentityProvider | None:
    """The provider that AUTH0_DOMAIN names, or None if it's unset.

    Cloud Run always sets it. Off Cloud Run, the sign-in routes answer 503
    without it.
    """
    domain = os.environ.get("AUTH0_DOMAIN", "")
    if not domain:
        return None
    return IdentityProvider(
        domain,
        os.environ.get("AUTH0_CLIENT_ID", ""),
        os.environ.get("AUTH0_CLIENT_SECRET", ""),
        os.environ.get("AUTH0_AUTHORIZE_URL") or None,
        os.environ.get("AUTH0_LOGOUT_URL") or None,
    )


def create_app() -> FastAPI:
    secret = os.environ.get("WORKER_SECRET", "")
    database_url = os.environ.get("DATABASE_URL", "")
    # Cloud Run sets K_SERVICE. Failing there stops a revision without the
    # secret from starting, rather than serving the API to anyone.
    if os.environ.get("K_SERVICE") and not secret:
        raise RuntimeError("WORKER_SECRET must be set when running on Cloud Run")
    # Off Cloud Run the database is optional, so the OpenAPI export runs
    # without one.
    if os.environ.get("K_SERVICE") and not database_url:
        raise RuntimeError("DATABASE_URL must be set when running on Cloud Run")
    missing = [name for name in AUTH0_SETTINGS if not os.environ.get(name)]
    if os.environ.get("K_SERVICE") and missing:
        names = ", ".join(missing)
        raise RuntimeError(f"{names} must be set when running on Cloud Run")

    engine = create_database_engine(database_url) if database_url else None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if engine is None:
            yield
            return
        # Before serving, so no request sees an old schema. A database that
        # can't be reached stops the API from starting.
        migrate(engine)
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(
        title="FortyMM API",
        version="0.1.0",
        generate_unique_id_function=operation_id,
        lifespan=lifespan,
    )
    app.state.sessions = sessionmaker(engine) if engine is not None else None
    app.state.identity_provider = identity_provider_from_env()
    app.include_router(v1.router)
    nullables_as_type_arrays(app)
    app.add_exception_handler(
        NoValidSession, lambda _request, _error: error_response(401, NO_SESSION)
    )
    app.add_exception_handler(
        AccountAdopted, lambda _request, _error: error_response(401, NO_SESSION)
    )
    app.add_exception_handler(GuestAccountLimitReached, too_many_guest_accounts)
    app.add_exception_handler(
        SignInUnavailable,
        lambda _request, _error: error_response(503, SIGN_IN_UNAVAILABLE),
    )
    for error, (status, title) in (
        PLAYER_ERRORS
        | ROLE_ERRORS
        | SIGNING_KEY_ERRORS
        | APPROVAL_ERRORS
        | MATCH_ERRORS
    ).items():
        app.add_exception_handler(error, answers(status, title))
    require_json(app)
    # Added last so it runs first: a request without the secret learns nothing
    # else about the API.
    if secret:
        require_worker_secret(app, secret)
    return app


app = create_app()
