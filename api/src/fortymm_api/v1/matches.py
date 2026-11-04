"""Matches: making one, picking its opponent, and the results its players'
devices signed. No route reads a match yet."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from fortymm_api.accounts import CurrentAccount, PlayerId
from fortymm_api.auth import RequestAccount, require_permission
from fortymm_api.database import DatabaseSession
from fortymm_api.matches import MatchId
from fortymm_api.permissions import Permission
from fortymm_api.services import match_results, matches, opponents
from fortymm_api.services.matches import Difference, Refused
from fortymm_api.v1.errors import (
    FORBIDDEN,
    NO_SESSION,
    UNSUPPORTED_MEDIA_TYPE,
    Responses,
    error_response,
    errors,
)
from fortymm_api.v1.types import HexBytes

router = APIRouter(prefix="/matches", tags=["matches"])

MatchCreator = Annotated[CurrentAccount, require_permission(Permission.MATCHES_CREATE)]

DIFFERENCE_NAMES: dict[Difference, str] = {
    "players": "players",
    "best_of": "best of",
    "rated": "rated status",
}

APPROVAL_ERRORS: Responses = {
    **UNSUPPORTED_MEDIA_TYPE,
    # This entry replaces FastAPI's own 422, so it repeats its body.
    422: {
        "description": (
            "The body is invalid. If the envelope isn't a signed result, is for"
            " another match, cites a key that isn't registered or was revoked,"
            " has a signature that doesn't verify, or its scores aren't a legal"
            " ending, the body is in the `errors` shape instead"
        ),
        "content": {
            "application/json": {
                "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
            }
        },
    },
}


class ApprovalRequest(BaseModel):
    # The COSE_Sign envelope of api/signed-results/README.md, in lowercase hex.
    envelope: HexBytes


class MatchApproval(BaseModel):
    # The kid of the key that signed.
    key_id: HexBytes
    # The player the key approved the result for.
    player_id: PlayerId


class CheckedResult(BaseModel):
    # The SHA-256 of the payload bytes, the result's identity.
    hash: HexBytes
    match_id: UUID
    # Sorted by key id, then player id.
    approvals: list[MatchApproval]


class ApprovalResponse(BaseModel):
    data: CheckedResult


@router.post("/{match_id}/approvals", status_code=201, responses=APPROVAL_ERRORS)
def create_match_approval(
    session: DatabaseSession, match_id: UUID, body: ApprovalRequest
) -> ApprovalResponse:
    """Check a result that the match's players signed, and accept it.

    It needs no session: the signatures are the authority. Today it checks
    the envelope's format, the match, every signature and that the scores
    are a legal ending, and stores nothing.
    """
    verified = match_results.check_approval(session, MatchId(match_id), body.envelope)
    approvals = sorted(
        (approval.kid, approval.player) for approval in verified.approvals
    )
    return ApprovalResponse(
        data=CheckedResult(
            hash=verified.hash,
            match_id=verified.result.match,
            approvals=[
                MatchApproval(key_id=kid, player_id=player) for kid, player in approvals
            ],
        )
    )


class MatchRequest(BaseModel):
    # Made on the device, so a retry names the match the first try made.
    id: UUID
    best_of: Literal[1, 3, 5, 7]
    rated: bool
    # Side 0's player, then side 1's.
    players: Annotated[list[PlayerId], Field(min_length=2, max_length=2)]

    def details(self) -> matches.MatchDetails:
        first, second = self.players
        return matches.MatchDetails(self.best_of, self.rated, (first, second))


class MadeMatch(BaseModel):
    id: UUID


class MatchResponse(BaseModel):
    data: MadeMatch


class Opponent(BaseModel):
    # The player that survives any merge.
    id: PlayerId
    display_name: str


class OpponentsResponse(BaseModel):
    data: list[Opponent]


CREATE_ERRORS: Responses = {
    201: {"model": MatchResponse, "description": "The match was made"},
    **NO_SESSION,
    **FORBIDDEN,
    **errors(
        409,
        "The match has other players, best of or rated status, and the title"
        " says which",
    ),
    **UNSUPPORTED_MEDIA_TYPE,
    # This entry replaces FastAPI's own 422, so it repeats its body.
    422: {
        "description": (
            "The body is invalid. If a player doesn't exist, merged into"
            " another player, or plays both sides, the body is in the `errors`"
            " shape instead"
        ),
        "content": {
            "application/json": {
                "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
            }
        },
    },
}


def differs_response(refused: Refused) -> JSONResponse:
    """409, with a title that says what differs."""
    *others, last = [
        name
        for difference, name in DIFFERENCE_NAMES.items()
        if difference in refused.differences
    ]
    listed = f"{', '.join(others)} and {last}" if others else last
    verb = "differ" if others or last == "players" else "differs"
    return error_response(409, f"The {listed} {verb} from the match's")


@router.get("/opponents", responses=NO_SESSION)
def match_opponents(
    session: DatabaseSession,
    account: RequestAccount,
    search: Annotated[str | None, Query(max_length=100)] = None,
) -> OpponentsResponse:
    """The players the account may pick as its opponent. With no `search`,
    or only spaces, the players its own player faced, most recent match
    first, at most 12. With text, the players whose display name contains
    it, whatever its case, by name, at most 20. Never the account's own
    player."""
    found = opponents.opponents(session, account.id, search)
    return OpponentsResponse(
        data=[
            Opponent(id=player.id, display_name=player.display_name) for player in found
        ]
    )


@router.post("", response_model=MatchResponse, responses=CREATE_ERRORS)
def create_match(
    session: DatabaseSession,
    response: Response,
    account: MatchCreator,
    body: MatchRequest,
) -> MatchResponse | JSONResponse:
    """Make the match, with its id from the device, or find it.

    A new match answers 201. One that already exists with the same details
    answers 200, so a retry or a second device gets the match. One with
    other players, best of or rated status answers 409, and the title says
    what differs. Players are compared through any merge. It needs
    `matches.create`, which no guest holds. The account needn't play in the
    match.
    """
    created = matches.create_match(
        session, MatchId(body.id), body.details(), account.id
    )
    if isinstance(created, Refused):
        return differs_response(created)
    if isinstance(created, matches.Created):
        response.status_code = 201
    return MatchResponse(data=MadeMatch(id=created.id))
