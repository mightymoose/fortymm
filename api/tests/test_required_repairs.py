"""Required work survives transport failure and transaction boundaries."""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import async_sessionmaker

from app import required_repairs
from tests._helpers import make_user


async def test_requested_repair_is_visible_only_after_commit(db_session, engine):
    user = await make_user(db_session, "repair-player")
    await db_session.commit()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    async with factory() as reader:
        assert await required_repairs.inspect(reader, repair_id) is None
    await db_session.commit()
    async with factory() as reader:
        repair = await required_repairs.inspect(reader, repair_id)
        assert repair is not None
        assert repair.requested_generation == 1
        assert repair.completed_generation == 0


async def test_completion_of_claimed_generation_leaves_new_mutation_pending(db_session):
    user = await make_user(db_session, "generations")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    now = datetime.now(UTC)
    claim = await required_repairs.claim(db_session, repair_id, now=now)
    await db_session.commit()
    assert claim is not None
    assert (
        await required_repairs.request_rating(db_session, user.player_id) == repair_id
    )
    await db_session.commit()
    assert await required_repairs.complete(db_session, claim, now=now)
    await db_session.commit()
    repair = await required_repairs.inspect(db_session, repair_id)
    assert repair.completed_generation == 1
    assert repair.requested_generation == 2
    assert await required_repairs.claim(db_session, repair_id, now=now) is not None


async def test_expired_worker_cannot_complete_reclaimed_work(db_session):
    user = await make_user(db_session, "lease")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    now = datetime.now(UTC)
    abandoned = await required_repairs.claim(db_session, repair_id, now=now)
    await db_session.commit()
    assert await required_repairs.claim(db_session, repair_id, now=now) is None
    later = now + timedelta(hours=1)
    replacement = await required_repairs.claim(db_session, repair_id, now=later)
    assert replacement is not None
    assert replacement.token != abandoned.token
    assert not await required_repairs.complete(db_session, abandoned, now=later)
    assert await required_repairs.complete(db_session, replacement, now=later)
    await db_session.commit()
    attempts = await required_repairs.attempts(db_session, repair_id)
    assert [attempt.outcome for attempt in attempts] == ["expired", "completed"]


async def test_failures_back_off_and_permanent_failure_needs_retry_or_new_input(
    db_session,
):
    user = await make_user(db_session, "retry")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    now = datetime.now(UTC)
    first = await required_repairs.claim(db_session, repair_id, now=now)
    await required_repairs.fail(
        db_session, first, error="database unavailable", permanent=False, now=now
    )
    assert await required_repairs.claim(db_session, repair_id, now=now) is None
    later = now + timedelta(hours=1)
    second = await required_repairs.claim(db_session, repair_id, now=later)
    assert second is not None
    await required_repairs.fail(
        db_session, second, error="unsupported strategy", permanent=True, now=later
    )
    assert (
        await required_repairs.claim(
            db_session, repair_id, now=later + timedelta(days=1)
        )
        is None
    )
    assert [row.id for row in await required_repairs.failed(db_session)] == [repair_id]
    assert await required_repairs.retry(db_session, repair_id, now=later)
    third = await required_repairs.claim(db_session, repair_id, now=later)
    await required_repairs.fail(
        db_session, third, error="still unsupported", permanent=True, now=later
    )
    await required_repairs.request_rating(db_session, user.player_id)
    assert await required_repairs.claim(db_session, repair_id, now=later) is not None
    assert [
        a.outcome for a in await required_repairs.attempts(db_session, repair_id)
    ].count("permanent") == 2


async def test_scanner_recovers_lost_schedule_job_and_worker_records_completion(
    db_session, engine, fake_solver_queue
):
    from app.models import ScheduleSolveStatus, ScheduleSolveTrigger
    from app.schedule_solves import latest_solve, request_solve
    from tests.test_schedule_solve_service import _make_tournament

    tournament_id, _ = await _make_tournament(db_session)
    await request_solve(db_session, tournament_id, ScheduleSolveTrigger.manual)
    await db_session.commit()
    fake_solver_queue.empty()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await required_repairs.recover(
        factory, now=datetime.now(UTC) + timedelta(seconds=31)
    )
    assert len(fake_solver_queue.jobs) == 1
    job = fake_solver_queue.jobs[0]
    job.func(*job.args)
    db_session.expire_all()
    solved = await latest_solve(db_session, tournament_id)
    assert solved.status is ScheduleSolveStatus.succeeded
    repair = await required_repairs.for_tournament(db_session, tournament_id)
    assert repair.completed_generation == repair.requested_generation
    assert (await required_repairs.attempts(db_session, repair.id))[
        0
    ].outcome == "completed"


async def test_merge_commits_rating_repair_and_scanner_recovers_after_later_merge(
    db_session, engine, fake_ratings_queue
):
    from sqlalchemy import delete

    from app.account_merge import merge_user
    from app.leagues import get_default_league
    from app.models import RatingHistory, UserLeagueRating
    from app.player_summary import load_player_ratings
    from app.ratings.inputs import record_rating_input

    source = await make_user(db_session, "merge-source")
    middle = await make_user(db_session, "merge-middle")
    destination = await make_user(db_session, "merge-destination")
    league = await get_default_league(db_session)
    await record_rating_input(
        db_session,
        league.id,
        source.player_id,
        actor_account_id=source.id,
        rating=1600,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await db_session.commit()
    middle_player = middle.player_id
    destination_player = destination.player_id
    await merge_user(db_session, from_user_id=source.id, to_user_id=middle.id)
    await db_session.commit()
    first = await required_repairs.for_player(db_session, middle_player)
    assert first is not None
    await merge_user(db_session, from_user_id=middle.id, to_user_id=destination.id)
    await db_session.commit()
    await db_session.execute(delete(RatingHistory))
    await db_session.execute(delete(UserLeagueRating))
    await db_session.commit()
    fake_ratings_queue.empty()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await required_repairs.recover(
        factory, now=datetime.now(UTC) + timedelta(seconds=31)
    )
    assert len(fake_ratings_queue.jobs) == 2
    old_job = next(
        job for job in fake_ratings_queue.jobs if job.args == (str(first.id),)
    )
    old_job.func(*old_job.args)
    assert await load_player_ratings(db_session, league.id, [destination_player]) == {
        destination_player: 1600
    }
    for job in fake_ratings_queue.jobs:
        if job.id != old_job.id:
            job.func(*job.args)
    first = await required_repairs.inspect(db_session, first.id)
    last = await required_repairs.for_player(db_session, destination_player)
    assert first.completed_generation == first.requested_generation
    assert last.completed_generation == last.requested_generation


async def test_retention_expires_completed_operations_but_keeps_unresolved_failures(
    db_session,
):
    completed_user = await make_user(db_session, "completed-old")
    failed_user = await make_user(db_session, "failed-old")
    completed_id = await required_repairs.request_rating(
        db_session, completed_user.player_id
    )
    failed_id = await required_repairs.request_rating(db_session, failed_user.player_id)
    await db_session.commit()
    now = datetime.now(UTC)
    completed = await required_repairs.claim(db_session, completed_id, now=now)
    await required_repairs.complete(db_session, completed, now=now)
    failure = await required_repairs.claim(db_session, failed_id, now=now)
    await required_repairs.fail(
        db_session, failure, error="needs operator", permanent=True, now=now
    )
    await db_session.commit()
    await required_repairs.prune(db_session, now=now + timedelta(days=29))
    assert await required_repairs.inspect(db_session, completed_id) is not None
    await required_repairs.prune(db_session, now=now + timedelta(days=31))
    assert await required_repairs.inspect(db_session, completed_id) is None
    assert await required_repairs.attempts(db_session, completed_id) == []
    assert await required_repairs.inspect(db_session, failed_id) is not None
    assert len(await required_repairs.attempts(db_session, failed_id)) == 1


async def test_operator_cli_lists_and_retries_failed_repairs(
    db_session, engine, capsys
):
    from app import repair_cli

    user = await make_user(db_session, "operator")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    now = datetime.now(UTC)
    claim = await required_repairs.claim(db_session, repair_id, now=now)
    await required_repairs.fail(
        db_session, claim, error="bad strategy version", permanent=True, now=now
    )
    await db_session.commit()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    assert await repair_cli.execute(["list"], factory) == 0
    output = capsys.readouterr().out
    assert str(repair_id) in output
    assert "bad strategy version" in output
    assert await repair_cli.execute(["retry", str(repair_id)], factory) == 0
    assert await required_repairs.failed(db_session) == []
    assert len(await required_repairs.attempts(db_session, repair_id)) == 1


async def test_retention_prunes_resolved_attempts_even_when_target_has_new_work(
    db_session,
):
    user = await make_user(db_session, "busy-target")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    now = datetime.now(UTC)
    claim = await required_repairs.claim(db_session, repair_id, now=now)
    await required_repairs.complete(db_session, claim, now=now)
    await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    await required_repairs.prune(db_session, now=now + timedelta(days=31))
    assert await required_repairs.inspect(db_session, repair_id) is not None
    assert await required_repairs.attempts(db_session, repair_id) == []


async def test_savepoint_commit_does_not_dispatch_and_rollback_discards_only_inner_work(
    db_session, fake_ratings_queue
):
    outer = await make_user(db_session, "outer-work")
    inner = await make_user(db_session, "inner-work")
    first = await required_repairs.request_rating(db_session, outer.player_id)
    async with db_session.begin_nested():
        await required_repairs.request_rating(db_session, outer.player_id)
    assert fake_ratings_queue.jobs == []
    savepoint = await db_session.begin_nested()
    rolled_back = await required_repairs.request_rating(db_session, inner.player_id)
    await savepoint.rollback()
    await db_session.commit()
    assert [job.args for job in fake_ratings_queue.jobs] == [(str(first),)]
    assert await required_repairs.inspect(db_session, rolled_back) is None
    fake_ratings_queue.empty()
    await required_repairs.request_rating(db_session, outer.player_id)
    await db_session.rollback()
    await db_session.commit()
    assert fake_ratings_queue.jobs == []


async def test_concurrent_scanners_skip_locked_work_and_dispatch_only_one_batch(
    db_session, engine, fake_ratings_queue
):
    import asyncio

    from sqlalchemy import select

    from app.models.required_repair import RequiredRepair

    user = await make_user(db_session, "scanner-lock")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    fake_ratings_queue.empty()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(UTC) + timedelta(seconds=31)
    async with factory() as gate:
        await gate.execute(
            select(RequiredRepair)
            .where(RequiredRepair.id == repair_id)
            .with_for_update()
        )
        assert (
            await asyncio.wait_for(
                required_repairs.recover(factory, now=now), timeout=1
            )
            == 0
        )
        assert fake_ratings_queue.jobs == []
        await gate.rollback()
    results = await asyncio.gather(
        required_repairs.recover(factory, now=now),
        required_repairs.recover(factory, now=now),
    )
    assert sum(results) == 1
    assert len(fake_ratings_queue.jobs) == 1


async def test_recovery_loop_survives_unexpected_dispatch_error_but_honors_cancellation(
    db_session, engine, fake_ratings_queue, monkeypatch
):
    import asyncio

    import pytest

    user = await make_user(db_session, "recovery-loop")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    fake_ratings_queue.empty()
    calls = 0
    sleeps = 0
    enqueue = fake_ratings_queue.enqueue
    now = datetime.now(UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now + timedelta(seconds=31 * (sleeps + 1))

    def intermittent_queue(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("broken queue adapter")
        return enqueue(*args, **kwargs)

    async def no_wait(seconds):
        nonlocal sleeps
        sleeps += 1
        if sleeps == 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(fake_ratings_queue, "enqueue", intermittent_queue)
    monkeypatch.setattr(required_repairs, "datetime", Clock)
    monkeypatch.setattr(required_repairs.asyncio, "sleep", no_wait)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    with pytest.raises(asyncio.CancelledError):
        await required_repairs.recovery_loop(factory)
    assert calls == 2
    assert [job.args for job in fake_ratings_queue.jobs] == [(str(repair_id),)]
    repair = await required_repairs.inspect(db_session, repair_id)
    assert repair.completed_generation == 0


async def test_database_rejects_invalid_repair_targets_states_and_generations(
    db_session,
):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    user = await make_user(db_session, "sql-constraints")
    for columns, values in [
        ("player_id", "NULL"),
        ("player_id, requested_generation", ":player, 0"),
        ("player_id, completed_generation", ":player, 2"),
        ("player_id, state", ":player, 'completed'"),
        ("player_id, state", ":player, 'running'"),
        ("player_id, failures", ":player, -1"),
        ("player_id", "gen_random_uuid()"),
    ]:
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(f"INSERT INTO required_repairs ({columns}) VALUES ({values})"),
                    {"player": user.player_id},
                )
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    for columns, values in [
        ("generation, outcome", "0, 'running'"),
        ("generation, outcome", "1, 'bogus'"),
        ("generation, outcome", "1, 'completed'"),
        ("generation, outcome, finished_at", "1, 'running', now()"),
    ]:
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(
                        f"INSERT INTO required_repair_attempts "
                        f"(id,repair_id,started_at,{columns}) "
                        f"VALUES (gen_random_uuid(),:repair,now(),{values})"
                    ),
                    {"repair": repair_id},
                )


async def test_worker_recovers_active_solve_even_when_its_request_timestamp_is_older(
    db_session, fake_solver_queue
):
    from app.models import ScheduleSolve, ScheduleSolveStatus, ScheduleSolveTrigger
    from app.schedule_solves import latest_solve, request_solve
    from tests.test_schedule_solve_service import _make_tournament

    tournament_id, _ = await _make_tournament(db_session)
    active = await request_solve(db_session, tournament_id, ScheduleSolveTrigger.manual)
    # Transaction timestamps need not follow commit order. A terminal ledger
    # row may therefore have a newer requested_at than the actual pending work.
    db_session.add(
        ScheduleSolve(
            tournament_id=tournament_id,
            trigger=ScheduleSolveTrigger.manual,
            status=ScheduleSolveStatus.failed,
            error="previous run",
            requested_at=datetime.now(UTC) + timedelta(seconds=1),
        )
    )
    await db_session.commit()
    assert (await latest_solve(db_session, tournament_id)).id == active.id
    job = fake_solver_queue.jobs[0]
    job.func(*job.args)
    await db_session.refresh(active)
    assert active.status is ScheduleSolveStatus.succeeded


async def test_schedule_worker_timeout_remains_eligible_for_recovery(
    db_session, fake_solver_queue, monkeypatch
):
    from rq.timeouts import JobTimeoutException

    from app import schedule_solves
    from app.models import ScheduleSolveTrigger
    from app.models.required_repair import RepairState
    from tests.test_schedule_solve_service import _make_tournament

    tournament_id, _ = await _make_tournament(db_session)
    await schedule_solves.request_solve(
        db_session, tournament_id, ScheduleSolveTrigger.manual
    )
    await db_session.commit()

    def timed_out(*args, **kwargs):
        raise JobTimeoutException("worker time budget exhausted")

    monkeypatch.setattr(schedule_solves, "_solve", timed_out)
    job = fake_solver_queue.jobs[0]
    job.func(*job.args)
    repair = await required_repairs.for_tournament(db_session, tournament_id)
    assert repair.state is RepairState.pending
    assert repair.completed_generation == 0
    assert (await required_repairs.attempts(db_session, repair.id))[
        0
    ].outcome == "transient"

    latest = await schedule_solves.latest_solve(db_session, tournament_id)
    assert latest.status.value == "queued"


async def test_stale_schedule_worker_cannot_apply_after_its_lease_is_reclaimed(
    db_session, fake_solver_queue, monkeypatch
):
    from app import schedule_solves
    from app.models import ScheduleSolveStatus, ScheduleSolveTrigger
    from app.rq_async import run_async_db_job
    from tests.test_schedule_solve_service import _make_tournament

    tournament_id, _ = await _make_tournament(db_session, materialize=True)
    ledger = await schedule_solves.request_solve(
        db_session, tournament_id, ScheduleSolveTrigger.manual
    )
    await db_session.commit()
    repair = await required_repairs.for_tournament(db_session, tournament_id)
    real_solver = schedule_solves._solve

    async def reclaim(factory):
        async with factory() as session:
            replacement = await required_repairs.claim(
                session, repair.id, now=datetime.now(UTC) + timedelta(hours=1)
            )
            assert replacement is not None
            await session.commit()

    def solve_then_lose_lease(*args, **kwargs):
        result = real_solver(*args, **kwargs)
        run_async_db_job("reclaim-solve-test", reclaim)
        return result

    monkeypatch.setattr(schedule_solves, "_solve", solve_then_lose_lease)
    job = fake_solver_queue.jobs[0]
    job.func(*job.args)
    await db_session.refresh(ledger)
    assert ledger.status is ScheduleSolveStatus.running
    repair = await required_repairs.inspect(db_session, repair.id)
    assert repair.completed_generation == 0
    assert [
        a.outcome for a in await required_repairs.attempts(db_session, repair.id)
    ] == ["expired", "running"]


async def test_two_workers_contending_for_one_repair_only_claim_once(
    db_session, engine
):
    import asyncio

    from sqlalchemy import select

    from app.models.required_repair import RequiredRepair

    user = await make_user(db_session, "claim-contention")
    repair_id = await required_repairs.request_rating(db_session, user.player_id)
    await db_session.commit()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(UTC)

    async def worker():
        async with factory() as session:
            ownership = await required_repairs.claim(session, repair_id, now=now)
            await session.commit()
            return ownership

    async with factory() as gate:
        await gate.execute(
            select(RequiredRepair)
            .where(RequiredRepair.id == repair_id)
            .with_for_update()
        )
        contenders = [asyncio.create_task(worker()), asyncio.create_task(worker())]
        try:
            done, _ = await asyncio.wait(contenders, timeout=0.15)
            assert not done
        finally:
            await gate.rollback()
        results = await asyncio.gather(*contenders)
    assert sum(result is not None for result in results) == 1
    assert len(await required_repairs.attempts(db_session, repair_id)) == 1


async def test_reading_stale_durable_solve_keeps_polling_until_recovery(db_session):
    from app import schedule_solves
    from app.models import ScheduleSolveStatus, ScheduleSolveTrigger
    from tests.test_schedule_solve_service import _make_tournament

    tournament_id, _ = await _make_tournament(db_session)
    ledger = await schedule_solves.request_solve(
        db_session, tournament_id, ScheduleSolveTrigger.manual
    )
    ledger.status = ScheduleSolveStatus.running
    ledger.started_at = datetime.now(UTC) - timedelta(hours=1)
    await db_session.commit()
    latest = await schedule_solves.latest_solve(db_session, tournament_id)
    assert latest.status is ScheduleSolveStatus.running


async def test_new_request_respects_persisted_worker_lease_when_time_cap_changes(
    db_session, monkeypatch
):
    from app import schedule_solves
    from app.models import ScheduleSolveStatus, ScheduleSolveTrigger
    from tests.test_schedule_solve_service import _make_tournament

    tournament_id, _ = await _make_tournament(db_session)
    ledger = await schedule_solves.request_solve(
        db_session, tournament_id, ScheduleSolveTrigger.manual
    )
    await db_session.commit()
    repair = await required_repairs.for_tournament(db_session, tournament_id)
    monkeypatch.setenv("SOLVER_TIME_CAP_S", "600")
    claim = await required_repairs.claim(db_session, repair.id, now=datetime.now(UTC))
    ledger.status = ScheduleSolveStatus.running
    ledger.started_at = datetime.now(UTC) - timedelta(minutes=20)
    await db_session.commit()
    monkeypatch.setenv("SOLVER_TIME_CAP_S", "10")
    result = await schedule_solves.request_solve(
        db_session, tournament_id, ScheduleSolveTrigger.settings_changed
    )
    assert result.id == ledger.id
    assert result.status is ScheduleSolveStatus.running
    assert (
        await required_repairs.lock_claim(db_session, claim, now=datetime.now(UTC))
        is not None
    )
