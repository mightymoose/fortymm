"""The rules of recording a result, through record_result(). The shared
vectors in api/signed-results/vectors.json are the envelopes where they fit:
their keys, players and matches are fixed."""

import json
import uuid
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID

import pytest
from locks import wait_behind
from match_setup import (
    NETWORK,
    add_account,
    add_match,
    add_player,
    approvals,
    current_result,
    in_transaction,
    merge,
    newest_board,
    outcomes,
    result_chain,
    sender,
)
from signed_result_vectors import (
    ANN,
    BO,
    KEYS,
    MERGED,
    VECTORS_PATH,
    InvalidJson,
    ValidJson,
    VectorsJson,
    result_from_json,
)
from sqlalchemy import Engine, func, select, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import BestOf, MatchId
from fortymm_api.models import Match, PlayerManager, StoredMatchResult
from fortymm_api.services.match_results import (
    IllegalEnding,
    InvalidOverrideReason,
    Recorded,
    SidesAreOnePlayer,
    check_ending,
    override_result,
    record_result,
)
from fortymm_api.services.matches import (
    Difference,
    MatchDetails,
    MatchNotFound,
    RecordedApproval,
    Refusal,
    Refused,
    push_board,
)
from fortymm_api.services.players import Answer, answer_question
from fortymm_api.services.sessions import new_session
from fortymm_api.services.signing_keys import revoke_key, sign_out_device
from fortymm_api.signed_results import (
    Completed,
    Ending,
    GamePoints,
    MatchResult,
    Retired,
    append_signature,
    encode_payload,
    sign,
)
from fortymm_api.signing_keys import SigningPrivateKey

VECTORS: VectorsJson = json.loads(VECTORS_PATH.read_text())
VALID = {vector["name"]: vector for vector in VECTORS["valid"]}
ISSUED_AT = datetime(2026, 11, 4, 12, tzinfo=UTC)
COMPLETED = VALID["completed-best-of-3"]
MATCH = MatchId(UUID(COMPLETED["result"]["match"]))
UNRATED = VALID["unrated"]
UNRATED_MATCH = MatchId(UUID(UNRATED["result"]["match"]))
ANN_KEY, BO_KEY, CY_KEY = KEYS["ann"], KEYS["bo"], KEYS["cy"]
FINISHED = Completed()


def result(
    games: tuple[GamePoints, ...], ending: Ending, best_of: BestOf
) -> MatchResult:
    return MatchResult(
        match=MATCH,
        best_of=best_of,
        rated=False,
        players=(ANN, BO),
        games=games,
        ending=ending,
    )


def envelope(vector: ValidJson | InvalidJson) -> bytes:
    return bytes.fromhex(vector["envelope"])


def first_result(vector: ValidJson) -> MatchResult:
    return result_from_json(vector["result"])


def players(database: Engine, *matches: ValidJson) -> tuple[AccountId, AccountId]:
    """The vectors' players: Ann, whose account holds ann's key, and Bo,
    whose account holds bo's. Nobody holds cy's key yet. The match of each
    vector in `matches` exists, with Ann's account as its creator."""

    def make(session: Session) -> tuple[AccountId, AccountId]:
        add_player(session, ANN)
        add_player(session, BO)
        ann = add_account(session, plays_as=ANN, keys=[ANN_KEY])
        for vector in matches:
            make_match(session, vector, ann)
        return ann, add_account(session, plays_as=BO, keys=[BO_KEY])

    return in_transaction(database, make)


def make_match(session: Session, vector: ValidJson, account: AccountId) -> None:
    result = first_result(vector)
    add_match(session, result.match, MatchDetails.of(result), account)


def record(database: Engine, data: bytes, match: MatchId = MATCH) -> Recorded | Refused:
    return in_transaction(
        database, lambda session: record_result(session, match, data, sender())
    )


def recorded(database: Engine, data: bytes, match: MatchId = MATCH) -> Recorded:
    answer = record(database, data, match)
    assert isinstance(answer, Recorded), answer
    return answer


def signed(result: MatchResult, *signers: tuple[SigningPrivateKey, PlayerId]) -> bytes:
    """An envelope of `result` that each (key, player) signs in turn."""
    (key, player), *rest = signers
    data = sign(result, ISSUED_AT, key, player)
    for key, player in rest:
        data = append_signature(data, key, player)
    return data


def corrected(
    games: tuple[GamePoints, ...], of: Recorded, rated: bool = True
) -> MatchResult:
    return replace(
        first_result(COMPLETED) if rated else first_result(UNRATED),
        games=games,
        replaces=of.hash,
    )


def current(database: Engine, match: MatchId = MATCH) -> bytes | None:
    return current_result(database, match)


def result_count(database: Engine) -> int:
    return in_transaction(
        database,
        lambda session: session.scalars(select(func.count(StoredMatchResult.id))).one(),
    )


@pytest.mark.parametrize(
    "data",
    [
        pytest.param(envelope(COMPLETED), id="accepted"),
        pytest.param(envelope(VALID["correction"]), id="a correction"),
        pytest.param(
            envelope(
                next(v for v in VECTORS["invalid"] if v["error"] == "bad_signature")
            ),
            id="refused",
        ),
    ],
)
def test_a_result_for_an_unknown_match_is_not_found_and_writes_nothing(
    migrated_database: Engine, data: bytes
) -> None:
    players(migrated_database)

    with pytest.raises(MatchNotFound):
        record(migrated_database, data)

    assert outcomes(migrated_database, MATCH) == []
    assert result_count(migrated_database) == 0
    count = in_transaction(
        migrated_database, lambda s: s.scalars(select(func.count(Match.id))).one()
    )
    assert count == 0


def test_each_approval_records_its_key_side_player_and_authority(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)

    answer = recorded(migrated_database, envelope(COMPLETED))

    assert set(answer.approvals) == {
        RecordedApproval(ANN_KEY.public_key.kid, 0, ANN, "self"),
        RecordedApproval(BO_KEY.public_key.kid, 1, BO, "self"),
    }


# The first result of a match between Ann and Bo, signed by their own keys.
# The others need a merge, a representative or an earlier result.
@pytest.mark.parametrize(
    "vector",
    [
        v
        for v in VECTORS["valid"]
        if v["result"]["players"] == [str(ANN), str(BO)]
        and not v["result"]["replaces"]
        and "cy" not in {s["key"] for s in v["signatures"]}
    ],
    ids=lambda v: v["name"],
)
def test_every_valid_vector_is_recorded(
    migrated_database: Engine, vector: ValidJson
) -> None:
    players(migrated_database, vector)
    match = MatchId(UUID(vector["result"]["match"]))
    sides = {s["side"] for s in vector["signatures"]}
    counts = len(sides) == 2 or not vector["result"]["rated"]

    answer = recorded(migrated_database, envelope(vector), match)

    assert answer.hash.hex() == vector["hash"]
    assert (answer.accepted_at is not None) == counts
    assert {(a.key_id.hex(), str(a.player)) for a in answer.approvals} == {
        (a["kid"], a["player"]) for a in vector["approvals"]
    }


@pytest.mark.parametrize(
    "vector",
    [v for v in VECTORS["invalid"] if "envelope" in v],
    ids=lambda v: v["name"],
)
def test_every_invalid_vector_is_refused_and_logged(
    migrated_database: Engine, vector: InvalidJson
) -> None:
    players(migrated_database, COMPLETED)

    answer = record(migrated_database, envelope(vector))

    assert answer == Refused(Refusal(vector["error"]))
    assert outcomes(migrated_database, MATCH) == [("result", vector["error"])]
    assert result_count(migrated_database) == 0


def test_a_result_for_another_match_is_refused(migrated_database: Engine) -> None:
    players(migrated_database, UNRATED)
    recorded(migrated_database, envelope(UNRATED), UNRATED_MATCH)

    answer = record(migrated_database, envelope(COMPLETED), UNRATED_MATCH)

    assert answer == Refused(Refusal.WRONG_MATCH)
    assert outcomes(migrated_database, UNRATED_MATCH)[-1] == ("result", "wrong_match")


def test_signed_illegal_scores_are_refused(migrated_database: Engine) -> None:
    players(migrated_database, COMPLETED)
    illegal = replace(first_result(COMPLETED), games=((11, 5), (11, 10)))

    answer = record(migrated_database, signed(illegal, (ANN_KEY, ANN)))

    assert answer == Refused(Refusal.ILLEGAL_ENDING)


def test_the_signed_result_wins_over_the_board(migrated_database: Engine) -> None:
    ann, _ = players(migrated_database, COMPLETED)
    other_scores = replace(first_result(COMPLETED), games=((11, 2), (11, 3)))
    board = encode_payload(other_scores, ISSUED_AT)
    in_transaction(
        migrated_database, lambda s: push_board(s, MATCH, board, sender(ann))
    )

    answer = recorded(migrated_database, envelope(COMPLETED))
    late_board = in_transaction(
        migrated_database, lambda s: push_board(s, MATCH, board, sender(ann))
    )

    assert current(migrated_database) == answer.hash
    newest = newest_board(migrated_database, MATCH)
    assert newest is not None and newest[0] == board
    assert late_board == Refused(Refusal.MATCH_FINAL)
    assert outcomes(migrated_database, MATCH) == [
        ("board", "accepted"),
        ("result", "accepted"),
        ("board", "match_final"),
    ]


def test_an_exact_retry_returns_the_result_and_changes_nothing(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))

    again = recorded(migrated_database, envelope(COMPLETED))
    swapped = recorded(
        migrated_database, envelope(VALID["completed-best-of-3-signatures-swapped"])
    )

    assert again == first == swapped
    assert result_count(migrated_database) == 1
    assert outcomes(migrated_database, MATCH) == [("result", "accepted")] * 3


def test_a_half_signed_rated_result_waits_for_the_other_side(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)

    waiting = recorded(migrated_database, envelope(VALID["half-signed"]))
    both = recorded(migrated_database, envelope(COMPLETED))

    assert waiting.accepted_at is None
    assert both.accepted_at is not None
    assert current(migrated_database) == both.hash
    assert len(both.approvals) == 2


def test_one_side_counts_for_an_unrated_result(migrated_database: Engine) -> None:
    players(migrated_database, UNRATED)

    answer = recorded(migrated_database, envelope(UNRATED), UNRATED_MATCH)

    assert answer.accepted_at is not None
    assert current(migrated_database, UNRATED_MATCH) == answer.hash


def test_a_correction_of_a_final_unrated_match_needs_both_sides(
    migrated_database: Engine,
) -> None:
    players(migrated_database, UNRATED)
    original = recorded(migrated_database, envelope(UNRATED), UNRATED_MATCH)
    correction = corrected(((11, 9), (11, 7)), original, rated=False)

    half = recorded(
        migrated_database, signed(correction, (ANN_KEY, ANN)), UNRATED_MATCH
    )
    both = recorded(
        migrated_database,
        signed(correction, (ANN_KEY, ANN), (BO_KEY, BO)),
        UNRATED_MATCH,
    )

    assert half.accepted_at is None
    assert both.accepted_at is not None
    assert current(migrated_database, UNRATED_MATCH) == both.hash


def test_a_new_result_on_a_final_match_must_be_a_correction(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))
    fresh = replace(first_result(COMPLETED), games=((11, 9), (11, 7)))

    answer = record(migrated_database, signed(fresh, (ANN_KEY, ANN), (BO_KEY, BO)))

    assert answer == Refused(Refusal.STALE)
    assert current(migrated_database) == first.hash
    assert outcomes(migrated_database, MATCH)[-1] == ("result", "stale")


def test_the_second_correction_of_one_result_is_stale(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))
    recorded(migrated_database, envelope(VALID["correction"]))
    another = corrected(((11, 9), (11, 7)), first)

    answer = record(migrated_database, signed(another, (BO_KEY, BO)))

    assert answer == Refused(Refusal.STALE)
    assert result_count(migrated_database) == 2
    assert outcomes(migrated_database, MATCH)[-1] == ("result", "stale")


def test_a_counter_that_races_another_is_stale_and_logged(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))
    one = signed(corrected(((11, 9), (11, 7)), first), (BO_KEY, BO))
    other = signed(corrected(((11, 9), (11, 8)), first), (ANN_KEY, ANN))

    held, waiting = wait_behind(
        migrated_database,
        lambda session: record_result(session, MATCH, one, sender()),
        lambda session: record_result(session, MATCH, other, sender()),
    )

    assert isinstance(held, Recorded)
    assert waiting.result() == Refused(Refusal.STALE)
    assert outcomes(migrated_database, MATCH)[-2:] == [
        ("result", "accepted"),
        ("result", "stale"),
    ]


def test_a_replaced_result_cant_be_approved(migrated_database: Engine) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(VALID["half-signed"]))
    counter = corrected(((11, 9), (11, 7)), first)
    recorded(migrated_database, signed(counter, (BO_KEY, BO)))

    answer = record(migrated_database, envelope(COMPLETED))

    assert answer == Refused(Refusal.NOT_HEAD)
    assert outcomes(migrated_database, MATCH)[-1] == ("result", "not_head")


@pytest.mark.parametrize(
    ("details", "differences"),
    [
        pytest.param(MatchDetails(3, True, (BO, ANN)), {"players"}, id="players"),
        pytest.param(MatchDetails(5, True, (ANN, BO)), {"best_of"}, id="best of"),
        pytest.param(MatchDetails(3, False, (ANN, BO)), {"rated"}, id="rated"),
    ],
)
def test_a_result_for_a_match_with_other_details_is_refused(
    migrated_database: Engine,
    details: MatchDetails,
    differences: set[Difference],
) -> None:
    ann, _ = players(migrated_database)
    in_transaction(migrated_database, lambda s: add_match(s, MATCH, details, ann))

    answer = record(migrated_database, envelope(COMPLETED))

    assert answer == Refused(Refusal.MATCH_DIFFERS, frozenset(differences))
    assert outcomes(migrated_database, MATCH) == [("result", "match_differs")]


def test_a_revoked_keys_retry_returns_the_result_but_it_signs_nothing_new(
    migrated_database: Engine,
) -> None:
    ann, _ = players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))
    in_transaction(
        migrated_database,
        lambda s: revoke_key(s, ann, ANN_KEY.public_key.kid),
    )

    retry = record(migrated_database, envelope(COMPLETED))
    correction = record(
        migrated_database, signed(corrected(((11, 9), (11, 7)), first), (ANN_KEY, ANN))
    )

    assert retry == first
    assert correction == Refused(Refusal.UNKNOWN_KEY)
    assert outcomes(migrated_database, MATCH) == [
        ("result", "accepted"),
        ("result", "accepted"),
        ("result", "unknown_key"),
    ]


def test_a_signed_out_key_still_verifies(migrated_database: Engine) -> None:
    ann, _ = players(migrated_database, COMPLETED)

    def sign_out(session: Session) -> None:
        _, token = new_session(session, ann)
        sign_out_device(session, token, ANN_KEY.public_key.kid)

    in_transaction(migrated_database, sign_out)

    assert recorded(migrated_database, envelope(COMPLETED)).accepted_at is not None


def test_one_account_managing_both_players_approves_as_representative(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    in_transaction(
        migrated_database,
        lambda s: add_account(s, manages=[ANN, BO], keys=[CY_KEY]),
    )

    answer = recorded(migrated_database, envelope(VALID["one-key-for-both-players"]))

    assert answer.accepted_at is not None
    assert {(a.side, a.authority) for a in answer.approvals} == {
        (0, "representative"),
        (1, "representative"),
    }


def test_a_player_and_their_representative_both_approve(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    in_transaction(
        migrated_database, lambda s: add_account(s, manages=[ANN], keys=[CY_KEY])
    )

    answer = recorded(migrated_database, envelope(VALID["two-keys-for-one-player"]))

    assert sorted((a.side, a.authority) for a in answer.approvals) == [
        (0, "representative"),
        (0, "self"),
        (1, "self"),
    ]


def test_making_the_opponents_match_gives_no_authority_over_them(
    migrated_database: Engine,
) -> None:
    def make(session: Session) -> AccountId:
        add_player(session, ANN)
        add_player(session, BO)
        ann = add_account(session, plays_as=ANN, keys=[ANN_KEY])
        add_match(session, MATCH, MatchDetails(3, True, (ANN, BO)), ann)
        return ann

    in_transaction(migrated_database, make)

    answer = record(
        migrated_database,
        signed(first_result(COMPLETED), (ANN_KEY, ANN), (ANN_KEY, BO)),
    )

    assert answer == Refused(Refusal.NO_AUTHORITY)
    assert outcomes(migrated_database, MATCH) == [("result", "no_authority")]


def test_an_open_is_this_you_question_gives_no_authority(
    migrated_database: Engine,
) -> None:
    _, bo = players(migrated_database, COMPLETED)

    def manage_with_open_question(session: Session) -> None:
        cy = add_account(session, manages=[BO], keys=[CY_KEY])
        session.execute(
            update(PlayerManager)
            .where(PlayerManager.account_id == cy)
            .values(adopted_from=bo)
        )

    in_transaction(migrated_database, manage_with_open_question)

    answer = record(
        migrated_database, signed(first_result(COMPLETED), (ANN_KEY, ANN), (CY_KEY, BO))
    )

    assert answer == Refused(Refusal.NO_AUTHORITY)


def test_a_result_for_a_merged_player_resolves_to_the_survivor(
    migrated_database: Engine,
) -> None:
    ann, _ = players(migrated_database)
    vector = VALID["merged-player"]
    match = MatchId(UUID(vector["result"]["match"]))

    def merge_later(session: Session) -> None:
        add_player(session, MERGED)
        make_match(session, vector, ann)
        merge(session, MERGED, ANN)

    in_transaction(migrated_database, merge_later)

    answer = recorded(migrated_database, envelope(vector), match)

    assert answer.accepted_at is not None
    assert {(a.player, a.authority) for a in answer.approvals} == {
        (ANN, "self"),
        (BO, "self"),
    }


def test_a_result_for_a_match_whose_sides_a_merge_made_one_player_is_refused(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    in_transaction(migrated_database, lambda session: merge(session, BO, ANN))

    answer = record(migrated_database, envelope(COMPLETED))

    assert answer == Refused(Refusal.SAME_PLAYER)
    assert outcomes(migrated_database, MATCH) == [("result", "same_player")]
    assert result_count(migrated_database) == 0


def test_a_merge_during_a_result_refuses_the_result(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> AccountId:
        add_player(session, ANN)
        add_player(session, BO)
        ann = add_account(session, plays_as=ANN, keys=[ANN_KEY, BO_KEY])
        session.add(
            PlayerManager(
                player_id=BO,
                account_id=ann,
                relationship="managed",
                adopted_from=add_account(session),
            )
        )
        make_match(session, COMPLETED, ann)
        return ann

    ann = in_transaction(migrated_database, setup)

    _, waiting = wait_behind(
        migrated_database,
        lambda session: answer_question(session, ann, BO, Answer.YES),
        lambda session: record_result(session, MATCH, envelope(COMPLETED), sender()),
    )

    assert waiting.result() == Refused(Refusal.SAME_PLAYER)


def test_a_correction_extends_the_chain(migrated_database: Engine) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))
    correction = recorded(migrated_database, envelope(VALID["correction"]))

    chain = result_chain(migrated_database, MATCH)

    assert [(r.hash, r.replaces) for r in chain] == [
        (first.hash, None),
        (correction.hash, first.hash),
    ]
    assert chain[1].games == first_result(VALID["correction"]).games
    assert approvals(migrated_database, first.hash) == [
        (a.key_id, a.side, a.player, a.authority) for a in first.approvals
    ]
    assert chain[1].accepted_at == correction.accepted_at
    assert current(migrated_database) == correction.hash


def override(
    database: Engine,
    games: tuple[GamePoints, ...] = ((11, 1), (11, 2)),
    ending: Ending = FINISHED,
    reason: str = " The umpire's sheet says so ",
    match: MatchId = MATCH,
) -> Recorded:
    def impose(session: Session) -> Recorded:
        admin = add_account(session)
        return override_result(session, match, admin, NETWORK, games, ending, reason)

    return in_transaction(database, impose)


def test_an_override_replaces_the_current_result_and_counts_at_once(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))

    imposed = override(migrated_database)

    assert imposed.accepted_at is not None
    assert imposed.approvals == ()
    chain = result_chain(migrated_database, MATCH)
    assert current(migrated_database) == imposed.hash
    assert [(r.hash, r.replaces, r.override_reason) for r in chain] == [
        (first.hash, None, None),
        (imposed.hash, first.hash, "The umpire's sheet says so"),
    ]
    assert chain[1].games == ((11, 1), (11, 2))
    assert approvals(migrated_database, imposed.hash) == []
    assert outcomes(migrated_database, MATCH)[-1] == ("override", "accepted")


def test_an_override_cuts_off_a_counter_that_waits(migrated_database: Engine) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))
    counter = corrected(((11, 9), (11, 7)), first)
    waiting = recorded(migrated_database, signed(counter, (BO_KEY, BO)))

    imposed = override(migrated_database)
    approval = record(migrated_database, signed(counter, (BO_KEY, BO), (ANN_KEY, ANN)))

    assert result_chain(migrated_database, MATCH)[-1].replaces == waiting.hash
    assert current(migrated_database) == imposed.hash
    assert approval == Refused(Refusal.NOT_HEAD)


def test_a_correction_after_an_override_is_stale(migrated_database: Engine) -> None:
    players(migrated_database, COMPLETED)
    recorded(migrated_database, envelope(COMPLETED))
    override(migrated_database)

    answer = record(migrated_database, envelope(VALID["correction"]))

    assert answer == Refused(Refusal.STALE)
    assert outcomes(migrated_database, MATCH)[-1] == ("result", "stale")


def test_players_correct_an_override_the_normal_way(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    recorded(migrated_database, envelope(COMPLETED))
    imposed = override(migrated_database)
    correction = corrected(((11, 9), (11, 7)), imposed)

    answer = recorded(
        migrated_database, signed(correction, (ANN_KEY, ANN), (BO_KEY, BO))
    )

    assert answer.accepted_at is not None
    assert current(migrated_database) == answer.hash


def test_an_override_of_a_match_whose_sides_a_merge_made_one_player_raises(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)
    in_transaction(migrated_database, lambda session: merge(session, BO, ANN))

    with pytest.raises(SidesAreOnePlayer):
        override(migrated_database)

    assert result_count(migrated_database) == 0


def test_an_override_settles_a_match_with_no_result(
    migrated_database: Engine,
) -> None:
    players(migrated_database, COMPLETED)

    imposed = override(migrated_database, games=((11, 4),), ending=Retired(1))

    assert current(migrated_database) == imposed.hash


@pytest.mark.parametrize(
    ("imposing", "error"),
    [
        pytest.param(
            lambda db: override(db, games=((11, 4), (11, 10))),
            IllegalEnding,
            id="illegal",
        ),
        pytest.param(
            lambda db: override(db, games=((11, 1),) * 4),
            IllegalEnding,
            id="too many games",
        ),
        pytest.param(
            lambda db: override(db, reason="  "), InvalidOverrideReason, id="blank"
        ),
        pytest.param(
            lambda db: override(db, match=MatchId(uuid.uuid4())),
            MatchNotFound,
            id="no match",
        ),
    ],
)
def test_a_refused_override_writes_nothing(
    migrated_database: Engine,
    imposing: Callable[[Engine], Recorded],
    error: type[Exception],
) -> None:
    players(migrated_database, COMPLETED)
    first = recorded(migrated_database, envelope(COMPLETED))

    with pytest.raises(error):
        imposing(migrated_database)

    assert current(migrated_database) == first.hash
    assert result_count(migrated_database) == 1


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
