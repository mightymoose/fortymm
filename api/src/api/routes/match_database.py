"""POST /v1/match-database/apply. TEMPORARY (see api.routes.temporary): apply parcels of
`match` records to a database sent with the request, and return the new database.

The database is a JSON object. `{}` is the empty database; what this returns is
`{"records": [...], "matches": [...]}`, which can be sent back unchanged. Nothing is
kept on the server: it is a calculation.

200: {"data": {"type": "match-database", "id": "new", "attributes":
       {"database": {...}, "parcels": [...]}}}
422: InvalidRequestError, with source.pointer at what is wrong.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from api.dependencies import get_match_database
from api.routes.errors import ErrorSource, InvalidRequestError, documented, error_response
from api.routes.temporary import TEMPORARY
from api.services import match_database as service

router = APIRouter()

# Lowercase hex, an even number of digits.
Hex = Annotated[str, Field(pattern=r"^([0-9a-f]{2})*$")]
Hex32 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class StoredRecord(BaseModel):
    """A record the database holds."""

    model_config = ConfigDict(extra="forbid")

    arrival: int = Field(ge=1, description="Arrival number: 1 for the first record held.")
    arrived_at: AwareDatetime = Field(description="The time of arrival sent with the submit.")
    answer: Literal["held"]
    record: Hex = Field(description="The standalone record ([body, signature]), in hex.")


class Match(BaseModel):
    """A match, derived from its `match` record."""

    model_config = ConfigDict(extra="forbid")

    match_id: Hex32
    sides: tuple[list[Hex32], list[Hex32]] = Field(description="Player ids, in hex.")
    terms: Hex
    created_by: Hex = Field(description="The 33-byte key that signed the match record.")


class MatchDatabase(BaseModel):
    """The database: `{}` when empty. `matches` is derived from `records`: the matches
    of a database sent in are ignored and rebuilt."""

    model_config = ConfigDict(extra="forbid")

    records: list[StoredRecord] = Field(default=[], max_length=10_000)
    matches: list[Match] = Field(default=[], max_length=10_000)


class ApplyParcelsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    database: MatchDatabase
    parcels: list[str] = Field(min_length=1, max_length=50, description="Parcel texts.")
    arrived_at: AwareDatetime = Field(
        description="The time of arrival to record. The server reads no clock."
    )


class RecordAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_id: Hex32
    answer: service.Answer
    reason: service.RecordReason | None


class ParcelOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["applied", "refused"]
    reason: service.ParcelReason | None
    records: list[RecordAnswer]


class MatchDatabaseAttributes(BaseModel):
    model_config = ConfigDict(extra="forbid")

    database: MatchDatabase
    parcels: list[ParcelOutcome] = Field(description="One per parcel sent, in order.")


class MatchDatabaseResource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["match-database"]
    # The resource is the database after this submit; nothing else is identified.
    id: Literal["new"]
    attributes: MatchDatabaseAttributes


class MatchDatabaseDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: MatchDatabaseResource


@router.post(
    "/match-database/apply",
    summary="TEMPORARY: apply parcels of match records to a database sent with the request",
    response_model=MatchDatabaseDocument,
    responses=documented(InvalidRequestError),
    openapi_extra=TEMPORARY,
)
async def apply_parcels(
    request: ApplyParcelsRequest,
    match_database: Annotated[service.MatchDatabase, Depends(get_match_database)],
) -> MatchDatabaseDocument | JSONResponse:
    match match_database.apply(_database(request.database), request.parcels, request.arrived_at):
        case service.Applied(database=database, parcels=parcels):
            return MatchDatabaseDocument(
                data=MatchDatabaseResource(
                    type="match-database",
                    id="new",
                    attributes=MatchDatabaseAttributes(
                        database=_database_model(database),
                        parcels=[_outcome_model(parcel) for parcel in parcels],
                    ),
                )
            )
        case service.InvalidDatabase(index=index):
            return error_response(
                InvalidRequestError(source=ErrorSource(pointer=f"/database/records/{index}"))
            )


def _database(model: MatchDatabase) -> service.Database:
    return service.Database(
        records=tuple(
            service.StoredRecord(
                arrival=stored.arrival,
                arrived_at=stored.arrived_at,
                answer=stored.answer,
                record=bytes.fromhex(stored.record),
            )
            for stored in model.records
        )
    )


def _database_model(database: service.Database) -> MatchDatabase:
    return MatchDatabase(
        records=[
            StoredRecord(
                arrival=stored.arrival,
                arrived_at=stored.arrived_at,
                answer=stored.answer,
                record=stored.record.hex(),
            )
            for stored in database.records
        ],
        matches=[
            Match(
                match_id=match.match_id.hex(),
                sides=([p.hex() for p in match.sides[0]], [p.hex() for p in match.sides[1]]),
                terms=match.terms.hex(),
                created_by=match.created_by.hex(),
            )
            for match in database.matches
        ],
    )


def _outcome_model(parcel: service.ParcelOutcome) -> ParcelOutcome:
    return ParcelOutcome(
        status=parcel.status,
        reason=parcel.reason,
        records=[
            RecordAnswer(
                record_id=answer.record_id.hex(),
                answer=answer.answer,
                reason=answer.reason,
            )
            for answer in parcel.records
        ],
    )
