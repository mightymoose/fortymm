"""The account's players, and its answers to "Is this you?".

A question is open while the account's player_managers row for the player
has `adopted_from` set. Sign-in sets it, through hand_over_players(). The
row may be `self` or `managed` while the question is open.

A merged player is hidden: the account no longer plays as it or manages it.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import Player, PlayerManager
from fortymm_api.services.player_matches import RecentMatch, played_matches
from fortymm_api.services.player_merge import Merged, merge_players, opponents
from fortymm_api.services.sessions import lock_account_for_write

type Relationship = Literal["self", "managed"]


class Answer(StrEnum):
    # The row becomes 'self'. If the account has another self player, the
    # two players merge, and the survivor's row becomes 'self'.
    YES = "yes"
    # The row becomes 'managed'. If it was the self player, the account has
    # none until its next session makes one.
    NO = "no"
    # The row goes. The player stays, with no manager.
    NOT_MINE = "not_mine"
    # The player merges with another managed player of the account, and the
    # survivor's row stays 'managed'. It comes with the other player's id, as
    # SameAs.
    SAME_AS = "same_as"


@dataclass(frozen=True)
class SameAs:
    """The answer `same_as`, with the managed player it names."""

    player: PlayerId


type Reply = Literal[Answer.YES, Answer.NO, Answer.NOT_MINE] | SameAs


@dataclass(frozen=True)
class Settled:
    kind: Literal["self", "managed", "removed", "already_answered"]


type Outcome = Settled | Merged


@dataclass(frozen=True)
class AccountPlayer:
    id: PlayerId
    display_name: str
    relationship: Relationship
    open_question: bool
    match_count: int
    recent_matches: tuple[RecentMatch, ...]
    # The account's other listed players that this one played, so they
    # can't merge.
    played_against: frozenset[PlayerId]


@dataclass(frozen=True)
class Answered:
    outcome: Outcome
    players: list[AccountPlayer]


class PlayerNotManaged(Exception):
    """The account doesn't manage the player. `create_app()` answers 404."""


class QuestionClosed(Exception):
    """The answer is "Not mine", and the question was already answered.
    `create_app()` answers 409."""


class SameAsItself(Exception):
    """The answer `same_as` names the player it answers for. `create_app()`
    answers 422."""


def account_players(session: Session, account: AccountId) -> list[AccountPlayer]:
    """The players the account manages: its self player first, then the rest
    by display name."""
    lock_account_for_write(session, account)
    return _players(session, account)


def answer_question(
    session: Session, account: AccountId, player: PlayerId, answer: Reply
) -> Answered:
    """Answer "Is this you?" for one player. Returns what the answer did, and
    the account's players after it.

    Every answer closes the question. A second answer changes nothing,
    whatever the first answer was, and its outcome is `already_answered`. A
    second "Not mine" raises QuestionClosed, because it can't delete a row
    the first answer kept.

    `same_as` names a managed player of the account whose question is
    closed. A player with an open question is refused, because the merge
    would close its question with no answer.
    """
    lock_account_for_write(session, account)
    if isinstance(answer, SameAs) and answer.player == player:
        raise SameAsItself
    # FOR UPDATE on every row of the account, so answers from two tabs take
    # turns. A second "Yes" sees the self player that the first one made.
    rows = {
        row.player_id: row
        for row in session.scalars(
            select(PlayerManager)
            .join(Player, Player.id == PlayerManager.player_id)
            .where(PlayerManager.account_id == account, Player.merged_into.is_(None))
            .order_by(PlayerManager.id)
            .with_for_update(of=PlayerManager)
        )
    }
    row = rows.get(player)
    if row is None:
        raise PlayerNotManaged
    if isinstance(answer, SameAs):
        target = rows.get(answer.player)
        if (
            target is None
            or target.relationship != "managed"
            or target.adopted_from is not None
        ):
            raise PlayerNotManaged
    if row.adopted_from is None:
        if answer is Answer.NOT_MINE:
            raise QuestionClosed
        return Answered(Settled("already_answered"), _players(session, account))

    outcome: Outcome
    match answer:
        case SameAs(target_player):
            outcome = merge_players(session, account, player, target_player)
        case Answer.YES:
            self_player = next(
                (id for id, other in rows.items() if other.relationship == "self"),
                None,
            )
            if self_player is None or self_player == player:
                row.relationship = "self"
                row.adopted_from = None
                outcome = Settled("self")
            else:
                outcome = merge_players(session, account, player, self_player)
        case Answer.NO:
            row.relationship = "managed"
            row.adopted_from = None
            outcome = Settled("managed")
        case Answer.NOT_MINE:
            session.delete(row)
            outcome = Settled("removed")
    session.flush()
    return Answered(outcome, _players(session, account))


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
    listed = {id for id, *_ in found}
    played = opponents(session, listed)
    matches = played_matches(session, listed)
    return [
        AccountPlayer(
            id,
            display_name,
            _relationship(relationship),
            open_question,
            match_count=matches[id].count,
            recent_matches=matches[id].recent,
            played_against=played[id] & listed,
        )
        for id, display_name, relationship, open_question in found
    ]


def _relationship(value: str) -> Relationship:
    # The column's CHECK constraint allows only these two.
    if value == "self":
        return "self"
    if value == "managed":
        return "managed"
    raise ValueError(f"Unknown relationship {value!r}")
