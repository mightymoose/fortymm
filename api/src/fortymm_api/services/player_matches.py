"""The matches a player was named in: what counts as a player having played.

A match counts from the moment it's made, with a result or not, because
making a match is the activity the app records today. A player counts
together with the players merged into it.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import Match, MatchSidePlayer, Player

RECENT_LIMIT = 5


@dataclass(frozen=True)
class RecentMatch:
    id: MatchId
    # When the match was made. Nothing records when it was played yet.
    played_at: datetime


@dataclass(frozen=True)
class PlayedMatches:
    count: int
    # The latest RECENT_LIMIT, newest first.
    recent: tuple[RecentMatch, ...]


def played_matches(
    session: Session, players: Collection[PlayerId]
) -> dict[PlayerId, PlayedMatches]:
    """Each of `players`' matches, its own and those of the players merged
    into it. A match counts once, whichever sides name it."""
    # A row counts for the player it names if that one was asked about,
    # otherwise for the player it merged into.
    owner = case((Player.id.in_(players), Player.id), else_=Player.merged_into)
    # Distinct, because after a merge one player can be on both sides.
    named = (
        select(
            owner.label("player"),
            Match.id.label("match"),
            Match.created_at.label("made_at"),
        )
        .distinct()
        .join(MatchSidePlayer, MatchSidePlayer.player_id == Player.id)
        .join(Match, Match.id == MatchSidePlayer.match_id)
        .where(Player.id.in_(players) | Player.merged_into.in_(players))
        .subquery()
    )
    ranked = select(
        named.c.player,
        named.c.match,
        named.c.made_at,
        func.count().over(partition_by=named.c.player).label("total"),
        func.row_number()
        .over(
            partition_by=named.c.player,
            order_by=(named.c.made_at.desc(), named.c.match),
        )
        .label("rank"),
    ).subquery()
    rows = session.execute(
        select(ranked.c.player, ranked.c.match, ranked.c.made_at, ranked.c.total)
        .where(ranked.c.rank <= RECENT_LIMIT)
        .order_by(ranked.c.player, ranked.c.rank)
    )
    counts: dict[PlayerId, int] = {}
    recent: dict[PlayerId, list[RecentMatch]] = {}
    for player, match, made_at, total in rows:
        counts[player] = total
        recent.setdefault(player, []).append(RecentMatch(MatchId(match), made_at))
    return {
        player: PlayedMatches(counts.get(player, 0), tuple(recent.get(player, ())))
        for player in players
    }


def has_played(session: Session, player: PlayerId) -> bool:
    """Whether the player, or a player merged into it, is in a match."""
    return played_matches(session, [player])[player].count > 0
