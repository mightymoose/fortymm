"""What the admin page shows about players: every player found by name, and
one player's page, with the accounts that manage it.

A merged player isn't listed, because its survivor stands for it. Its own
page still answers, and names the survivor.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, Email, PlayerId
from fortymm_api.models import (
    Account,
    League,
    LeagueMember,
    Player,
    PlayerManager,
)
from fortymm_api.services.player_matches import played_matches

PLAYER_PAGE_SIZE = 50


@dataclass(frozen=True)
class AdminPlayer:
    id: PlayerId
    display_name: str
    # The account that plays as it, if any. Its email is None for a guest.
    account: AccountId | None
    account_email: Email | None
    # How many accounts manage it, the one that plays as it included.
    manager_count: int


@dataclass(frozen=True)
class PlayerPage:
    players: list[AdminPlayer]
    # More players match than the page holds.
    has_more: bool


@dataclass(frozen=True)
class Manager:
    """An account that manages the player."""

    id: AccountId
    # None for a guest.
    email: Email | None
    relationship: Literal["self", "managed"]
    # The account hasn't answered "Is this you?" for the player yet.
    open_question: bool


@dataclass(frozen=True)
class Survivor:
    id: PlayerId
    display_name: str


@dataclass(frozen=True)
class PlayerDetail:
    """What the admin page shows about one player."""

    id: PlayerId
    display_name: str
    created_at: datetime
    # The player it merged into, or None if it didn't merge.
    merged_into: Survivor | None
    # The matches it was named in, a player merged into it's too, with a
    # result or not.
    match_count: int
    # The accounts that play as it or manage it, the one that plays as it
    # first, then verified accounts by email, then guests.
    managers: tuple[Manager, ...]
    # The names of its leagues, by name.
    leagues: tuple[str, ...]


class PlayerNotFound(Exception):
    """No player has the id. `create_app()` answers 404."""


def list_players(session: Session, name: str | None) -> PlayerPage:
    """The players no merge replaced whose display name contains `name`,
    whatever its case, by name. At most PLAYER_PAGE_SIZE."""
    term = (name or "").strip()
    self_row = aliased(PlayerManager)
    manager_count = (
        select(func.count())
        .where(PlayerManager.player_id == Player.id)
        .scalar_subquery()
    )
    query = (
        select(
            Player.id,
            Player.display_name,
            self_row.account_id,
            Account.email,
            manager_count,
        )
        .outerjoin(
            self_row,
            and_(self_row.player_id == Player.id, self_row.relationship == "self"),
        )
        .outerjoin(Account, Account.id == self_row.account_id)
        .where(Player.merged_into.is_(None))
        .order_by(func.lower(Player.display_name), Player.id)
        .limit(PLAYER_PAGE_SIZE + 1)
    )
    if term:
        query = query.where(Player.display_name.icontains(term, autoescape=True))
    found = [
        AdminPlayer(id, display_name, account, email, count)
        for id, display_name, account, email, count in session.execute(query)
    ]
    return PlayerPage(found[:PLAYER_PAGE_SIZE], has_more=len(found) > PLAYER_PAGE_SIZE)


def get_player(session: Session, player: PlayerId) -> PlayerDetail:
    """The player, merged or not, with its managers, leagues and how many
    matches it was in."""
    survivor = aliased(Player)
    row = session.execute(
        select(
            Player.display_name,
            Player.created_at,
            survivor.id,
            survivor.display_name,
        )
        .outerjoin(survivor, survivor.id == Player.merged_into)
        .where(Player.id == player)
    ).one_or_none()
    if row is None:
        raise PlayerNotFound
    display_name, created_at, survivor_id, survivor_name = row

    match_count = played_matches(session, [player])[player].count
    managers = session.execute(
        select(
            PlayerManager.account_id,
            Account.email,
            PlayerManager.relationship,
            PlayerManager.adopted_from.is_not(None),
        )
        .join(Account, Account.id == PlayerManager.account_id)
        .where(PlayerManager.player_id == player)
        .order_by(
            PlayerManager.relationship != "self",
            Account.email.is_(None),
            Account.email,
            Account.id,
        )
    ).all()
    leagues = session.scalars(
        select(League.name)
        .join(LeagueMember, LeagueMember.league_id == League.id)
        .where(LeagueMember.player_id == player)
        .order_by(func.lower(League.name))
    ).all()
    return PlayerDetail(
        player,
        display_name,
        created_at,
        Survivor(survivor_id, survivor_name) if survivor_id else None,
        match_count,
        tuple(
            Manager(account, email, _relationship(relationship), open_question)
            for account, email, relationship, open_question in managers
        ),
        tuple(leagues),
    )


def _relationship(value: str) -> Literal["self", "managed"]:
    # The column's CHECK constraint allows only these two.
    if value == "self":
        return "self"
    if value == "managed":
        return "managed"
    raise ValueError(f"Unknown relationship {value!r}")
