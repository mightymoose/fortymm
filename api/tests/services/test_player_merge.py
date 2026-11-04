"""Two players who played each other are two people, so they never merge. A
match counts once it has a result, rated or not, because anyone may create a
match naming any two players."""

import uuid
from collections.abc import Callable, Iterable

import pytest
from played_matches import played
from sqlalchemy import Engine, insert, select, update
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import Account, Player, PlayerManager
from fortymm_api.services.adoption import adopt_guest
from fortymm_api.services.player_merge import Merged, PlayedEachOther
from fortymm_api.services.players import (
    Answer,
    Answered,
    Reply,
    SameAs,
    account_players,
    answer_question,
)

ANN = PlayerId(uuid.uuid4())
BO = PlayerId(uuid.uuid4())
CY = PlayerId(uuid.uuid4())


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def add_player(session: Session, id: PlayerId) -> None:
    """A player that no account manages."""
    session.execute(
        insert(Player).values(id=id, display_name=f"player {uuid.uuid4().hex[:12]}")
    )


def add_account(
    session: Session,
    plays_as: PlayerId | None = None,
    manages: Iterable[PlayerId] = (),
) -> AccountId:
    """A guest account whose self player is `plays_as`, which manages
    `manages`."""
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
    return account


def merge(session: Session, player: PlayerId, into: PlayerId) -> None:
    session.execute(update(Player).where(Player.id == player).values(merged_into=into))


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
    """Ann's account plays as ANN. A sign-in asks it "Is this you?" about
    BO."""
    add_player(session, ANN)
    add_player(session, BO)
    ann = add_account(session, plays_as=ANN)
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


def test_a_match_with_no_result_doesnt_block_the_merge(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> AccountId:
        ann = ann_asked_about_bo(session)
        played(session, (ANN, BO), with_result=False)
        return ann

    ann = in_transaction(migrated_database, setup)

    answered = answer(migrated_database, ann, Answer.YES)

    assert isinstance(answered.outcome, Merged)


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
