"""Matches: making one, taking its lock, comparing what a request says about
it with what it is, and its boards (#187).
services/match_results.py records results (#188).

Only `create_match()` makes a match, so a board, result or override for a
match that doesn't exist raises MatchNotFound and writes nothing. One whose
details differ from the match's is refused, and says what differs. Players
are compared through merged_into, so a request from before a merge still
fits.

A write that a refusal can follow returns Refused rather than raising, so
the request's transaction still commits the submission that logs it.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import BestOf, MatchId, MatchResultId
from fortymm_api.models import (
    League,
    Match,
    MatchApproval,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchSubmission,
    Player,
)
from fortymm_api.services.sessions import ClientNetwork, lock_account_for_write
from fortymm_api.signed_results import (
    Malformed,
    MatchResult,
    Side,
    decode_envelope,
    decode_payload,
)
from fortymm_api.signing_keys import KeyId

# The class key of pg_advisory_xact_lock(int, int), whose keyspace doesn't
# meet the one-key locks of sign-in and roles.
MATCH_LOCK = int.from_bytes(b"MTCH")

type Difference = Literal["players", "best_of", "rated"]
type SubmissionKind = Literal["board", "result", "override"]
# `self` for the account's own player, `representative` for one it manages.
type Authority = Literal["self", "representative"]
ACCEPTED = "accepted"


@dataclass(frozen=True)
class MatchDetails:
    """What a match fixes forever. Players are in side order."""

    best_of: BestOf
    rated: bool
    players: tuple[PlayerId, PlayerId]

    @staticmethod
    def of(result: MatchResult) -> MatchDetails:
        return MatchDetails(result.best_of, result.rated, result.players)


@dataclass(frozen=True)
class Sender:
    """Who sent a request: the account of its session, if it had one, and
    the network it came from."""

    account: AccountId | None
    network: ClientNetwork | None


class Refusal(StrEnum):
    """Why a request for a match was refused. Its value is the submission's
    `outcome`."""

    # The bytes aren't the signed result format.
    MALFORMED = "malformed"
    # The payload names another match than the request's.
    WRONG_MATCH = "wrong_match"
    # A signature's key isn't registered, or was revoked.
    UNKNOWN_KEY = "unknown_key"
    BAD_SIGNATURE = "bad_signature"
    ILLEGAL_ENDING = "illegal_ending"
    # A new signature's account neither plays as its player nor manages it.
    NO_AUTHORITY = "no_authority"
    MATCH_DIFFERS = "match_differs"
    # Both sides are one player since a merge.
    SAME_PLAYER = "same_player"
    # New approvals for a result that another result replaced.
    NOT_HEAD = "not_head"
    # A new result that doesn't replace the match's head.
    STALE = "stale"
    # A board for a match whose result is accepted.
    MATCH_FINAL = "match_final"


@dataclass(frozen=True)
class Refused:
    refusal: Refusal
    # What differs, for MATCH_DIFFERS.
    differences: frozenset[Difference] = frozenset()


@dataclass(frozen=True)
class RecordedApproval:
    """A signature a result counts, with the player it approved for and the
    authority, as they were when it was accepted."""

    key_id: KeyId
    side: Side
    # The player that survived any merge then.
    player: PlayerId
    authority: Authority


@dataclass(frozen=True)
class BoardPushed:
    received_at: datetime


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


class MergedPlayer(Exception):
    """A new match would name a player merged into another. `create_app()`
    answers 422, so the device picks the player again."""


class SamePlayer(Exception):
    """Both sides of a match would be one player. `create_app()` answers
    422."""


class MatchNotFound(Exception):
    """No match has this id. `create_app()` answers 404."""


def create_match(
    session: Session, match_id: MatchId, details: MatchDetails, account: AccountId
) -> Created | Found | Refused:
    """Make the match in the default league, as the account's, or find it if
    it exists with the same details, so a retry or a second device gets the
    same answer. Refused with what differs otherwise. Raises UnknownPlayer,
    MergedPlayer or SamePlayer, and writes nothing, for players that can't
    play a new match. An existing match is found first, so a retry after its
    players merged still finds it.

    A new match names only players that aren't merged, so the device's copy
    of the match names the players stored. Making a match grants nobody
    anything: who may approve its results is the players' managers'
    business.
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
    if any(survivors[player] != player for player in details.players):
        raise MergedPlayer
    first, second = details.players
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


def lock_match(session: Session, match_id: MatchId) -> Match:
    """Lock the match's row FOR UPDATE until the transaction ends, and
    return the match. Raises MatchNotFound if it doesn't exist. Every write
    to a match's results and submissions holds it, so they take turns."""
    match = session.scalar(select(Match).where(Match.id == match_id).with_for_update())
    if match is None:
        raise MatchNotFound
    return match


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


def sides_are_one_player(session: Session, match_id: MatchId) -> bool:
    """Whether a merge made both sides of the match one player. Holds each
    side's surviving player, then the side players, FOR SHARE until the
    transaction ends. So a merge of them, which locks them FOR UPDATE, takes
    turns with the caller, and the later one sees the earlier.

    The locks go in the merge's order: survivors by created_at and id, then
    the players merged into them. In the other order, a caller holding a
    merged side player and a merge holding its survivor would each wait for
    the other, and Postgres would abort one as a deadlock.
    """
    side = aliased(Player)
    survivors = (
        select(func.coalesce(side.merged_into, side.id))
        .join(MatchSidePlayer, MatchSidePlayer.player_id == side.id)
        .where(MatchSidePlayer.match_id == match_id)
    )
    while True:
        locked = session.execute(
            select(Player.id, Player.merged_into)
            .where(Player.id.in_(survivors.scalar_subquery()))
            .order_by(Player.created_at, Player.id)
            .with_for_update(read=True)
        ).all()
        # A merge between the read and the lock moved a survivor. Its
        # survivor is the one to hold now.
        if any(merged_into is not None for _, merged_into in locked):
            continue
        resolved = session.scalars(
            survivors.order_by(side.created_at, side.id).with_for_update(
                read=True, of=side
            )
        ).all()
        if set(resolved) <= {player for player, _ in locked}:
            return len(set(resolved)) < len(resolved)


def stored_details(session: Session, match: Match) -> MatchDetails:
    """The match's details, with each side's player as it survives any
    merge."""
    best_of, rated = session.execute(
        select(MatchSettings.best_of, MatchSettings.rated).where(
            MatchSettings.id == match.settings_id
        )
    ).one()
    return MatchDetails(as_best_of(best_of), rated, _side_players(session, match.id))


def push_board(
    session: Session, match_id: MatchId, body: bytes, sender: Sender
) -> BoardPushed | Refused:
    """Keep `body` as the match's board, the newest one wins. It is a draft
    payload or an envelope, whose signatures nobody checks, because a board
    settles nothing.

    Raises MatchNotFound, and writes nothing, for a match that doesn't
    exist. Every other push is logged, refused or not. Refused for bytes
    that aren't the format, another match, other details than the match's,
    or a match that is final.
    """
    match = lock_match(session, match_id)

    def refuse(refusal: Refused | Refusal) -> Refused:
        return log_refusal(session, match_id, "board", body, sender, refusal)

    try:
        result = board_result(body)
    except Malformed:
        return refuse(Refusal.MALFORMED)
    if result.match != match_id:
        return refuse(Refusal.WRONG_MATCH)
    if differences := match_differences(session, match, MatchDetails.of(result)):
        return refuse(Refused(Refusal.MATCH_DIFFERS, differences))
    if match.current_result_id is not None:
        return refuse(Refusal.MATCH_FINAL)
    submission = log_submission(session, match_id, "board", body, sender, ACCEPTED)
    return BoardPushed(submission.received_at)


def log_submission(
    session: Session,
    match_id: MatchId,
    kind: SubmissionKind,
    body: bytes,
    sender: Sender,
    outcome: str,
    result_id: MatchResultId | None = None,
) -> MatchSubmission:
    """Log one request for the match, with what it sent, who sent it and its
    outcome: ACCEPTED or a Refusal."""
    return session.scalars(
        insert(MatchSubmission)
        .values(
            match_id=match_id,
            kind=kind,
            body=body,
            account_id=sender.account,
            network=None if sender.network is None else str(sender.network),
            outcome=outcome,
            result_id=result_id,
        )
        .returning(MatchSubmission)
    ).one()


def log_refusal(
    session: Session,
    match_id: MatchId,
    kind: SubmissionKind,
    body: bytes,
    sender: Sender,
    refusal: Refused | Refusal,
    result_id: MatchResultId | None = None,
) -> Refused:
    """The refusal, logged with the result it was about if it got that
    far."""
    refused = refusal if isinstance(refusal, Refused) else Refused(refusal)
    log_submission(session, match_id, kind, body, sender, refused.refusal, result_id)
    return refused


def result_approvals(
    session: Session, results: list[MatchResultId]
) -> dict[MatchResultId, tuple[RecordedApproval, ...]]:
    """Each result's approvals, sorted by key id, then side."""
    found: dict[MatchResultId, list[RecordedApproval]] = {id: [] for id in results}
    rows = session.execute(
        select(
            MatchApproval.result_id,
            MatchApproval.key_id,
            MatchApproval.side,
            MatchApproval.player_id,
            MatchApproval.authority,
        )
        .where(MatchApproval.result_id.in_(results))
        .order_by(MatchApproval.key_id, MatchApproval.side)
    )
    for result, key, side, player, authority in rows:
        found[result].append(
            RecordedApproval(key, as_side(side), player, _authority(authority))
        )
    return {id: tuple(approvals) for id, approvals in found.items()}


def board_result(body: bytes) -> MatchResult:
    """The scores a board holds, read from its payload. An envelope's
    signatures stay unchecked."""
    try:
        payload = decode_envelope(body).payload
    except Malformed:
        payload = body
    return decode_payload(payload).result


def as_best_of(value: int) -> BestOf:
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


def as_side(value: int) -> Side:
    return 0 if value == 0 else 1


def _authority(value: str) -> Authority:
    return "self" if value == "self" else "representative"


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
