from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.parcels import (
    PLACEHOLDER_STAMP,
    Held,
    Ingested,
    ParcelsService,
    Refused,
)

client = TestClient(app)

PARCEL = b"\x01\x02\x03"
RECORD_ID = bytes(range(32))


def post(body: bytes = PARCEL) -> dict[str, object]:
    response = client.post(
        "/api/v1/parcels",
        content=body,
        headers={"content-type": "application/octet-stream"},
    )
    result: dict[str, object] = response.json()
    return result


class FakeParcels(ParcelsService):
    def __init__(self, ingested: Ingested) -> None:
        self.ingested = ingested
        self.received: list[bytes] = []

    async def ingest(self, parcel: bytes) -> Ingested:
        self.received.append(parcel)
        return self.ingested


@pytest.fixture
def fake() -> Iterator[FakeParcels]:
    parcels = FakeParcels(
        Ingested(
            answers=[Held(RECORD_ID), Refused(RECORD_ID, reason="stale")],
            stamp=PLACEHOLDER_STAMP,
        )
    )
    app.dependency_overrides[ParcelsService] = lambda: parcels
    yield parcels
    app.dependency_overrides.clear()


def test_posting_a_parcel_responds_ok() -> None:
    response = client.post(
        "/api/v1/parcels",
        content=PARCEL,
        headers={"content-type": "application/octet-stream"},
    )
    assert response.status_code == 200


def test_posting_a_parcel_answers_no_records() -> None:
    assert post()["data"] == []


def test_posting_a_parcel_carries_the_stamp_as_hex() -> None:
    assert post()["meta"] == {"stamp": "0000000000000000"}


def test_the_posted_bytes_reach_ingest_unchanged(fake: FakeParcels) -> None:
    post()
    assert fake.received == [PARCEL]


def test_a_held_record_is_answered_held(fake: FakeParcels) -> None:
    assert post()["data"][0] == {  # type: ignore[index]
        "type": "record",
        "id": RECORD_ID.hex(),
        "attributes": {"answer": "held"},
    }


def test_a_refused_record_is_answered_refused_with_its_reason(fake: FakeParcels) -> None:
    assert post()["data"][1] == {  # type: ignore[index]
        "type": "record",
        "id": RECORD_ID.hex(),
        "attributes": {"answer": "refused", "reason": "stale"},
    }
