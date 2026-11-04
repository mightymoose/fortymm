import hashlib
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from ipaddress import ip_address

import cbor2
import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import BestOf, MatchId
from fortymm_api.services.match_results import (
    IllegalEnding,
    WrongMatch,
    check_approval,
    check_ending,
)
from fortymm_api.services.sessions import start_session
from fortymm_api.services.signing_keys import (
    register_key,
    revoke_key,
    sign_out_device,
)
from fortymm_api.signed_results import (
    Approval,
    BadSignature,
    Completed,
    Ending,
    GamePoints,
    Malformed,
    MatchResult,
    Retired,
    UnknownKey,
    append_signature,
    encode_payload,
    sign,
)
from fortymm_api.signing_keys import SigningPrivateKey

MATCH = MatchId(uuid.UUID("6f1c2a52-3c1e-4d51-9b0c-0d6f9f0a1b01"))
ANN = PlayerId(uuid.UUID("0b7f3e0c-1a2b-4c3d-8e4f-5a6b7c8d9e01"))
BOB = PlayerId(uuid.UUID("0b7f3e0c-1a2b-4c3d-8e4f-5a6b7c8d9e02"))
ISSUED_AT = datetime(2026, 11, 3, 18, 30, tzinfo=UTC)
ANN_KEY = SigningPrivateKey(hashlib.sha256(b"ann's device").digest())
BOB_KEY = SigningPrivateKey(hashlib.sha256(b"bob's device").digest())
NETWORK = ip_address("203.0.113.7")
COMPLETED = Completed()


def result(
    games: tuple[GamePoints, ...] = ((11, 5), (11, 7), (11, 9)),
    ending: Ending = COMPLETED,
    best_of: BestOf = 5,
    match: MatchId = MATCH,
) -> MatchResult:
    return MatchResult(
        match=match,
        best_of=best_of,
        rated=False,
        players=(ANN, BOB),
        games=games,
        ending=ending,
    )


def envelope(signed: MatchResult | None = None) -> bytes:
    first = sign(signed or result(), ISSUED_AT, ANN_KEY, ANN)
    return append_signature(first, BOB_KEY, BOB)


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def account_with_keys(
    database: Engine, *keys: SigningPrivateKey
) -> tuple[AccountId, str]:
    """A guest account that registered `keys`, and its session token."""

    def start(session: Session) -> tuple[AccountId, str]:
        started = start_session(session, None, NETWORK)
        for key in keys:
            register_key(
                session,
                started.account.id,
                public_key=key.public_key.to_cose_key(),
                proof=key.registration_proof(started.account.id),
                label="Phone",
            )
        return started.account.id, started.token

    return in_transaction(database, start)


def check(database: Engine, data: bytes, match: MatchId = MATCH) -> object:
    return in_transaction(
        database, lambda session: check_approval(session, match, data)
    )


def test_a_result_both_players_signed_is_accepted(
    migrated_database: Engine,
) -> None:
    account_with_keys(migrated_database, ANN_KEY, BOB_KEY)
    data = envelope()

    verified = in_transaction(
        migrated_database, lambda session: check_approval(session, MATCH, data)
    )

    assert verified.result == result()
    assert verified.approvals == {
        Approval(ANN_KEY.public_key.kid, ANN),
        Approval(BOB_KEY.public_key.kid, BOB),
    }


def test_bytes_that_are_not_a_signed_result_are_malformed(
    migrated_database: Engine,
) -> None:
    with pytest.raises(Malformed):
        check(migrated_database, b"\x00not an envelope")


def test_a_result_for_another_match_is_refused_before_any_key(
    migrated_database: Engine,
) -> None:
    other = MatchId(uuid.UUID("6f1c2a52-3c1e-4d51-9b0c-0d6f9f0a1b02"))

    with pytest.raises(WrongMatch):
        check(migrated_database, envelope(result(match=other)))


def test_an_unregistered_key_is_unknown(migrated_database: Engine) -> None:
    account_with_keys(migrated_database, ANN_KEY)

    with pytest.raises(UnknownKey) as refused:
        check(migrated_database, envelope())

    assert refused.value.kids == {BOB_KEY.public_key.kid}


def test_a_revoked_key_is_unknown(migrated_database: Engine) -> None:
    account, _ = account_with_keys(migrated_database, ANN_KEY, BOB_KEY)
    in_transaction(
        migrated_database,
        lambda session: revoke_key(session, account, BOB_KEY.public_key.kid),
    )

    with pytest.raises(UnknownKey):
        check(migrated_database, envelope())


def test_a_signed_out_key_still_verifies(migrated_database: Engine) -> None:
    _, token = account_with_keys(migrated_database, ANN_KEY, BOB_KEY)
    in_transaction(
        migrated_database,
        lambda session: sign_out_device(session, token, BOB_KEY.public_key.kid),
    )

    check(migrated_database, envelope())


def test_signatures_over_other_scores_do_not_match(
    migrated_database: Engine,
) -> None:
    account_with_keys(migrated_database, ANN_KEY, BOB_KEY)
    protected, unprotected, _, signatures = cbor2.loads(envelope()).value
    other_scores = encode_payload(result(games=((11, 5), (11, 7), (11, 8))), ISSUED_AT)
    tampered = cbor2.dumps(
        cbor2.CBORTag(98, [protected, unprotected, other_scores, signatures]),
        canonical=True,
    )

    with pytest.raises(BadSignature):
        check(migrated_database, tampered)


def test_signed_illegal_scores_are_refused_after_the_signatures(
    migrated_database: Engine,
) -> None:
    account_with_keys(migrated_database, ANN_KEY, BOB_KEY)

    with pytest.raises(IllegalEnding):
        check(migrated_database, envelope(result(games=((11, 5), (11, 10)))))


@pytest.mark.parametrize(
    ("games", "ending", "best_of"),
    [
        pytest.param(((11, 5), (11, 7), (11, 9)), Completed(), 5, id="straight"),
        pytest.param(((5, 11), (11, 9), (11, 3)), Completed(), 3, id="from behind"),
        pytest.param(
            ((11, 0), (0, 11), (11, 0), (0, 11), (14, 12)),
            Completed(),
            5,
            id="deuce decider",
        ),
        pytest.param(
            ((11, 6), (11, 7), (11, 8), (11, 9)), Completed(), 7, id="best of 7"
        ),
        pytest.param(((11, 6),), Completed(), 1, id="best of 1"),
        pytest.param(((13, 11),), Completed(), 1, id="best of 1 past deuce"),
        pytest.param(((5, 8),), Retired(0), 1, id="best of 1 retired mid game"),
        pytest.param((), Retired(1), 1, id="best of 1 retired before a point"),
        pytest.param((), Retired(0), 5, id="retired before a point"),
        pytest.param(((11, 5), (4, 2)), Retired(1), 5, id="retired mid game"),
        pytest.param(((11, 5), (10, 10)), Retired(1), 5, id="retired at deuce"),
        pytest.param(((11, 5), (11, 10)), Retired(0), 5, id="retired at advantage"),
        pytest.param(((11, 5), (11, 7)), Retired(1), 5, id="retired between games"),
    ],
)
def test_a_legal_ending_passes(
    games: tuple[GamePoints, ...], ending: Ending, best_of: BestOf
) -> None:
    check_ending(result(games=games, ending=ending, best_of=best_of))


@pytest.mark.parametrize(
    ("games", "ending", "best_of"),
    [
        pytest.param(((11, 5), (11, 7), (11, 11)), Completed(), 5, id="level"),
        pytest.param(((11, 5), (11, 7), (10, 8)), Completed(), 5, id="short of 11"),
        pytest.param(((11, 5), (11, 7), (11, 10)), Completed(), 5, id="11-10"),
        pytest.param(((11, 5), (11, 7), (12, 9)), Completed(), 5, id="12-9"),
        pytest.param(((11, 5), (11, 7), (15, 12)), Completed(), 5, id="deuce by 3"),
        pytest.param(((11, 5), (11, 7)), Completed(), 5, id="too few games"),
        pytest.param((), Completed(), 3, id="no games"),
        pytest.param(
            ((11, 5), (11, 7), (7, 11)), Completed(), 3, id="game after decider"
        ),
        pytest.param(
            ((11, 5), (11, 7), (4, 2)), Retired(1), 3, id="retired after decided"
        ),
        pytest.param(((11, 5), (11, 7)), Retired(1), 3, id="retired at the decider"),
        pytest.param(((11, 10), (4, 2)), Retired(1), 5, id="retired after 11-10"),
        pytest.param(((11, 5), (15, 3)), Retired(1), 5, id="unreachable last game"),
        pytest.param((), Completed(), 1, id="best of 1 with no game"),
        pytest.param(((11, 10),), Completed(), 1, id="best of 1 unfinished"),
        pytest.param(((11, 6),), Retired(1), 1, id="best of 1 retired after it"),
    ],
)
def test_an_illegal_ending_is_refused(
    games: tuple[GamePoints, ...], ending: Ending, best_of: BestOf
) -> None:
    with pytest.raises(IllegalEnding):
        check_ending(result(games=games, ending=ending, best_of=best_of))
