"""Request required work in the caller's transaction; inspect its durable progress."""

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from redis.exceptions import RedisError
from rq.timeouts import JobTimeoutException
from sqlalchemy import case, delete, event, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import Session, SessionTransaction

from app import queue as queue_module
from app.config import get_settings
from app.models.required_repair import RepairAttempt, RepairState, RequiredRepair


async def request_rating(db: AsyncSession, player_id: uuid.UUID) -> uuid.UUID:
    statement = insert(RequiredRepair).values(player_id=player_id)
    repair_id = (
        await db.execute(
            statement.on_conflict_do_update(
                index_elements=[RequiredRepair.player_id],
                set_={
                    "requested_generation": RequiredRepair.requested_generation + 1,
                    "state": case(
                        (
                            RequiredRepair.state == RepairState.running,
                            RepairState.running.value,
                        ),
                        else_=RepairState.pending.value,
                    ).cast(RequiredRepair.state.type),
                    "completed_at": None,
                    "available_at": func.now(),
                    "failures": 0,
                },
            ).returning(RequiredRepair.id)
        )
    ).scalar_one()
    _stage(db, "rating", repair_id)
    return repair_id


async def inspect(db: AsyncSession, repair_id: uuid.UUID) -> RequiredRepair | None:
    return await db.get(RequiredRepair, repair_id, populate_existing=True)


@dataclass(frozen=True)
class Claim:
    repair_id: uuid.UUID
    token: uuid.UUID
    generation: int


async def claim(
    db: AsyncSession, repair_id: uuid.UUID, *, now: datetime
) -> Claim | None:
    row = await db.scalar(
        select(RequiredRepair)
        .where(RequiredRepair.id == repair_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None or row.state in (RepairState.completed, RepairState.failed):
        return None
    if row.state is RepairState.running:
        if row.lease_until is None or row.lease_until > now:
            return None
        await db.execute(
            update(RepairAttempt)
            .where(RepairAttempt.id == row.claim_token)
            .values(outcome="expired", finished_at=now, error="worker lease expired")
        )
    if row.available_at > now:
        return None
    token = uuid.uuid4()
    row.state = RepairState.running
    row.claim_token = token
    row.lease_until = now + timedelta(
        seconds=max(900, get_settings().solver_time_cap_s * 6)
    )
    db.add(
        RepairAttempt(
            id=token,
            repair_id=row.id,
            generation=row.requested_generation,
            started_at=now,
        )
    )
    await db.flush()
    return Claim(row.id, token, row.requested_generation)


async def lock_claim(
    db: AsyncSession, claim: Claim, *, now: datetime
) -> RequiredRepair | None:
    return (
        await db.scalars(
            select(RequiredRepair)
            .where(
                RequiredRepair.id == claim.repair_id,
                RequiredRepair.claim_token == claim.token,
                RequiredRepair.lease_until > now,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).one_or_none()


async def complete(db: AsyncSession, claim: Claim, *, now: datetime) -> bool:
    row = await lock_claim(db, claim, now=now)
    if row is None:
        return False
    await db.execute(
        update(RepairAttempt)
        .where(RepairAttempt.id == claim.token)
        .values(outcome="completed", finished_at=now)
    )
    row.available_at = now
    row.completed_generation = claim.generation
    row.state = (
        RepairState.completed
        if row.requested_generation == claim.generation
        else RepairState.pending
    )
    row.completed_at = now if row.state is RepairState.completed else None
    row.claim_token = None
    row.lease_until = None
    await db.flush()
    return True


async def attempts(db: AsyncSession, repair_id: uuid.UUID) -> list[RepairAttempt]:
    return list(
        await db.scalars(
            select(RepairAttempt)
            .where(RepairAttempt.repair_id == repair_id)
            .order_by(RepairAttempt.started_at, RepairAttempt.id)
        )
    )


log = logging.getLogger(__name__)


async def fail(
    db: AsyncSession, claim: Claim, *, error: str, permanent: bool, now: datetime
) -> bool:
    row = await lock_claim(db, claim, now=now)
    if row is None:
        return False
    await db.execute(
        update(RepairAttempt)
        .where(RepairAttempt.id == claim.token)
        .values(
            outcome="permanent" if permanent else "transient",
            finished_at=now,
            error=error,
        )
    )
    newer = row.requested_generation > claim.generation
    row.state = RepairState.failed if permanent and not newer else RepairState.pending
    row.failures += 1
    row.last_error = error
    row.available_at = (
        now
        if newer
        else now + timedelta(seconds=min(3600, 30 * 2 ** min(row.failures - 1, 7)))
    )
    row.claim_token = None
    row.lease_until = None
    log.error(
        "Required repair attempt failed",
        extra={
            "repair_id": str(row.id),
            "generation": claim.generation,
            "permanent": permanent,
            "repair_error": error,
        },
    )
    await db.flush()
    return True


async def failed(db: AsyncSession) -> list[RequiredRepair]:
    return list(
        await db.scalars(
            select(RequiredRepair)
            .where(RequiredRepair.state == RepairState.failed)
            .order_by(RequiredRepair.id)
        )
    )


async def retry(db: AsyncSession, repair_id: uuid.UUID, *, now: datetime) -> bool:
    row = await db.scalar(
        select(RequiredRepair)
        .where(RequiredRepair.id == repair_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None or row.state is not RepairState.failed:
        return False
    row.state = RepairState.pending
    row.available_at = now
    row.failures = 0
    await db.flush()
    return True


async def request_schedule(db: AsyncSession, tournament_id: uuid.UUID) -> uuid.UUID:
    statement = insert(RequiredRepair).values(tournament_id=tournament_id)
    repair_id = (
        await db.execute(
            statement.on_conflict_do_update(
                index_elements=[RequiredRepair.tournament_id],
                set_={
                    "requested_generation": RequiredRepair.requested_generation + 1,
                    "state": case(
                        (
                            RequiredRepair.state == RepairState.running,
                            RepairState.running.value,
                        ),
                        else_=RepairState.pending.value,
                    ).cast(RequiredRepair.state.type),
                    "completed_at": None,
                    "available_at": func.now(),
                    "failures": 0,
                },
            ).returning(RequiredRepair.id)
        )
    ).scalar_one()
    return repair_id


@dataclass(frozen=True)
class Dispatch:
    kind: Literal["rating", "schedule"]
    target: uuid.UUID


_STAGED = "app.required_repairs.dispatch"


def _stage(
    db: AsyncSession, kind: Literal["rating", "schedule"], target: uuid.UUID
) -> None:
    transaction = (
        db.sync_session.get_nested_transaction() or db.sync_session.get_transaction()
    )
    staged: dict[SessionTransaction | None, set[Dispatch]] = db.info.setdefault(
        _STAGED, {}
    )
    staged.setdefault(transaction, set()).add(Dispatch(kind, target))


def _enqueue(dispatch: Dispatch) -> None:
    if dispatch.kind == "schedule":
        queue_module.get_queue().enqueue(
            "app.schedule_solves.run_schedule_solve",
            str(dispatch.target),
            job_timeout=int(get_settings().solver_time_cap_s) + 60,
        )
    else:
        queue_module.get_ratings_queue().enqueue(
            "app.required_repairs.run_rating",
            str(dispatch.target),
            job_timeout=900,
            result_ttl=60,
            failure_ttl=86400,
        )


@event.listens_for(Session, "after_commit")
def _dispatch_committed(session: Session) -> None:
    if session.in_nested_transaction():
        return
    staged: dict[SessionTransaction | None, set[Dispatch]] = session.info.pop(
        _STAGED, {}
    )
    for dispatch in set().union(*staged.values()):
        try:
            _enqueue(dispatch)
        except (
            Exception
        ):  # post-commit boundary: never report a committed mutation as failed
            log.exception(
                "Required repair immediate dispatch failed",
                extra={"repair_target": str(dispatch.target)},
            )


@event.listens_for(Session, "after_soft_rollback")
def _discard_dispatch(
    session: Session, previous_transaction: SessionTransaction
) -> None:
    staged: dict[SessionTransaction | None, set[Dispatch]] = session.info.get(
        _STAGED, {}
    )
    if previous_transaction.parent is None:
        session.info.pop(_STAGED, None)
    else:
        for transaction in list(staged):
            ancestor = transaction
            while ancestor is not None:
                if ancestor is previous_transaction:
                    staged.pop(transaction, None)
                    break
                ancestor = ancestor.parent


async def for_tournament(
    db: AsyncSession, tournament_id: uuid.UUID
) -> RequiredRepair | None:
    return (
        await db.scalars(
            select(RequiredRepair)
            .where(RequiredRepair.tournament_id == tournament_id)
            .execution_options(populate_existing=True)
        )
    ).one_or_none()


async def recover(factory: async_sessionmaker[AsyncSession], *, now: datetime) -> int:
    """Dispatch a bounded batch; Redis delivery remains an unacknowledged hint."""
    from app.models import ScheduleSolve

    count = 0
    async with factory() as db:
        rows = list(
            await db.scalars(
                select(RequiredRepair)
                .where(
                    or_(
                        RequiredRepair.state == RepairState.pending,
                        (RequiredRepair.state == RepairState.running)
                        & (RequiredRepair.lease_until <= now),
                    ),
                    RequiredRepair.available_at <= now,
                    RequiredRepair.dispatch_after <= now,
                )
                .order_by(RequiredRepair.dispatch_after, RequiredRepair.id)
                .limit(100)
                .with_for_update(skip_locked=True)
            )
        )
        dispatches = []
        for row in rows:
            row.dispatch_after = now + timedelta(seconds=30)
            if row.tournament_id is not None:
                solve_id = await db.scalar(
                    select(ScheduleSolve.id)
                    .where(ScheduleSolve.tournament_id == row.tournament_id)
                    .order_by(
                        ScheduleSolve.requested_at.desc(), ScheduleSolve.id.desc()
                    )
                    .limit(1)
                )
                if solve_id is not None:
                    dispatches.append(Dispatch("schedule", solve_id))
            else:
                dispatches.append(Dispatch("rating", row.id))
        # Release locks before queue I/O; losing this process after commit costs
        # at most the scan interval. The database requirement remains pending.
        await db.commit()
    for dispatch in dispatches:
        try:
            _enqueue(dispatch)
            count += 1
        except (RedisError, OSError):
            log.exception(
                "Required repair recovery dispatch failed",
                extra={"repair_target": str(dispatch.target)},
            )
    return count


async def recovery_loop(
    factory: async_sessionmaker[AsyncSession] | None = None,
) -> None:
    from app.db import get_sessionmaker

    factory = factory or get_sessionmaker()
    while True:
        try:
            await recover(factory, now=datetime.now(UTC))
            async with factory() as session:
                await prune(session, now=datetime.now(UTC))
                await session.commit()
        except (
            Exception
        ):  # long-lived recovery boundary; cancellation inherits BaseException
            log.exception("Required repair recovery scan failed")
        await asyncio.sleep(30)


def stage_schedule(db: AsyncSession, solve_id: uuid.UUID) -> None:
    _stage(db, "schedule", solve_id)


async def for_player(db: AsyncSession, player_id: uuid.UUID) -> RequiredRepair | None:
    return (
        await db.scalars(
            select(RequiredRepair)
            .where(RequiredRepair.player_id == player_id)
            .execution_options(populate_existing=True)
        )
    ).one_or_none()


def run_rating(repair_id: str) -> None:
    from app.rq_async import run_async_db_job

    identifier = uuid.UUID(repair_id)
    run_async_db_job(
        f"rating-repair-{identifier}",
        lambda factory: execute_rating(factory, identifier),
    )


async def execute_rating(
    factory: async_sessionmaker[AsyncSession], repair_id: uuid.UUID
) -> None:
    from app.ratings.jobs import _recompute_after_merge

    async with factory() as db:
        ownership = await claim(db, repair_id, now=datetime.now(UTC))
        if ownership is None:
            return
        row = await inspect(db, repair_id)
        if row is None or row.player_id is None:
            return
        player_id = row.player_id
        await db.commit()
    try:
        await _recompute_after_merge(player_id, factory=factory, ownership=ownership)
    except (
        Exception
    ) as exc:  # worker boundary: preserve every unexpected failure for operator retry
        async with factory() as db:
            await fail(
                db,
                ownership,
                error=str(exc) or type(exc).__name__,
                permanent=not is_transient(exc),
                now=datetime.now(UTC),
            )
            await db.commit()


def is_transient(error: Exception) -> bool:
    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.exc import TimeoutError as PoolTimeout

    if isinstance(error, (OSError, RedisError, PoolTimeout, JobTimeoutException)):
        return True
    if isinstance(error, DBAPIError):
        code = getattr(error.orig, "sqlstate", None)
        return error.connection_invalidated or (
            isinstance(code, str)
            and (
                code.startswith("08")
                or code in {"40001", "40P01", "53300", "57P01", "57P02", "57P03"}
            )
        )
    return False


async def prune(db: AsyncSession, *, now: datetime) -> None:
    """Completed operational state is disposable after thirty days."""
    await db.execute(
        delete(RepairAttempt).where(
            RepairAttempt.repair_id == RequiredRepair.id,
            RepairAttempt.generation <= RequiredRepair.completed_generation,
            RepairAttempt.finished_at < now - timedelta(days=30),
        )
    )
    await db.execute(
        delete(RequiredRepair).where(
            RequiredRepair.state == RepairState.completed,
            RequiredRepair.completed_at < now - timedelta(days=30),
        )
    )
