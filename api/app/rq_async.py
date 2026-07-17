"""Shared plumbing for RQ jobs with async bodies.

RQ workers are synchronous, so every async job in the repo needs the same
sync-entry-point dance; it lives here once so the entry points stay thin
(``app.schedule_solves.run_schedule_solve``, ``app.match_calls.run_pin_tick``).
"""

import asyncio
import threading
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from app.db import get_database_url


def run_async_job(
    name: str, coro_factory: Callable[[], Coroutine[Any, Any, None]]
) -> None:
    """Run an async job body from a sync RQ entry point.

    In the worker there is no running loop and ``asyncio.run`` is used
    directly. Under the tests' *synchronous* fake queue the job executes
    inline at enqueue time inside an async test — a loop is already running,
    and ``asyncio.run`` would refuse — so a fresh thread (named ``name``, for
    debuggability) hosts the job's own loop instead, relaying any error back
    to the calling thread so a failing job still fails its caller.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(coro_factory())
        return

    errors: list[Exception] = []

    def _run_on_own_loop() -> None:
        try:
            asyncio.run(coro_factory())
        except Exception as exc:  # noqa: BLE001 -- re-raised on the caller's thread below
            errors.append(exc)

    thread = threading.Thread(target=_run_on_own_loop, name=name)
    thread.start()
    thread.join()
    if errors:
        raise errors[0]


def run_async_db_job(
    name: str,
    body: Callable[[async_sessionmaker[AsyncSession]], Awaitable[None]],
) -> None:
    """:func:`run_async_job` plus a per-run engine: created from
    ``DATABASE_URL`` with ``NullPool`` and disposed at the end, so the job's
    connections live and die on the loop that made them (an engine shared
    across loops would hand out connections bound to a dead loop)."""
    run_async_job(name, lambda: _run_with_fresh_engine(body))


async def _run_with_fresh_engine(
    body: Callable[[async_sessionmaker[AsyncSession]], Awaitable[None]],
) -> None:
    engine = create_async_engine(get_database_url(), poolclass=NullPool)
    try:
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        await body(sessionmaker)
    finally:
        await engine.dispose()
