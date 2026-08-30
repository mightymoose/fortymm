"""Auto-accept a lapsed standing result once its retirement window elapses.

When a match requires confirmation, the posting side's claim sits as a
*standing* (unaccepted) result at the head of the negotiation chain. If the
opponent never accepts, the claim auto-finalizes once
``match_settings.retirement_window`` elapses (see ``app.retirement``). This
module is the background worker that performs that auto-acceptance.

Approach (ADR 0007 / task O8): a periodic **sweep**, not a per-deadline
``enqueue_at``. ``sweep_lapsed_retirements`` scans for candidate matches whose
standing head has lapsed and calls ``retire_if_lapsed`` for each, every one
under its own row lock. The acceptance itself reuses the extracted
``app.result_acceptance.accept_standing_result`` core — this module never
re-implements accept logic.

It's a leaf: it depends only on the models and the already-extracted domain
leaves (``result_chain``, ``retirement``, ``result_acceptance``), never on the
``app.matches`` router. The blocking row lock and eager load are reproduced here
(a narrow ``SELECT ... FOR UPDATE`` and the same selectinload chain) rather than
imported from the router, per api/CLAUDE.md ("don't import another router's
internals").

RQ workers are sync processes, so the entry point ``run_retirement_sweep`` is a
thin ``asyncio.run`` wrapper that opens its own ``async_sessionmaker`` from
``app.db.get_engine`` — mirroring ``app.ratings.jobs`` / ``app.notifications.jobs``.
The periodic trigger that calls it is out of scope here (task #9).
"""

import asyncio
import enum
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload
from sqlalchemy.sql.base import ExecutableOption

from app.db import get_engine
from app.models import (
    League,
    Match,
    MatchGame,
    MatchResult,
    MatchSettings,
    MatchSide,
    MatchStatus,
)
from app.notifications.apns import push_sender_from_env
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory
from app.result_acceptance import accept_standing_result
from app.result_chain import standing_result
from app.retirement import retirement_deadline
from app.schemas.notification import NotificationJob

log = logging.getLogger(__name__)

RUN_RETIREMENT_SWEEP_JOB = "app.retirement_jobs.run_retirement_sweep"

# How far ahead of the retirement deadline the single "your window is closing"
# reminder fires. O7's default is one reminder ~24h before, not an escalating
# series — the ``reminder_sent_at`` marker guarantees at-most-once per standing
# result. NB: this assumes the sweep runs **at least daily** (task #9's trigger);
# a match whose whole 24h lead falls between two sweep ticks would be retired
# without a reminder ever having been due.
REMINDER_LEAD = timedelta(hours=24)

_RETIRED_TITLE = "Match finalized"
_RETIRED_BODY = (
    "You didn't respond in time, so the reported result was finalized as the "
    "official outcome."
)
_RETIRED_ACTION_LABEL = "View result"
_REMINDER_TITLE = "A result is waiting for you"
_REMINDER_BODY = (
    "A reported result will be finalized automatically within 24 hours unless "
    "you respond."
)
_REMINDER_ACTION_LABEL = "Review"


class RetirementOutcome(enum.Enum):
    """What ``retire_if_lapsed`` did for one match — a domain return value so the
    sweep and tests can observe the decision, and so the notification (task #6)
    can hook the ``retired`` case."""

    #: The standing result lapsed and was auto-accepted; the match is completed.
    retired = "retired"
    #: No live standing proposal bound to ``result_id`` (a counter superseded it,
    #: it was already accepted, or none stands) — a no-op.
    superseded = "superseded"
    #: There is a standing proposal but its deadline is unset or still in the
    #: future — a no-op.
    not_yet_due = "not_yet_due"
    #: Defensive: no non-empty owing side could be resolved (e.g. a solo /
    #: player-less sentinel side). A no-op rather than a crash.
    no_owing_side = "no_owing_side"


def _eager_options() -> tuple[ExecutableOption, ...]:
    """The eager-load chain for the auto-acceptance path. Async SQLAlchemy can't
    lazy-load mid-transaction, so every collection ``accept_standing_result`` and
    the owing-side resolution touch — match_settings, league→rating_strategy,
    results, sides→players, games→score — is pulled up front.

    Note the ``league→rating_strategy`` leg: this carries its own strategy load
    because the router's shared ``match_eager_options`` no longer does (issue
    #182 — the read paths dropped it, and the router's finalize handlers load it
    explicitly via ``match_rating_eager_options``). ``_apply_rating_update`` reads
    ``league.rating_strategy``, so this worker path must load it itself or a lazy
    access here would raise ``MissingGreenlet``."""
    return (
        selectinload(Match.match_settings),
        selectinload(Match.league).selectinload(League.rating_strategy),
        selectinload(Match.results),
        selectinload(Match.sides).selectinload(MatchSide.players),
        selectinload(Match.games).selectinload(MatchGame.score),
    )


async def _lock_match_row(db: AsyncSession, match_id: uuid.UUID) -> None:
    """Take the transaction-scoped row lock on the ``matches`` row (blocking
    ``SELECT matches.id ... FOR UPDATE``) so this auto-acceptance serializes
    against concurrent propose/accept transitions and other sweep workers.

    A concurrent manual acceptance holds this lock until it commits; we then
    block, re-read the post-image, and our standing-result guard returns a clean
    ``superseded`` — the rating change is applied exactly once (mirrors the
    router's ``_lock_match_row`` for issue #365)."""
    await db.execute(select(Match.id).where(Match.id == match_id).with_for_update())


async def _load_match(db: AsyncSession, match_id: uuid.UUID) -> Match | None:
    result = await db.execute(
        select(Match).where(Match.id == match_id).options(*_eager_options())
    )
    return result.scalar_one_or_none()


def _owing_side(match: Match, submitter_id: uuid.UUID) -> MatchSide | None:
    """The side that owes acceptance: the one whose players do **not** include
    the standing result's submitter. Returns ``None`` if no such side has a
    player (defensive against a solo / player-less sentinel side)."""
    for side in match.sides:
        if not side.players:
            continue
        if any(p.user_id == submitter_id for p in side.players):
            continue
        return side
    return None


def _notify_owing(
    notifications: NotificationService,
    match_id: uuid.UUID,
    owing_user_ids: list[uuid.UUID],
    *,
    title: str,
    body: str,
    action_label: str,
    result_id: uuid.UUID | None,
) -> None:
    """Fire-and-forget one notification per owing-side player. Reuses the
    ``RESULT_CONFIRM`` category the propose/accept prompts already file under
    (a dedicated "retirement" category would need a seeded ``notification_types``
    row via migration + conftest + MSW factory — out of scope here). Deep-links
    to the match. Enqueue is best-effort — ``enqueue_notification`` swallows a
    Redis hiccup — so it never sinks the sweep.

    ``result_id`` has no default: each caller must say explicitly whether this
    notice is *hideable* (issue #1583). ``remind_if_due``'s reminder is still
    asking about a live standing result, so it binds one; ``retire_if_lapsed``'s
    "Match finalized" is a closed-loop FYI (the match is already done) and
    passes ``None`` so it's never hidden."""
    for user_id in owing_user_ids:
        notifications.enqueue_notification(
            NotificationJob(
                user_id=user_id,
                category=NotificationCategory.RESULT_CONFIRM,
                title=title,
                body=body,
                link=f"/matches/{match_id}",
                action_label=action_label,
                collapse_id=f"result-confirm:{match_id}",
                result_id=result_id,
            )
        )


async def retire_if_lapsed(
    db: AsyncSession,
    match_id: uuid.UUID,
    result_id: uuid.UUID,
    notifications: NotificationService,
) -> RetirementOutcome:
    """Auto-accept the standing result ``result_id`` on ``match_id`` iff it has
    lapsed, all under the match row lock. Commits on retirement; rolls back on
    any no-op so the ``FOR UPDATE`` lock is released immediately (a sweep runs
    every candidate on one session — a held lock would block a concurrent user
    accept on a skipped match until the next commit).

    Binds the acceptance to the specific ``result_id`` (ADR 0007): if the live
    standing head is no longer ``result_id`` — a counter superseded it, it was
    accepted meanwhile, or none stands — this is a no-op (``superseded``). If the
    deadline is unset or still in the future, no-op (``not_yet_due``). Otherwise
    it resolves an acceptor on the owing side (never the submitter's side, never
    a blind ``players[0]``) and delegates to ``accept_standing_result``.
    """
    await _lock_match_row(db, match_id)
    match = await _load_match(db, match_id)
    if match is None:
        await db.rollback()
        return RetirementOutcome.superseded

    standing = standing_result(match)
    if standing is None or standing.id != result_id:
        await db.rollback()
        return RetirementOutcome.superseded

    deadline = retirement_deadline(match)
    if deadline is None or deadline > datetime.now(UTC):
        await db.rollback()
        return RetirementOutcome.not_yet_due

    owing = _owing_side(match, standing.submitted_by_user_id)
    if owing is None:
        await db.rollback()
        return RetirementOutcome.no_owing_side

    # Capture the recipients before the commit so the fire-and-forget enqueue
    # below can't trip an async lazy-load on an expired collection.
    owing_user_ids = [player.user_id for player in owing.players]

    await accept_standing_result(
        db,
        match,
        result_id=result_id,
        accepted_by_user_id=owing.players[0].user_id,
    )
    await db.commit()
    # Only the owing party is told the match was finalized on their non-response;
    # the proposer already learns of completion through the normal result flow.
    _notify_owing(
        notifications,
        match_id,
        owing_user_ids,
        title=_RETIRED_TITLE,
        body=_RETIRED_BODY,
        action_label=_RETIRED_ACTION_LABEL,
        # FYI notice: the match is already finalized, so there's nothing left
        # to review — never hideable.
        result_id=None,
    )
    return RetirementOutcome.retired


async def sweep_lapsed_retirements(
    db: AsyncSession, notifications: NotificationService
) -> list[RetirementOutcome]:
    """Find every match with a lapsed standing head and try to retire each one,
    each under its own lock. Returns the per-match outcomes.

    The SQL filter is deliberately loose — in_progress, a retirement window set,
    and at least one posted result — and the precise "is it actually lapsed?"
    decision is a Python re-check (``standing_result`` + ``retirement_deadline``)
    made authoritatively inside ``retire_if_lapsed`` under the lock. Candidate ids
    are collected first, then retired one at a time (each ``retire_if_lapsed``
    owns its own commit)."""
    candidate_ids = (
        (
            await db.execute(
                select(Match.id)
                .join(MatchSettings, MatchSettings.id == Match.match_settings_id)
                .where(
                    Match.status == MatchStatus.in_progress,
                    MatchSettings.retirement_window.is_not(None),
                    exists().where(MatchResult.match_id == Match.id),
                )
            )
        )
        .scalars()
        .all()
    )

    to_retire: list[tuple[uuid.UUID, uuid.UUID]] = []
    for match_id in candidate_ids:
        match = await _load_match(db, match_id)
        if match is None:
            continue
        standing = standing_result(match)
        if standing is None:
            continue
        deadline = retirement_deadline(match)
        if deadline is None or deadline > datetime.now(UTC):
            continue
        to_retire.append((match_id, standing.id))

    outcomes: list[RetirementOutcome] = []
    for match_id, result_id in to_retire:
        outcomes.append(await retire_if_lapsed(db, match_id, result_id, notifications))
    return outcomes


async def sweep_due_reminders(
    db: AsyncSession, notifications: NotificationService
) -> int:
    """Send the single "your retirement window is closing" reminder to the owing
    party for every match whose standing result's deadline falls inside the next
    ``REMINDER_LEAD`` (24h) and is still in the future, and which hasn't already
    been reminded (``reminder_sent_at IS NULL``). Returns how many matches were
    reminded.

    At-most-once is guaranteed by the ``reminder_sent_at`` marker: this stamps it
    and commits, so a subsequent sweep tick re-reads it set and skips — the daily
    sweep never re-sends. **Assumes the sweep runs at least daily** (task #9's
    trigger); the reminder is a best-effort courtesy, not a hard SLA.

    Like ``sweep_lapsed_retirements`` the SQL filter is deliberately loose
    (in_progress, a window set, at least one posted result) and the precise "is a
    reminder actually due?" decision is a Python re-check under the row lock in
    ``remind_if_due``."""
    candidate_ids = (
        (
            await db.execute(
                select(Match.id)
                .join(MatchSettings, MatchSettings.id == Match.match_settings_id)
                .where(
                    Match.status == MatchStatus.in_progress,
                    MatchSettings.retirement_window.is_not(None),
                    exists().where(MatchResult.match_id == Match.id),
                )
            )
        )
        .scalars()
        .all()
    )

    reminded = 0
    for match_id in candidate_ids:
        if await remind_if_due(db, match_id, notifications):
            reminded += 1
    return reminded


async def remind_if_due(
    db: AsyncSession, match_id: uuid.UUID, notifications: NotificationService
) -> bool:
    """Send the deadline-nearing reminder for one match iff it is due, under the
    match row lock (serializing the ``reminder_sent_at`` stamp against a
    concurrent accept/retire on the same match). Returns whether it sent.

    A reminder is due when there is a standing proposal whose ``reminder_sent_at``
    is unset and whose retirement deadline is still in the future but within
    ``REMINDER_LEAD``. Commits the marker on send; rolls back on any no-op so the
    ``FOR UPDATE`` lock is released immediately (mirrors ``retire_if_lapsed``)."""
    await _lock_match_row(db, match_id)
    match = await _load_match(db, match_id)
    if match is None:
        await db.rollback()
        return False

    standing = standing_result(match)
    if standing is None or standing.reminder_sent_at is not None:
        await db.rollback()
        return False

    deadline = retirement_deadline(match)
    now = datetime.now(UTC)
    if deadline is None or deadline <= now or deadline > now + REMINDER_LEAD:
        await db.rollback()
        return False

    owing = _owing_side(match, standing.submitted_by_user_id)
    if owing is None:
        await db.rollback()
        return False

    owing_user_ids = [player.user_id for player in owing.players]
    # Capture before the commit too, mirroring owing_user_ids above.
    standing_result_id = standing.id
    standing.reminder_sent_at = now
    await db.commit()
    _notify_owing(
        notifications,
        match_id,
        owing_user_ids,
        title=_REMINDER_TITLE,
        body=_REMINDER_BODY,
        action_label=_REMINDER_ACTION_LABEL,
        # Hideable: still asking about a live standing result, so binds it.
        result_id=standing_result_id,
    )
    return True


def run_retirement_sweep() -> None:
    """RQ entry point. Sweep all matches for lapsed standing results and
    auto-accept them, then send any due deadline-nearing reminders. Sync wrapper
    (RQ workers can't call async) that owns its own session, mirroring
    ``app.ratings.jobs`` / ``app.notifications.jobs``."""
    asyncio.run(_run_retirement_sweep())


async def _run_retirement_sweep() -> None:
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as db:
        notifications = NotificationService(db, push_sender_from_env())
        await sweep_lapsed_retirements(db, notifications)
        await sweep_due_reminders(db, notifications)
