"""Shared test helpers for the API test suite.

The leading underscore keeps pytest from auto-collecting this as a test module;
fixtures still belong in ``conftest.py``.
"""

from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass

import pytest
from httpx import ASGITransport, AsyncClient, Request
from rq import Queue
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app import schedule_solves, scheduling
from app.main import app as fastapi_app
from app.models import (
    League,
    Permission,
    RatingHistory,
    RatingHistorySource,
    Role,
    RolePermission,
    User,
    UserLeagueRating,
    UserRole,
)
from app.notifications.apns import Environment, SendOutcome, SendResult
from app.notifications.dependencies import get_push_sender
from app.notifications.jobs import DELIVER_NOTIFICATION_JOB
from app.scheduling import ScheduleSnapshot, SolveResult
from app.schemas.notification import NotificationJob
from app.sessions import CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_SAFE_METHODS


def hijack_solve(
    monkeypatch: pytest.MonkeyPatch, after_solve: Callable[[], None]
) -> None:
    """Interpose on the ``_solve`` seam: run the real solver, then
    ``after_solve`` — landing work exactly in the gap between a schedule
    solve job's snapshot and its guarded apply (the drift-guard race
    window)."""
    real = scheduling.solve

    def wrapper(
        snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
    ) -> SolveResult:
        result = real(
            snapshot, time_cap_s=time_cap_s, num_search_workers=num_search_workers
        )
        after_solve()
        return result

    monkeypatch.setattr(schedule_solves, "_solve", wrapper)


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


async def grant_permissions(
    db_session: AsyncSession, user: User, names: Sequence[str]
) -> None:
    """Grant ``names`` to ``user`` through real RBAC rows, so tests exercise the
    genuine permission gate rather than overriding it.

    Each Permission row is reused if an earlier call already created it, and the
    user gets a role of their own carrying exactly ``names`` — so two users in
    one test can hold different subsets (view-only vs view+enter, say), which is
    what proves a route is gated on the permission it claims and not merely on
    "is signed in".
    """
    role = Role(name=f"grant-{user.id}", description="Per-user test grant.")
    db_session.add(role)
    await db_session.flush()
    for name in names:
        permission = (
            await db_session.execute(select(Permission).where(Permission.name == name))
        ).scalar_one_or_none()
        if permission is None:
            permission = Permission(name=name, description=name)
            db_session.add(permission)
            await db_session.flush()
        db_session.add(RolePermission(role_id=role.id, permission_id=permission.id))
    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()


async def rate_player(
    db_session: AsyncSession, user: User, league: League, value: float
) -> None:
    """Put ``user`` on ``league``'s ladder at ``value`` — **actually rated**, not merely
    holding a rating row.

    The two are different, and the difference is what keeps the Unrated tests from
    being vacuous. Minting a session JOINS the default league, which SEEDS a
    ``user_league_ratings`` row at 1500 plus an ``initial`` rating-history event
    (``app.ratings.rated``): every player in the suite already has a rating *row* on
    the default league before they do anything. So a rating is made here in the two
    moves that ``app.ratings.rated.is_rated_member`` actually asks about:

    1. the seeded row's value is MOVED to ``value`` (inserted, if this is a league the
       player never joined), and
    2. a NON-``initial`` ``rating_history`` row is written — the thing that says
       something real moved it.

    Write only (1) and the player is still Unrated by every read on the platform, and
    an "over the cap is refused" test goes green against a guard that refuses nobody.

    Shared by the eligibility tests on BOTH sides of ADR-0783 — the entry route's
    refusal (``test_tournament_entries``) and the detail read's ``entry_state``
    (``test_tournaments``) — precisely because a second, subtly weaker copy of it in
    one of them would let that side pass while testing nothing.
    """
    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.league_id == league.id,
                UserLeagueRating.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if rating is None:
        rating = UserLeagueRating(
            league_id=league.id,
            user_id=user.id,
            rating_strategy_id=league.rating_strategy_id,
        )
        db_session.add(rating)
    rating.rating_value = value
    db_session.add(
        RatingHistory(
            league_id=league.id,
            user_id=user.id,
            match_id=None,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=value,
            rating_state={"rating": value, "rd": 200.0, "volatility": 0.06},
            previous_rating_value=None,
            # ``manual``, not ``initial``: an ``initial`` row is the seed every member
            # joins with, and it makes nobody rated.
            source=RatingHistorySource.manual,
        )
    )
    await db_session.commit()


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


def make_raw_client() -> AsyncClient:
    """Like ``make_client`` but *without* the CSRF auto-attach hook, so a test
    can drive the double-submit guard by hand — or stand in for a cold,
    cookieless browser that was never issued session/csrf cookies."""
    return AsyncClient(
        transport=ASGITransport(app=fastapi_app),
        base_url="https://testserver",
    )


async def accept_standing_result(
    client: AsyncClient, match_id: str, *, expected_status: int = 201
) -> dict:
    """Accept the match's current standing proposal as ``client`` — the second
    verb of the propose/accept negotiation. Reads the standing result id from
    the match-details negotiation block, then POSTs the acceptance.

    Replaces the old ``POST /confirmation`` for the common "opponent ratifies
    the posted result" path in collateral tests."""
    details = (await client.get(f"/v1/matches/{match_id}")).json()
    standing = details["negotiation"]["standing_result"]
    assert standing is not None, "no standing result to accept"
    response = await client.post(
        f"/v1/matches/{match_id}/results/{standing['id']}/acceptance"
    )
    assert response.status_code == expected_status, response.text
    return response.json()


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


@asynccontextmanager
async def counted_statements(
    engine: AsyncEngine,
) -> AsyncIterator[tuple[AsyncSession, list[str]]]:
    """Yields ``(session, statements)``: a session whose every emitted SQL
    statement is appended to the list, for the N+1 tripwires that pin how many
    round-trips a loader costs.

    Example::

        async with counted_statements(engine) as (session, statements):
            await MatchDetailsRepository(session).career_before(ids, now)
        assert len(statements) == 1, statements

    **Why a fresh session, not the ``db_session`` fixture.** The counter must see
    only the statements the code under test emits: a fresh
    ``async_sessionmaker`` session keeps the setup's already-committed INSERTs out
    of the count, and starts with an empty identity map so the shared session's
    cached rows / pending flushes can't mask a query the loader really would have
    issued against a cold session (which is what a real request gets).

    **Why the batching callers cite three ids.** A reintroduced per-user loop
    emits one statement per user, so three ids fail loudly against a pin of one —
    where a two-id list could still be read off as a coincidence.

    ``expire_on_commit=False``, as everywhere else in the suite (the ``db_session``
    fixture, the lock-race tests' sessionmakers): a caller counting the statements a
    *handler* emits — rather than a bare loader — would otherwise have every ORM
    instance expired by that handler's ``commit()``, and the next attribute read
    would try to refresh it from inside sync code (``MissingGreenlet``). It also
    keeps the count honest: an expiry-triggered reload is a statement the code under
    test never asked for.
    """
    statements: list[str] = []

    def before(conn: object, cursor: object, statement: str, *args: object) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", before)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            yield session, statements
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before)


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
    collapse_id: str | None = None


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
        collapse_id: str | None = None,
    ) -> SendResult:
        self.sent.append(
            SentPush(token, environment, title, body, category, data, collapse_id)
        )
        return SendResult(self._outcomes.get(token, SendOutcome.SUCCESS))


def use_sender(sender: FakeSender) -> None:
    """Override the process-wide push sender for the duration of a test.
    ``api_client`` clears ``dependency_overrides`` afterwards."""
    fastapi_app.dependency_overrides[get_push_sender] = lambda: sender
