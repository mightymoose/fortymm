"""A match's results, as its players' devices signed them."""

from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel

from fortymm_api.accounts import PlayerId
from fortymm_api.database import DatabaseSession
from fortymm_api.matches import MatchId
from fortymm_api.services import match_results
from fortymm_api.v1.errors import UNSUPPORTED_MEDIA_TYPE, Responses
from fortymm_api.v1.types import HexBytes

router = APIRouter(prefix="/matches", tags=["matches"])

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
