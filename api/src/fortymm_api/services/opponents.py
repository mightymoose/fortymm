"""The players an account may pick as its opponent when it makes a match."""

from dataclasses import dataclass

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import Match, MatchSidePlayer, Player, PlayerManager

RECENT_LIMIT = 12
SEARCH_LIMIT = 20


@dataclass(frozen=True)
class Opponent:
    # The player that survives any merge.
    id: PlayerId
    display_name: str


def opponents(
    session: Session, account: AccountId, search: str | None
) -> list[Opponent]:
    """With no search text, or only spaces, the players that the account's
    self player faced, most recent match first, each once, at most
    RECENT_LIMIT. With text, the players whose display name contains it,
    whatever its case, by name, at most SEARCH_LIMIT.

    Every player is one that no merge replaced, and never the account's own
    self player. An account with no self player has no recent opponents.
    """
    me = session.scalar(
        select(PlayerManager.player_id).where(
            PlayerManager.account_id == account,
            PlayerManager.relationship == "self",
        )
    )
    term = (search or "").strip()
    if term:
        return _search(session, term, me)
    if me is None:
        return []
    return _recent(session, me)


def _search(session: Session, term: str, me: PlayerId | None) -> list[Opponent]:
    query = select(Player.id, Player.display_name).where(
        Player.merged_into.is_(None),
        Player.display_name.icontains(term, autoescape=True),
    )
    if me is not None:
        query = query.where(Player.id != me)
    rows = session.execute(
        query.order_by(func.lower(Player.display_name), Player.id).limit(SEARCH_LIMIT)
    )
    return [Opponent(id, display_name) for id, display_name in rows]


def _recent(session: Session, me: PlayerId) -> list[Opponent]:
    mine, theirs = aliased(MatchSidePlayer), aliased(MatchSidePlayer)
    my_player, their_player = aliased(Player), aliased(Player)
    survivor = func.coalesce(their_player.merged_into, their_player.id)
    faced = (
        select(survivor.label("player"), func.max(Match.created_at).label("last"))
        .select_from(mine)
        .join(my_player, my_player.id == mine.player_id)
        .join(
            theirs,
            and_(
                theirs.match_id == mine.match_id,
                theirs.match_side_id != mine.match_side_id,
            ),
        )
        .join(their_player, their_player.id == theirs.player_id)
        .join(Match, Match.id == mine.match_id)
        .where(func.coalesce(my_player.merged_into, my_player.id) == me, survivor != me)
        .group_by(survivor)
        .subquery()
    )
    rows = session.execute(
        select(Player.id, Player.display_name)
        .join(faced, faced.c.player == Player.id)
        .order_by(faced.c.last.desc(), Player.id)
        .limit(RECENT_LIMIT)
    )
    return [Opponent(id, display_name) for id, display_name in rows]
