"""Shared test helpers for the API test suite.

The leading underscore keeps pytest from auto-collecting this as a test module;
fixtures still belong in ``conftest.py``.
"""

from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass

from httpx import ASGITransport, AsyncClient, Request
from rq import Queue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app as fastapi_app
from app.models import User
from app.notifications.apns import Environment, SendOutcome, SendResult
from app.notifications.dependencies import get_push_sender
from app.notifications.jobs import DELIVER_NOTIFICATION_JOB
from app.schemas.notification import NotificationJob
from app.sessions import CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_SAFE_METHODS


def enqueued_notification_jobs(queue: Queue) -> list[NotificationJob]:
    """The notification-delivery payloads enqueued so far, decoded back into
    ``NotificationJob``. Under the async-style ``fake_notifications_queue`` the
    worker body never runs, so tests assert on what was enqueued; channel
    delivery itself is covered by the ``NotificationService.notify`` tests."""
    jobs: list[NotificationJob] = []
    for job in queue.get_jobs():
        assert job.func_name == DELIVER_NOTIFICATION_JOB
        jobs.append(NotificationJob.model_validate_json(job.args[0]))
    return jobs


async def _attach_csrf_header(request: Request) -> None:
    """httpx request hook that satisfies the app's double-submit CSRF guard on
    every mutating request, mirroring the browser client.

    If the client carries a real ``csrf_token`` cookie (it called
    ``/v1/session``), echo that value in the ``X-CSRF-Token`` header. Tests that
    bypass the session via ``dependency_overrides`` have no such cookie, so
    inject a synthetic matching cookie/header pair — they still need to clear
    the middleware. Tests exercising the *rejection* path build a client
    without this hook."""
    if request.method.upper() in CSRF_SAFE_METHODS:
        return
    cookie_header = request.headers.get("cookie")
    prefix = f"{CSRF_COOKIE_NAME}="
    token: str | None = None
    for part in (cookie_header or "").split("; "):
        if part.startswith(prefix):
            token = part[len(prefix) :]
            break
    if token is None:
        token = "test-csrf-token"
        pair = f"{prefix}{token}"
        request.headers["cookie"] = (
            f"{cookie_header}; {pair}" if cookie_header else pair
        )
    request.headers[CSRF_HEADER_NAME] = token


# Pass to every test ``AsyncClient`` so the existing mutating-request tests keep
# passing under the double-submit CSRF guard.
CSRF_EVENT_HOOKS = {"request": [_attach_csrf_header]}


async def start_session(api_client: AsyncClient, db_session: AsyncSession) -> User:
    """Establish a session cookie on the client and return the signed-in user."""
    response = await api_client.get("/v1/session")
    assert response.status_code == 200
    username = response.json()["data"]["user"]["username"]
    return (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()


async def make_user(db_session: AsyncSession, username: str) -> User:
    user = User(username=username)
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


def make_client() -> AsyncClient:
    """Build a second cookie-isolated client bound to the same test app.

    Useful when a test needs two distinct users (each one calls
    ``start_session`` on their own client) sharing the same ``db_session``
    fixture override — which the primary ``api_client`` fixture has already
    installed by the time this helper runs.
    """
    return AsyncClient(
        transport=ASGITransport(app=fastapi_app),
        base_url="https://testserver",
        event_hooks=CSRF_EVENT_HOOKS,
    )


@asynccontextmanager
async def opponent_session(
    db_session: AsyncSession, username: str
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """Async context manager that mints an ephemeral session on a fresh
    client, renames the auto-generated user to ``username``, yields
    ``(client, user)``, and closes the client on exit.

    Used by signature-flow tests that need a second human who can act on the
    match — typically ``POST /v1/matches/{id}/confirmation`` — without the
    test setting up (and cleaning up) the session juggling itself.

    Example::

        async with opponent_session(db_session, "rival") as (opp_client, opp):
            await _play_match_to_completion(
                api_client, opp_client, opp.id, best_of=3, side_1_wins=True
            )
    """
    client = make_client()
    try:
        user = await start_session(client, db_session)
        user.username = username
        await db_session.commit()
        yield client, user
    finally:
        await client.aclose()


# ----- push notifications ---------------------------------------------------


@dataclass
class SentPush:
    """One recorded ``PushSender.send`` call."""

    token: str
    environment: str
    title: str
    body: str
    category: str | None
    data: Mapping[str, str] | None


class FakeSender:
    """Records every send and returns a per-token outcome (default success).

    Drop-in for the ``PushSender`` protocol; install it with ``use_sender``."""

    def __init__(
        self,
        *,
        configured: bool = True,
        outcomes: dict[str, SendOutcome] | None = None,
    ) -> None:
        self.is_configured = configured
        self.sent: list[SentPush] = []
        self._outcomes = outcomes or {}

    async def send(
        self,
        token: str,
        *,
        environment: Environment,
        title: str,
        body: str,
        category: str | None = None,
        data: Mapping[str, str] | None = None,
    ) -> SendResult:
        self.sent.append(SentPush(token, environment, title, body, category, data))
        return SendResult(self._outcomes.get(token, SendOutcome.SUCCESS))


def use_sender(sender: FakeSender) -> None:
    """Override the process-wide push sender for the duration of a test.
    ``api_client`` clears ``dependency_overrides`` afterwards."""
    fastapi_app.dependency_overrides[get_push_sender] = lambda: sender
