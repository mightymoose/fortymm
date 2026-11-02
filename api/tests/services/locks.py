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


def overlap[H, W](
    database: Engine,
    holder: Callable[[Session, Callable[[], None]], H],
    waiter: Callable[[Session], W],
) -> tuple[H, Future[W]]:
    """Run `holder` in an open transaction. When it calls the function it is
    given, run `waiter` in another transaction on another thread, and return
    to the holder once the waiter waits for a lock. Commits the holder after
    it returns. Returns the holder's result and the waiter's finished
    future."""
    sessions = sessionmaker(database)
    pids: list[int] = []

    def run_waiter() -> W:
        with sessions.begin() as session:
            pids.append(session.scalar(text("SELECT pg_backend_pid()")))
            return waiter(session)

    held = sessions()
    try:
        held.begin()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future: Future[W] | None = None

            def let_waiter_wait() -> None:
                nonlocal future
                assert future is None, "the waiter already started"
                future = executor.submit(run_waiter)
                deadline = time.monotonic() + 10
                while not (pids and backend_waits_for_a_lock(database, pids[0])):
                    assert not future.done(), "the waiter never waited"
                    assert time.monotonic() < deadline, "the waiter never waited"
                    time.sleep(0.05)

            held_result = holder(held, let_waiter_wait)
            assert future is not None, "the holder never let the waiter wait"
            held.commit()
            wait([future], timeout=10)
    finally:
        held.close()
    return held_result, future


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

    def hold(session: Session, let_waiter_wait: Callable[[], None]) -> H:
        result = holder(session)
        let_waiter_wait()
        if then is not None:
            then(session)
        return result

    return overlap(database, hold, waiter)
