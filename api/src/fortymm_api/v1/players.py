from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel

from fortymm_api.accounts import PlayerId
from fortymm_api.auth import RequestAccount
from fortymm_api.database import DatabaseSession
from fortymm_api.services import players
from fortymm_api.services.players import Answer

router = APIRouter(prefix="/account/players", tags=["players"])

ANSWER_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"description": "The account doesn't manage the player"},
    409: {
        "description": (
            "The answer is `not_mine` and the question was already answered"
        )
    },
}


class AccountPlayer(BaseModel):
    id: UUID
    display_name: str
    # `self` is the player the account plays as. `managed` is one it manages
    # for someone else, such as a child.
    relationship: Literal["self", "managed"]
    # True until the account answers "Is this you?" for the player.
    open_question: bool


class AccountPlayersResponse(BaseModel):
    data: list[AccountPlayer]


class AnswerRequest(BaseModel):
    answer: Answer


def players_response(found: list[players.AccountPlayer]) -> AccountPlayersResponse:
    return AccountPlayersResponse(
        data=[
            AccountPlayer(
                id=player.id,
                display_name=player.display_name,
                relationship=player.relationship,
                open_question=player.open_question,
            )
            for player in found
        ]
    )


@router.get("")
def account_players(
    session: DatabaseSession, account: RequestAccount
) -> AccountPlayersResponse:
    """List the players the account manages, its own player first. A merged
    player isn't listed.

    `open_question` is true for a player that a sign-in brought to the
    account, until the account answers "Is this you?" for it.
    """
    return players_response(players.account_players(session, account.id))


@router.post("/{player_id}/answer", responses=ANSWER_ERRORS)
def answer_question(
    session: DatabaseSession,
    account: RequestAccount,
    player_id: UUID,
    body: AnswerRequest,
) -> AccountPlayersResponse:
    """Answer "Is this you?" for one player, and list the account's players
    after it.

    `yes` makes it the account's own player. If the account already has one,
    the two players merge. The player created first survives, and the other
    leaves the list. `no` keeps it as a player the account manages. `not_mine` takes
    it off the account. The player stays, with no manager. Every answer
    closes the question. A second `yes` or `no` changes nothing, and a second
    `not_mine` answers 409.
    """
    found = players.answer_question(
        session, account.id, PlayerId(player_id), body.answer
    )
    return players_response(found)
