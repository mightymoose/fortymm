from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.services.parcels import (
    Applied,
    Held,
    Malformed,
    ParcelsService,
    RecordAnswer,
    Refused,
    RetryLater,
)

router = APIRouter()


class RecordAttributes(BaseModel):
    """What the server did with the record: `held` (the ledger holds it), `applied` (a request
    that took effect), `malformed` (it doesn't verify; nothing stored) or `retry_later` (the
    server can't take it now; nothing stored)."""

    model_config = ConfigDict(extra="forbid")

    answer: Literal["held", "applied", "malformed", "retry_later"]


class RefusedRecordAttributes(BaseModel):
    """The record, a request, did not take effect and never will. It is still held."""

    model_config = ConfigDict(extra="forbid")

    answer: Literal["refused"]
    reason: str


class RecordResource(BaseModel):
    """One record of the parcel and the server's answer to it. `id` is the record id, the
    SHA-256 of its body, in lower-case hex."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["record"]
    id: str = Field(pattern="^[0-9a-f]{64}$")
    attributes: Annotated[RecordAttributes | RefusedRecordAttributes, Field(discriminator="answer")]


class ParcelsMeta(BaseModel):
    """`stamp` is the server's current stamp, 8 bytes in lower-case hex."""

    model_config = ConfigDict(extra="forbid")

    stamp: str = Field(pattern="^[0-9a-f]{16}$")


class ParcelsDocument(BaseModel):
    """One entry per record of the parcel, in the parcel's order, and the server's current
    stamp."""

    model_config = ConfigDict(extra="forbid")

    data: list[RecordResource]
    meta: ParcelsMeta


def record_resource(answer: RecordAnswer) -> RecordResource:
    attributes: RecordAttributes | RefusedRecordAttributes
    match answer:
        case Held():
            attributes = RecordAttributes(answer="held")
        case Applied():
            attributes = RecordAttributes(answer="applied")
        case Refused(reason=reason):
            attributes = RefusedRecordAttributes(answer="refused", reason=reason)
        case Malformed():
            attributes = RecordAttributes(answer="malformed")
        case RetryLater():
            attributes = RecordAttributes(answer="retry_later")
    return RecordResource(type="record", id=answer.record_id.hex(), attributes=attributes)


@router.post(
    "/parcels",
    summary="Hand the server a parcel, and learn what it did with each record",
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": "The parcel's bytes, as the core's to_binary writes them.",
            # OpenAPI 3.1 writes raw binary content as its media type with no schema.
            "content": {"application/octet-stream": {}},
        }
    },
)
async def post_parcels(
    request: Request, service: Annotated[ParcelsService, Depends()]
) -> ParcelsDocument:
    ingested = await service.ingest(await request.body())
    return ParcelsDocument(
        data=[record_resource(answer) for answer in ingested.answers],
        meta=ParcelsMeta(stamp=ingested.stamp.hex()),
    )
