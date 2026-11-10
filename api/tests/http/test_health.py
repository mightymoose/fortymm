"""GET /health, driven in process through the app's HTTP interface.

The database is the real test database, or a stand-in from support.database_faults
when a test needs it to fail in a particular way.
"""

import logging
import time

import pytest

from tests.support.api_client import api_client
from tests.support.database_faults import (
    database_proxy,
    database_that_never_answers_queries,
    silent_database,
    unused_port,
    with_address,
)
from tests.support.openapi import assert_matches_documented_response

pytestmark = pytest.mark.anyio

HEALTHY = {"status": "ok", "database": "ok"}
UNAVAILABLE = {"status": "unavailable", "database": "unavailable"}

# The API gives the database 2 seconds; this leaves room for a slow test runner.
ANSWER_WITHIN_SECONDS = 3.0


def unreachable(database_url: str) -> str:
    return with_address(database_url, "127.0.0.1", unused_port())


async def test_reachable_database_answers_200_ok(database_url: str) -> None:
    async with api_client(database_url) as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == HEALTHY


async def test_database_going_down_turns_the_answer_to_503(database_url: str) -> None:
    async with database_proxy(database_url) as proxy, api_client(proxy.url) as client:
        assert (await client.get("/health")).status_code == 200

        await proxy.stop()
        response = await client.get("/health")

    assert response.status_code == 503


async def test_database_coming_back_turns_the_answer_to_200(database_url: str) -> None:
    async with database_proxy(database_url) as proxy, api_client(proxy.url) as client:
        await proxy.stop()
        assert (await client.get("/health")).status_code == 503

        await proxy.start()
        response = await client.get("/health")

    assert response.status_code == 200


async def test_unreachable_database_answers_503_naming_only_the_database(
    database_url: str,
) -> None:
    url = unreachable(database_url)
    async with api_client(url) as client:
        response = await client.get("/health")

    assert response.status_code == 503
    # Exactly this body: no error text, connection string or trace.
    assert response.json() == UNAVAILABLE


async def test_unreachable_database_logs_the_cause(
    database_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    async with api_client(unreachable(database_url)) as client:
        with caplog.at_level(logging.WARNING, logger="api"):
            await client.get("/health")

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("ConnectionRefusedError" in message for message in warnings), warnings


async def test_database_that_accepts_but_never_answers_gets_503_in_time(
    database_url: str,
) -> None:
    async with silent_database(database_url) as url, api_client(url) as client:
        started = time.monotonic()
        response = await client.get("/health")
        elapsed = time.monotonic() - started

    assert response.status_code == 503
    assert elapsed < ANSWER_WITHIN_SECONDS


async def test_database_that_never_answers_select_1_gets_503_in_time(
    database_url: str,
) -> None:
    # Connecting succeeds here, so only actually running the query can tell.
    async with database_that_never_answers_queries(database_url) as url, api_client(url) as client:
        started = time.monotonic()
        response = await client.get("/health")
        elapsed = time.monotonic() - started

    assert response.status_code == 503
    assert elapsed < ANSWER_WITHIN_SECONDS


async def test_200_answer_matches_the_openapi_document(database_url: str) -> None:
    async with api_client(database_url) as client:
        document = (await client.get("/openapi.json")).json()
        response = await client.get("/health")

    assert response.status_code == 200
    assert_matches_documented_response(document, "get", "/health", response)


async def test_503_answer_matches_the_openapi_document(database_url: str) -> None:
    async with api_client(unreachable(database_url)) as client:
        document = (await client.get("/openapi.json")).json()
        response = await client.get("/health")

    assert response.status_code == 503
    assert_matches_documented_response(document, "get", "/health", response)
