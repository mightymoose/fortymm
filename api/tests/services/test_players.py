import uuid
from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import ip_address

import pytest
from locks import wait_behind
from sqlalchemy import Engine, text, update
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, Email, PlayerId
from fortymm_api.models import Account, Player, PlayerManager
from fortymm_api.services.adoption import adopt_guest, hand_over_players
from fortymm_api.services.players import (
    AccountPlayer,
    Answer,
    PlayerNotManaged,
    QuestionClosed,
    SelfPlayerExists,
    account_players,
    answer_question,
)
from fortymm_api.services.sessions import AccountAdopted, start_session

ANN = ip_address("203.0.113.7")
EGRET = "excited egret 387"


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


@dataclass(frozen=True)
class Question:
    """An open "Is this you?" question: the account, the player it asks
    about, and the guest account the player came from."""

    account: AccountId
    player: PlayerId
    adopted_from: AccountId


def new_guest(session: Session, display_name: str) -> tuple[AccountId, PlayerId]:
    started = start_session(session, None, ANN, new_display_name=lambda: display_name)
    assert started.player is not None
    return started.account.id, started.player.id


def adopted(database: Engine) -> Question:
    """A guest account that signed in to Bob's account, as AdoptGuest does."""

    def setup(session: Session) -> Question:
        bob = Account(email=Email("bob@example.com"))
        session.add(bob)
        session.flush()
        guest, player = new_guest(session, EGRET)
        adopt_guest(session, guest, bob.id)
        return Question(bob.id, player, guest)

    return in_transaction(database, setup)


def verified_in_place(database: Engine) -> Question:
    """A guest account that signed in with a new email, as VerifyInPlace
    does. The question names the account itself."""

    def setup(session: Session) -> Question:
        guest, player = new_guest(session, EGRET)
        session.execute(
            update(Account)
            .where(Account.id == guest)
            .values(email=Email("ann@example.com"))
        )
        hand_over_players(session, guest, guest)
        return Question(guest, player, guest)

    return in_transaction(database, setup)


SETUPS = pytest.mark.parametrize(
    "setup", [adopted, verified_in_place], ids=["adopted", "verified_in_place"]
)
type Setup = Callable[[Engine], Question]


def add_player(
    database: Engine,
    account: AccountId,
    name: str,
    relationship: str,
    *,
    adopted_from: AccountId | None = None,
) -> PlayerId:
    def add(session: Session) -> PlayerId:
        player = Player(display_name=name)
        session.add(player)
        session.flush()
        session.add(
            PlayerManager(
                player_id=player.id,
                account_id=account,
                relationship=relationship,
                adopted_from=adopted_from,
            )
        )
        return player.id

    return in_transaction(database, add)


def players_of(database: Engine, account: AccountId) -> list[AccountPlayer]:
    return in_transaction(database, lambda session: account_players(session, account))


def answer(database: Engine, question: Question, value: Answer) -> list[AccountPlayer]:
    return in_transaction(
        database,
        lambda session: answer_question(
            session, question.account, question.player, value
        ),
    )


def manager_rows(database: Engine, player: PlayerId) -> list[tuple[object, ...]]:
    with database.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT account_id, relationship, adopted_from FROM player_managers"
                " WHERE player_id = :player"
            ),
            {"player": player},
        ).all()
    return [tuple(row) for row in rows]


def exists(database: Engine, table: str, id: uuid.UUID) -> bool:
    with database.connect() as connection:
        found: bool = connection.scalar(
            text(f"SELECT EXISTS (SELECT 1 FROM {table} WHERE id = :id)"), {"id": id}
        )
        return found


@SETUPS
def test_lists_a_player_with_an_open_question(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    assert players_of(migrated_database, question.account) == [
        AccountPlayer(question.player, EGRET, "managed", open_question=True)
    ]


def test_lists_the_self_player_first_then_the_rest_by_name(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    zebra = add_player(migrated_database, question.account, "zany zebra 101", "self")
    ant = add_player(migrated_database, question.account, "able ant 102", "managed")

    assert players_of(migrated_database, question.account) == [
        AccountPlayer(zebra, "zany zebra 101", "self", open_question=False),
        AccountPlayer(ant, "able ant 102", "managed", open_question=False),
        AccountPlayer(question.player, EGRET, "managed", open_question=True),
    ]


@SETUPS
def test_yes_makes_the_player_the_accounts_own(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    found = answer(migrated_database, question, Answer.YES)

    assert found == [AccountPlayer(question.player, EGRET, "self", open_question=False)]
    assert manager_rows(migrated_database, question.player) == [
        (question.account, "self", None)
    ]


@SETUPS
def test_no_keeps_the_player_as_one_the_account_manages(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    found = answer(migrated_database, question, Answer.NO)

    assert found == [
        AccountPlayer(question.player, EGRET, "managed", open_question=False)
    ]
    assert manager_rows(migrated_database, question.player) == [
        (question.account, "managed", None)
    ]


@SETUPS
def test_not_mine_takes_the_player_off_the_account_and_keeps_it(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    found = answer(migrated_database, question, Answer.NOT_MINE)

    assert found == []
    assert manager_rows(migrated_database, question.player) == []
    assert exists(migrated_database, "players", question.player)
    assert exists(migrated_database, "accounts", question.adopted_from)


@SETUPS
def test_yes_is_refused_while_the_account_has_its_own_player(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)
    add_player(migrated_database, question.account, "zany zebra 101", "self")

    with pytest.raises(SelfPlayerExists):
        answer(migrated_database, question, Answer.YES)

    assert manager_rows(migrated_database, question.player) == [
        (question.account, "managed", question.adopted_from)
    ]


@SETUPS
@pytest.mark.parametrize(
    ("first", "second"),
    [
        (Answer.NO, Answer.YES),
        (Answer.YES, Answer.NO),
        (Answer.YES, Answer.YES),
        (Answer.NO, Answer.NO),
    ],
)
def test_a_second_answer_changes_nothing(
    migrated_database: Engine, setup: Setup, first: Answer, second: Answer
) -> None:
    question = setup(migrated_database)
    after_first = answer(migrated_database, question, first)
    rows = manager_rows(migrated_database, question.player)

    assert answer(migrated_database, question, second) == after_first
    assert manager_rows(migrated_database, question.player) == rows


@SETUPS
@pytest.mark.parametrize("first", [Answer.YES, Answer.NO])
def test_not_mine_is_refused_once_the_question_is_answered(
    migrated_database: Engine, setup: Setup, first: Answer
) -> None:
    question = setup(migrated_database)
    answer(migrated_database, question, first)
    rows = manager_rows(migrated_database, question.player)

    with pytest.raises(QuestionClosed):
        answer(migrated_database, question, Answer.NOT_MINE)

    assert manager_rows(migrated_database, question.player) == rows


@pytest.mark.parametrize("value", list(Answer))
def test_a_player_the_account_doesnt_manage_is_refused(
    migrated_database: Engine, value: Answer
) -> None:
    question = adopted(migrated_database)
    _, someone_elses = in_transaction(
        migrated_database, lambda session: new_guest(session, "brave badger 214")
    )
    rows = manager_rows(migrated_database, someone_elses)

    for player in (someone_elses, PlayerId(uuid.uuid4())):
        with pytest.raises(PlayerNotManaged):
            answer(
                migrated_database,
                Question(question.account, player, question.adopted_from),
                value,
            )

    assert manager_rows(migrated_database, someone_elses) == rows


def test_an_adopted_account_can_neither_list_nor_answer(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    guest = question.adopted_from

    with pytest.raises(AccountAdopted):
        players_of(migrated_database, guest)
    with pytest.raises(AccountAdopted):
        answer(
            migrated_database,
            Question(guest, question.player, guest),
            Answer.NO,
        )


def test_two_yes_answers_at_once_make_one_self_player(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    badger = add_player(
        migrated_database,
        question.account,
        "brave badger 214",
        "managed",
        adopted_from=question.adopted_from,
    )

    first_result, waiter = wait_behind(
        migrated_database,
        lambda session: answer_question(
            session, question.account, question.player, Answer.YES
        ),
        lambda session: answer_question(session, question.account, badger, Answer.YES),
    )

    assert [player.relationship for player in first_result] == ["self", "managed"]
    assert isinstance(waiter.exception(), SelfPlayerExists)
    assert manager_rows(migrated_database, badger) == [
        (question.account, "managed", question.adopted_from)
    ]
