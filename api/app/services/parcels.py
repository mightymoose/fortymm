"""Parcels: a device hands the server a parcel, and the server answers each record in it.

No intake yet: `ingest` answers every parcel with no records.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Held:
    """The ledger holds the record."""

    record_id: bytes


@dataclass(frozen=True)
class Applied:
    """The record, a request, took effect."""

    record_id: bytes


@dataclass(frozen=True)
class Refused:
    """The record, a request, did not take effect and never will. It is still held."""

    record_id: bytes
    reason: str


@dataclass(frozen=True)
class Malformed:
    """The record doesn't verify. Nothing is stored."""

    record_id: bytes


@dataclass(frozen=True)
class RetryLater:
    """The server can't take the record now. Nothing is stored."""

    record_id: bytes


type RecordAnswer = Held | Applied | Refused | Malformed | RetryLater


@dataclass(frozen=True)
class Ingested:
    """One answer per record, in the parcel's order, and the server's current stamp."""

    answers: list[RecordAnswer]
    stamp: bytes


# A stand-in until the server issues stamps (8 bytes, core/FORMAT.md key 6).
PLACEHOLDER_STAMP = bytes(8)


class ParcelsService:
    """Takes in parcels. The endpoint builds the response from what it answers."""

    async def ingest(self, parcel: bytes) -> Ingested:
        return Ingested(answers=[], stamp=PLACEHOLDER_STAMP)
