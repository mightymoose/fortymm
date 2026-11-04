from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, Field, model_validator

from fortymm_api.accounts import PlayerId
from fortymm_api.auth import RequestAccount
from fortymm_api.database import DatabaseSession
from fortymm_api.services import players
from fortymm_api.services.player_merge import Merged
from fortymm_api.services.players import Answer, Reply, SameAs
from fortymm_api.v1.errors import NO_SESSION, UNSUPPORTED_MEDIA_TYPE, Responses, errors

router = APIRouter(prefix="/account/players", tags=["players"])

ANSWER_ERRORS: Responses = {
    **NO_SESSION,
    **errors(
        404,
        "The account doesn't manage the player, or `player_id` isn't a"
        " `managed` player of the account with a closed question",
    ),
    **errors(
        409,
        "The answer is `not_mine` and the question was already answered. Or"
        " the answer is `yes` or `same_as` and the two players played each"
        " other",
    ),
    **UNSUPPORTED_MEDIA_TYPE,
    # This entry replaces FastAPI's own 422, so it repeats its body.
    422: {
        "description": (
            "The body is invalid, or `player_id` is missing with `same_as` or"
            " set with another answer. If `player_id` is the answered player,"
            " the body is in the `errors` shape instead"
        ),
        "content": {
            "application/json": {
                "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
            }
        },
    },
}


class RecentMatch(BaseModel):
    id: UUID
    played_at: datetime


class AccountPlayer(BaseModel):
    id: UUID
    display_name: str
    # `self` is the player the account plays as. `managed` is one it manages
    # for someone else, such as a child.
    relationship: Literal["self", "managed"]
    # True until the account answers "Is this you?" for the player.
    open_question: bool
    match_count: int
    # The player's latest matches, newest first.
    recent_matches: list[RecentMatch]


class AccountPlayersResponse(BaseModel):
    data: list[AccountPlayer]


class AnswerRequest(BaseModel):
    answer: Answer
    # With `same_as` only: the managed player that the answered player is.
    player_id: UUID | None = None

    @model_validator(mode="after")
    def player_id_comes_with_same_as(self) -> Self:
        if (self.answer is Answer.SAME_AS) != (self.player_id is not None):
            raise ValueError("player_id goes with the answer same_as, and only with it")
        return self

    def reply(self) -> Reply:
        if self.answer is not Answer.SAME_AS:
            return self.answer
        assert self.player_id is not None  # player_id_comes_with_same_as
        return SameAs(PlayerId(self.player_id))


class MergedOutcome(BaseModel):
    outcome: Literal["merged"]
    # The player that survived the merge. It keeps its id and display name.
    survivor: UUID
    # The other player. It leaves the list.
    merged: UUID


class SettledOutcome(BaseModel):
    outcome: Literal["self", "managed", "removed", "already_answered"]


class AnswerResponse(BaseModel):
    data: list[AccountPlayer]
    meta: Annotated[MergedOutcome | SettledOutcome, Field(discriminator="outcome")]


def player_models(found: list[players.AccountPlayer]) -> list[AccountPlayer]:
    return [
        AccountPlayer(
            id=player.id,
            display_name=player.display_name,
            relationship=player.relationship,
            open_question=player.open_question,
            match_count=player.match_count,
            recent_matches=[
                RecentMatch(id=match.id, played_at=match.played_at)
                for match in player.recent_matches
            ],
        )
        for player in found
    ]


def outcome_model(outcome: players.Outcome) -> MergedOutcome | SettledOutcome:
    match outcome:
        case Merged(survivor, merged):
            return MergedOutcome(outcome="merged", survivor=survivor, merged=merged)
        case players.Settled(kind):
            return SettledOutcome(outcome=kind)


@router.get("", responses=NO_SESSION)
def account_players(
    session: DatabaseSession, account: RequestAccount
) -> AccountPlayersResponse:
    """List the players the account manages, its own player first. A merged
    player isn't listed.

    `open_question` is true for a player that a sign-in brought to the
    account, until the account answers "Is this you?" for it.
    `match_count` counts the player's matches, and `recent_matches` holds
    its latest ones, newest first.
    """
    return AccountPlayersResponse(
        data=player_models(players.account_players(session, account.id))
    )


@router.post("/{player_id}/answer", responses=ANSWER_ERRORS)
def answer_question(
    session: DatabaseSession,
    account: RequestAccount,
    player_id: UUID,
    body: AnswerRequest,
) -> AnswerResponse:
    """Answer "Is this you?" for one player. `data` lists the account's
    players after the answer, and `meta.outcome` says what the answer did.

    `yes` makes it the account's own player, with outcome `self`. If the
    account already has one, the two players merge, with outcome `merged`.
    `no` keeps it as a player the account manages, with outcome `managed`.
    `not_mine` takes it off the account, with outcome `removed`. The player
    stays, with no manager. `same_as` merges it with the `managed` player
    that `player_id` names, with outcome `merged`. That player's question
    must be closed, because the merge would close it with no answer.
    Two players who played each other never merge, so `yes` or `same_as`
    for two such players answers 409.

    In a merge, the player created first survives, and the other leaves the
    list. `meta.survivor` and `meta.merged` name them. Every answer closes
    the question. A second answer changes nothing, with outcome
    `already_answered`, but a second `not_mine` answers 409.
    """
    answered = players.answer_question(
        session, account.id, PlayerId(player_id), body.reply()
    )
    return AnswerResponse(
        data=player_models(answered.players), meta=outcome_model(answered.outcome)
    )
