import importlib.util
import os
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import NamedTuple

import fakeredis
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from rq import Queue
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

import app.models  # noqa: F401  -- ensures models register on Base.metadata
from app import queue as queue_module
from app.db import Base, get_session
from app.main import app as fastapi_app
from app.models import (
    DrawType,
    DrawTypeOption,
    League,
    LeagueVisibility,
    NotificationType,
    RatingStrategy,
    Role,
)
from app.models import NotificationChannel as NotificationChannelModel
from app.models.draw_type import DRAW_TYPE_IDS
from app.notifications.taxonomy import (
    CHANNEL_AVAILABLE,
    NotificationCategory,
)
from app.notifications.taxonomy import NotificationChannel as ChannelEnum
from app.roles import DEFAULT_ROLE_DESCRIPTION, DEFAULT_ROLE_NAME
from app.stream import SessionFactory, get_stream_session_factory
from tests._helpers import CSRF_EVENT_HOOKS


@pytest.fixture(autouse=True)
def fake_solver_queue(monkeypatch):
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.SOLVER_QUEUE, connection=connection, is_async=False)
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q


@pytest.fixture(autouse=True)
def _solver_job_database(monkeypatch, postgres_url):
    """Jobs on the synchronous fake solver queue run INLINE at enqueue time and
    open their own engine from ``DATABASE_URL`` (``run_schedule_solve`` — now
    enqueued by every go-live and every tournament-match completion, not just
    the solve-specific test files). Point that env var at the test database so
    the inline run reads the same Postgres as the test — where it exits as a
    stale no-op, the row it was enqueued for not yet being committed — instead
    of dialing the compose default. Free: the autouse ``rating_strategies`` →
    ``db_session`` chain already makes every test require ``postgres_url``."""
    monkeypatch.setenv("DATABASE_URL", postgres_url)


@pytest.fixture(autouse=True)
def fake_ratings_queue(monkeypatch):
    """Async-style RQ queue against fakeredis: enqueues are recorded but the
    job body never runs. The recompute job opens its own DB engine via
    ``app.db.get_engine()`` which would not point at the testcontainers
    database; we test the recompute algorithm by calling
    ``app.ratings.recompute.recompute_league_ratings`` directly, and use this
    fixture only to assert that callers enqueued the job."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.RATINGS_QUEUE, connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_ratings_queue", lambda: q)
    return q


@pytest.fixture(autouse=True)
def fake_notifications_queue(monkeypatch):
    """Async-style RQ queue against fakeredis: enqueues are recorded but the
    ``deliver_notification`` body never runs (like ``fake_ratings_queue``, it
    would open its own DB engine via ``app.db.get_engine()``, not the
    testcontainers database). Delivery is covered by direct
    ``NotificationService.notify`` tests; this fixture only lets callers assert
    which jobs were enqueued."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.NOTIFICATIONS_QUEUE, connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_notifications_queue", lambda: q)
    return q


@pytest.fixture(autouse=True)
def fake_email_queue(monkeypatch):
    """Sync RQ queue against fakeredis so enqueued jobs execute inline.

    Tests can assert against the queue's ``finished_job_registry`` or peek
    at recorded jobs via ``q.get_jobs()`` before they run by toggling
    ``is_async`` if they need to inspect enqueue arguments without
    triggering the email send.

    Also forces dev mode so ``send_confirmation_email`` runs the
    log+print path instead of raising on missing SMTP.
    """
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.EMAIL_QUEUE, connection=connection, is_async=False)
    monkeypatch.setattr(queue_module, "get_email_queue", lambda: q)
    monkeypatch.setenv("FORTYMM_DEV", "1")
    return q


@pytest.fixture(autouse=True)
def stub_captcha(monkeypatch):
    """Pretend Cloudflare Turnstile said yes. Tests that want the failure
    path override the patched function with ``monkeypatch.setattr``."""

    async def _always_pass(token):  # noqa: ARG001
        return True

    from app import captcha as captcha_module

    monkeypatch.setattr(captcha_module, "verify_captcha", _always_pass)


@pytest_asyncio.fixture(scope="session")
async def _rate_limiter_redis():
    """One fakeredis client published to ``app.rate_limiting`` for the whole
    test session — the httpx ASGITransport never fires the app's lifespan, so
    we init here. Per-test counter resets happen in ``rate_limiter_fakeredis``
    below."""
    import fakeredis.aioredis

    from app.rate_limiting import init_rate_limit_redis, shutdown_rate_limit_redis

    fake = fakeredis.aioredis.FakeRedis(encoding="utf-8")
    init_rate_limit_redis(fake)
    try:
        yield fake
    finally:
        shutdown_rate_limit_redis()
        await fake.aclose()


@pytest_asyncio.fixture(autouse=True)
async def rate_limiter_fakeredis(_rate_limiter_redis):
    """Flush rate-limit counters between tests so each starts clean."""
    await _rate_limiter_redis.flushall()
    return _rate_limiter_redis


@pytest.fixture(scope="session")
def realtime_redis_server():
    """One ``fakeredis.FakeServer`` shared by the realtime write and read sides.

    The publisher is synchronous (``redis.Redis``) and the broker is async
    (``redis.asyncio``), so they are two *different* fakeredis clients. Handing
    both the same ``FakeServer`` is what makes a sync ``PUBLISH`` visible to the
    async subscriber — without it each client gets a private server and every
    realtime test passes by not delivering anything."""
    return fakeredis.FakeServer()


@pytest.fixture(autouse=True)
def realtime_publisher_redis(realtime_redis_server, monkeypatch):
    """Point ``publish_event`` at the shared fake server.

    Autouse so no test can ever dial a real Redis — publish call sites live in
    ordinary write paths (result acceptance, match calls), so this is the same
    blanket the ``fake_*_queue`` fixtures provide for RQ.

    Replacing ``_connection`` itself — rather than the client it memoizes —
    is what keeps the fake per-test: production caches *inside* ``_connection``
    (see its docstring), so patching over it bypasses the memo entirely and no
    fake can outlive the test that installed it. One ``FakeStrictRedis`` per
    test, reused across that test's publishes, because constructing one costs
    ~120ms (it builds a whole command table)."""
    from app.realtime import publisher as realtime_publisher

    client = fakeredis.FakeStrictRedis(server=realtime_redis_server)
    monkeypatch.setattr(realtime_publisher, "_connection", lambda: client)
    return realtime_redis_server


@pytest_asyncio.fixture
async def realtime_broker(realtime_redis_server):
    """A started :class:`RealtimeBroker` published via ``init_broker``.

    ``httpx.ASGITransport`` never runs the app lifespan, so — exactly like
    ``_rate_limiter_redis`` — a test that exercises the stream has to install
    the process-wide broker itself. ``coalesce_delay=0`` so assertions don't
    each pay the 250ms production window."""
    import fakeredis.aioredis

    from app.realtime import RealtimeBroker, init_broker, shutdown_broker

    fake = fakeredis.aioredis.FakeRedis(server=realtime_redis_server, encoding="utf-8")
    broker = RealtimeBroker(fake, coalesce_delay=0.0, poll_interval=0.01)
    await broker.start()
    init_broker(broker)
    try:
        yield broker
    finally:
        await shutdown_broker()
        await fake.aclose()


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    override = os.environ.get("TEST_DATABASE_URL")
    if override:
        yield override
        return

    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:16-alpine", driver="asyncpg") as pg:
        yield pg.get_connection_url()


@pytest_asyncio.fixture(scope="session")
async def engine(postgres_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(postgres_url)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db_session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as session:
        try:
            yield session
        finally:
            await session.rollback()
    async with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())


GLICKO2_STATE_SCHEMA = {
    "type": "object",
    "required": ["rating", "rd", "volatility"],
    "properties": {
        "rating": {"type": "number"},
        "rd": {"type": "number"},
        "volatility": {"type": "number"},
    },
    "additionalProperties": False,
}
MANUAL_STATE_SCHEMA = {
    "type": "object",
    "required": ["rating"],
    "properties": {"rating": {"type": "number"}},
    "additionalProperties": False,
}


@pytest_asyncio.fixture(autouse=True)
async def rating_strategies(db_session: AsyncSession) -> dict[str, RatingStrategy]:
    """Seed the canonical rating strategies. Migration 0005 inserts these in
    real deployments; tests build via ``Base.metadata.create_all`` so we
    re-seed here for every test."""
    glicko2 = RatingStrategy(
        key="glicko2",
        name="Glicko-2",
        description="Glicko-2.",
        state_schema=GLICKO2_STATE_SCHEMA,
        initial_state={"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
        initial_rating_value=1500.0,
        is_automatic=True,
    )
    manual = RatingStrategy(
        key="manual",
        name="Manual / external",
        description="Ratings supplied externally.",
        state_schema=MANUAL_STATE_SCHEMA,
        initial_state=None,
        initial_rating_value=None,
        is_automatic=False,
    )
    db_session.add_all([glicko2, manual])
    await db_session.commit()
    return {"glicko2": glicko2, "manual": manual}


class DrawTypeSeedCopy(NamedTuple):
    """One ``draw_types`` row's display copy, from migration 0010's own seed.

    Named rather than positional: the fixture below used to index a bare 3-tuple
    (``[0]``/``[1]``/``[2]``), which api/CLAUDE.md warns against — a reordered
    seed would have silently swapped a label for its help text.
    """

    name: str
    description: str
    display_order: int


def _migration_draw_type_seed() -> dict[DrawType, DrawTypeSeedCopy]:
    """Read the draw-type display copy out of migration 0010, by path.

    Loaded from the migration rather than hand-copied beside it. The copy was
    duplicated here verbatim and nothing pinned the two together — the migration
    test compares KEYS only, and the payload tests only assert ``name`` /
    ``description`` are non-blank — so editing the migration's wording left the
    whole suite serving the stale strings with nothing red.

    Importing a migration from a test is fine: the self-containment rule is
    one-directional (a MIGRATION may not import app code), and
    ``tests/test_match_calls_notifications.py`` already loads migration 0009 the
    same way.

    Keyed by the enum member, not the slug, so a new ``DrawType`` with no seeded
    copy is a ``KeyError`` in the fixture below rather than a silently missing
    lookup row. A seeded slug with NO enum member is skipped rather than raising,
    so that drift fails in ``test_draw_type_seed_migration`` — which says so in
    words — instead of erroring out collection for the entire suite.
    """
    path = (
        Path(__file__).parent.parent
        / "migrations"
        / "versions"
        / "20260617_0000_0010_create_tournaments_table.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0010", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    known = {draw_type.value: draw_type for draw_type in DrawType}
    return {
        known[key]: DrawTypeSeedCopy(name, description, display_order)
        for key, name, description, display_order in module.DRAW_TYPE_SEED
        if key in known
    }


DRAW_TYPE_SEED: dict[DrawType, DrawTypeSeedCopy] = _migration_draw_type_seed()


@pytest_asyncio.fixture(autouse=True)
async def draw_types(db_session: AsyncSession) -> list[DrawTypeOption]:
    """Seed the draw type lookup rows (one per ``DrawType`` member).

    Seeded FROM the enum so the rows and the code-level closed set cannot
    drift — a row exists exactly when a draw type has a strategy — with the
    display copy read out of migration 0010 itself, so the rows a test sees are
    the rows a migrated database has. Autouse because the FK on the event's
    ``draw_type_id`` requires the parent rows to exist whenever a test builds a
    tournament event, which is most of the suite. Migration 0010 inserts these in
    real deployments; tests build via ``Base.metadata.create_all`` so we re-seed
    here.

    ``id`` is set explicitly from :data:`app.models.draw_type.DRAW_TYPE_IDS`,
    not left to the column's ``gen_random_uuid()`` default — the model's
    ``draw_type`` setter writes a settings row's ``draw_type_id`` from that same
    fixed map (see its docstring for why), so a row seeded with a random id would
    make every settings-row write in the suite FK-violate against a row that
    does not, by the map, exist.
    """
    rows = [
        DrawTypeOption(
            id=DRAW_TYPE_IDS[draw_type],
            key=draw_type.value,
            name=DRAW_TYPE_SEED[draw_type].name,
            description=DRAW_TYPE_SEED[draw_type].description,
            display_order=DRAW_TYPE_SEED[draw_type].display_order,
        )
        for draw_type in DrawType
    ]
    db_session.add_all(rows)
    await db_session.commit()
    return rows


# Display labels mirror the migration seeds — 0009 for the original five
# categories (and the former client-side CATEGORY_META / CHANNEL_META), 0015
# for match_calls. The migrations insert these in real deployments; tests
# build via ``Base.metadata.create_all`` so we re-seed here.
NOTIFICATION_TYPE_LABELS: dict[NotificationCategory, tuple[str, str]] = {
    NotificationCategory.MATCH_REMINDER: ("Match reminders", "Match"),
    NotificationCategory.RATING_CHANGE: ("Rating changes", "Rating"),
    NotificationCategory.TOURNAMENT: ("Tournament news", "Tourney"),
    NotificationCategory.OPPONENT: ("Challenges & friends", "Social"),
    NotificationCategory.RESULT_CONFIRM: ("Score acceptances", "Scores"),
    NotificationCategory.MATCH_CALLS: ("Match calls", "Calls"),
}
NOTIFICATION_CHANNEL_LABELS: dict[ChannelEnum, str] = {
    ChannelEnum.IN_APP: "In-app",
    ChannelEnum.PUSH: "Push",
    ChannelEnum.EMAIL: "Email",
    ChannelEnum.SMS: "SMS",
}


@pytest_asyncio.fixture(autouse=True)
async def notification_types(db_session: AsyncSession) -> list[NotificationType]:
    """Seed the notification type lookup rows (one per NotificationCategory).
    Autouse because the FK on notifications/preferences ``category`` requires the
    parent rows to exist whenever a test creates a notification or preference."""
    rows = [
        NotificationType(
            key=category.value,
            name=NOTIFICATION_TYPE_LABELS[category][0],
            short_label=NOTIFICATION_TYPE_LABELS[category][1],
            display_order=order,
        )
        for order, category in enumerate(NotificationCategory, start=1)
    ]
    db_session.add_all(rows)
    await db_session.commit()
    return rows


@pytest_asyncio.fixture(autouse=True)
async def notification_channels(
    db_session: AsyncSession,
) -> list[NotificationChannelModel]:
    """Seed the notification channel lookup rows (one per NotificationChannel).
    Autouse because the FK on the ``channel`` columns requires the parent rows.
    ``is_available`` is seeded from ``CHANNEL_AVAILABLE`` so it can't drift."""
    rows = [
        NotificationChannelModel(
            key=channel.value,
            name=NOTIFICATION_CHANNEL_LABELS[channel],
            display_order=order,
            is_available=CHANNEL_AVAILABLE[channel],
        )
        for order, channel in enumerate(ChannelEnum, start=1)
    ]
    db_session.add_all(rows)
    await db_session.commit()
    return rows


@pytest_asyncio.fixture(autouse=True)
async def default_league(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
) -> League:
    """Seed a default league so user-creation paths can attach memberships.

    Autouse so tests don't have to remember to opt in. Tests that want to
    exercise the "no default league" branch can ``await db_session.delete(...)``
    this row before triggering the path under test.
    """
    league = League(
        name="FortyMM",
        description="Test default league.",
        visibility=LeagueVisibility.public,
        is_default=True,
        rating_strategy_id=rating_strategies["glicko2"].id,
    )
    db_session.add(league)
    await db_session.commit()
    return league


@pytest_asyncio.fixture(autouse=True)
async def default_role(db_session: AsyncSession) -> Role:
    """Seed the default `User` role every user holds (ADR-0016).

    Autouse because both user-minting paths (`GET /v1/session` and
    `POST /v1/users`) now grant it and **raise** when it's absent — a missing
    role row is a broken deployment, not a soft-skip. `scripts/seed_rbac.py`
    inserts it in real deployments; tests build via ``Base.metadata.create_all``
    so we re-seed here, exactly as ``default_league`` does.

    Tests that want the "role is missing" branch can ``await
    db_session.delete(...)`` this row before triggering the path under test.
    """
    role = Role(name=DEFAULT_ROLE_NAME, description=DEFAULT_ROLE_DESCRIPTION)
    db_session.add(role)
    await db_session.commit()
    return role


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """HTTP client bound to the test app, sharing the per-test ``db_session``
    so commits inside endpoints are visible to assertions in the same test."""

    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    # ``GET /v1/stream`` deliberately takes a session *factory* rather than
    # ``Depends(get_session)`` (a yield dependency would pin a pooled connection
    # for the life of the stream — see ``app/stream.py``), so overriding
    # ``get_session`` alone would leave it dialling the real ``DATABASE_URL``
    # engine. Hand it a factory over the same shared session, which it must not
    # close: the test goes on asserting against it after the request.
    @asynccontextmanager
    async def _shared_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_stream_session_factory() -> SessionFactory:
        return _shared_session

    fastapi_app.dependency_overrides[get_session] = _override
    fastapi_app.dependency_overrides[get_stream_session_factory] = (
        _override_stream_session_factory
    )
    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(
        transport=transport,
        base_url="https://testserver",
        event_hooks=CSRF_EVENT_HOOKS,
    ) as client:
        yield client
    fastapi_app.dependency_overrides.clear()
