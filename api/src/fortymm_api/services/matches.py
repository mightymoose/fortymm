"""Matches: making one, and comparing what a request says about it with what
it is (#187).

A device makes the match id, so a match can start with no signal. A create
whose details differ from the match's is refused, and says what differs.
Players are compared through merged_into, so a request from before a merge
still fits.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import BestOf, MatchId
from fortymm_api.models import (
    League,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    Player,
)
from fortymm_api.services.sessions import lock_account_for_write

# The class key of pg_advisory_xact_lock(int, int), whose keyspace doesn't
# meet the one-key locks of sign-in and roles.
MATCH_LOCK = int.from_bytes(b"MTCH")

type Difference = Literal["players", "best_of", "rated"]


@dataclass(frozen=True)
class MatchDetails:
    """What a match fixes forever. Players are in side order."""

    best_of: BestOf
    rated: bool
    players: tuple[PlayerId, PlayerId]


class Refusal(StrEnum):
    """Why a request for a match was refused."""

    MATCH_DIFFERS = "match_differs"


@dataclass(frozen=True)
class Refused:
    refusal: Refusal
    # What differs, for MATCH_DIFFERS.
    differences: frozenset[Difference] = frozenset()


@dataclass(frozen=True)
class Created:
    id: MatchId


@dataclass(frozen=True)
class Found:
    """The match already existed with the same details."""

    id: MatchId


class UnknownPlayer(Exception):
    """A match would name a player that doesn't exist. `create_app()`
    answers 422."""


class SamePlayer(Exception):
    """Both sides of a match would be one player, after merges.
    `create_app()` answers 422."""


def create_match(
    session: Session, match_id: MatchId, details: MatchDetails, account: AccountId
) -> Created | Found | Refused:
    """Make the match in the default league, as the account's, or find it if
    it exists with the same details, so a retry or a second device gets the
    same answer. Refused with what differs otherwise. Raises UnknownPlayer
    or SamePlayer, and writes nothing, for players that can't play a new
    match. An existing match is found first, so a retry after its players
    merged still finds it.

    Each side stores the player that survives any merge. Anyone may make a
    match, and it grants nobody anything: who may approve its results is
    the players' managers' business.
    """
    lock_account_for_write(session, account)
    # A row lock can't hold a match that isn't there yet, so two creates of
    # one id take turns here, and the second finds the first's match.
    session.execute(
        select(func.pg_advisory_xact_lock(MATCH_LOCK, func.hashtext(str(match_id))))
    )
    match = session.scalar(select(Match).where(Match.id == match_id))
    if match is not None:
        if differences := match_differences(session, match, details):
            return Refused(Refusal.MATCH_DIFFERS, differences)
        return Found(match_id)
    survivors = _survivors(session, details.players)
    if any(player not in survivors for player in details.players):
        raise UnknownPlayer
    first, second = (survivors[player] for player in details.players)
    if first == second:
        raise SamePlayer
    settings = session.scalar(
        insert(MatchSettings)
        .values(team_size=1, best_of=details.best_of, rated=details.rated)
        .returning(MatchSettings.id)
    )
    league = session.scalar(select(League.id).where(League.is_default))
    session.execute(
        insert(Match).values(
            id=match_id, settings_id=settings, league_id=league, created_by=account
        )
    )
    for side, player in enumerate((first, second)):
        side_id = session.scalar(
            insert(MatchSide)
            .values(match_id=match_id, side=side)
            .returning(MatchSide.id)
        )
        session.execute(
            insert(MatchSidePlayer).values(
                match_side_id=side_id, match_id=match_id, player_id=player
            )
        )
    return Created(match_id)


def match_differences(
    session: Session, match: Match, details: MatchDetails
) -> frozenset[Difference]:
    """What `details` say differently from the match. Players are compared
    side by side, each through merged_into."""
    stored = stored_details(session, match)
    survivors = _survivors(session, details.players)
    sent = tuple(survivors.get(player, player) for player in details.players)
    differences: set[Difference] = set()
    if sent != stored.players:
        differences.add("players")
    if stored.best_of != details.best_of:
        differences.add("best_of")
    if stored.rated != details.rated:
        differences.add("rated")
    return frozenset(differences)


def stored_details(session: Session, match: Match) -> MatchDetails:
    """The match's details, with each side's player as it survives any
    merge."""
    best_of, rated = session.execute(
        select(MatchSettings.best_of, MatchSettings.rated).where(
            MatchSettings.id == match.settings_id
        )
    ).one()
    return MatchDetails(_best_of(best_of), rated, _side_players(session, match.id))


def _best_of(value: int) -> BestOf:
    """match_settings' CHECK allows exactly these."""
    match value:
        case 1:
            return 1
        case 3:
            return 3
        case 5:
            return 5
        case 7:
            return 7
    raise ValueError(f"best of {value} isn't a match's format")


def _survivors(
    session: Session, players: tuple[PlayerId, ...]
) -> dict[PlayerId, PlayerId]:
    """Each known player's survivor: itself, or the player it merged into. A
    merge points every earlier merge at the survivor too, so one step is
    enough."""
    rows = session.execute(
        select(Player.id, func.coalesce(Player.merged_into, Player.id)).where(
            Player.id.in_(players)
        )
    )
    return {PlayerId(player): PlayerId(survivor) for player, survivor in rows}


def _side_players(session: Session, match_id: MatchId) -> tuple[PlayerId, PlayerId]:
    """The match's surviving players, in side order. Singles only."""
    written = aliased(Player)
    rows = session.execute(
        select(MatchSide.side, func.coalesce(written.merged_into, written.id))
        .join(MatchSidePlayer, MatchSidePlayer.match_side_id == MatchSide.id)
        .join(written, written.id == MatchSidePlayer.player_id)
        .where(MatchSide.match_id == match_id)
    )
    players = {side: player for side, player in rows}
    return PlayerId(players[0]), PlayerId(players[1])
