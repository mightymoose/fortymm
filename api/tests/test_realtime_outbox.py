"""``app.realtime.outbox`` — a hint publishes iff its transaction commits.

The commit/rollback pair is the property the outbox exists for, so those two are
asserted end-to-end at the **broker** (via :mod:`tests._realtime`, which explains
why never over the socket). The rest — dedupe, session scoping, failure
swallowing — are about the listener's own contract and record at the publisher
seam, where "exactly once" is a count rather than an inference.
"""

import logging
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import Session

from app.models import User
from app.realtime import EventKind, RealtimeBroker
from app.realtime import outbox as outbox_module
from app.realtime import publisher as publisher_module
from app.realtime.outbox import STAGED_HINTS_KEY, stage_event
from tests._helpers import make_user
from tests._realtime import watch_hints

Published = list[tuple[uuid.UUID, EventKind]]


def _name(stem: str) -> str:
    return f"{stem}-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> Published:
    """Record every publish the listener performs, in order.

    Patched at ``outbox.publish_event`` rather than at Redis so a test can count
    publishes exactly: the point of the dedupe assertions is *how many* calls the
    outbox makes, which a fan-in at the broker (which coalesces by design) cannot
    tell apart.
    """
    calls: Published = []

    def _record(user_id: uuid.UUID, kind: EventKind) -> bool:
        calls.append((user_id, kind))
        return True

    monkeypatch.setattr(outbox_module, "publish_event", _record)
    return calls


@pytest.fixture
def rollback_events() -> Iterator[list[str]]:
    """Record which of the two rollback events SQLAlchemy actually emits.

    This is what makes the ``after_soft_rollback`` choice a tested decision
    rather than a comment: a test can assert that ``after_rollback`` stayed
    silent on the very rollback that still had to discard the hint.
    """
    fired: list[str] = []

    def _hard(session: Session) -> None:
        fired.append("after_rollback")

    def _soft(session: Session, previous: object) -> None:
        fired.append("after_soft_rollback")

    event.listen(Session, "after_rollback", _hard)
    event.listen(Session, "after_soft_rollback", _soft)
    try:
        yield fired
    finally:
        event.remove(Session, "after_rollback", _hard)
        event.remove(Session, "after_soft_rollback", _soft)


async def _committed_usernames(engine: AsyncEngine) -> set[str]:
    """Usernames visible to a **separate** session — i.e. actually committed."""
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as other:
        return set((await other.execute(select(User.username))).scalars())


# ----- (1) the commit/rollback property -----------------------------------


async def test_a_hint_staged_in_a_committed_transaction_is_published(
    db_session: AsyncSession, realtime_broker: RealtimeBroker
) -> None:
    user = await make_user(db_session, _name("outbox-commit"))
    user_id = user.id

    async with watch_hints(realtime_broker, user_id) as watch:
        stage_event(db_session, user_id, EventKind.dashboard_changed)
        db_session.add(User(username=_name("committed")))
        await db_session.commit()
        hints = await watch.collect()

    assert hints == {user_id: [EventKind.dashboard_changed]}


async def test_a_hint_staged_in_a_rolled_back_transaction_is_never_published(
    db_session: AsyncSession, engine: AsyncEngine, realtime_broker: RealtimeBroker
) -> None:
    """The twin of the test above, and the reason the outbox exists.

    The later commit is load-bearing: a discard that merely *deferred* the hint
    would still publish it here, one transaction late, which is exactly the
    stale-read the ADR is guarding against.
    """
    user = await make_user(db_session, _name("outbox-rollback"))
    # Read the id up front: ``rollback()`` expires every instance in the
    # session, so touching ``user.id`` afterwards is a lazy refresh outside the
    # greenlet — a ``MissingGreenlet`` that has nothing to do with the outbox.
    user_id = user.id
    ghost = _name("rolled-back")

    async with watch_hints(realtime_broker, user_id) as watch:
        stage_event(db_session, user_id, EventKind.dashboard_changed)
        db_session.add(User(username=ghost))
        await db_session.flush()
        await db_session.rollback()

        db_session.add(User(username=_name("unrelated")))
        await db_session.commit()

        hints = await watch.collect()

    assert hints == {user_id: []}
    assert ghost not in await _committed_usernames(engine)


async def test_a_rollback_after_rollback_never_sees_still_discards_the_hint(
    db_session: AsyncSession, published: Published, rollback_events: list[str]
) -> None:
    """A rollback of an already-deactivated transaction emits ``after_soft_rollback``
    **only** — a failed flush has already spent the ``after_rollback`` event.

    An outbox listening on ``after_rollback`` alone leaves the hint staged here,
    and the next commit on this session publishes an invalidation for work that
    never happened. Asserting the absence of ``after_rollback`` is what makes
    this the falsification for that listener choice rather than a duplicate of
    the rollback test above.
    """
    taken = _name("taken")
    await make_user(db_session, taken)

    db_session.add(User(username=taken))
    with pytest.raises(IntegrityError):
        await db_session.flush()
    rollback_events.clear()

    user_id = uuid.uuid4()
    stage_event(db_session, user_id, EventKind.dashboard_changed)
    await db_session.rollback()

    assert rollback_events == ["after_soft_rollback"]
    assert STAGED_HINTS_KEY not in db_session.info

    db_session.add(User(username=_name("after-the-rollback")))
    await db_session.commit()
    assert published == []


# ----- (2) one publish per (user, kind) per transaction --------------------


async def test_staging_the_same_hint_twice_in_one_transaction_publishes_once(
    db_session: AsyncSession, published: Published
) -> None:
    """One transaction can touch a user several times — completion, draw
    advance, call re-pin. Hints are idempotent, so that is one ``PUBLISH``."""
    user_id = uuid.uuid4()

    stage_event(db_session, user_id, EventKind.dashboard_changed)
    stage_event(db_session, user_id, EventKind.dashboard_changed)
    stage_event(db_session, user_id, EventKind.dashboard_changed)
    db_session.add(User(username=_name("deduped")))
    await db_session.commit()

    assert published == [(user_id, EventKind.dashboard_changed)]


async def test_dedupe_is_per_user_not_a_single_hint_for_the_transaction(
    db_session: AsyncSession, published: Published
) -> None:
    """The guard against "collapse it all into one": two affected users are two
    publishes, because a topic is per-user."""
    first, second = uuid.uuid4(), uuid.uuid4()

    stage_event(db_session, first, EventKind.dashboard_changed)
    stage_event(db_session, second, EventKind.dashboard_changed)
    stage_event(db_session, first, EventKind.dashboard_changed)
    db_session.add(User(username=_name("two-users")))
    await db_session.commit()

    assert sorted(published) == sorted(
        [
            (first, EventKind.dashboard_changed),
            (second, EventKind.dashboard_changed),
        ]
    )


async def test_a_second_transaction_does_not_republish_the_first_ones_hints(
    db_session: AsyncSession, published: Published
) -> None:
    """The outbox empties on flush: a later commit on the same session must not
    re-announce staleness that was already announced."""
    user_id = uuid.uuid4()

    stage_event(db_session, user_id, EventKind.dashboard_changed)
    db_session.add(User(username=_name("first-txn")))
    await db_session.commit()

    db_session.add(User(username=_name("second-txn")))
    await db_session.commit()

    assert published == [(user_id, EventKind.dashboard_changed)]


async def test_hints_are_scoped_to_the_session_they_were_staged_on(
    db_session: AsyncSession, engine: AsyncEngine, published: Published
) -> None:
    """``Session.info`` is per-session, so a commit elsewhere in the process —
    a concurrent request, the sweep worker — cannot flush someone else's outbox."""
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as other:
        stage_event(other, uuid.uuid4(), EventKind.dashboard_changed)

        db_session.add(User(username=_name("other-session")))
        await db_session.commit()
        assert published == []

        await other.rollback()


# ----- (3) failure is swallowed, the commit still stands -------------------


async def test_a_redis_failure_while_publishing_is_swallowed_and_the_commit_stands(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A hint is an optimization over the client's existing refetch-on-navigation
    freshness. A Redis hiccup must degrade the dashboard to that, not undo the
    match completion that triggered it."""

    def _no_redis() -> object:
        raise ConnectionError("redis is down")

    monkeypatch.setattr(publisher_module, "_connection", _no_redis)

    username = _name("survives-redis-down")
    stage_event(db_session, uuid.uuid4(), EventKind.dashboard_changed)
    db_session.add(User(username=username))

    with caplog.at_level(logging.ERROR, logger="uvicorn.error"):
        await db_session.commit()

    assert username in await _committed_usernames(engine)
    assert "Failed to publish realtime" in caplog.text


async def test_an_exception_from_the_publisher_cannot_escape_the_commit(
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The listener runs inside ``await db.commit()`` but *after* the COMMIT has
    landed, so anything escaping it would raise out of a write that already
    happened — the database committed, the caller told it failed."""

    def _explode(user_id: uuid.UUID, kind: EventKind) -> bool:
        raise RuntimeError("publisher blew up in a way publish_event does not catch")

    monkeypatch.setattr(outbox_module, "publish_event", _explode)

    username = _name("survives-listener-blowup")
    stage_event(db_session, uuid.uuid4(), EventKind.dashboard_changed)
    db_session.add(User(username=username))

    with caplog.at_level(logging.ERROR, logger="uvicorn.error"):
        await db_session.commit()

    assert username in await _committed_usernames(engine)
    assert "Failed to flush staged realtime hints" in caplog.text
    assert STAGED_HINTS_KEY not in db_session.info
