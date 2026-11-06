"""Recording a match's results, as its players' devices signed them (#188).
references/matches.md explains the rules.

A result is one distinct payload, stored once and found by its hash. Each
signature counts once per (result, key, side), as an approval. A match's
results form one chain, and every new result replaces its head. A result
counts once it has the approvals it needs, and then the match is final.

Every upload for a match that exists is logged, refused or not. So
record_result() returns Refused instead of raising once it could log, and
the request still commits the submission.
"""

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import exists, func, insert, select, update
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId, MatchResultId
from fortymm_api.models import (
    Match,
    MatchApproval,
    Player,
    PlayerManager,
    SigningKey,
    StoredMatchResult,
)
from fortymm_api.services.matches import (
    ACCEPTED,
    Authority,
    MatchDetails,
    RecordedApproval,
    Refusal,
    Refused,
    Sender,
    lock_match,
    log_refusal,
    log_submission,
    match_differences,
    result_approvals,
    sides_are_one_player,
    stored_details,
)
from fortymm_api.services.sessions import ClientNetwork, lock_account_for_write
from fortymm_api.services.signing_keys import verification_keys
from fortymm_api.signed_results import (
    BadSignature,
    Completed,
    Ending,
    GamePoints,
    Malformed,
    MatchResult,
    ResultHash,
    Retired,
    Side,
    Signature,
    UnknownKey,
    decode_envelope,
    encode_payload,
    result_hash,
)
from fortymm_api.signing_keys import KeyId

# A finished game's winner has at least this many points.
GAME_POINTS = 11


class IllegalEnding(Exception):
    """The games aren't a legal ending to the match: a game's score can't be
    final, the match ends before its last game or isn't decided by it, or a
    retirement comes after the match was decided."""


class SidesAreOnePlayer(Exception):
    """A merge made both sides of the match one player, so no override
    may settle it. `create_app()` answers 409."""


class InvalidOverrideReason(Exception):
    """An override's reason is empty after trimming. `create_app()` answers
    422."""


@dataclass(frozen=True)
class Recorded:
    """A result as the server holds it after the request."""

    hash: ResultHash
    match_id: MatchId
    # When it counted, which made the match final. None until then, and for
    # good once another result replaces it first.
    accepted_at: datetime | None
    approvals: tuple[RecordedApproval, ...]


@dataclass(frozen=True)
class _Head:
    id: MatchResultId
    hash: ResultHash


@dataclass(frozen=True)
class _Signer:
    """A new approval: an account's key that may approve for its player."""

    signature: Signature
    account: AccountId
    player: PlayerId
    authority: Authority


def record_result(
    session: Session, match_id: MatchId, envelope: bytes, sender: Sender
) -> Recorded | Refused:
    """Record the signed result in `envelope` for the match `match_id`, with
    its new approvals, and accept it once it has the approvals it needs.

    It needs no session: the signatures are the authority. Refused, in this
    order, for: bytes that aren't the format, another match, a key that
    isn't registered or was revoked, a bad signature, scores that aren't a
    legal ending, a match whose sides a merge made one player, a match
    with other details, a new signature whose account neither plays as nor
    manages its player, new approvals for a result another result replaced,
    and a new result that doesn't replace the head. A signed-out key still
    verifies, because results from a hall upload late.

    A signature already recorded with the same bytes needs no key, so an
    exact retry returns the result whatever has happened to its keys since.
    Raises MatchNotFound, and writes nothing, for a match that doesn't
    exist. No route makes a match yet.
    """
    match = lock_match(session, match_id)

    def refuse(
        refusal: Refused | Refusal, about: MatchResultId | None = None
    ) -> Refused:
        return log_refusal(
            session, match_id, "result", envelope, sender, refusal, about
        )

    try:
        unverified = decode_envelope(envelope)
    except Malformed:
        return refuse(Refusal.MALFORMED)
    if unverified.match != match_id:
        return refuse(Refusal.WRONG_MATCH)
    recorded = _recorded_signatures(session, unverified.payload)
    keys = verification_keys(session, unverified.kids)
    already = [
        s for s in unverified.signatures if s.signature == recorded.get((s.kid, s.side))
    ]
    try:
        verified = unverified.verify(
            (key.public_key for key in keys.values()), verified=already
        )
    except UnknownKey:
        return refuse(Refusal.UNKNOWN_KEY)
    except BadSignature:
        return refuse(Refusal.BAD_SIGNATURE)
    try:
        check_ending(verified.result)
    except IllegalEnding:
        return refuse(Refusal.ILLEGAL_ENDING)
    if sides_are_one_player(session, match_id):
        return refuse(Refusal.SAME_PLAYER)
    details = MatchDetails.of(verified.result)
    if differences := match_differences(session, match, details):
        return refuse(Refused(Refusal.MATCH_DIFFERS, differences))
    signers = _signers(session, unverified.signatures, recorded)
    if signers is None:
        return refuse(Refusal.NO_AUTHORITY)

    stored = session.scalar(
        select(StoredMatchResult.id).where(
            func.sha256(StoredMatchResult.payload) == verified.hash
        )
    )
    head = _head(session, match_id)
    if stored is not None and not signers:
        log_submission(session, match_id, "result", envelope, sender, ACCEPTED, stored)
        return _recorded(session, match_id, stored, verified.hash)
    if stored is not None:
        if head is None or head.id != stored:
            return refuse(Refusal.NOT_HEAD, about=stored)
        result = stored
    else:
        if verified.result.replaces != (None if head is None else head.hash):
            return refuse(Refusal.STALE)
        result = session.scalars(
            insert(StoredMatchResult)
            .values(
                match_id=match_id,
                payload=unverified.payload,
                replaces_id=None if head is None else head.id,
            )
            .returning(StoredMatchResult.id)
        ).one()
    submission = log_submission(
        session, match_id, "result", envelope, sender, ACCEPTED, result
    )
    for signer in signers:
        session.execute(
            insert(MatchApproval).values(
                result_id=result,
                key_id=signer.signature.kid,
                side=signer.signature.side,
                signature=signer.signature.signature,
                account_id=signer.account,
                player_id=signer.player,
                authority=signer.authority,
                submission_id=submission.id,
            )
        )
    _accept_if_approved(session, match, result, verified.result.rated)
    return _recorded(session, match_id, result, verified.hash)


def override_result(
    session: Session,
    match_id: MatchId,
    admin: AccountId,
    network: ClientNetwork | None,
    games: tuple[GamePoints, ...],
    ending: Ending,
    reason: str,
) -> Recorded:
    """Impose a result on the match, as the administrator `admin`, who holds
    matches.override. The caller checks the permission.

    The server encodes the payload itself, with the match's details, the
    head's hash as `replaces` and now as its time. The result has no
    approvals and counts at once, so it replaces the current result, or
    cuts off a counter that waits on it. Players can still correct it the
    normal way. The reason is trimmed.

    Raises, before it writes anything: InvalidOverrideReason for a blank
    reason, MatchNotFound, SidesAreOnePlayer for a match whose sides a merge
    made one player, and IllegalEnding for scores that aren't a legal
    ending. The check holds the side players, as `record_result()` does, so
    a merge of them waits for the override, then sees its result.
    """
    reason = reason.strip()
    if not reason:
        raise InvalidOverrideReason
    lock_account_for_write(session, admin)
    match = lock_match(session, match_id)
    if sides_are_one_player(session, match_id):
        raise SidesAreOnePlayer
    details = stored_details(session, match)
    head = _head(session, match_id)
    try:
        result = MatchResult(
            match=match_id,
            best_of=details.best_of,
            rated=details.rated,
            players=details.players,
            games=games,
            ending=ending,
            replaces=None if head is None else head.hash,
        )
    except ValueError as error:
        raise IllegalEnding from error
    check_ending(result)
    payload = encode_payload(result, datetime.now(UTC).replace(microsecond=0))
    stored = session.scalars(
        insert(StoredMatchResult)
        .values(
            match_id=match_id,
            payload=payload,
            replaces_id=None if head is None else head.id,
            override_reason=reason,
        )
        .returning(StoredMatchResult.id)
    ).one()
    log_submission(
        session,
        match_id,
        "override",
        payload,
        Sender(admin, network),
        ACCEPTED,
        stored,
    )
    _accept(session, match, stored)
    return _recorded(session, match_id, stored, result_hash(payload))


def check_ending(result: MatchResult) -> None:
    """Raise IllegalEnding unless the games are a legal ending to the match.
    web-client/src/scoring/board.ts holds the same rules for the scoring pad.

    A completed match is decided by its last game: every game has a final
    score, and a side reaches the wins it needs at the last game, not before
    and not never. A retired match was not decided: every game but the last
    has a final score, the last may be unfinished, and no side has the wins
    it needs. A retirement before the first point has no games.
    """
    needed = (result.best_of + 1) // 2
    wins = [0, 0]
    match result.ending:
        case Completed():
            for number, points in enumerate(result.games, 1):
                winner = _final_winner(points)
                wins[winner] += 1
                if wins[winner] == needed and number != len(result.games):
                    raise IllegalEnding
            if max(wins) < needed:
                raise IllegalEnding
        case Retired():
            for number, points in enumerate(result.games, 1):
                if number == len(result.games) and _unfinished(points):
                    continue
                wins[_final_winner(points)] += 1
            if max(wins) >= needed:
                raise IllegalEnding


def games_won(result: MatchResult) -> tuple[int, int]:
    """The games each side won, players[0]'s first, in a result that
    check_ending() accepted. A retired match's unfinished last game counts
    for nobody."""
    wins = [0, 0]
    for number, points in enumerate(result.games, 1):
        if (
            isinstance(result.ending, Retired)
            and number == len(result.games)
            and _unfinished(points)
        ):
            continue
        wins[_final_winner(points)] += 1
    return wins[0], wins[1]


def _final_winner(points: GamePoints) -> Side:
    """The side that won a game with this final score: at least 11 points,
    with at most 9 for the loser at 11, or else exactly 2 ahead after
    deuce."""
    a, b = points
    high, low = max(a, b), min(a, b)
    legal = (high == GAME_POINTS and low <= GAME_POINTS - 2) or (
        high > GAME_POINTS and high - low == 2
    )
    if not legal:
        raise IllegalEnding
    return 0 if a > b else 1


def _unfinished(points: GamePoints) -> bool:
    """Whether a game can still go on from this score: nobody has 11 yet,
    or it is at deuce with no 2-point lead."""
    high, low = max(points), min(points)
    return high < GAME_POINTS or (low >= GAME_POINTS - 1 and high - low < 2)


def _recorded_signatures(
    session: Session, payload: bytes
) -> dict[tuple[KeyId, int], bytes]:
    """The signature bytes of each (key, side) the payload's result already
    counts, if it is stored."""
    rows = session.execute(
        select(MatchApproval.key_id, MatchApproval.side, MatchApproval.signature)
        .join(StoredMatchResult, StoredMatchResult.id == MatchApproval.result_id)
        .where(func.sha256(StoredMatchResult.payload) == result_hash(payload))
    )
    return {(key, side): signature for key, side, signature in rows}


def _signers(
    session: Session,
    signatures: tuple[Signature, ...],
    recorded: dict[tuple[KeyId, int], bytes],
) -> list[_Signer] | None:
    """Each (key, side) of `signatures` that isn't recorded yet, once, with
    the authority of the key's account over the signature's player. None if
    one has no authority."""
    signers: dict[tuple[KeyId, int], _Signer] = {}
    for signature in signatures:
        slot = (signature.kid, signature.side)
        if slot in recorded or slot in signers:
            continue
        authority = _authority(session, signature.kid, signature.player)
        if authority is None:
            return None
        account, player, kind = authority
        signers[slot] = _Signer(signature, account, player, kind)
    return list(signers.values())


def _authority(
    session: Session, key: KeyId, player: PlayerId
) -> tuple[AccountId, PlayerId, Authority] | None:
    """The key's account, the player's survivor, and the account's authority
    over it, if it has one: its `self` player, or a `managed` player with no
    open "Is this you?" question. Creating a match against a player grants
    none. One statement, so the key's owner and its rows are read together.
    A revoked key has no authority."""
    written = aliased(Player)
    row = session.execute(
        select(
            SigningKey.account_id,
            PlayerManager.player_id,
            PlayerManager.relationship,
        )
        .join(PlayerManager, PlayerManager.account_id == SigningKey.account_id)
        .join(
            written,
            func.coalesce(written.merged_into, written.id) == PlayerManager.player_id,
        )
        .where(
            SigningKey.id == key,
            SigningKey.revoked_at.is_(None),
            written.id == player,
            PlayerManager.adopted_from.is_(None),
        )
    ).one_or_none()
    if row is None:
        return None
    account, survivor, relationship = row
    return account, survivor, "self" if relationship == "self" else "representative"


def _head(session: Session, match_id: MatchId) -> _Head | None:
    """The match's result that nothing replaces, if it has results."""
    successor = aliased(StoredMatchResult)
    row = session.execute(
        select(StoredMatchResult.id, func.sha256(StoredMatchResult.payload)).where(
            StoredMatchResult.match_id == match_id,
            ~exists().where(successor.replaces_id == StoredMatchResult.id),
        )
    ).one_or_none()
    return None if row is None else _Head(row[0], ResultHash(row[1]))


def _accept_if_approved(
    session: Session, match: Match, result: MatchResultId, rated: bool
) -> None:
    """Accept the result, and make it the match's current one, once its
    approvals cover the sides it needs: both for a rated result, or for a
    correction of a match that is final. Otherwise one. The caller holds the
    match's lock and has checked that the result is the head."""
    accepted_at = session.scalar(
        select(StoredMatchResult.accepted_at).where(StoredMatchResult.id == result)
    )
    if accepted_at is not None:
        return
    sides = set(
        session.scalars(
            select(MatchApproval.side).where(MatchApproval.result_id == result)
        )
    )
    needed = 2 if rated or match.current_result_id is not None else 1
    if len(sides) >= needed:
        _accept(session, match, result)


def _accept(session: Session, match: Match, result: MatchResultId) -> None:
    """Accept the head `result` and make it the match's current result."""
    session.execute(
        update(StoredMatchResult)
        .where(StoredMatchResult.id == result)
        .values(accepted_at=func.now())
    )
    match.current_result_id = result
    session.flush()


def _recorded(
    session: Session, match_id: MatchId, result: MatchResultId, hash: ResultHash
) -> Recorded:
    accepted_at = session.scalar(
        select(StoredMatchResult.accepted_at).where(StoredMatchResult.id == result)
    )
    return Recorded(
        hash, match_id, accepted_at, result_approvals(session, [result])[result]
    )
