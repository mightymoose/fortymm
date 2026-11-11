"""POST /v1/match-database/apply through the app's HTTP interface: wiring only.

The logic is proven in tests/services/test_match_database.py. Here the real service runs
in the whole app: one case per outcome, that the response is byte for byte the same for
the same request, and that the server keeps nothing between submits.
"""

from typing import Any

import pytest

from tests.support.api_client import api_client
from tests.support.openapi import assert_matches_documented_response
from tests.support.records import FIRST_MATCH, SECOND_MATCH

pytestmark = pytest.mark.anyio

PATH = "/v1/match-database/apply"
NOON = "2026-11-11T12:00:00Z"


def submit(database: Any, *parcels: str) -> dict[str, Any]:
    return {"database": database, "parcels": list(parcels), "arrived_at": NOON}


async def test_the_empty_database_and_a_match_parcel_answer_200_with_the_new_database(
    database_url: str,
) -> None:
    async with api_client(database_url) as client:
        response = await client.post(PATH, json=submit({}, FIRST_MATCH.text))

    assert response.status_code == 200
    assert response.json() == {
        "data": {
            "type": "match-database",
            "id": "new",
            "attributes": {
                "database": {
                    "records": [
                        {
                            "arrival": 1,
                            "arrived_at": NOON,
                            "answer": "held",
                            "record": FIRST_MATCH.record,
                        }
                    ],
                    "matches": [
                        {
                            "match_id": FIRST_MATCH.id,
                            "sides": list(FIRST_MATCH.sides),
                            "terms": FIRST_MATCH.terms,
                            "created_by": FIRST_MATCH.signer,
                        }
                    ],
                },
                "parcels": [
                    {
                        "status": "applied",
                        "reason": None,
                        "records": [
                            {"record_id": FIRST_MATCH.id, "answer": "held", "reason": None}
                        ],
                    }
                ],
            },
        }
    }


async def test_the_returned_database_can_be_sent_back_unchanged(database_url: str) -> None:
    async with api_client(database_url) as client:
        first = await client.post(PATH, json=submit({}, FIRST_MATCH.text))
        database = first.json()["data"]["attributes"]["database"]
        again = await client.post(PATH, json=submit(database, FIRST_MATCH.text))

    assert again.status_code == 200
    assert again.json() == first.json()


async def test_the_same_request_gives_the_same_response_byte_for_byte(
    database_url: str,
) -> None:
    async with api_client(database_url) as client:
        responses = [
            await client.post(PATH, json=submit({}, SECOND_MATCH.text, FIRST_MATCH.text))
            for _ in range(2)
        ]

    assert responses[0].content == responses[1].content


async def test_a_submit_leaves_nothing_behind_on_the_server(database_url: str) -> None:
    request = submit({}, SECOND_MATCH.text)
    async with api_client(database_url) as used:
        await used.post(PATH, json=submit({}, FIRST_MATCH.text, SECOND_MATCH.text))
        after_other_submits = await used.post(PATH, json=request)
    async with api_client(database_url) as fresh:
        on_a_fresh_server = await fresh.post(PATH, json=request)

    assert after_other_submits.content == on_a_fresh_server.content


async def test_a_database_the_service_refuses_answers_422_pointing_at_the_record(
    database_url: str,
) -> None:
    database = {
        "records": [
            {"arrival": 1, "arrived_at": NOON, "answer": "held", "record": "00"},
        ]
    }
    async with api_client(database_url) as client:
        response = await client.post(PATH, json=submit(database, FIRST_MATCH.text))

    assert response.status_code == 422
    assert response.json() == {
        "errors": [
            {
                "status": "422",
                "code": "invalid_request",
                "title": "The request is not valid",
                "source": {"pointer": "/database/records/0"},
            }
        ]
    }


async def test_a_database_that_is_not_an_object_answers_422_pointing_at_it(
    database_url: str,
) -> None:
    async with api_client(database_url) as client:
        response = await client.post(PATH, json=submit([], FIRST_MATCH.text))

    assert response.status_code == 422
    assert response.json()["errors"][0]["source"] == {"pointer": "/database"}


async def test_200_answer_matches_the_openapi_document(database_url: str) -> None:
    async with api_client(database_url) as client:
        document = (await client.get("/openapi.json")).json()
        response = await client.post(PATH, json=submit({}, FIRST_MATCH.text))

    assert response.status_code == 200
    assert_matches_documented_response(document, "post", PATH, response)


async def test_422_answers_match_the_openapi_document(database_url: str) -> None:
    async with api_client(database_url) as client:
        document = (await client.get("/openapi.json")).json()
        responses = [
            await client.post(PATH, json=submit([], FIRST_MATCH.text)),
            await client.post(PATH, json={"database": {}, "parcels": []}),
        ]

    for response in responses:
        assert response.status_code == 422
        assert_matches_documented_response(document, "post", PATH, response)


async def test_the_operation_is_marked_temporary_in_the_document(database_url: str) -> None:
    async with api_client(database_url) as client:
        document = (await client.get("/openapi.json")).json()

    assert document["paths"][PATH]["post"]["x-stability-level"] == "draft"
