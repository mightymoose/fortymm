"""Stage a realtime hint on a session; publish it iff that session commits.

A hint says "your dashboard changed, refetch it". Published a moment too early
— before the writing transaction commits — it makes the client re-read the
*pre-commit* state and cache staleness that no later event will correct. So
publication has to happen strictly after commit, and the write paths cannot do
that themselves: the natural funnel :func:`app.result_acceptance.finalize_match`
explicitly *does not commit* (it runs in the caller's transaction, under the
match row lock), and neither does ``on_match_completed``. Publishing there would
be exactly the too-early publish.

The alternative — a hand-placed ``publish_event`` after every ``await
db.commit()`` — is what this module exists to avoid. The codebase already
hand-rolls that contract three times (``tournament_placement``,
``match_calls``, ``schedule_solves``, each carrying its own "Post-commit, by
design" comment), and each new completion path would owe another copy of it in
a different file. Here it is one invariant in one place, enforced by SQLAlchemy
rather than by code review: a write path calls :func:`stage_event` wherever it
knows *who* is affected, and the transaction boundary decides whether that hint
is real.

Three details are load-bearing.

**A set, not a list.** One transaction can touch the same user several times —
a result acceptance completes a match, advances a draw and re-pins a call — and
hints are idempotent, so ``(user_id, kind)`` dedupes to one ``PUBLISH``. This is
the same losslessness argument the broker's coalescing rests on, applied one
hop earlier.

**``after_soft_rollback``, not ``after_rollback``.** ``after_rollback`` only
fires when the transaction actually reached the connection. The guard-clause
style in ``app.retirement_jobs`` (``await db.rollback()`` on each no-op branch,
to drop the ``FOR UPDATE`` lock immediately) frequently rolls back a
transaction that never got that far, and those rollbacks would silently leave
staged hints behind to be published by whatever committed next.

**The listener swallows everything.** It runs inside SQLAlchemy's greenlet
during ``await db.commit()``, *after* the COMMIT has already succeeded, so an
exception escaping here would surface out of a commit that already happened —
turning a Redis hiccup into a failed write. Same contract, and the same reason,
as ``app.notifications.service.enqueue_notification_job``.

One assumption worth naming: a hint is staged by the same unit of work that
*made it true*, so a transaction is already open when :func:`stage_event` runs.
``Session.rollback()`` on a session with no transaction at all emits neither
rollback event (there is nothing to roll back), so staging a hint against a
session that then does no work leaves it pending for that session's next commit.
Every call site stages alongside a write, which is what ties the hint's fate to
that write's.
"""

import logging
import uuid
from collections.abc import MutableMapping
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from app.realtime.events import EventKind
from app.realtime.publisher import publish_event

log = logging.getLogger("uvicorn.error")

#: Key under which the pending hint set lives on ``Session.info``. Namespaced
#: because ``info`` is a free-for-all dict shared with anything else that wants
#: to hang per-session state off it.
STAGED_HINTS_KEY = "app.realtime.staged_hints"

#: One pending publish: the affected user and what kind of staleness they have.
StagedHint = tuple[uuid.UUID, EventKind]


def _staged(info: MutableMapping[Any, Any]) -> set[StagedHint]:
    staged: set[StagedHint] | None = info.get(STAGED_HINTS_KEY)
    if staged is None:
        staged = set()
        info[STAGED_HINTS_KEY] = staged
    return staged


def stage_event(db: AsyncSession, user_id: uuid.UUID, kind: EventKind) -> None:
    """Queue a hint for ``user_id``, to be published **iff ``db`` commits**.

    Call it from wherever the write path knows who is affected — that set is
    write-path work and resolving it is the whole design (ADR "realtime topics
    are per-user, and the server resolves who is affected"). Staging the same
    ``(user_id, kind)`` twice in one transaction publishes once.

    Staged on ``Session.info`` rather than on some registry keyed by session,
    so the hints live and die with the session that made them: a session
    garbage-collected without committing takes its unpublished hints with it.
    """
    _staged(db.info).add((user_id, kind))


def _take_staged(session: Session) -> list[StagedHint]:
    """Remove and return the session's pending hints, in a stable order."""
    staged: set[StagedHint] | None = session.info.pop(STAGED_HINTS_KEY, None)
    if not staged:
        return []
    return sorted(staged, key=lambda hint: (str(hint[0]), hint[1].value))


@event.listens_for(Session, "after_commit")
def _publish_staged_hints(session: Session) -> None:
    """Flush the outbox: the transaction committed, so the hints are true now.

    Registered on ``Session`` (the sync class ``AsyncSession`` drives) because
    that is where SQLAlchemy's ORM events live; ``AsyncSession.info`` is the
    same dict, so what :func:`stage_event` wrote is what this reads.
    """
    try:
        for user_id, kind in _take_staged(session):
            publish_event(user_id, kind)
    except Exception:  # noqa: BLE001 -- post-COMMIT: an escape would fail an already-committed write
        log.exception("Failed to flush staged realtime hints after commit")


@event.listens_for(Session, "after_soft_rollback")
def _discard_staged_hints(
    session: Session,
    previous_transaction: SessionTransaction,  # noqa: ARG001 -- SQLAlchemy event signature
) -> None:
    """Drop the outbox: the work those hints describe did not happen.

    ``after_soft_rollback`` fires even when the transaction never reached the
    connection, which is the common case for the ``await db.rollback()``
    guard-clause style — ``after_rollback`` alone would leak the hints.
    """
    try:
        session.info.pop(STAGED_HINTS_KEY, None)
    except Exception:  # noqa: BLE001 -- a rollback path must not raise on top of whatever caused it
        log.exception("Failed to discard staged realtime hints on rollback")
