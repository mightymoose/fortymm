"""Players, accounts and matches for the match tests, made directly in the
database, so a test names exactly who plays as whom."""

import uuid
from collections.abc import Callable
from datetime import datetime

from sqlalchemy import Engine, insert, select, update
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import (
    Account,
    League,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    Player,
    PlayerManager,
)
from fortymm_api.services.matches import MatchDetails


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def add_player(session: Session) -> PlayerId:
    """A player that no account manages, as a record made for an opponent
    is."""
    return session.scalars(
        insert(Player)
        .values(display_name=f"player {uuid.uuid4().hex[:12]}")
        .returning(Player.id)
    ).one()


def add_account(session: Session, plays_as: PlayerId | None = None) -> AccountId:
    """A guest account whose self player is `plays_as`."""
    account = session.scalars(insert(Account).returning(Account.id)).one()
    if plays_as:
        session.add(
            PlayerManager(player_id=plays_as, account_id=account, relationship="self")
        )
        session.flush()
    return account


def add_match(
    session: Session,
    match: MatchId,
    details: MatchDetails,
    *,
    created_at: datetime | None = None,
) -> None:
    """The match, its settings, its two sides and their players, in the
    default league. A trigger keeps a match's created_at, so a test that
    orders matches gives it here."""
    settings = session.scalars(
        insert(MatchSettings)
        .values(team_size=1, best_of=details.best_of, rated=details.rated)
        .returning(MatchSettings.id)
    ).one()
    league = session.scalars(select(League.id).where(League.is_default)).one()
    session.execute(
        insert(Match).values(
            id=match,
            settings_id=settings,
            league_id=league,
            **({"created_at": created_at} if created_at else {}),
        )
    )
    for side, player in enumerate(details.players):
        side_id = session.scalars(
            insert(MatchSide).values(match_id=match, side=side).returning(MatchSide.id)
        ).one()
        session.execute(
            insert(MatchSidePlayer).values(
                match_side_id=side_id, match_id=match, player_id=player
            )
        )


def merge(session: Session, player: PlayerId, into: PlayerId) -> None:
    """Point `player` at `into`, as a merge does, without the merge's rules."""
    session.execute(update(Player).where(Player.id == player).values(merged_into=into))
