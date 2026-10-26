"""The account's players, and its answers to "Is this you?".

A question is open while the account's player_managers row for the player
has `adopted_from` set. Sign-in sets it, through hand_over_players().

A merged player is hidden: the account no longer plays as it or manages it.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import Player, PlayerManager
from fortymm_api.services.player_merge import merge_into_self
from fortymm_api.services.sessions import lock_account_for_write

type Relationship = Literal["self", "managed"]


class Answer(StrEnum):
    # The row becomes 'self'. If the account has a self player, the two
    # players merge, and the survivor's row becomes 'self'.
    YES = "yes"
    # The row stays 'managed'.
    NO = "no"
    # The row goes. The player stays, with no manager.
    NOT_MINE = "not_mine"


@dataclass(frozen=True)
class AccountPlayer:
    id: PlayerId
    display_name: str
    relationship: Relationship
    open_question: bool


class PlayerNotManaged(Exception):
    """The account doesn't manage the player. `create_app()` answers 404."""


class QuestionClosed(Exception):
    """The answer is "Not mine", and the question was already answered.
    `create_app()` answers 409."""


def account_players(session: Session, account: AccountId) -> list[AccountPlayer]:
    """The players the account manages: its self player first, then the rest
    by display name."""
    lock_account_for_write(session, account)
    return _players(session, account)


def answer_question(
    session: Session, account: AccountId, player: PlayerId, answer: Answer
) -> list[AccountPlayer]:
    """Answer "Is this you?" for one player. Returns the account's players
    after the answer.

    Every answer closes the question. A second "Yes" or "No" changes nothing,
    whatever the first answer was. A second "Not mine" raises QuestionClosed,
    because it can't delete a row the first answer kept.
    """
    lock_account_for_write(session, account)
    # FOR UPDATE on every row of the account, so answers from two tabs take
    # turns. A second "Yes" sees the self player that the first one made.
    rows = session.scalars(
        select(PlayerManager)
        .join(Player, Player.id == PlayerManager.player_id)
        .where(PlayerManager.account_id == account, Player.merged_into.is_(None))
        .order_by(PlayerManager.id)
        .with_for_update(of=PlayerManager)
    ).all()
    row = next((row for row in rows if row.player_id == player), None)
    if row is None:
        raise PlayerNotManaged
    if row.adopted_from is None:
        if answer is Answer.NOT_MINE:
            raise QuestionClosed
        return _players(session, account)

    match answer:
        case Answer.YES if any(other.relationship == "self" for other in rows):
            merge_into_self(session, account, player)
        case Answer.YES:
            row.relationship = "self"
            row.adopted_from = None
        case Answer.NO:
            row.adopted_from = None
        case Answer.NOT_MINE:
            session.delete(row)
    session.flush()
    return _players(session, account)


def _players(session: Session, account: AccountId) -> list[AccountPlayer]:
    found = session.execute(
        select(
            Player.id,
            Player.display_name,
            PlayerManager.relationship,
            PlayerManager.adopted_from.is_not(None),
        )
        .join(PlayerManager, PlayerManager.player_id == Player.id)
        .where(PlayerManager.account_id == account, Player.merged_into.is_(None))
        .order_by(PlayerManager.relationship != "self", Player.display_name)
    ).all()
    return [
        AccountPlayer(id, display_name, _relationship(relationship), open_question)
        for id, display_name, relationship, open_question in found
    ]


def _relationship(value: str) -> Relationship:
    # The column's CHECK constraint allows only these two.
    if value == "self":
        return "self"
    if value == "managed":
        return "managed"
    raise ValueError(f"Unknown relationship {value!r}")
