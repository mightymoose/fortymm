"""Two players who played each other are two people, so they never merge. A
match counts once it has a result, rated or not, because anyone may create a
match naming any two players."""

import json
import uuid
from uuid import UUID

import pytest
from locks import wait_behind
from match_setup import (
    add_account,
    add_player,
    in_transaction,
    merge,
    played,
    sender,
)
from signed_result_vectors import ANN, BO, KEYS, VECTORS_PATH, VectorsJson
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import Player, PlayerManager
from fortymm_api.services.adoption import adopt_guest
from fortymm_api.services.match_results import (
    Recorded,
    SidesAreOnePlayer,
    override_result,
    record_result,
)
from fortymm_api.services.matches import Refusal, Refused
from fortymm_api.services.player_merge import Merged, PlayedEachOther
from fortymm_api.services.players import (
    Answer,
    Answered,
    Reply,
    SameAs,
    account_players,
    answer_question,
)
from fortymm_api.signed_results import Completed

VECTORS: VectorsJson = json.loads(VECTORS_PATH.read_text())
COMPLETED = next(v for v in VECTORS["valid"] if v["name"] == "completed-best-of-3")
# The vector's match: a rated best of 3 between ANN and BO, signed by both.
VECTOR_MATCH = MatchId(UUID(COMPLETED["result"]["match"]))
CY = PlayerId(uuid.uuid4())


def asked_about(session: Session, account: AccountId, player: PlayerId) -> None:
    """A sign-in brought `player` to the account, with an open question."""
    guest = add_account(session)
    session.add(
        PlayerManager(
            player_id=player,
            account_id=account,
            relationship="managed",
            adopted_from=guest,
        )
    )
    session.flush()


def ann_asked_about_bo(session: Session) -> AccountId:
    """Ann's account plays as ANN and holds both vector keys. A sign-in asks
    it "Is this you?" about BO."""
    add_player(session, ANN)
    add_player(session, BO)
    ann = add_account(session, plays_as=ANN, keys=[KEYS["ann"], KEYS["bo"]])
    asked_about(session, ann, BO)
    return ann


def answer(database: Engine, account: AccountId, reply: Reply) -> Answered:
    return in_transaction(
        database, lambda session: answer_question(session, account, BO, reply)
    )


type Snapshot = tuple[list[tuple[object, ...]], list[tuple[object, ...]]]


def snapshot(database: Engine) -> Snapshot:
    """Every player's merge and every account's rows, to show nothing
    changed."""

    def read(session: Session) -> Snapshot:
        players = session.execute(
            select(Player.id, Player.merged_into).order_by(Player.id)
        ).all()
        rows = session.execute(
            select(
                PlayerManager.account_id,
                PlayerManager.player_id,
                PlayerManager.relationship,
                PlayerManager.adopted_from,
            ).order_by(PlayerManager.id)
        ).all()
        return [tuple(p) for p in players], [tuple(r) for r in rows]

    return in_transaction(database, read)


def manager_rows(database: Engine, player: PlayerId) -> list[tuple[object, ...]]:
    return in_transaction(
        database,
        lambda session: [
            tuple(row)
            for row in session.execute(
                select(
                    PlayerManager.account_id,
                    PlayerManager.relationship,
                    PlayerManager.adopted_from,
                ).where(PlayerManager.player_id == player)
            )
        ],
    )


def merged_into(database: Engine, player: PlayerId) -> PlayerId | None:
    return in_transaction(
        database,
        lambda session: session.scalar(
            select(Player.merged_into).where(Player.id == player)
        ),
    )


@pytest.mark.parametrize("rated", [True, False], ids=["rated", "unrated"])
def test_yes_refuses_to_merge_two_players_who_played_each_other(
    migrated_database: Engine, rated: bool
) -> None:
    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        played(session, (ANN, BO), rated=rated)
        return ann

    ann = in_transaction(migrated_database, setup)
    before = snapshot(migrated_database)

    with pytest.raises(PlayedEachOther):
        answer(migrated_database, ann, Answer.YES)

    assert snapshot(migrated_database) == before


def test_same_as_refuses_to_merge_two_players_who_played_each_other(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> AccountId:
        add_player(session, CY)
        add_player(session, ANN)
        add_player(session, BO)
        account = add_account(session, plays_as=CY, manages=[ANN])
        asked_about(session, account, BO)
        played(session, (ANN, BO))
        return account

    account = in_transaction(migrated_database, setup)
    before = snapshot(migrated_database)

    with pytest.raises(PlayedEachOther):
        answer(migrated_database, account, SameAs(ANN))

    assert snapshot(migrated_database) == before


@pytest.mark.parametrize(
    "players",
    [(CY, BO), (ANN, CY)],
    ids=["merged_into_the_self_player", "merged_into_the_asked_player"],
)
def test_a_player_already_merged_into_one_counts_as_that_player(
    migrated_database: Engine, players: tuple[PlayerId, PlayerId]
) -> None:
    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        add_player(session, CY)
        merge(session, CY, ANN if players[0] == CY else BO)
        played(session, players)
        return ann

    ann = in_transaction(migrated_database, setup)

    with pytest.raises(PlayedEachOther):
        answer(migrated_database, ann, Answer.YES)


def test_a_match_with_no_result_doesnt_block_the_merge_but_its_result_is_refused(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        played(session, (ANN, BO), with_result=False, match=VECTOR_MATCH)
        return ann

    ann = in_transaction(migrated_database, setup)

    answered = answer(migrated_database, ann, Answer.YES)
    recorded = in_transaction(
        migrated_database,
        lambda session: record_result(
            session, VECTOR_MATCH, bytes.fromhex(COMPLETED["envelope"]), sender()
        ),
    )

    assert isinstance(answered.outcome, Merged)
    assert recorded == Refused(Refusal.SAME_PLAYER)


def test_a_result_recorded_during_the_merge_blocks_it(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> AccountId:
        add_player(session, ANN)
        add_player(session, BO)
        ann = add_account(session, plays_as=ANN, keys=[KEYS["ann"]])
        add_account(session, plays_as=BO, keys=[KEYS["bo"]])
        asked_about(session, ann, BO)
        played(session, (ANN, BO), with_result=False, match=VECTOR_MATCH)
        return ann

    ann = in_transaction(migrated_database, setup)

    recorded, waiting = wait_behind(
        migrated_database,
        lambda session: record_result(
            session, VECTOR_MATCH, bytes.fromhex(COMPLETED["envelope"]), sender()
        ),
        lambda session: answer_question(session, ann, BO, Answer.YES),
    )

    assert isinstance(recorded, Recorded)
    with pytest.raises(PlayedEachOther):
        waiting.result()


def test_a_merge_during_a_result_refuses_the_result(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        played(session, (ANN, BO), with_result=False, match=VECTOR_MATCH)
        return ann

    ann = in_transaction(migrated_database, setup)

    _, waiting = wait_behind(
        migrated_database,
        lambda session: answer_question(session, ann, BO, Answer.YES),
        lambda session: record_result(
            session, VECTOR_MATCH, bytes.fromhex(COMPLETED["envelope"]), sender()
        ),
    )

    assert waiting.result() == Refused(Refusal.SAME_PLAYER)


def override(session: Session) -> Recorded:
    return override_result(
        session,
        VECTOR_MATCH,
        add_account(session),
        None,
        ((11, 1), (11, 2)),
        Completed(),
        "The umpire's sheet",
    )


def test_an_override_during_the_merge_blocks_it(migrated_database: Engine) -> None:
    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        played(session, (ANN, BO), with_result=False, match=VECTOR_MATCH)
        return ann

    ann = in_transaction(migrated_database, setup)

    imposed, waiting = wait_behind(
        migrated_database,
        override,
        lambda session: answer_question(session, ann, BO, Answer.YES),
    )

    assert isinstance(imposed, Recorded)
    with pytest.raises(PlayedEachOther):
        waiting.result()


def test_a_merge_during_an_override_refuses_the_override(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        played(session, (ANN, BO), with_result=False, match=VECTOR_MATCH)
        return ann

    ann = in_transaction(migrated_database, setup)

    _, waiting = wait_behind(
        migrated_database,
        lambda session: answer_question(session, ann, BO, Answer.YES),
        override,
    )

    with pytest.raises(SidesAreOnePlayer):
        waiting.result()


def test_adoption_asks_instead_of_merging_two_players_who_played_each_other(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[AccountId, AccountId]:
        add_player(session, ANN)
        add_player(session, BO)
        ann = add_account(session, plays_as=ANN)
        guest = add_account(session, plays_as=BO)
        played(session, (ANN, BO))
        adopt_guest(session, guest, ann)
        return ann, guest

    ann, guest = in_transaction(migrated_database, setup)

    listed = in_transaction(
        migrated_database, lambda session: account_players(session, ann)
    )
    assert [(p.id, p.relationship, p.open_question) for p in listed] == [
        (ANN, "self", False),
        (BO, "managed", True),
    ]
    assert merged_into(migrated_database, BO) is None
    assert merged_into(migrated_database, ANN) is None
    assert manager_rows(migrated_database, BO) == [(ann, "managed", guest)]


def test_the_list_names_the_accounts_players_each_one_played(
    migrated_database: Engine,
) -> None:
    stranger = PlayerId(uuid.uuid4())

    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        add_player(session, CY)
        add_player(session, stranger)
        session.add(PlayerManager(player_id=CY, account_id=ann, relationship="managed"))
        session.flush()
        played(session, (ANN, BO))
        played(session, (BO, ANN), rated=False)
        played(session, (ANN, CY), with_result=False)
        played(session, (CY, stranger))
        return ann

    ann = in_transaction(migrated_database, setup)

    listed = in_transaction(
        migrated_database, lambda session: account_players(session, ann)
    )

    assert {p.id: p.played_against for p in listed} == {
        ANN: frozenset({BO}),
        BO: frozenset({ANN}),
        CY: frozenset(),
    }
