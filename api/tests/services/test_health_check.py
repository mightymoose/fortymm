"""HealthCheck, called through its public method. Every case of the logic lives here.

The database is the real test database, or a stand-in from support.database_faults
when a test needs it to fail in a particular way.
"""

import logging
import time

import pytest

from api.services.health_check import HealthCheck, HealthOk, HealthUnavailable
from tests.support.database_faults import (
    database_proxy,
    database_that_never_answers_queries,
    silent_database,
    unreachable,
)

pytestmark = pytest.mark.anyio

# The service gives the database 2 seconds; this leaves room for a slow test runner.
ANSWER_WITHIN_SECONDS = 3.0


async def test_reachable_database_is_ok(database_url: str) -> None:
    assert await HealthCheck(database_url).run() == HealthOk()


async def test_database_going_down_makes_it_unavailable(database_url: str) -> None:
    async with database_proxy(database_url) as proxy:
        health_check = HealthCheck(proxy.url)
        assert await health_check.run() == HealthOk()

        await proxy.stop()

        assert await health_check.run() == HealthUnavailable()


async def test_database_coming_back_makes_it_ok_again(database_url: str) -> None:
    async with database_proxy(database_url) as proxy:
        health_check = HealthCheck(proxy.url)
        await proxy.stop()
        assert await health_check.run() == HealthUnavailable()

        await proxy.start()

        assert await health_check.run() == HealthOk()


async def test_unreachable_database_is_unavailable(database_url: str) -> None:
    assert await HealthCheck(unreachable(database_url)).run() == HealthUnavailable()


async def test_unreachable_database_logs_the_cause(
    database_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="api"):
        await HealthCheck(unreachable(database_url)).run()

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("ConnectionRefusedError" in message for message in warnings), warnings


async def test_database_that_accepts_but_never_answers_is_unavailable_in_time(
    database_url: str,
) -> None:
    async with silent_database(database_url) as url:
        started = time.monotonic()
        result = await HealthCheck(url).run()
        elapsed = time.monotonic() - started

    assert result == HealthUnavailable()
    assert elapsed < ANSWER_WITHIN_SECONDS


async def test_database_that_never_answers_select_1_is_unavailable_in_time(
    database_url: str,
) -> None:
    # Connecting succeeds here, so only actually running the query can tell.
    async with database_that_never_answers_queries(database_url) as url:
        started = time.monotonic()
        result = await HealthCheck(url).run()
        elapsed = time.monotonic() - started

    assert result == HealthUnavailable()
    assert elapsed < ANSWER_WITHIN_SECONDS
