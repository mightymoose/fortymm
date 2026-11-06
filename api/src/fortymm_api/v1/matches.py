"""Matches: making one, picking its opponent, their boards, the results
their players' devices signed, and reading them. The services hold the
rules. A refused write answers in the `errors` shape without raising, so
the request still commits the submission that logs it."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from fortymm_api.accounts import CurrentAccount, PlayerId
from fortymm_api.auth import RequestAccount, require_permission
from fortymm_api.database import DatabaseSession
from fortymm_api.matches import MatchId
from fortymm_api.permissions import Permission
from fortymm_api.services import match_reads, match_results, matches, opponents
from fortymm_api.services.matches import (
    Authority,
    Difference,
    RecordedApproval,
    Refusal,
    Refused,
    Sender,
)
from fortymm_api.services.sessions import client_network
from fortymm_api.signed_results import GamePoints
from fortymm_api.v1.errors import (
    FORBIDDEN,
    NO_SESSION,
    UNSUPPORTED_MEDIA_TYPE,
    Responses,
    error_response,
    errors,
)
from fortymm_api.v1.session import client_address
from fortymm_api.v1.types import HexBytes

router = APIRouter(prefix="/matches", tags=["matches"])

MatchCreator = Annotated[CurrentAccount, require_permission(Permission.MATCHES_CREATE)]
MatchScorer = Annotated[CurrentAccount, require_permission(Permission.MATCHES_SCORE)]
MatchViewer = Annotated[CurrentAccount, require_permission(Permission.MATCHES_VIEW)]

type RefusalAnswers = dict[Refusal, tuple[int, str]]

# What each route answers for each refusal its service returns. A
# MATCH_DIFFERS title says what differs instead.
MATCH_DIFFERS: RefusalAnswers = {
    Refusal.MATCH_DIFFERS: (409, "The details differ from the match's"),
}
BOARD_REFUSALS: RefusalAnswers = {
    **MATCH_DIFFERS,
    Refusal.MALFORMED: (422, "The board isn't a FortyMM draft or signed result"),
    Refusal.WRONG_MATCH: (422, "The board is for another match"),
    Refusal.MATCH_FINAL: (409, "The match is final, so its board can't change"),
}
RESULT_REFUSALS: RefusalAnswers = {
    **MATCH_DIFFERS,
    Refusal.MALFORMED: (422, "The envelope isn't a FortyMM signed result"),
    Refusal.WRONG_MATCH: (422, "The result is for another match"),
    Refusal.UNKNOWN_KEY: (422, "A signature's key isn't registered, or was revoked"),
    Refusal.BAD_SIGNATURE: (422, "A signature doesn't match the result"),
    Refusal.ILLEGAL_ENDING: (422, "The scores aren't a legal ending to the match"),
    Refusal.NO_AUTHORITY: (
        422,
        "A signature's account doesn't play as or manage the player it signs for",
    ),
    Refusal.NOT_HEAD: (
        409,
        "Another result replaced this one, so it can't be approved",
    ),
    Refusal.STALE: (409, "The result doesn't replace the match's newest result"),
    Refusal.SAME_PLAYER: (409, "Both sides of the match are now the same player"),
}
DIFFERENCE_NAMES: dict[Difference, str] = {
    "players": "players",
    "best_of": "best of",
    "rated": "rated status",
}


def invalid_body(otherwise: str) -> Responses:
    """The 422 entry. It replaces FastAPI's own, so it repeats its body."""
    return {
        422: {
            "description": (
                f"The body is invalid. If {otherwise}, the body is in the"
                " `errors` shape instead"
            ),
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
                }
            },
        }
    }


DIFFERS = (
    "The match has other players, best of or rated status, and the title says which"
)
NO_MATCH = errors(404, "No match has this id")
BOARD_ERRORS: Responses = {
    **NO_SESSION,
    **FORBIDDEN,
    **NO_MATCH,
    **errors(409, f"{DIFFERS}. Or the match is final"),
    **UNSUPPORTED_MEDIA_TYPE,
    **invalid_body(
        "the board isn't a draft payload or an envelope of the format, or is"
        " for another match"
    ),
}
APPROVAL_ERRORS: Responses = {
    **NO_SESSION,
    **FORBIDDEN,
    **NO_MATCH,
    **errors(
        409,
        f"{DIFFERS}. Or another result replaced this one, the result doesn't"
        " replace the match's newest result, or a merge made both sides one"
        " player",
    ),
    **UNSUPPORTED_MEDIA_TYPE,
    **invalid_body(
        "the envelope isn't a signed result, is for another match, cites a key"
        " that isn't registered or was revoked, has a signature that doesn't"
        " verify, its scores aren't a legal ending, or a signature's account"
        " may not approve for its player"
    ),
}


class MatchApproval(BaseModel):
    # The kid of the key that signed.
    key_id: HexBytes
    # The player the key approved the result for, as it was then.
    player_id: PlayerId
    # The side it approved for.
    side: int
    # `self` for the account's own player, `representative` for one it
    # manages.
    authority: Authority


class BoardRequest(BaseModel):
    # The URL fragment's bytes, a draft payload or an envelope, in lowercase
    # hex.
    board: HexBytes


class PushedBoard(BaseModel):
    match_id: UUID
    received_at: datetime


class BoardResponse(BaseModel):
    data: PushedBoard


class ApprovalRequest(BaseModel):
    # The COSE_Sign envelope of api/signed-results/README.md, in lowercase hex.
    envelope: HexBytes


class CheckedResult(BaseModel):
    # The SHA-256 of the payload bytes, the result's identity.
    hash: HexBytes
    match_id: UUID
    # Every approval the result has, sorted by key id, then side.
    approvals: list[MatchApproval]
    # When it counted, which made the match final. Null until then, and for
    # good once another result replaces it first.
    accepted_at: datetime | None


class ApprovalResponse(BaseModel):
    data: CheckedResult


def sender(request: Request, account: CurrentAccount) -> Sender:
    return Sender(account.id, client_network(client_address(request)))


def approval_models(approvals: tuple[RecordedApproval, ...]) -> list[MatchApproval]:
    return [
        MatchApproval(
            key_id=approval.key_id,
            player_id=approval.player,
            side=approval.side,
            authority=approval.authority,
        )
        for approval in approvals
    ]


def refusal_response(refused: Refused, answers: RefusalAnswers) -> JSONResponse:
    if refused.differences:
        return differs_response(refused)
    status, title = answers[refused.refusal]
    return error_response(status, title)


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


# Each game's points, side 0's then side 1's, in the order played.
Games = list[Annotated[list[int], Field(min_length=2, max_length=2)]]
Side = Literal[0, 1]


class MatchPlayer(BaseModel):
    # The player that survives any merge.
    id: PlayerId
    display_name: str


class MatchSide(BaseModel):
    side: Side
    players: list[MatchPlayer]


class NotStartedState(BaseModel):
    kind: Literal["not_started"]


class LiveState(BaseModel):
    # The games are the newest board's.
    kind: Literal["live"]


class AwaitingState(BaseModel):
    # One side signed the result, which waits on the other side.
    kind: Literal["awaiting"]
    signed_by: Side
    # When the result first arrived.
    signed_at: datetime


class DisputedState(BaseModel):
    # One side signed other scores than the other side's pending result.
    kind: Literal["disputed"]
    signed_by: Side
    signed_at: datetime
    # The other side's scores, which these replace.
    their_games: Games


class FinalState(BaseModel):
    kind: Literal["final"]
    accepted_at: datetime
    # The sides that approved the result, sorted. One for an unrated result
    # only one side approved, none for an override.
    approved_by: list[Side]
    # Why an administrator set the result, null if none did.
    override_reason: str | None


MatchState = Annotated[
    NotStartedState | LiveState | AwaitingState | DisputedState | FinalState,
    Field(discriminator="kind"),
]


class MatchSummary(BaseModel):
    id: UUID
    best_of: Literal[1, 3, 5, 7]
    rated: bool
    # When the match was made.
    started_at: datetime
    # Side 0, then side 1.
    sides: list[MatchSide]
    # The side of the session account's own player, null if it doesn't play.
    viewer_side: Side | None
    # The games the state is about: the board's while live, otherwise the
    # newest result's.
    games: Games
    # The side that retired in that result, null if it completed or there is
    # no result.
    retired_by: Side | None
    state: MatchState


class MatchEvent(BaseModel):
    at: datetime
    kind: Literal["created", "board", "signed", "approved", "override"]
    # The display name of who acted, null for an account with no player.
    by: str | None
    # The side a signature was for.
    side: Side | None
    # The scores it carried, null for `created`.
    games: Games | None


class MatchDetail(MatchSummary):
    # Oldest first.
    history: list[MatchEvent]


class MatchesMeta(BaseModel):
    # More matches exist than the list holds.
    has_more: bool


class MatchesResponse(BaseModel):
    data: list[MatchSummary]
    meta: MatchesMeta


class MatchDetailResponse(BaseModel):
    data: MatchDetail


def games_model(games: tuple[GamePoints, ...]) -> Games:
    return [list(points) for points in games]


def state_model(state: match_reads.MatchState) -> MatchState:
    match state:
        case match_reads.NotStarted():
            return NotStartedState(kind=state.kind)
        case match_reads.Live():
            return LiveState(kind=state.kind)
        case match_reads.Awaiting(signed_by, signed_at):
            return AwaitingState(
                kind=state.kind, signed_by=signed_by, signed_at=signed_at
            )
        case match_reads.Disputed(signed_by, signed_at, their_games):
            return DisputedState(
                kind=state.kind,
                signed_by=signed_by,
                signed_at=signed_at,
                their_games=games_model(their_games),
            )
        case match_reads.Final(accepted_at, approved_by, override_reason):
            return FinalState(
                kind=state.kind,
                accepted_at=accepted_at,
                approved_by=list(approved_by),
                override_reason=override_reason,
            )


def summary_model(view: match_reads.MatchView) -> MatchSummary:
    return MatchSummary(
        id=view.id,
        best_of=view.best_of,
        rated=view.rated,
        started_at=view.started_at,
        sides=[
            MatchSide(
                side=side.side,
                players=[
                    MatchPlayer(id=player.id, display_name=player.display_name)
                    for player in side.players
                ],
            )
            for side in view.sides
        ],
        viewer_side=view.viewer_side,
        games=games_model(view.games),
        retired_by=view.retired_by,
        state=state_model(view.state),
    )


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


@router.get("", responses={**NO_SESSION, **FORBIDDEN})
def list_matches(session: DatabaseSession, account: MatchViewer) -> MatchesResponse:
    """Every match, newest first, at most 50. `meta.has_more` says that more
    exist. Needs `matches.view`."""
    page = match_reads.list_matches(session, account.id)
    return MatchesResponse(
        data=[summary_model(view) for view in page.matches],
        meta=MatchesMeta(has_more=page.has_more),
    )


@router.get("/{match_id}", responses={**NO_SESSION, **FORBIDDEN, **NO_MATCH})
def get_match(
    session: DatabaseSession, account: MatchViewer, match_id: UUID
) -> MatchDetailResponse:
    """The match, with its history. Needs `matches.view`."""
    found = match_reads.get_match(session, MatchId(match_id), account.id)
    return MatchDetailResponse(
        data=MatchDetail(
            **dict(summary_model(found.match)),
            history=[
                MatchEvent(
                    at=event.at,
                    kind=event.kind,
                    by=event.by,
                    side=event.side,
                    games=None if event.games is None else games_model(event.games),
                )
                for event in found.history
            ],
        )
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


@router.post(
    "/{match_id}/boards",
    status_code=201,
    response_model=BoardResponse,
    responses=BOARD_ERRORS,
)
def push_match_board(
    session: DatabaseSession,
    request: Request,
    account: MatchScorer,
    match_id: UUID,
    body: BoardRequest,
) -> BoardResponse | JSONResponse:
    """Keep the scorer's board, so spectators can follow the match.

    Needs `matches.score`. The newest board wins, and nothing about it is
    checked but its format: its signatures, if any, and its scores settle
    nothing. A board for a match that doesn't exist answers 404 and writes
    nothing. Every other push is logged, refused or not.
    """
    pushed = matches.push_board(
        session, MatchId(match_id), body.board, sender(request, account)
    )
    if isinstance(pushed, Refused):
        return refusal_response(pushed, BOARD_REFUSALS)
    return BoardResponse(
        data=PushedBoard(match_id=match_id, received_at=pushed.received_at)
    )


@router.post(
    "/{match_id}/approvals",
    status_code=201,
    response_model=ApprovalResponse,
    responses=APPROVAL_ERRORS,
)
def create_match_approval(
    session: DatabaseSession,
    request: Request,
    account: MatchScorer,
    match_id: UUID,
    body: ApprovalRequest,
) -> ApprovalResponse | JSONResponse:
    """Record a result that the match's players signed, with its approvals.

    Needs `matches.score`, which turns the feature on. The signatures, not
    the session, are the authority: each one's account must play as or
    manage the player it signs for, whoever uploads it. A rated result
    counts once both sides approve it, and an unrated one once either side
    does. A correction of a final match needs both sides. A result for a
    match that doesn't exist answers 404 and writes nothing. An exact retry
    answers the result again, whatever its keys' state. Every other upload
    is logged, refused or not.
    """
    recorded = match_results.record_result(
        session, MatchId(match_id), body.envelope, sender(request, account)
    )
    if isinstance(recorded, Refused):
        return refusal_response(recorded, RESULT_REFUSALS)
    return ApprovalResponse(
        data=CheckedResult(
            hash=recorded.hash,
            match_id=recorded.match_id,
            approvals=approval_models(recorded.approvals),
            accepted_at=recorded.accepted_at,
        )
    )
