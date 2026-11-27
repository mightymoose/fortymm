import asyncio

from app.services.parcels import ParcelsService


def test_ingest_answers_no_records() -> None:
    assert asyncio.run(ParcelsService().ingest(b"\x01")).answers == []


def test_ingest_gives_an_8_byte_stamp() -> None:
    assert len(asyncio.run(ParcelsService().ingest(b"\x01")).stamp) == 8
