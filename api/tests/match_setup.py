"""Players, accounts, keys and matches for the match tests, made directly in
the database, so a test names exactly who manages whom."""

import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from ipaddress import ip_address
from typing import NamedTuple

from sqlalchemy import Engine, func, insert, select, update
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import (
    Account,
    League,
    Match,
    MatchApproval,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchSubmission,
    Player,
    PlayerManager,
    StoredMatchResult,
)
from fortymm_api.services.matches import MatchDetails, Sender
from fortymm_api.services.sessions import client_network
from fortymm_api.services.signing_keys import register_key
from fortymm_api.signed_results import (
    Completed,
    GamePoints,
    MatchResult,
    decode_payload,
    encode_payload,
    result_hash,
)
from fortymm_api.signing_keys import KeyId, SigningPrivateKey

NETWORK = client_network(ip_address("203.0.113.7"))
ISSUED_AT = datetime(2026, 11, 4, 12, tzinfo=UTC)


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def add_player(session: Session, id: uuid.UUID | None = None) -> PlayerId:
    """A player that no account manages, as a record made for an opponent
    is."""
    return session.scalars(
        insert(Player)
        .values(id=id or uuid.uuid4(), display_name=f"player {uuid.uuid4().hex[:12]}")
        .returning(Player.id)
    ).one()


def add_account(
    session: Session,
    plays_as: PlayerId | None = None,
    manages: Iterable[PlayerId] = (),
    keys: Iterable[SigningPrivateKey] = (),
) -> AccountId:
    """A guest account whose self player is `plays_as`, which manages
    `manages`, and which registered `keys`."""
    account = session.scalars(insert(Account).returning(Account.id)).one()
    rows = [(plays_as, "self")] if plays_as else []
    rows += [(player, "managed") for player in manages]
    for player, relationship in rows:
        session.add(
            PlayerManager(
                player_id=player, account_id=account, relationship=relationship
            )
        )
    session.flush()
    for key in keys:
        register_key(
            session,
            account,
            public_key=key.public_key.to_cose_key(),
            proof=key.registration_proof(account),
            label="Phone",
        )
    return account


def add_match(
    session: Session,
    match: MatchId,
    details: MatchDetails,
    created_by: AccountId | None = None,
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
            created_by=created_by,
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


def add_result(session: Session, result: MatchResult) -> None:
    """The match's first result, with no approvals, so it doesn't count."""
    session.execute(
        insert(StoredMatchResult).values(
            match_id=result.match, payload=encode_payload(result, ISSUED_AT)
        )
    )


def played(
    session: Session,
    players: tuple[PlayerId, PlayerId],
    *,
    rated: bool = True,
    with_result: bool = True,
    match: MatchId | None = None,
) -> MatchId:
    """A best of 3 between `players`, with a result unless told otherwise."""
    match = match or MatchId(uuid.uuid4())
    add_match(session, match, MatchDetails(3, rated, players))
    if with_result:
        add_result(
            session,
            MatchResult(
                match=match,
                best_of=3,
                rated=rated,
                players=players,
                games=((11, 5), (11, 7)),
                ending=Completed(),
            ),
        )
    return match


def merge(session: Session, player: PlayerId, into: PlayerId) -> None:
    """Point `player` at `into`, as a merge does, without the merge's rules."""
    session.execute(update(Player).where(Player.id == player).values(merged_into=into))


def sender(account: AccountId | None = None) -> Sender:
    return Sender(account, NETWORK)


def outcomes(database: Engine, match: MatchId) -> list[tuple[str, str]]:
    """Each logged request for the match, oldest first, as (kind, outcome)."""
    return in_transaction(
        database,
        lambda session: [
            (kind, outcome)
            for kind, outcome in session.execute(
                select(MatchSubmission.kind, MatchSubmission.outcome)
                .where(MatchSubmission.match_id == match)
                .order_by(MatchSubmission.id)
            )
        ],
    )


class StoredResult(NamedTuple):
    hash: bytes
    replaces: bytes | None
    games: tuple[GamePoints, ...]
    accepted_at: datetime | None
    override_reason: str | None


def result_chain(database: Engine, match: MatchId) -> list[StoredResult]:
    """The match's results, from the first to the one nothing replaces."""

    def read(session: Session) -> list[StoredResult]:
        rows = session.scalars(
            select(StoredMatchResult).where(StoredMatchResult.match_id == match)
        ).all()
        successors = {row.replaces_id: row for row in rows}
        hashes = {row.id: result_hash(row.payload) for row in rows}
        chain = []
        row = successors.get(None)
        while row is not None:
            chain.append(
                StoredResult(
                    hashes[row.id],
                    None if row.replaces_id is None else hashes[row.replaces_id],
                    decode_payload(row.payload).result.games,
                    row.accepted_at,
                    row.override_reason,
                )
            )
            row = successors.get(row.id)
        return chain

    return in_transaction(database, read)


def current_result(database: Engine, match: MatchId) -> bytes | None:
    """The hash of the result that settles the match, or None."""
    return in_transaction(
        database,
        lambda session: session.scalar(
            select(func.sha256(StoredMatchResult.payload))
            .join(Match, Match.current_result_id == StoredMatchResult.id)
            .where(Match.id == match)
        ),
    )


def approvals(database: Engine, hash: bytes) -> list[tuple[KeyId, int, PlayerId, str]]:
    """The result's approvals as (key, side, player, authority), by key, then
    side."""
    return in_transaction(
        database,
        lambda session: [
            (key, side, player, authority)
            for key, side, player, authority in session.execute(
                select(
                    MatchApproval.key_id,
                    MatchApproval.side,
                    MatchApproval.player_id,
                    MatchApproval.authority,
                )
                .join(
                    StoredMatchResult, StoredMatchResult.id == MatchApproval.result_id
                )
                .where(func.sha256(StoredMatchResult.payload) == hash)
                .order_by(MatchApproval.key_id, MatchApproval.side)
            )
        ],
    )


def newest_board(database: Engine, match: MatchId) -> tuple[bytes, datetime] | None:
    """The body and arrival of the newest board the match accepted."""
    row = in_transaction(
        database,
        lambda session: session.execute(
            select(MatchSubmission.body, MatchSubmission.received_at)
            .where(
                MatchSubmission.match_id == match,
                MatchSubmission.kind == "board",
                MatchSubmission.outcome == "accepted",
            )
            .order_by(MatchSubmission.id.desc())
            .limit(1)
        ).one_or_none(),
    )
    return None if row is None else (row.body, row.received_at)
