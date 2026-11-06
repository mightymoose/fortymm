"""The matches a player was named in: what counts as a player having played.

A match counts from the moment it's made, with a result or not, because
making a match is the activity the app records today. A player counts
together with the players merged into it.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import (
    Match,
    MatchSide,
    MatchSidePlayer,
    Player,
    StoredMatchResult,
)
from fortymm_api.services.match_results import games_won
from fortymm_api.signed_results import Completed, MatchResult, Retired, decode_payload

RECENT_LIMIT = 5


@dataclass(frozen=True)
class RecentResult:
    won: bool
    # The player's games, then the other side's.
    games: tuple[int, int]


@dataclass(frozen=True)
class RecentMatch:
    id: MatchId
    # When the match was made. Nothing records when it was played yet.
    played_at: datetime
    # The display names on the other side, each player named by its
    # survivor, in name order.
    opponents: tuple[str, ...]
    # From the match's current result. None until it has one.
    result: RecentResult | None


@dataclass(frozen=True)
class _SidePlayer:
    side: int
    player: PlayerId
    merged_into: PlayerId | None
    survivor: PlayerId
    survivor_name: str


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
    ).all()
    matches = {match for _, match, _, _ in rows}
    sides = _side_players(session, matches)
    results = _current_results(session, matches)
    counts: dict[PlayerId, int] = {}
    recent: dict[PlayerId, list[RecentMatch]] = {}
    for player, match, made_at, total in rows:
        counts[player] = total
        recent.setdefault(player, []).append(
            _recent_match(player, match, made_at, sides[match], results.get(match))
        )
    return {
        player: PlayedMatches(counts.get(player, 0), tuple(recent.get(player, ())))
        for player in players
    }


def _side_players(
    session: Session, matches: Collection[MatchId]
) -> dict[MatchId, list[_SidePlayer]]:
    survivor = aliased(Player)
    rows = session.execute(
        select(
            MatchSide.match_id,
            MatchSide.side,
            Player.id,
            Player.merged_into,
            survivor.id,
            survivor.display_name,
        )
        .join(MatchSidePlayer, MatchSidePlayer.match_side_id == MatchSide.id)
        .join(Player, Player.id == MatchSidePlayer.player_id)
        .join(survivor, survivor.id == func.coalesce(Player.merged_into, Player.id))
        .where(MatchSide.match_id.in_(matches))
    )
    found: dict[MatchId, list[_SidePlayer]] = {}
    for match, side, player, merged_into, survivor_id, survivor_name in rows:
        found.setdefault(match, []).append(
            _SidePlayer(side, player, merged_into, survivor_id, survivor_name)
        )
    return found


def _current_results(
    session: Session, matches: Collection[MatchId]
) -> dict[MatchId, MatchResult]:
    rows = session.execute(
        select(Match.id, StoredMatchResult.payload)
        .join(StoredMatchResult, StoredMatchResult.id == Match.current_result_id)
        .where(Match.id.in_(matches))
    )
    return {match: decode_payload(payload).result for match, payload in rows}


def _recent_match(
    player: PlayerId,
    match: MatchId,
    made_at: datetime,
    side_players: list[_SidePlayer],
    result: MatchResult | None,
) -> RecentMatch:
    mine = {
        found.side
        for found in side_players
        if player in (found.player, found.merged_into)
    }
    opponents = {
        found.survivor: found.survivor_name
        for found in side_players
        if found.side not in mine
    }
    return RecentMatch(
        match,
        made_at,
        tuple(sorted(opponents.values(), key=str.casefold)),
        _recent_result(result, mine),
    )


def _recent_result(result: MatchResult | None, mine: set[int]) -> RecentResult | None:
    # A side is the index into result.players. A player merged from both
    # sides is on neither side of the result.
    if result is None or len(mine) != 1:
        return None
    (side,) = mine
    games = games_won(result)
    own, other = games[side], games[1 - side]
    match result.ending:
        case Completed():
            won = own > other
        case Retired(by):
            won = by != side
    return RecentResult(won, (own, other))


def has_played(session: Session, player: PlayerId) -> bool:
    """Whether the player, or a player merged into it, is in a match."""
    return played_matches(session, [player])[player].count > 0
