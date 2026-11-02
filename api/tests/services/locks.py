"""Run two transactions so that one waits for the other's lock."""

import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker


def backend_waits_for_a_lock(database: Engine, pid: int) -> bool:
    with database.connect() as connection:
        wait: str | None = connection.scalar(
            text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"),
            {"pid": pid},
        )
        return wait == "Lock"


def wait_behind[H, W](
    database: Engine,
    holder: Callable[[Session], H],
    waiter: Callable[[Session], W],
    then: Callable[[Session], None] | None = None,
) -> tuple[H, Future[W]]:
    """Run `holder` in an open transaction, then `waiter` in another one on
    another thread. Once the waiter waits for a lock, runs `then` in the
    holder's transaction, if given, and commits the holder. Returns the
    holder's result and the waiter's finished future."""
    sessions = sessionmaker(database)
    pids: list[int] = []

    def run_waiter() -> W:
        with sessions.begin() as session:
            pids.append(session.scalar(text("SELECT pg_backend_pid()")))
            return waiter(session)

    held = sessions()
    try:
        held.begin()
        held_result = holder(held)
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(run_waiter)
            deadline = time.monotonic() + 10
            while not (pids and backend_waits_for_a_lock(database, pids[0])):
                assert not future.done(), "the waiter never waited"
                assert time.monotonic() < deadline, "the waiter never waited"
                time.sleep(0.05)
            if then is not None:
                then(held)
            held.commit()
            wait([future], timeout=10)
    finally:
        held.close()
    return held_result, future
