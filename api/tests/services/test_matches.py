"""The rules of making a match and of its boards. The board tests insert
their match with add_match()."""

import hashlib
import uuid
from collections.abc import Callable
from datetime import UTC, datetime

import pytest
from locks import wait_behind
from match_setup import (
    NETWORK,
    add_account,
    add_match,
    add_player,
    in_transaction,
    merge,
    newest_board,
    outcomes,
    sender,
)
from sqlalchemy import Engine, Text, cast, func, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import BestOf, MatchId
from fortymm_api.models import Match, MatchSubmission
from fortymm_api.services.matches import (
    BoardPushed,
    Created,
    Difference,
    Found,
    MatchDetails,
    MatchNotFound,
    MergedPlayer,
    Refusal,
    Refused,
    SamePlayer,
    UnknownPlayer,
    create_match,
    push_board,
    stored_details,
)
from fortymm_api.signed_results import (
    Completed,
    MatchResult,
    decode_payload,
    encode_payload,
    sign,
)
from fortymm_api.signing_keys import SigningPrivateKey

MATCH = MatchId(uuid.UUID("01970000-0000-7000-8000-000000000001"))
ISSUED_AT = datetime(2026, 11, 4, 12, tzinfo=UTC)


def two_players(database: Engine) -> tuple[AccountId, PlayerId, PlayerId]:
    """An account playing as Ann, and Bea, a player nobody manages."""

    def make(session: Session) -> tuple[AccountId, PlayerId, PlayerId]:
        ann = add_player(session)
        return add_account(session, plays_as=ann), ann, add_player(session)

    return in_transaction(database, make)


def create(
    database: Engine, details: MatchDetails, account: AccountId, match: MatchId = MATCH
) -> Created | Found | Refused:
    return in_transaction(
        database, lambda session: create_match(session, match, details, account)
    )


def match_count(database: Engine) -> int:
    return in_transaction(
        database, lambda session: session.scalars(select(func.count(Match.id))).one()
    )


def test_a_created_match_has_its_details_and_creator(
    migrated_database: Engine,
) -> None:
    account, ann, bea = two_players(migrated_database)

    created = create(migrated_database, MatchDetails(5, True, (ann, bea)), account)

    assert created == Created(MATCH)
    details, creator = in_transaction(
        migrated_database,
        lambda session: (
            stored_details(session, session.get_one(Match, MATCH)),
            session.get_one(Match, MATCH).created_by,
        ),
    )
    assert details == MatchDetails(5, True, (ann, bea))
    assert creator == account


def test_the_creator_needs_not_play(migrated_database: Engine) -> None:
    _, ann, bea = two_players(migrated_database)
    bystander = in_transaction(migrated_database, add_account)

    created = create(migrated_database, MatchDetails(3, False, (ann, bea)), bystander)

    assert isinstance(created, Created)


def test_creating_it_again_finds_the_same_match(migrated_database: Engine) -> None:
    account, ann, bea = two_players(migrated_database)
    details = MatchDetails(3, False, (ann, bea))
    first = create(migrated_database, details, account)
    assert isinstance(first, Created)

    again = create(migrated_database, details, account)

    assert again == Found(MATCH)
    assert match_count(migrated_database) == 1


@pytest.mark.parametrize(
    ("change", "differences"),
    [
        pytest.param(lambda d, p: MatchDetails(5, d.rated, d.players), {"best_of"}),
        pytest.param(lambda d, p: MatchDetails(d.best_of, True, d.players), {"rated"}),
        pytest.param(
            lambda d, p: MatchDetails(d.best_of, d.rated, (d.players[1], d.players[0])),
            {"players"},
            id="sides swapped",
        ),
        pytest.param(
            lambda d, p: MatchDetails(d.best_of, d.rated, (d.players[0], p)),
            {"players"},
            id="another opponent",
        ),
        pytest.param(
            lambda d, p: MatchDetails(7, True, (d.players[0], p)),
            {"players", "best_of", "rated"},
            id="everything",
        ),
    ],
)
def test_a_create_with_other_details_is_refused_with_what_differs(
    migrated_database: Engine,
    change: Callable[[MatchDetails, PlayerId], MatchDetails],
    differences: set[Difference],
) -> None:
    account, ann, bea = two_players(migrated_database)
    details = MatchDetails(3, False, (ann, bea))
    create(migrated_database, details, account)
    other = in_transaction(migrated_database, add_player)

    refused = create(migrated_database, change(details, other), account)

    assert refused == Refused(Refusal.MATCH_DIFFERS, frozenset(differences))


def test_a_new_match_naming_a_merged_player_is_not_made(
    migrated_database: Engine,
) -> None:
    account, ann, bea = two_players(migrated_database)
    alias = in_transaction(migrated_database, add_player)
    in_transaction(migrated_database, lambda session: merge(session, alias, ann))

    with pytest.raises(MergedPlayer):
        create(migrated_database, MatchDetails(3, False, (alias, bea)), account)
    assert match_count(migrated_database) == 0


def test_a_create_from_before_a_merge_finds_the_match(
    migrated_database: Engine,
) -> None:
    account, ann, bea = two_players(migrated_database)
    first = create(migrated_database, MatchDetails(3, False, (ann, bea)), account)
    assert isinstance(first, Created)
    newer = in_transaction(migrated_database, add_player)
    in_transaction(migrated_database, lambda session: merge(session, newer, ann))

    again = create(migrated_database, MatchDetails(3, False, (newer, bea)), account)

    assert isinstance(again, Found)


def test_a_create_after_its_players_merged_finds_the_match(
    migrated_database: Engine,
) -> None:
    account, ann, bea = two_players(migrated_database)
    first = create(migrated_database, MatchDetails(3, False, (ann, bea)), account)
    assert isinstance(first, Created)
    in_transaction(migrated_database, lambda session: merge(session, bea, ann))

    again = create(migrated_database, MatchDetails(3, False, (ann, bea)), account)

    assert again == Found(MATCH)


def test_a_match_with_an_unknown_player_is_not_made(
    migrated_database: Engine,
) -> None:
    account, ann, _ = two_players(migrated_database)
    nobody = PlayerId(uuid.uuid4())

    with pytest.raises(UnknownPlayer):
        create(migrated_database, MatchDetails(3, False, (ann, nobody)), account)
    assert match_count(migrated_database) == 0


def test_one_player_on_both_sides_is_not_made(migrated_database: Engine) -> None:
    account, ann, _ = two_players(migrated_database)

    with pytest.raises(SamePlayer):
        create(migrated_database, MatchDetails(3, False, (ann, ann)), account)
    assert match_count(migrated_database) == 0


def test_two_creates_of_one_match_take_turns(migrated_database: Engine) -> None:
    account, ann, bea = two_players(migrated_database)
    details = MatchDetails(3, False, (ann, bea))

    first, second = wait_behind(
        migrated_database,
        lambda session: create_match(session, MATCH, details, account),
        lambda session: create_match(session, MATCH, details, account),
    )

    assert isinstance(first, Created)
    assert second.result() == Found(MATCH)
    assert match_count(migrated_database) == 1


def a_match(database: Engine) -> tuple[AccountId, PlayerId, PlayerId]:
    """An unrated best of 3 between Ann and Bea."""
    account, ann, bea = two_players(database)
    details = MatchDetails(3, False, (ann, bea))
    in_transaction(database, lambda session: add_match(session, MATCH, details))
    return account, ann, bea


def draft(
    players: tuple[PlayerId, PlayerId],
    games: int = 1,
    match: MatchId = MATCH,
    best_of: BestOf = 3,
    rated: bool = False,
) -> bytes:
    """A board's draft payload: the first `games` games of the match."""
    result = MatchResult(
        match=match,
        best_of=best_of,
        rated=rated,
        players=players,
        games=((11, 5), (11, 7))[:games],
        ending=Completed(),
    )
    return encode_payload(result, ISSUED_AT)


def push(
    database: Engine, body: bytes, account: AccountId | None = None
) -> BoardPushed | Refused:
    return in_transaction(
        database, lambda session: push_board(session, MATCH, body, sender(account))
    )


def test_a_board_is_kept_with_its_sender(migrated_database: Engine) -> None:
    account, ann, bea = a_match(migrated_database)
    board = draft((ann, bea))

    pushed = push(migrated_database, board, account)

    assert isinstance(pushed, BoardPushed)
    assert newest_board(migrated_database, MATCH) == (board, pushed.received_at)
    assert outcomes(migrated_database, MATCH) == [("board", "accepted")]
    logged = in_transaction(
        migrated_database,
        lambda session: session.execute(
            select(
                MatchSubmission.account_id,
                cast(MatchSubmission.network, Text),
                MatchSubmission.body,
            )
        ).one(),
    )
    assert tuple(logged) == (account, str(NETWORK), board)


def test_a_board_needs_no_session(migrated_database: Engine) -> None:
    _, ann, bea = a_match(migrated_database)

    pushed = push(migrated_database, draft((ann, bea)))

    assert isinstance(pushed, BoardPushed)


@pytest.mark.parametrize("signed_in", [True, False], ids=["session", "no session"])
def test_a_board_for_no_match_is_not_found_and_writes_nothing(
    migrated_database: Engine, signed_in: bool
) -> None:
    account, ann, bea = two_players(migrated_database)

    with pytest.raises(MatchNotFound):
        push(migrated_database, draft((ann, bea)), account if signed_in else None)

    assert outcomes(migrated_database, MATCH) == []


def test_a_boards_signatures_are_never_checked(migrated_database: Engine) -> None:
    _, ann, bea = a_match(migrated_database)
    unregistered = SigningPrivateKey(hashlib.sha256(b"nobody's key").digest())
    result = decode_payload(draft((ann, bea), games=2)).result
    envelope = sign(result, ISSUED_AT, unregistered, ann)

    pushed = push(migrated_database, envelope)

    assert isinstance(pushed, BoardPushed)
    assert newest_board(migrated_database, MATCH) == (envelope, pushed.received_at)


def test_the_newest_board_wins(migrated_database: Engine) -> None:
    account, ann, bea = a_match(migrated_database)
    push(migrated_database, draft((ann, bea), games=2), account)

    newest = push(migrated_database, draft((ann, bea), games=1))

    assert isinstance(newest, BoardPushed)
    assert newest_board(migrated_database, MATCH) == (
        draft((ann, bea), games=1),
        newest.received_at,
    )
    assert outcomes(migrated_database, MATCH) == [("board", "accepted")] * 2


@pytest.mark.parametrize(
    ("body", "refusal"),
    [
        pytest.param(lambda ann, bea: b"\x00", Refusal.MALFORMED, id="malformed"),
        pytest.param(
            lambda ann, bea: draft((ann, bea), match=MatchId(uuid.uuid4())),
            Refusal.WRONG_MATCH,
            id="another match",
        ),
        pytest.param(
            lambda ann, bea: draft((ann, bea), best_of=5),
            Refusal.MATCH_DIFFERS,
            id="other details",
        ),
    ],
)
def test_a_refused_board_is_logged_and_changes_nothing(
    migrated_database: Engine,
    body: Callable[[PlayerId, PlayerId], bytes],
    refusal: Refusal,
) -> None:
    _, ann, bea = a_match(migrated_database)
    first = push(migrated_database, draft((ann, bea)))
    assert isinstance(first, BoardPushed)

    refused = push(migrated_database, body(ann, bea))

    assert isinstance(refused, Refused)
    assert refused.refusal == refusal
    assert newest_board(migrated_database, MATCH) == (
        draft((ann, bea)),
        first.received_at,
    )
    assert outcomes(migrated_database, MATCH) == [
        ("board", "accepted"),
        ("board", refusal.value),
    ]


@pytest.mark.parametrize(
    ("change", "differences"),
    [
        pytest.param(lambda ann, bea, cy: draft((ann, bea), best_of=5), {"best_of"}),
        pytest.param(lambda ann, bea, cy: draft((ann, bea), rated=True), {"rated"}),
        pytest.param(
            lambda ann, bea, cy: draft((bea, ann)), {"players"}, id="sides swapped"
        ),
        pytest.param(
            lambda ann, bea, cy: draft((ann, cy)), {"players"}, id="another opponent"
        ),
        pytest.param(
            lambda ann, bea, cy: draft((ann, cy), best_of=7, rated=True),
            {"players", "best_of", "rated"},
            id="everything",
        ),
    ],
)
def test_other_details_are_refused_with_what_differs(
    migrated_database: Engine,
    change: Callable[[PlayerId, PlayerId, PlayerId], bytes],
    differences: set[Difference],
) -> None:
    _, ann, bea = a_match(migrated_database)
    cy = in_transaction(migrated_database, add_player)

    refused = push(migrated_database, change(ann, bea, cy))

    assert refused == Refused(Refusal.MATCH_DIFFERS, frozenset(differences))


def test_a_player_merged_since_still_fits(migrated_database: Engine) -> None:
    _, ann, bea = two_players(migrated_database)
    alias = in_transaction(migrated_database, add_player)
    in_transaction(
        migrated_database,
        lambda session: add_match(session, MATCH, MatchDetails(3, False, (alias, bea))),
    )
    in_transaction(migrated_database, lambda session: merge(session, alias, ann))

    by_survivor = push(migrated_database, draft((ann, bea)))
    by_old_id = push(migrated_database, draft((alias, bea)))

    assert isinstance(by_survivor, BoardPushed)
    assert isinstance(by_old_id, BoardPushed)
